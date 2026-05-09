import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';

export const BOARD_LIST_WEBHOOKS_TOOL: Tool = {
  name: 'board_list_webhooks',
  description:
    'List all webhooks configured for a Kanban board. ' +
    'Returns webhook configurations including name, URL, subscribed events, and format.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Kanban board',
      },
    },
    required: ['boardId'],
  },
};

export async function boardListWebhooks(
  client: KanbanApiClient,
  args: { boardId: string }
) {
  const result = await client.listWebhooks(args.boardId);
  return { webhooks: result.webhooks };
}

export const BOARD_CREATE_WEBHOOK_TOOL: Tool = {
  name: 'board_create_webhook',
  description:
    'Create a new webhook for a Kanban board. ' +
    'The webhook will receive HTTP POST requests when specified events occur. ' +
    'Supports standard JSON, Slack, and Discord formats.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Kanban board',
      },
      name: {
        type: 'string',
        description: 'A descriptive name for the webhook',
      },
      url: {
        type: 'string',
        description: 'The URL to send webhook payloads to',
      },
      events: {
        type: 'array',
        items: { type: 'string' },
        description: 'Array of event types to subscribe to (e.g., ["task.created", "task.completed"])',
      },
      format: {
        type: 'string',
        enum: ['standard', 'slack', 'discord'],
        description: 'Webhook payload format (default: standard)',
      },
    },
    required: ['boardId', 'name', 'url', 'events'],
  },
};

export async function boardCreateWebhook(
  client: KanbanApiClient,
  args: { boardId: string; name: string; url: string; events: string[]; format?: 'standard' | 'slack' | 'discord' }
) {
  const result = await client.createWebhook(args.boardId, {
    name: args.name,
    url: args.url,
    events: args.events,
    format: args.format,
  });
  return { webhook: result.webhook };
}

export const BOARD_DELETE_WEBHOOK_TOOL: Tool = {
  name: 'board_delete_webhook',
  description:
    'Delete a webhook by its ID. ' +
    'The webhook will immediately stop receiving events. Deletion is permanent.',
  inputSchema: {
    type: 'object',
    properties: {
      webhookId: {
        type: 'string',
        description: 'The UUID of the webhook to delete',
      },
    },
    required: ['webhookId'],
  },
};

export async function boardDeleteWebhook(
  client: KanbanApiClient,
  args: { webhookId: string }
) {
  await client.deleteWebhook(args.webhookId);
  return { success: true };
}
