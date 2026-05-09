import { getDb } from '../db/index.js';
import { taskWatchers } from '../db/schema.js';
import { eq, and, asc, desc } from 'drizzle-orm';
import type { TaskWatcher } from '../models/index.js';

export function addWatcher(taskId: string, userId: string): TaskWatcher {
  const db = getDb();
  const now = new Date().toISOString();

  db.insert(taskWatchers)
    .values({ taskId, userId, createdAt: now })
    .onConflictDoNothing()
    .run();

  return { taskId, userId, createdAt: now };
}

export function removeWatcher(taskId: string, userId: string): boolean {
  const db = getDb();
  const existing = db
    .select()
    .from(taskWatchers)
    .where(and(eq(taskWatchers.taskId, taskId), eq(taskWatchers.userId, userId)))
    .get();

  if (!existing) return false;

  db.delete(taskWatchers)
    .where(and(eq(taskWatchers.taskId, taskId), eq(taskWatchers.userId, userId)))
    .run();
  return true;
}

export function isWatching(taskId: string, userId: string): boolean {
  const db = getDb();
  const row = db
    .select()
    .from(taskWatchers)
    .where(and(eq(taskWatchers.taskId, taskId), eq(taskWatchers.userId, userId)))
    .get();
  return row !== undefined;
}

export function getWatchersForTask(taskId: string): TaskWatcher[] {
  const db = getDb();
  return db
    .select()
    .from(taskWatchers)
    .where(eq(taskWatchers.taskId, taskId))
    .orderBy(asc(taskWatchers.createdAt))
    .all() as TaskWatcher[];
}

export function getWatcherUserIdsForTask(taskId: string): string[] {
  const db = getDb();
  const rows = db
    .select({ userId: taskWatchers.userId })
    .from(taskWatchers)
    .where(eq(taskWatchers.taskId, taskId))
    .all();
  return rows.map((r: { userId: string }) => r.userId);
}

export function getWatchedTasksForUser(userId: string): TaskWatcher[] {
  const db = getDb();
  return db
    .select()
    .from(taskWatchers)
    .where(eq(taskWatchers.userId, userId))
    .orderBy(desc(taskWatchers.createdAt))
    .all() as TaskWatcher[];
}

export function removeWatchersForTask(taskId: string): void {
  const db = getDb();
  db.delete(taskWatchers)
    .where(eq(taskWatchers.taskId, taskId))
    .run();
}
