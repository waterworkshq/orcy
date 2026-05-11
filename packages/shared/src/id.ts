export function normalizeTaskId(id: string): string {
  return id.startsWith('feat-') ? id.slice(5) : id;
}
