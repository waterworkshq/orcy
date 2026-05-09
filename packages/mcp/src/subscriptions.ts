import { logger } from './logger.js';
import type { KanbanApiClient } from './api.js';

interface Subscription {
  boardId: string;
  agentId: string;
  active: boolean;
  lastEventSeq: number;
  abortController: AbortController;
  pollTimer: ReturnType<typeof setInterval> | null;
}

interface MCPNotification {
  jsonrpc: '2.0';
  method: string;
  params: {
    type: string;
    data: unknown;
  };
}

type NotificationSender = (notification: MCPNotification) => void;

const subscriptions = new Map<string, Subscription>();

let notificationSender: NotificationSender | null = null;

export function setNotificationSender(sender: NotificationSender): void {
  notificationSender = sender;
}

export function subscribe(
  client: KanbanApiClient,
  boardId: string,
  agentId: string
): { success: boolean; message: string } {
  const key = `${agentId}:${boardId}`;

  const existing = subscriptions.get(key);
  if (existing) {
    return { success: true, message: `Already subscribed to board ${boardId}` };
  }

  const abortController = new AbortController();

  const subscription: Subscription = {
    boardId,
    agentId,
    active: true,
    lastEventSeq: 0,
    abortController,
    pollTimer: null,
  };

  subscriptions.set(key, subscription);

  startEventPolling(client, subscription);

  logger.info('subscription_created', { boardId, agentId });
  return { success: true, message: `Subscribed to events for board ${boardId}` };
}

export function unsubscribe(boardId: string, agentId: string): { success: boolean; message: string } {
  const key = `${agentId}:${boardId}`;
  const subscription = subscriptions.get(key);

  if (!subscription) {
    return { success: false, message: `Not subscribed to board ${boardId}` };
  }

  subscription.active = false;
  subscription.abortController.abort();

  if (subscription.pollTimer) {
    clearInterval(subscription.pollTimer);
  }

  subscriptions.delete(key);

  logger.info('subscription_removed', { boardId, agentId });
  return { success: true, message: `Unsubscribed from board ${boardId}` };
}

export function getSubscription(boardId: string, agentId: string): Subscription | undefined {
  return subscriptions.get(`${agentId}:${boardId}`);
}

export function getActiveSubscriptions(agentId: string): Subscription[] {
  const result: Subscription[] = [];
  for (const sub of subscriptions.values()) {
    if (sub.agentId === agentId && sub.active) {
      result.push(sub);
    }
  }
  return result;
}

export function cleanupAll(): void {
  for (const [key, sub] of subscriptions) {
    sub.active = false;
    sub.abortController.abort();
    if (sub.pollTimer) {
      clearInterval(sub.pollTimer);
    }
    subscriptions.delete(key);
  }
}

function startEventPolling(client: KanbanApiClient, subscription: Subscription): void {
  const poll = async () => {
    if (!subscription.active || !notificationSender) return;

    try {
      const sseUrl = `${client.getBaseUrl()}/sse/boards/${subscription.boardId}/stream`;
      const { apiKey } = getCredentials();

      const response = await fetch(sseUrl, {
        headers: {
          'Accept': 'text/event-stream',
          ...(apiKey ? { 'X-Agent-API-Key': apiKey } : {}),
        },
        signal: subscription.abortController.signal,
      });

      if (!response.ok) {
        logger.warn('sse_connect_failed', {
          boardId: subscription.boardId,
          status: response.status,
        });
        return;
      }

      const reader = response.body?.getReader();
      if (!reader) return;

      const decoder = new TextDecoder();
      let buffer = '';

      while (subscription.active) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.slice(6).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr);

              if (event.type === 'connected') continue;

              notificationSender!({
                jsonrpc: '2.0',
                method: 'notifications/event',
                params: {
                  type: event.type,
                  data: event.data,
                },
              });

              subscription.lastEventSeq++;
            } catch {
              logger.warn('sse_parse_error', { line: jsonStr.slice(0, 100) });
            }
          }
        }
      }

      reader.releaseLock();
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      logger.error('sse_poll_error', {
        boardId: subscription.boardId,
        error: (err as Error).message,
      });
    }
  };

  poll();

  subscription.pollTimer = setInterval(() => {
    if (subscription.active) {
      poll();
    }
  }, 30_000);
}

function getCredentials(): { apiKey: string; agentId: string } {
  return {
    apiKey: process.env.ORCY_API_KEY ?? '',
    agentId: process.env.ORCY_AGENT_ID ?? '',
  };
}
