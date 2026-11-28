// Process-local reconciliation for a Stop whose offline write failed. A
// successful heartbeat supersedes that pending write even at the same clock
// instant. This is not durable across API process restarts.
const pendingOfflineWrites = new Set<string>();

export function markPendingOfflineWrite(id: string): void {
  pendingOfflineWrites.add(id);
}

export function clearPendingOfflineWrite(id: string): void {
  pendingOfflineWrites.delete(id);
}

export function hasPendingOfflineWrite(id: string): boolean {
  return pendingOfflineWrites.has(id);
}
