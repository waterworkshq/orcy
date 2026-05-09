import type { PresenceEntry, PresenceEvent, SSEEvent } from '../models/index.js';
import { sseBroadcaster } from './broadcaster.js';

const boardPresence = new Map<string, Map<string, PresenceEntry>>();
const pendingBroadcasts = new Map<string, NodeJS.Timeout>();
/**
 * Manages per-board presence tracking: who is viewing which board and task.
 * Throttles presence summary broadcasts to avoid flooding clients.
 */

const BROADCAST_THROTTLE_MS = 5_000;

// Forwards a presence event to the SSE broadcaster as a generic SSEEvent
function publishPresence(boardId: string, event: PresenceEvent): void {
  sseBroadcaster.publish(boardId, event as unknown as SSEEvent);
}

/**
 * Schedules a throttled presence summary broadcast for the board.
 * Only one pending broadcast per board exists at a time.
 */
function schedulePresenceBroadcast(boardId: string): void {
  if (pendingBroadcasts.has(boardId)) return;
  pendingBroadcasts.set(
    boardId,
    setTimeout(() => {
      pendingBroadcasts.delete(boardId);
      const viewers = getBoardPresence(boardId);
      publishPresence(boardId, { type: 'presence.summary', data: { boardId, viewers } });
    }, BROADCAST_THROTTLE_MS)
  );
}

/**
 * Registers a new session as present on a board and publishes a joined event.
 */
export function joinBoard(boardId: string, entry: Omit<PresenceEntry, 'lastSeen'>): void {
  if (!boardPresence.has(boardId)) {
    boardPresence.set(boardId, new Map());
  }
  const newEntry: PresenceEntry = { ...entry, lastSeen: Date.now() };
  boardPresence.get(boardId)!.set(entry.sessionId, newEntry);
  publishPresence(boardId, { type: 'presence.joined', data: { boardId, presence: newEntry } });
  schedulePresenceBroadcast(boardId);
}

/**
 * Removes a session from the board's presence and publishes a left event.
 */
export function leaveBoard(boardId: string, sessionId: string): void {
  const board = boardPresence.get(boardId);
  if (!board) return;
  board.delete(sessionId);
  publishPresence(boardId, { type: 'presence.left', data: { boardId, sessionId } });
  schedulePresenceBroadcast(boardId);
}

/**
 * Updates the task a session is currently viewing (or clears it with null).
 */
export function setViewingTask(boardId: string, sessionId: string, taskId: string | null): void {
  const board = boardPresence.get(boardId);
  if (!board) return;
  const entry = board.get(sessionId);
  if (!entry) return;
  entry.viewingTaskId = taskId;
  entry.lastSeen = Date.now();
  publishPresence(boardId, { type: 'presence.refresh', data: { boardId, presence: entry } });
  schedulePresenceBroadcast(boardId);
}

/**
 * Returns all active presence entries for a board.
 */
export function getBoardPresence(boardId: string): PresenceEntry[] {
  return Array.from(boardPresence.get(boardId)?.values() ?? []);
}

/**
 * Returns all sessions currently viewing a specific task on a board.
 */
export function getTaskViewers(boardId: string, taskId: string): PresenceEntry[] {
  const board = boardPresence.get(boardId);
  if (!board) return [];
  return Array.from(board.values()).filter(e => e.viewingTaskId === taskId);
}

/**
 * Removes presence entries older than maxAgeMs and publishes left events for each.
 * Schedules summary broadcasts for any boards that had stale entries removed.
 * Returns the count of removed entries.
 */
export function cleanupStalePresence(maxAgeMs: number = 120_000): number {
  const now = Date.now();
  let removed = 0;
  for (const [boardId, entries] of boardPresence) {
    for (const [sessionId, entry] of entries) {
      if (now - entry.lastSeen > maxAgeMs) {
        entries.delete(sessionId);
        removed++;
        publishPresence(boardId, { type: 'presence.left', data: { boardId, sessionId } });
      }
    }
    if (entries.size === 0) {
      boardPresence.delete(boardId);
    }
  }
  if (removed > 0) {
    for (const boardId of boardPresence.keys()) {
      schedulePresenceBroadcast(boardId);
    }
  }
  return removed;
}

/**
 * Resets all presence state and clears pending timeouts.
 * Use only in test contexts.
 */
export function resetPresenceForTesting(): void {
  for (const [, timeout] of pendingBroadcasts) {
    clearTimeout(timeout);
  }
  pendingBroadcasts.clear();
  boardPresence.clear();
}

/**
 * Starts a background interval that periodically removes stale presence entries.
 * Returns the interval handle for cleanup during shutdown.
 */
export function startPresenceCleanup(intervalMs: number = 60_000): NodeJS.Timeout {
  return setInterval(() => {
    cleanupStalePresence();
  }, intervalMs);
}
