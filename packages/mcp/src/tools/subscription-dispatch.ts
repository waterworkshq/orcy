import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import { habitatSubscribe, habitatUnsubscribe } from './subscription.js';

export const SUBSCRIPTION_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_habitat_subscription',
  description:
    'Subscription operations: subscribe to real-time board events via MCP notifications, or unsubscribe to stop receiving events',
  actions: ['subscribe', 'unsubscribe'],
  sharedParams: {
    boardId: { type: 'string', description: 'The UUID of the Orcy habitat to subscribe to or unsubscribe from' },
  },
});

export const SUBSCRIPTION_ACTIONS: Record<string, Handler> = {
  'subscribe': habitatSubscribe,
  'unsubscribe': habitatUnsubscribe,
};

export const SUBSCRIPTION_DISPATCH_HANDLER = createDispatchHandler(SUBSCRIPTION_ACTIONS);
