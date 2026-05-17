import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import { getCurrentAgentId } from './agent-id.js';

export const BOARD_SUBSCRIBE_TOOL: Tool = {
  name: 'board_subscribe',
  description:
    'Subscribe to real-time board events via MCP notifications. ' +
    'After subscribing, the MCP server will push notifications/event messages to the client ' +
    'for any changes on the board (task created, updated, claimed, submitted, etc.). ' +
    'Use board_unsubscribe to stop receiving events.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Kanban board to subscribe to',
      },
    },
    required: ['boardId'],
  },
};

export async function habitatSubscribe(
  client: KanbanApiClient,
  args: { boardId: string }
) {
  const agentId = getCurrentAgentId();
  if (!agentId) {
    throw new Error('ORCY_AGENT_ID not configured');
  }
  const { subscribe } = await import('../subscriptions.js');
  return subscribe(client, args.boardId, agentId);
}

export const BOARD_UNSUBSCRIBE_TOOL: Tool = {
  name: 'board_unsubscribe',
  description:
    'Unsubscribe from real-time board events. ' +
    'Stops the MCP server from pushing notifications for the specified board.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Kanban board to unsubscribe from',
      },
    },
    required: ['boardId'],
  },
};

export async function habitatUnsubscribe(
  _client: KanbanApiClient,
  args: { boardId: string }
) {
  const agentId = getCurrentAgentId();
  if (!agentId) {
    throw new Error('ORCY_AGENT_ID not configured');
  }
  const { unsubscribe } = await import('../subscriptions.js');
  return unsubscribe(args.boardId, agentId);
}
