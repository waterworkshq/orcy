/** Strips the legacy `feat-` prefix from a task ID if present, returning the canonical ID. */
export function normalizeTaskId(id: string): string {
  return id.startsWith("feat-") ? id.slice(5) : id;
}

/** Strips the legacy `feat-` prefix from a mission ID if present, returning the canonical ID. */
export function normalizeMissionId(id: string): string {
  return id.startsWith("feat-") ? id.slice(5) : id;
}
