import type { SSEEvent } from '../models/index.js';
import { dispatchWebhooks } from '../services/webhookDispatcher.js';
import { processEvent } from '../services/notificationService.js';
import type { NotificationEventType, NotificationEventData } from '../services/notificationService.js';
import { processEvent as chatProcessEvent } from '../services/chatService.js';
import { logger } from '../lib/logger.js';

class SSEBroadcaster {
  private habitatStreams = new Map<string, Set<(event: SSEEvent) => void>>();

  subscribe(habitatId: string, handler: (event: SSEEvent) => void): () => void {
    if (!this.habitatStreams.has(habitatId)) {
      this.habitatStreams.set(habitatId, new Set());
    }
    this.habitatStreams.get(habitatId)!.add(handler);

    return () => {
      this.habitatStreams.get(habitatId)?.delete(handler);
      if (this.habitatStreams.get(habitatId)?.size === 0) {
        this.habitatStreams.delete(habitatId);
      }
    };
  }

  publish(habitatId: string, event: SSEEvent): void {
    const handlers = this.habitatStreams.get(habitatId);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }

    if (event.type.startsWith('task.') || event.type.startsWith('column.') || event.type.startsWith('agent.') || event.type.startsWith('anomaly.') || event.type.startsWith('mission.')) {
      dispatchWebhooks(habitatId, event).catch(err => {
        logger.error({ err }, 'Webhook dispatch error');
      });
      chatProcessEvent(event.type, habitatId, event.data as Record<string, unknown>).catch(err => {
        logger.error({ err }, 'Chat push error');
      });
    }

    this.triggerNotifications(habitatId, event);
  }

  private notifySafe(
    eventType: NotificationEventType,
    habitatId: string,
    data: NotificationEventData,
    label: string
  ): void {
    processEvent(eventType, habitatId, data).catch(err => {
      logger.error({ err, eventType, label }, `[notifications] ${label} error`);
    });
  }

  private triggerNotifications(habitatId: string, event: SSEEvent): void {
    switch (event.type) {
      case 'task.claimed':
        this.notifySafe('task.assigned', habitatId, {
          taskId: event.data.taskId,
          actorId: event.data.agentId,
        }, 'task.assigned');
        break;

      case 'task.submitted':
        this.notifySafe('task.submitted', habitatId, {
          taskId: event.data.taskId,
          actorId: event.data.agentId,
        }, 'task.submitted');
        break;

      case 'task.approved':
        this.notifySafe('task.approved', habitatId, {
          taskId: event.data.taskId,
          actorId: event.data.reviewerId,
        }, 'task.approved');
        break;

      case 'task.rejected':
        this.notifySafe('task.rejected', habitatId, {
          taskId: event.data.taskId,
          actorId: undefined,
          reason: event.data.reason,
        }, 'task.rejected');
        break;

      case 'task.overdue':
        this.notifySafe('task.overdue', habitatId, {
          taskId: event.data.taskId,
        }, 'task.overdue');
        break;

      case 'task.mentioned':
        if (event.data.mentionedType === 'human') {
          this.notifySafe('comment.mentioned', habitatId, {
            taskId: event.data.taskId,
            mentionedUserId: event.data.mentionedId,
            mentionedByName: event.data.mentionedName,
          }, 'comment.mentioned');
        }
        break;

      case 'mission.mentioned':
        if (event.data.mentionedType === 'human') {
          this.notifySafe('comment.mentioned', habitatId, {
            missionId: event.data.missionId,
            mentionedUserId: event.data.mentionedId,
            mentionedByName: event.data.mentionedName,
          }, 'comment.mentioned');
        }
        break;

      case 'task.watcher_notify':
        this.notifySafe('task.watching', habitatId, {
          taskId: event.data.taskId,
        }, 'task.watching');
        break;
    }
  }

  getSubscriberCount(habitatId: string): number {
    return this.habitatStreams.get(habitatId)?.size ?? 0;
  }
}

export const sseBroadcaster = new SSEBroadcaster();
