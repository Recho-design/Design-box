export function orderAgentsWithOpenDesignFirst<T extends { id: string }>(
  agents: readonly T[],
): T[] {
  return [...agents];
}
