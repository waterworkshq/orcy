import type { MessageClient } from "../api/interfaces.js";
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import type { Agent } from '@orcy/shared';
import { enrichMessagesWithFromAgentNames } from './enrichment.js';
import { MESSAGE_TYPES, MESSAGE_PRIORITIES } from './constants.js';

export const BOARD_SEND_MESSAGE_TOOL: Tool = {
  name: 'board_send_message',
  description:
    'Send a message from the current agent to another agent on the same board. ' +
    'Use this for coordinated multi-agent workflows — e.g., notify another agent that a dependency is resolved, ' +
    'request help, or share information. Messages can optionally be scoped to a specific task.',
  inputSchema: {
    type: 'object',
    properties: {
      toAgentId: {
        type: 'string',
        description: 'The UUID of the recipient agent',
      },
      toAgentName: {
        type: 'string',
        description: 'The name of the recipient agent (required if toAgentId not provided — will be resolved automatically)',
      },
      boardId: {
        type: 'string',
        description: 'The UUID of the board context for this message',
      },
      taskId: {
        type: 'string',
        description: 'Optional task UUID to scope the message to a specific task',
      },
      subject: {
        type: 'string',
        description: 'Brief subject line for the message',
      },
      body: {
        type: 'string',
        description: 'Full message body',
      },
      messageType: {
        type: 'string',
        enum: [...MESSAGE_TYPES],
        description: 'Message type (default: info)',
      },
      priority: {
        type: 'string',
        enum: [...MESSAGE_PRIORITIES],
        description: 'Message priority (default: normal)',
      },
    },
    required: ['boardId', 'subject', 'body'],
  },
};

export async function habitatSendMessage(
  client: KanbanApiClient,
  args: { toAgentId?: string; toAgentName?: string; boardId: string; taskId?: string; subject: string; body: string; messageType?: 'info' | 'request' | 'response' | 'alert'; priority?: 'low' | 'normal' | 'high' | 'urgent' }
) {
  let toAgentId = args.toAgentId;

  if (!toAgentId && args.toAgentName) {
    const agentsResp = await client.listAgents();
    const agents = Array.isArray(agentsResp.agents)
      ? agentsResp.agents as Agent[]
      : (agentsResp.agents as { agent: Agent }[]).map(a => a.agent);
    const found = agents.find(a => a.name === args.toAgentName);
    if (!found) {
      throw new Error(`Agent with name "${args.toAgentName}" not found`);
    }
    toAgentId = found.id;
  }

  if (!toAgentId) {
    throw new Error('Either toAgentId or toAgentName must be provided');
  }

  return client.sendMessage(toAgentId, {
    boardId: args.boardId,
    taskId: args.taskId,
    subject: args.subject,
    body: args.body,
    messageType: args.messageType,
    priority: args.priority,
  });
}

export const BOARD_GET_MESSAGES_TOOL: Tool = {
  name: 'board_get_messages',
  description:
    'List messages addressed to the current agent. ' +
    'Optionally filter for unread only, or scope to a specific task. ' +
    'Returns messages sorted newest first with an unread count.',
  inputSchema: {
    type: 'object',
    properties: {
      unreadOnly: {
        type: 'boolean',
        description: 'Only return unread messages (default: false)',
      },
      taskId: {
        type: 'string',
        description: 'Filter messages scoped to a specific task',
      },
      limit: {
        type: 'number',
        description: 'Maximum messages to return (default: 50)',
      },
      offset: {
        type: 'number',
        description: 'Number of messages to skip (for pagination)',
      },
    },
  },
};

export async function habitatGetMessages(
  client: KanbanApiClient,
  args: { unreadOnly?: boolean; taskId?: string; limit?: number; offset?: number }
) {
  const result = await client.getMessages({
    unreadOnly: args.unreadOnly,
    taskId: args.taskId,
    limit: args.limit,
    offset: args.offset,
  });

  const enrichedMessages = await enrichMessagesWithFromAgentNames(client, result.messages);
  return { messages: enrichedMessages, total: result.total, unreadCount: result.unreadCount };
}
