import { getDb } from '../db/index.js';
import { notificationPreferences } from '../db/schema/index.js';
import { eq, isNull, and } from 'drizzle-orm';
import { v4 as uuidv4 } from 'uuid';

export interface NotificationPreferences {
  id: string;
  userId: string;
  habitatId: string | null;
  taskAssigned: boolean;
  taskSubmitted: boolean;
  taskApproved: boolean;
  taskRejected: boolean;
  taskOverdue: boolean;
  taskMentioned: boolean;
  taskWatching: boolean;
  taskReviewAssigned: boolean;
  taskPriorityChanged: boolean;
  createdAt: string;
  updatedAt: string;
}

const DEFAULT_PREFS = {
  taskAssigned: 1,
  taskSubmitted: 1,
  taskApproved: 0,
  taskRejected: 1,
  taskOverdue: 1,
  taskMentioned: 1,
  taskWatching: 1,
  taskReviewAssigned: 1,
  taskPriorityChanged: 1,
};

export function getPreferences(userId: string, habitatId?: string | null): NotificationPreferences {
  const db = getDb();
  const now = new Date().toISOString();

  const rows = habitatId
    ? db.select().from(notificationPreferences).where(
        and(eq(notificationPreferences.userId, userId), eq(notificationPreferences.habitatId, habitatId))
      ).all()
    : db.select().from(notificationPreferences).where(
        and(eq(notificationPreferences.userId, userId), isNull(notificationPreferences.habitatId))
      ).all();

  if (rows.length > 0) {
    const row = rows[0];
    return {
      id: row.id,
      userId: row.userId,
      habitatId: row.habitatId,
      taskAssigned: row.taskAssigned === 1,
      taskSubmitted: row.taskSubmitted === 1,
      taskApproved: row.taskApproved === 1,
      taskRejected: row.taskRejected === 1,
      taskOverdue: row.taskOverdue === 1,
      taskMentioned: row.taskMentioned === 1,
      taskWatching: row.taskWatching === 1,
      taskReviewAssigned: row.taskReviewAssigned === 1,
      taskPriorityChanged: row.taskPriorityChanged === 1,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  const id = uuidv4();
  const habitatIdVal = habitatId ?? null;
  db.insert(notificationPreferences).values({
    id,
    userId,
    habitatId: habitatIdVal,
    ...DEFAULT_PREFS,
    createdAt: now,
    updatedAt: now,
  }).run();

  return {
    id,
    userId,
    habitatId: habitatIdVal,
    taskAssigned: DEFAULT_PREFS.taskAssigned === 1,
    taskSubmitted: DEFAULT_PREFS.taskSubmitted === 1,
    taskApproved: DEFAULT_PREFS.taskApproved === 1,
    taskRejected: DEFAULT_PREFS.taskRejected === 1,
    taskOverdue: DEFAULT_PREFS.taskOverdue === 1,
    taskMentioned: DEFAULT_PREFS.taskMentioned === 1,
    taskWatching: DEFAULT_PREFS.taskWatching === 1,
    taskReviewAssigned: DEFAULT_PREFS.taskReviewAssigned === 1,
    taskPriorityChanged: DEFAULT_PREFS.taskPriorityChanged === 1,
    createdAt: now,
    updatedAt: now,
  };
}

export function upsertPreferences(
  userId: string,
  habitatId: string | null | undefined,
  updates: Partial<Omit<NotificationPreferences, 'id' | 'userId' | 'habitatId' | 'createdAt' | 'updatedAt'>>
): NotificationPreferences {
  const db = getDb();
  const now = new Date().toISOString();
  const existing = getPreferences(userId, habitatId);

  const merged = {
    taskAssigned: updates.taskAssigned ?? existing.taskAssigned,
    taskSubmitted: updates.taskSubmitted ?? existing.taskSubmitted,
    taskApproved: updates.taskApproved ?? existing.taskApproved,
    taskRejected: updates.taskRejected ?? existing.taskRejected,
    taskOverdue: updates.taskOverdue ?? existing.taskOverdue,
    taskMentioned: updates.taskMentioned ?? existing.taskMentioned,
    taskWatching: updates.taskWatching ?? existing.taskWatching,
    taskReviewAssigned: updates.taskReviewAssigned ?? existing.taskReviewAssigned,
    taskPriorityChanged: updates.taskPriorityChanged ?? existing.taskPriorityChanged,
  };

  db.update(notificationPreferences).set({
    taskAssigned: merged.taskAssigned ? 1 : 0,
    taskSubmitted: merged.taskSubmitted ? 1 : 0,
    taskApproved: merged.taskApproved ? 1 : 0,
    taskRejected: merged.taskRejected ? 1 : 0,
    taskOverdue: merged.taskOverdue ? 1 : 0,
    taskMentioned: merged.taskMentioned ? 1 : 0,
    taskWatching: merged.taskWatching ? 1 : 0,
    taskReviewAssigned: merged.taskReviewAssigned ? 1 : 0,
    taskPriorityChanged: merged.taskPriorityChanged ? 1 : 0,
    updatedAt: now,
  }).where(eq(notificationPreferences.id, existing.id)).run();

  return {
    ...existing,
    ...merged,
    updatedAt: now,
  };
}
