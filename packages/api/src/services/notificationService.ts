import * as prefRepo from '../repositories/notificationPreferences.js';
import type { NotificationPreferences } from '../repositories/notificationPreferences.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/feature.js';
import * as habitatRepo from '../repositories/board.js';
import * as agentRepo from '../repositories/agent.js';
import * as userRepo from '../repositories/user.js';
import * as watcherRepo from '../repositories/watcher.js';
import * as emailService from './emailService.js';
import { getDb } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

export type NotificationEventType = 'task.assigned' | 'task.submitted' | 'task.approved' | 'task.rejected' | 'task.overdue' | 'comment.mentioned' | 'task.watching' | 'task.priority_changed' | 'task.review_assigned';

export type NotificationEventData = {
  taskId?: string;
  missionId?: string;
  actorId?: string;
  reason?: string;
  mentionedUserId?: string;
  mentionedByName?: string;
  commentContent?: string;
  oldPriority?: string;
  newPriority?: string;
  reviewerId?: string;
};

type EventType = NotificationEventType;

function getUserEmail(userId: string): string | null {
  const db = getDb();
  const row = db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
  return row?.email ?? null;
}

function getActorName(actorId: string): string {
  const agent = agentRepo.getAgentById(actorId);
  if (agent) return agent.name;

  const db = getDb();
  const row = db.select({ displayName: users.displayName, username: users.username }).from(users).where(eq(users.id, actorId)).get();
  if (row) return row.displayName || row.username || actorId;
  return actorId;
}

function getPreferenceValue(prefs: NotificationPreferences, field: string): boolean | undefined {
  switch (field) {
    case 'taskAssigned': return prefs.taskAssigned;
    case 'taskSubmitted': return prefs.taskSubmitted;
    case 'taskApproved': return prefs.taskApproved;
    case 'taskRejected': return prefs.taskRejected;
    case 'taskOverdue': return prefs.taskOverdue;
    case 'taskMentioned': return prefs.taskMentioned;
    case 'taskWatching': return prefs.taskWatching;
    case 'taskPriorityChanged': return prefs.taskPriorityChanged;
    case 'taskReviewAssigned': return prefs.taskReviewAssigned;
    default: return undefined;
  }
}

async function sendIfEnabled(userId: string, habitatId: string, eventType: EventType, buildEmail: () => emailService.EmailPayload): Promise<void> {
  const habitatPrefs = prefRepo.getPreferences(userId, habitatId);
  const globalPrefs = prefRepo.getPreferences(userId, null);

  const prefField = eventTypeToField(eventType);
  if (!prefField) return;

  const enabled = getPreferenceValue(habitatPrefs, prefField) ?? getPreferenceValue(globalPrefs, prefField) ?? false;
  if (!enabled) return;

  const email = getUserEmail(userId);
  if (!email) return;

  const payload = buildEmail();
  payload.to = email;
  await emailService.sendEmail(payload);
}

function eventTypeToField(eventType: EventType): string | null {
  switch (eventType) {
    case 'task.assigned': return 'taskAssigned';
    case 'task.submitted': return 'taskSubmitted';
    case 'task.approved': return 'taskApproved';
    case 'task.rejected': return 'taskRejected';
    case 'task.overdue': return 'taskOverdue';
    case 'comment.mentioned': return 'taskMentioned';
    case 'task.watching': return 'taskWatching';
    case 'task.priority_changed': return 'taskPriorityChanged';
    case 'task.review_assigned': return 'taskReviewAssigned';
    default: return null;
  }
}

export async function processEvent(
  eventType: NotificationEventType,
  habitatId: string,
  data: NotificationEventData
): Promise<void> {
  if (!emailService.isConfigured()) return;

  const task = data.taskId ? taskRepo.getTaskById(data.taskId) : null;
  if (!task) return;

  const mission = task.missionId ? missionRepo.getMissionById(task.missionId) : null;

  const habitat = habitatRepo.getHabitatById(habitatId);
  const habitatName = habitat?.name ?? 'Unknown Habitat';
  const taskTitle = task.title;
  const actorName = data.actorId ? getActorName(data.actorId) : 'System';

  const queue: Array<{ userId: string; eventType: EventType; buildEmail: () => emailService.EmailPayload }> = [];

  switch (eventType) {
    case 'task.assigned': {
      if (task.assignedAgentId) {
        queue.push({
          userId: task.assignedAgentId,
          eventType: 'task.assigned',
          buildEmail: () => emailService.taskAssignedTemplate(taskTitle, habitatName, actorName),
        });
      }
      break;
    }
    case 'task.submitted': {
      const db = getDb();
      const adminRows = db.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all();
      for (const row of adminRows) {
        queue.push({
          userId: row.id,
          eventType: 'task.submitted',
          buildEmail: () => emailService.taskSubmittedTemplate(taskTitle, habitatName, actorName),
        });
      }
      break;
    }
    case 'task.approved': {
      if (task.assignedAgentId) {
        queue.push({
          userId: task.assignedAgentId,
          eventType: 'task.approved',
          buildEmail: () => emailService.taskApprovedTemplate(taskTitle, habitatName, actorName),
        });
      }
      break;
    }
    case 'task.rejected': {
      if (task.assignedAgentId) {
        queue.push({
          userId: task.assignedAgentId,
          eventType: 'task.rejected',
          buildEmail: () => emailService.taskRejectedTemplate(taskTitle, habitatName, actorName, data.reason ?? 'No reason provided'),
        });
      }
      break;
    }
    case 'task.overdue': {
      if (task.assignedAgentId) {
        queue.push({
          userId: task.assignedAgentId,
          eventType: 'task.overdue',
          buildEmail: () => emailService.taskOverdueTemplate(taskTitle, habitatName, mission?.dueAt ?? mission?.slaDeadlineAt ?? 'Unknown'),
        });
      }
      const db2 = getDb();
      const adminRows2 = db2.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all();
      for (const row of adminRows2) {
        queue.push({
          userId: row.id,
          eventType: 'task.overdue',
          buildEmail: () => emailService.taskOverdueTemplate(taskTitle, habitatName, mission?.dueAt ?? mission?.slaDeadlineAt ?? 'Unknown'),
        });
      }
      break;
    }
    case 'comment.mentioned': {
      if (data.mentionedUserId) {
        queue.push({
          userId: data.mentionedUserId,
          eventType: 'comment.mentioned',
          buildEmail: () => emailService.commentMentionedTemplate(taskTitle, habitatName, data.mentionedByName ?? actorName, data.commentContent ?? ''),
        });
      }
      break;
    }
    case 'task.watching': {
      if (!data.taskId) break;
      const watcherUserIds = watcherRepo.getWatcherUserIdsForTask(data.taskId);
      for (const userId of watcherUserIds) {
        if (userId === data.actorId) continue;
        queue.push({
          userId,
          eventType: 'task.watching',
          buildEmail: () => emailService.taskWatchingTemplate(taskTitle, habitatName, eventType),
        });
      }
      break;
    }
    case 'task.priority_changed': {
      // Notify the assigned agent
      if (task.assignedAgentId) {
        queue.push({
          userId: task.assignedAgentId,
          eventType: 'task.priority_changed',
          buildEmail: () => emailService.priorityChangedTemplate(
            taskTitle, habitatName,
            data.oldPriority ?? 'medium', data.newPriority ?? 'medium'
          ),
        });
      }
      // Also notify admins
      const db3 = getDb();
      const adminRows3 = db3.select({ id: users.id }).from(users).where(eq(users.role, 'admin')).all();
      for (const row of adminRows3) {
        if (row.id !== task.assignedAgentId) { // avoid duplicate
          queue.push({
            userId: row.id,
            eventType: 'task.priority_changed',
            buildEmail: () => emailService.priorityChangedTemplate(
              taskTitle, habitatName,
              data.oldPriority ?? 'medium', data.newPriority ?? 'medium'
            ),
          });
        }
      }
      break;
    }
    case 'task.review_assigned': {
      if (data.reviewerId) {
        queue.push({
          userId: data.reviewerId,
          eventType: 'task.review_assigned',
          buildEmail: () => emailService.reviewAssignedTemplate(taskTitle, habitatName, actorName),
        });
      }
      break;
    }
  }

  await Promise.allSettled(
    queue.map(item => sendIfEnabled(item.userId, habitatId, item.eventType, item.buildEmail))
  );
}
