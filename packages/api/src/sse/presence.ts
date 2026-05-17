import type { PresenceEntry, PresenceEvent, SSEEvent } from '../models/index.js';
import { sseBroadcaster } from './broadcaster.js';

const habitatPresence = new Map<string, Map<string, PresenceEntry>>();
const pendingBroadcasts = new Map<string, NodeJS.Timeout>();
/**
 * Manages per-board presence tracking: who is viewing which board and task.
 * Throttles presence summary broadcasts to avoid flooding clients.
 */

const BROADCAST_THROTTLE_MS = 5_000;

// Forwards a presence event to the SSE broadcaster as a generic SSEEvent
function publishPresence(habitatId: string, event: PresenceEvent): void {
  sseBroadcaster.publish(habitatId, event as unknown as SSEEvent);
}

/**
 * Schedules a throttled presence summary broadcast for the board.
 * Only one pending broadcast per board exists at a time.
 */
function schedulePresenceBroadcast(habitatId: string): void {
  if (pendingBroadcasts.has(habitatId)) return;
  pendingBroadcasts.set(
    habitatId,
    setTimeout(() => {
      pendingBroadcasts.delete(habitatId);
      const viewers = getHabitatPresence(habitatId);
      publishPresence(habitatId, { type: 'presence.summary', data: { habitatId, viewers } });
    }, BROADCAST_THROTTLE_MS)
  );
}

/**
 * Registers a new session as present on a board and publishes a joined event.
 */
export function joinHabitat(habitatId: string, entry: Omit<PresenceEntry, 'lastSeen'>): void {
  if (!habitatPresence.has(habitatId)) {
    habitatPresence.set(habitatId, new Map());
  }
  const newEntry: PresenceEntry = { ...entry, lastSeen: Date.now() };
  habitatPresence.get(habitatId)!.set(entry.sessionId, newEntry);
  publishPresence(habitatId, { type: 'presence.joined', data: { habitatId, presence: newEntry } });
  schedulePresenceBroadcast(habitatId);
}

/**
 * Removes a session from the board's presence and publishes a left event.
 */
export function leaveHabitat(habitatId: string, sessionId: string): void {
  const habitat = habitatPresence.get(habitatId);
  if (!habitat) return;
  habitat.delete(sessionId);
  publishPresence(habitatId, { type: 'presence.left', data: { habitatId, sessionId } });
  schedulePresenceBroadcast(habitatId);
}

/**
 * Updates the task a session is currently viewing (or clears it with null).
 */
export function setViewingTask(habitatId: string, sessionId: string, taskId: string | null): void {
  const habitat = habitatPresence.get(habitatId);
  if (!habitat) return;
  const entry = habitat.get(sessionId);
  if (!entry) return;
  entry.viewingTaskId = taskId;
  entry.lastSeen = Date.now();
  publishPresence(habitatId, { type: 'presence.refresh', data: { habitatId, presence: entry } });
  schedulePresenceBroadcast(habitatId);
}

/**
 * Returns all active presence entries for a board.
 */
export function getHabitatPresence(habitatId: string): PresenceEntry[] {
  return Array.from(habitatPresence.get(habitatId)?.values() ?? []);
}

/**
 * Returns all sessions currently viewing a specific task on a board.
 */
export function getTaskViewers(habitatId: string, taskId: string): PresenceEntry[] {
  const habitat = habitatPresence.get(habitatId);
  if (!habitat) return [];
  return Array.from(habitat.values()).filter(e => e.viewingTaskId === taskId);
}

/**
 * Removes presence entries older than maxAgeMs and publishes left events for each.
 * Schedules summary broadcasts for any boards that had stale entries removed.
 * Returns the count of removed entries.
 */
export function cleanupStalePresence(maxAgeMs: number = 120_000): number {
  const now = Date.now();
  let removed = 0;
  for (const [habitatId, entries] of habitatPresence) {
    for (const [sessionId, entry] of entries) {
      if (now - entry.lastSeen > maxAgeMs) {
        entries.delete(sessionId);
        removed++;
        publishPresence(habitatId, { type: 'presence.left', data: { habitatId, sessionId } });
      }
    }
    if (entries.size === 0) {
      habitatPresence.delete(habitatId);
    }
  }
  if (removed > 0) {
    for (const habitatId of habitatPresence.keys()) {
      schedulePresenceBroadcast(habitatId);
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
  habitatPresence.clear();
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
