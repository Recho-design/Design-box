// Experience diagnostics reporting removed.

export function reportExperienceFailure(
  _input: unknown,
  _occurrence?: string,
): void {
  // Pure local stub: /api/observability/event reporting removed.
}

export function reportExperienceEvent(
  _event: string,
  _props: Record<string, unknown>,
): void {
  // Pure local stub: /api/observability/event reporting removed.
}

export function reportProjectFailure(
  _project: { id: string; status?: { value: string; runId?: string; updatedAt?: number } },
  _surface: string,
): void {
  // Pure local stub: /api/observability/event reporting removed.
}

export function resetExperienceDiagnosticsForTests(): void {
  // Pure local stub.
}
