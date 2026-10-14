// Local run-terminal integrity bookkeeping.
//
// A physical Run may be told it reached a terminal state more than once: a
// runtime can report the same outcome through adjacent error/close callbacks, a
// client can claim a terminal state that the daemon already recorded, and a
// daemon restart can leave a record that is only settled on the next boot. This
// module answers the questions the run record, the SSE `end` payload and the
// failure card all ask about that: was the terminal claim canonical, how many
// duplicates or late claims were ignored, and how was the claim persisted.
//
// It is deliberately free of any telemetry shape: this is local bookkeeping.

export const RUN_TERMINAL_INTEGRITY_VERSION = 1;

export type RunTerminalIntegrity =
  | 'canonical'
  | 'duplicate'
  | 'late'
  | 'reconciled'
  | 'overwritten'
  | 'permanently_missing'
  | 'post_terminal_activity';

export type RunTerminalPersistenceStatus =
  | 'acknowledged'
  | 'failed'
  | 'unknown';

export type RunTerminalPersistenceErrorType =
  | 'permission_denied'
  | 'read_only_storage'
  | 'storage_full'
  | 'storage_unavailable'
  | 'serialization_failed'
  | 'unknown';

export interface RunTerminalPersistenceResult {
  status: RunTerminalPersistenceStatus;
  errorType: RunTerminalPersistenceErrorType | null;
}

export type RunTerminationOrigin =
  | 'user_cancel'
  | 'watchdog_cleanup'
  | 'project_cleanup'
  | 'unknown';

export type RunMatureUnfinishedState =
  | 'still_running'
  | 'permanently_missing'
  | 'terminated_persistence_missing'
  | 'recovery_pending'
  | 'unknown';

export interface RunTerminalLifecycleV1 {
  version: typeof RUN_TERMINAL_INTEGRITY_VERSION;
  runAttempt: number;
  runtimeGenerationId: string | null;
  terminationOrigin: RunTerminationOrigin;
  terminalIntegrity: RunTerminalIntegrity;
  terminalPersistence: RunTerminalPersistenceResult;
  unfinishedState: RunMatureUnfinishedState;
  duplicateTerminalCount: number;
  lateTerminalCount: number;
  reconciliation?: {
    generationId: string;
    integrity: 'recovered';
  };
}

function normalizedAttemptCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

export function runAttemptForTerminalLifecycle(input: {
  cumulativeRetryAttemptCount?: unknown;
  retryAttemptCount?: unknown;
  manualResumeAttemptCount?: unknown;
}): number {
  return normalizedAttemptCount(input.cumulativeRetryAttemptCount)
    + normalizedAttemptCount(input.retryAttemptCount)
    + normalizedAttemptCount(input.manualResumeAttemptCount);
}

export function boundedRuntimeGenerationId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim();
  return /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu
    .test(normalized)
    ? normalized.toLowerCase()
    : null;
}

export function deriveRunTerminationOrigin(input: {
  cancelOrigin?: string | null;
  terminalTrigger?: string | null;
}): RunTerminationOrigin {
  if (input.cancelOrigin === 'user_stop') return 'user_cancel';
  if (input.cancelOrigin === 'project_cleanup') return 'project_cleanup';
  if (
    input.terminalTrigger === 'first_output_deadline'
    || input.terminalTrigger === 'inactivity_watchdog'
    || input.terminalTrigger === 'acp_stage_timeout'
  ) {
    return 'watchdog_cleanup';
  }
  // `daemon_shutdown` currently merges user quit, updater apply, external
  // SIGTERM, and sidecar teardown. `daemon_restart` is observed only on the
  // next boot. Neither is sufficient evidence for a more specific origin.
  return 'unknown';
}

export function terminalPersistenceErrorType(
  error: unknown,
): RunTerminalPersistenceErrorType {
  const code = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === 'EACCES' || code === 'EPERM') return 'permission_denied';
  if (code === 'EROFS') return 'read_only_storage';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'storage_full';
  if (code === 'ENOENT' || code === 'EIO') return 'storage_unavailable';
  if (error instanceof TypeError) return 'serialization_failed';
  return 'unknown';
}

export function terminalLifecycleSnapshot(input: {
  cumulativeRetryAttemptCount?: unknown;
  retryAttemptCount?: unknown;
  manualResumeAttemptCount?: unknown;
  runtimeGenerationId?: unknown;
  cancelOrigin?: string | null;
  terminalTrigger?: string | null;
  terminalIntegrity?: RunTerminalIntegrity | null;
  terminalPersistence: RunTerminalPersistenceResult;
  duplicateTerminalCount?: number;
  lateTerminalCount?: number;
}): RunTerminalLifecycleV1 {
  const snapshot: RunTerminalLifecycleV1 = {
    version: RUN_TERMINAL_INTEGRITY_VERSION,
    runAttempt: runAttemptForTerminalLifecycle(input),
    runtimeGenerationId: boundedRuntimeGenerationId(input.runtimeGenerationId),
    terminationOrigin: deriveRunTerminationOrigin(input),
    terminalIntegrity: input.terminalIntegrity ?? 'canonical',
    terminalPersistence: input.terminalPersistence,
    unfinishedState: 'unknown',
    duplicateTerminalCount: input.duplicateTerminalCount ?? 0,
    lateTerminalCount: input.lateTerminalCount ?? 0,
  };
  snapshot.unfinishedState = classifyMatureUnfinishedRun({
    runStatus: 'terminal',
    terminalLifecycle: snapshot,
  });
  return snapshot;
}

export function recordIgnoredTerminalClaim(
  lifecycle: RunTerminalLifecycleV1,
  kind: 'duplicate' | 'late',
): RunTerminalLifecycleV1 {
  const terminalIntegrity = lifecycle.terminalIntegrity === 'canonical'
    ? kind
    : lifecycle.terminalIntegrity === 'duplicate' && kind === 'late'
      ? 'late'
      : lifecycle.terminalIntegrity;
  return {
    ...lifecycle,
    terminalIntegrity,
    duplicateTerminalCount:
      lifecycle.duplicateTerminalCount + (kind === 'duplicate' ? 1 : 0),
    lateTerminalCount:
      lifecycle.lateTerminalCount + (kind === 'late' ? 1 : 0),
  };
}

export function classifyMatureUnfinishedRun(input: {
  runStatus: 'running' | 'terminal' | 'unknown';
  terminalLifecycle?: RunTerminalLifecycleV1 | null;
}): RunMatureUnfinishedState {
  if (input.runStatus === 'running') return 'still_running';
  if (input.runStatus !== 'terminal' || !input.terminalLifecycle) return 'unknown';
  if (input.terminalLifecycle.terminalIntegrity === 'permanently_missing') {
    return 'permanently_missing';
  }
  if (input.terminalLifecycle.terminalPersistence.status === 'failed') {
    return 'terminated_persistence_missing';
  }
  return 'unknown';
}
