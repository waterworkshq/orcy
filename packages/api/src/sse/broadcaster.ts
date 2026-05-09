import type { SSEEvent } from '../models/index.js';
import { dispatchWebhooks } from '../services/webhookDispatcher.js';
import { processEvent } from '../services/notificationService.js';
import type { NotificationEventType, NotificationEventData } from '../services/notificationService.js';
import { processEvent as chatProcessEvent } from '../services/chatService.js';
import { logger } from '../lib/logger.js';

class SSEBroadcaster {
  private boardStreams = new Map<string, Set<(event: SSEEvent) => void>>();

  subscribe(boardId: string, handler: (event: SSEEvent) => void): () => void {
    if (!this.boardStreams.has(boardId)) {
      this.boardStreams.set(boardId, new Set());
    }
    this.boardStreams.get(boardId)!.add(handler);

    return () => {
      this.boardStreams.get(boardId)?.delete(handler);
      if (this.boardStreams.get(boardId)?.size === 0) {
        this.boardStreams.delete(boardId);
      }
    };
  }

  publish(boardId: string, event: SSEEvent): void {
    const handlers = this.boardStreams.get(boardId);
    if (handlers) {
      for (const handler of handlers) {
        handler(event);
      }
    }

    if (event.type.startsWith('task.') || event.type.startsWith('column.') || event.type.startsWith('agent.') || event.type.startsWith('anomaly.') || event.type.startsWith('feature.')) {
      dispatchWebhooks(boardId, event).catch(err => {
        logger.error({ err }, 'Webhook dispatch error');
      });
      chatProcessEvent(event.type, boardId, event.data as Record<string, unknown>).catch(err => {
        logger.error({ err }, 'Chat push error');
      });
    }

    this.triggerNotifications(boardId, event);
  }

  private notifySafe(
    eventType: NotificationEventType,
    boardId: string,
    data: NotificationEventData,
    label: string
  ): void {
    processEvent(eventType, boardId, data).catch(err => {
      logger.error({ err, eventType, label }, `[notifications] ${label} error`);
    });
  }

  private triggerNotifications(boardId: string, event: SSEEvent): void {
    switch (event.type) {
      case 'task.claimed':
        this.notifySafe('task.assigned', boardId, {
          taskId: event.data.taskId,
          actorId: event.data.agentId,
        }, 'task.assigned');
        break;

      case 'task.submitted':
        this.notifySafe('task.submitted', boardId, {
          taskId: event.data.taskId,
          actorId: event.data.agentId,
        }, 'task.submitted');
        break;

      case 'task.approved':
        this.notifySafe('task.approved', boardId, {
          taskId: event.data.taskId,
          actorId: event.data.reviewerId,
        }, 'task.approved');
        break;

      case 'task.rejected':
        this.notifySafe('task.rejected', boardId, {
          taskId: event.data.taskId,
          actorId: undefined,
          reason: event.data.reason,
        }, 'task.rejected');
        break;

      case 'task.overdue':
        this.notifySafe('task.overdue', boardId, {
          taskId: event.data.taskId,
        }, 'task.overdue');
        break;

      case 'task.mentioned':
        if (event.data.mentionedType === 'human') {
          this.notifySafe('comment.mentioned', boardId, {
            taskId: event.data.taskId,
            mentionedUserId: event.data.mentionedId,
            mentionedByName: event.data.mentionedName,
          }, 'comment.mentioned');
        }
        break;

      case 'task.watcher_notify':
        this.notifySafe('task.watching', boardId, {
          taskId: event.data.taskId,
        }, 'task.watching');
        break;
    }
  }

  getSubscriberCount(boardId: string): number {
    return this.boardStreams.get(boardId)?.size ?? 0;
  }
}

export const sseBroadcaster = new SSEBroadcaster();
