import { useEffect, useRef } from 'react';
import { useBoardStore } from '../store/habitatStore.js';
import { notify } from '../lib/toast.js';
import type { SSEEvent } from '../types/index.js';

/**
 * Wraps handleSSEEvent to emit toast notifications for relevant board events.
 * Uses a ref to deduplicate duplicate events received within the same session.
 */
export function useSSENotifications() {
  const prevEventsRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const originalHandler = useBoardStore.getState().handleSSEEvent;

    const wrappedHandler = (event: SSEEvent) => {
      const state = useBoardStore.getState();
      const taskId = 'taskId' in event.data ? event.data.taskId :
                      'id' in event.data ? event.data.id : null;
      const eventKey = taskId ? `${event.type}:${taskId}` : event.type;

      if (prevEventsRef.current.has(eventKey)) {
        originalHandler(event);
        return;
      }
      prevEventsRef.current.add(eventKey);

      const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
      const taskTitle = task?.title ?? 'Unknown task';

      const agentId = 'agentId' in event.data ? event.data.agentId : null;
      const agent = agentId ? state.agents.find((a) => a.id === agentId) : null;
      const agentName = agent?.name ?? 'Unknown agent';

      const reason = 'reason' in event.data ? String(event.data.reason) : '';
      const notificationEvents: Record<string, string> = {
        'task.claimed': `Agent ${agentName} claimed "${taskTitle}"`,
        'task.submitted': `Agent ${agentName} submitted "${taskTitle}" for review`,
        'task.approved': `Task "${taskTitle}" approved`,
        'task.rejected': `Task "${taskTitle}" rejected: ${reason}`,
        'task.failed': `Task "${taskTitle}" failed: ${reason}`,
        'task.completed': `Task "${taskTitle}" completed`,
        'task.released': `Task "${taskTitle}" released`,
      };

      if (notificationEvents[event.type] && taskId) {
        state.addNotification({
          type: event.type,
          taskId: taskId as string,
          taskTitle,
          agentName: agentName !== 'Unknown agent' ? agentName : undefined,
          message: notificationEvents[event.type],
          timestamp: new Date().toISOString(),
        });
      }

      switch (event.type) {
        case 'task.claimed':
          notify.info(`Agent ${agentName} claimed "${taskTitle}"`);
          break;
        case 'task.submitted':
          notify.info(`Agent ${agentName} submitted "${taskTitle}" for review`);
          break;
        case 'task.approved':
          notify.success(`Task "${taskTitle}" approved`);
          break;
        case 'task.rejected':
          notify.warning(`Task "${taskTitle}" rejected: ${event.data.reason}`);
          break;
        case 'task.failed':
          notify.error(`Task "${taskTitle}" failed: ${event.data.reason}`);
          break;
        case 'task.completed':
          notify.success(`Task "${taskTitle}" completed`);
          break;
        case 'task.released':
          notify.info(`Task "${taskTitle}" released`);
          break;
        case 'column.wip_limit_reached':
          notify.warning(`WIP limit (${event.data.limit}) reached for column`);
          break;
        case 'agent.status_changed':
          notify.info(`Agent ${agentName} is now ${event.data.status}`);
          break;
        case 'task.watcher_notify': {
          const token = localStorage.getItem('orcy_token');
          if (!token) break;
          try {
            const payload = JSON.parse(atob(token.split('.')[1])) as { sub: string };
            if (!event.data.watcherUserIds.includes(payload.sub)) break;
          } catch {
            break;
          }

          const actionLabel = event.data.eventType.replace('task.', '').replace('_', ' ');
          notify.info(`Watched task "${event.data.taskTitle}" was ${actionLabel}`);
          break;
        }
        case 'task.mentioned': {
          const token = localStorage.getItem('orcy_token');
          if (!token || event.data.mentionedType !== 'human') break;
          try {
            const payload = JSON.parse(atob(token.split('.')[1])) as { sub: string; username: string };
            if (payload.sub !== event.data.mentionedId) break;
          } catch {
            break;
          }

          const mentionedTask = state.tasks.find((t) => t.id === event.data.taskId);
          notify.info(`You were mentioned on "${mentionedTask?.title ?? 'a task'}"`);
          break;
        }
      }

      originalHandler(event);
    };

    useBoardStore.setState({ handleSSEEvent: wrappedHandler });

    return () => {
      useBoardStore.setState({ handleSSEEvent: originalHandler });
    };
  }, []);
}
