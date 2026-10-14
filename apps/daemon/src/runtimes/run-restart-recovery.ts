/**
 * Why a Run reached its terminal state. This used to be the analytics tracking
 * union; it is a local product fact (the failure card and the retry policy both
 * read it), so the daemon owns the list.
 */
export type RunTerminalTrigger =
  | 'daemon_restart'
  | 'daemon_shutdown'
  | 'first_output_deadline'
  | 'inactivity_watchdog'
  | 'acp_stage_timeout'
  | 'unknown';

const TERMINAL_STATUSES = new Set(['succeeded', 'failed', 'canceled']);

export const RESTART_ERROR_CODE = 'DAEMON_RESTARTED';
export const RESTART_ERROR_MESSAGE =
  'Run interrupted because the daemon restarted.';

export interface RestartRecoverableDurableRunState {
  error?: string | null;
  errorCode?: string | null;
  exitCode?: number | null;
  signal?: string | null;
  status: string;
  terminalTrigger?: RunTerminalTrigger | null;
  terminalRecoveryReason?: 'daemon_restart' | 'analytics_incomplete';
  terminalAt?: number | null;
  updatedAt: number;
}

export function interruptDurableRunAfterDaemonRestart(
  state: RestartRecoverableDurableRunState,
  now = Date.now(),
): boolean {
  if (TERMINAL_STATUSES.has(state.status)) return false;
  state.status = 'failed';
  state.updatedAt = now;
  state.terminalAt = now;
  state.exitCode = 1;
  state.signal = null;
  state.error = RESTART_ERROR_MESSAGE;
  state.errorCode = RESTART_ERROR_CODE;
  state.terminalTrigger = 'daemon_restart';
  state.terminalRecoveryReason = 'daemon_restart';
  return true;
}
