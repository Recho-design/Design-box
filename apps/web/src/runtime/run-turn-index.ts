const RUN_TURN_INDEX_KEY = 'open-design:analytics.run_turn_index';
const PROJECT_TURN_INDEX_KEY_PREFIX = 'open-design:analytics.project_turn_index:';

// Claim the next 0-based run turn index for the current browser session and advance
// the counter. Lives in sessionStorage so it shares the exact lifetime of the session.
export function claimRunTurnIndex(): { turnIndex: number; isFirstRun: boolean } | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.sessionStorage.getItem(RUN_TURN_INDEX_KEY);
    const current = raw ? Number.parseInt(raw, 10) : 0;
    const turnIndex = Number.isFinite(current) && current >= 0 ? current : 0;
    window.sessionStorage.setItem(RUN_TURN_INDEX_KEY, String(turnIndex + 1));
    return { turnIndex, isFirstRun: turnIndex === 0 };
  } catch {
    return null;
  }
}

// Per-PROJECT run turn index, keyed by project id. Answers "within THIS project,
// which prompt / follow-up number is this run?". Persisted in localStorage.
export function claimProjectTurnIndex(
  projectId: string,
): { projectTurnIndex: number } | null {
  if (typeof window === 'undefined') return null;
  if (!projectId) return null;
  try {
    const key = `${PROJECT_TURN_INDEX_KEY_PREFIX}${projectId}`;
    const raw = window.localStorage.getItem(key);
    const current = raw ? Number.parseInt(raw, 10) : 0;
    const projectTurnIndex = Number.isFinite(current) && current >= 0 ? current : 0;
    window.localStorage.setItem(key, String(projectTurnIndex + 1));
    return { projectTurnIndex };
  } catch {
    return null;
  }
}
