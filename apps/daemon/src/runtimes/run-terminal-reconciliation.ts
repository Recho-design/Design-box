import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type Database from 'better-sqlite3';

import { appendMessageStatusEvent } from '../db.js';
import type { IntentRecoveryRunState } from '../strategies/od-next/intent-resolution-recovery.js';
import { reconcileStrategyTaskRunTerminal } from '../strategies/task-store.js';
import {
  interruptDurableRunAfterDaemonRestart,
  RESTART_ERROR_CODE,
  RESTART_ERROR_MESSAGE,
  type RestartRecoverableDurableRunState,
  type RunTerminalTrigger,
} from './run-restart-recovery.js';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);
const RECONCILED_STATUS_MESSAGE = 'Run terminal state reconciled after daemon restart.';

interface DurableRunState extends RestartRecoverableDurableRunState, IntentRecoveryRunState {
  schemaVersion: 1;
  id: string;
  projectId: string | null;
  conversationId: string | null;
  assistantMessageId: string | null;
  agentId: string | null;
  cancelOrigin?: string | null;
  terminalTrigger?: RunTerminalTrigger | null;
  createdAt: number;
  artifactCount?: number;
  endedWithUnfinishedWork?: boolean;
  userPrompt?: string;
  model?: string;
  resolvedModelId?: string;
  preflightAgentCliVersion?: string;
  reasoning?: string;
  skillId?: string;
  designSystemId?: string;
  designSystemDigest?: string;
  designSystemSelectionSource?: string;
  clientType?: 'desktop' | 'web' | 'unknown';
  promptTelemetry?: Record<string, unknown>;
  promptCache?: Record<string, unknown>;
  cumulativeRetryAttemptCount?: number;
  retryAttemptCount?: number;
  manualResumeAttemptCount?: number;
  runtimeGenerationId?: string | null;
}

export interface ReconciliationOptions {
  db: Database.Database;
  runsLogDir: string;
  recoverBeforeInterrupt?: (
    state: DurableRunState,
    states: ReadonlyMap<string, DurableRunState>,
    now: number,
  ) => Partial<DurableRunState> | null;
  finalizeTerminalLocally?: (run: DurableRunState, status: string, terminalAt: number) => void;
}

export interface RunTerminalReconciliationResult {
  scanned: number;
  interrupted: number;
  messagesReconciled: number;
  strategyTasksReconciled: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function readState(filePath: string): DurableRunState | null {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
    if (!isObject(value) || value.schemaVersion !== 1) return null;
    if (typeof value.id !== 'string' || typeof value.status !== 'string') return null;
    if (typeof value.createdAt !== 'number' || typeof value.updatedAt !== 'number') return null;
    return value as unknown as DurableRunState;
  } catch {
    return null;
  }
}

function writeState(filePath: string, state: DurableRunState): boolean {
  const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tempPath, filePath);
    return true;
  } catch {
    try { fs.unlinkSync(tempPath); } catch { /* best-effort cleanup */ }
    return false;
  }
}

function reconcileMessages(
  db: Database.Database,
  statesByRunId: Map<string, DurableRunState>,
  now: number,
  deferredRunIds: ReadonlySet<string>,
): number {
  let rows: Array<{ id: string; runId: string | null }> = [];
  try {
    rows = db.prepare(
      `SELECT id, run_id AS runId
         FROM messages
        WHERE run_status IN ('queued', 'running')`,
    ).all() as Array<{ id: string; runId: string | null }>;
  } catch {
    return 0;
  }
  let reconciled = 0;
  for (const row of rows) {
    if (row.runId && deferredRunIds.has(row.runId)) continue;
    reconciled += 1;
    const state = row.runId ? statesByRunId.get(row.runId) : undefined;
    const status = state && TERMINAL_STATUSES.has(state.status) ? state.status : 'failed';
    db.prepare(
      `UPDATE messages
          SET run_status = ?, ended_at = COALESCE(ended_at, ?)
        WHERE id = ? AND run_status IN ('queued', 'running')`,
    ).run(status, state?.updatedAt ?? now, row.id);
    const isDaemonRestart = state?.terminalRecoveryReason === 'daemon_restart'
      || state?.errorCode === RESTART_ERROR_CODE;
    appendMessageStatusEvent(db, row.id, status === 'failed'
      ? {
          label: 'error',
          detail: isDaemonRestart
            ? RESTART_ERROR_MESSAGE
            : state?.error ?? RECONCILED_STATUS_MESSAGE,
        }
      : { label: status, detail: RECONCILED_STATUS_MESSAGE });
  }
  return reconciled;
}

/**
 * Reconcile one Run's strategy-task terminal, absorbing any failure to read
 * that single record.
 *
 * Startup reconciliation owes EVERY Run its terminal obligation: message
 * repair and strategy-task terminal state. A task row whose persisted Prompt
 * Bundle can no longer be parsed is one Run's problem, and must never cancel the
 * obligation owed to its siblings — `strategyTaskTurnsForRunIds` already holds
 * this invariant for the message list. Returns whether the record was
 * reconciled; an unreadable record counts as not reconciled rather than as a
 * batch-ending error.
 */
function reconcileStrategyTaskRunTerminalIsolated(
  db: Parameters<typeof reconcileStrategyTaskRunTerminal>[0],
  input: Parameters<typeof reconcileStrategyTaskRunTerminal>[1],
): boolean {
  try {
    return reconcileStrategyTaskRunTerminal(db, input);
  } catch (error) {
    console.warn('[runs] strategy task terminal reconciliation skipped', input.runId, error);
    return false;
  }
}

/**
 * Repair the local, durable half of every Run that a daemon restart left
 * unfinished: interrupt still-running records, repair their message rows, and
 * settle their strategy-task terminal. Nothing here talks to the network.
 */
export async function reconcileDurableRunTerminals(
  options: ReconciliationOptions,
): Promise<RunTerminalReconciliationResult> {
  const result: RunTerminalReconciliationResult = {
    scanned: 0,
    interrupted: 0,
    messagesReconciled: 0,
    strategyTasksReconciled: 0,
  };
  let entries: fs.Dirent[] = [];
  try {
    entries = fs.readdirSync(options.runsLogDir, { withFileTypes: true });
  } catch {
    entries = [];
  }

  let states = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({
      filePath: path.join(options.runsLogDir, entry.name, 'state.json'),
      state: readState(path.join(options.runsLogDir, entry.name, 'state.json')),
    }))
    .filter((entry): entry is { filePath: string; state: DurableRunState } => entry.state !== null);
  result.scanned = states.length;
  const now = Date.now();

  const deferredRunIds = new Set<string>();
  if (options.recoverBeforeInterrupt) {
    const originalStates = new Map(states.map(entry => [entry.state.id, entry.state]));
    states = states.filter(entry => {
      try {
        const recovered = options.recoverBeforeInterrupt!(entry.state, originalStates, now);
        if (!recovered) return true;
        const next = { ...entry.state, ...recovered };
        // A validated local verdict can correct a previously derived restart
        // failure. Its stale marker would otherwise replay a failed SSE end
        // even though the durable status has now been repaired to succeeded.
        if (recovered.status === 'succeeded' && entry.state.status === 'failed'
          && entry.state.errorCode === RESTART_ERROR_CODE
          && entry.state.terminalRecoveryReason === 'daemon_restart') {
          delete next.terminalRecoveryReason;
          if (next.terminalTrigger === 'daemon_restart') delete next.terminalTrigger;
        }
        if (!writeState(entry.filePath, next)) {
          // SQL may already be committed. Leave the original physical snapshot
          // untouched for the next local replay, rather than interrupting it.
          deferredRunIds.add(entry.state.id);
          console.warn('[runs] local terminal recovery persistence deferred', entry.state.id);
          return false;
        }
        entry.state = next;
        return true;
      } catch (error) {
        // An owner/SQL read failure cannot authorize a successful recovery.
        // Defer this run without preventing siblings from reconciling.
        deferredRunIds.add(entry.state.id);
        console.warn('[runs] local terminal recovery deferred', entry.state.id, error);
        return false;
      }
    });
  }

  for (const entry of states) {
    if (!interruptDurableRunAfterDaemonRestart(entry.state, now)) continue;
    writeState(entry.filePath, entry.state);
    result.interrupted += 1;
  }

  // Repair both newly interrupted Runs and terminal state snapshots that may
  // have survived a crash before their local terminal write.
  for (const { state } of states) {
    if (state.status !== 'failed' && state.status !== 'canceled') continue;
    try {
      options.finalizeTerminalLocally?.(
        state,
        state.status,
        state.terminalAt ?? state.updatedAt,
      );
    } catch (error) {
      console.warn(
        '[runs] terminal local finalizer failed during restart reconciliation',
        error,
      );
    }
  }

  const statesByRunId = new Map(states.map((entry) => [entry.state.id, entry.state]));
  result.messagesReconciled = reconcileMessages(options.db, statesByRunId, now, deferredRunIds);
  for (const { state } of states) {
    if (state.status !== 'failed' && state.status !== 'canceled') continue;
    if (reconcileStrategyTaskRunTerminalIsolated(options.db, {
      runId: state.id,
      status: state.status,
      updatedAt: state.updatedAt,
    })) {
      result.strategyTasksReconciled += 1;
    }
  }

  return result;
}
