import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import { boardSendMessage, boardGetMessages } from './messaging.js';
import { MESSAGE_TYPES, MESSAGE_PRIORITIES } from './constants.js';

export const MESSAGE_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_habitat_message',
  description:
    'Message operations: send a message to another agent on the same board, or list messages addressed to the current agent',
  actions: ['send', 'get-messages'],
  sharedParams: {
    toAgentId: { type: 'string', description: 'The UUID of the recipient agent (action=send)' },
    toAgentName: { type: 'string', description: 'The name of the recipient agent — resolved to UUID automatically (action=send)' },
    boardId: { type: 'string', description: 'The UUID of the habitat context (action=send)' },
    taskId: { type: 'string', description: 'Optional task UUID to scope the message to (action=send, action=get-messages)' },
    subject: { type: 'string', description: 'Brief subject line for the message (action=send)' },
    body: { type: 'string', description: 'Full message body (action=send)' },
    messageType: { type: 'string', enum: [...MESSAGE_TYPES], description: 'Message type (action=send)' },
    priority: { type: 'string', enum: [...MESSAGE_PRIORITIES], description: 'Message priority (action=send)' },
    unreadOnly: { type: 'boolean', description: 'Only return unread messages (action=get-messages)' },
    limit: { type: 'number', description: 'Maximum number of messages to return (action=get-messages)' },
    offset: { type: 'number', description: 'Number of messages to skip for pagination (action=get-messages)' },
  },
});

export const MESSAGE_ACTIONS: Record<string, Handler> = {
  'send': boardSendMessage,
  'get-messages': boardGetMessages,
};

export const MESSAGE_DISPATCH_HANDLER = createDispatchHandler(MESSAGE_ACTIONS);
