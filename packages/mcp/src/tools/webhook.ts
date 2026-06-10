import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { WebhookClient } from '../api/interfaces.js';

/**
 * @requires WebhookClient
 */
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

/**
 * @requires WebhookClient
 */
export async function habitatListWebhooks(
  client: WebhookClient,
  args: { boardId: string }
) {
  const result = await client.listWebhooks(args.boardId);
  return { webhooks: result.webhooks };
}

/**
 * @requires WebhookClient
 */
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

/**
 * @requires WebhookClient
 */
export async function habitatCreateWebhook(
  client: WebhookClient,
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

/**
 * @requires WebhookClient
 */
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

/**
 * @requires WebhookClient
 */
export async function habitatDeleteWebhook(
  client: WebhookClient,
  args: { webhookId: string }
) {
  await client.deleteWebhook(args.webhookId);
  return { success: true };
}
