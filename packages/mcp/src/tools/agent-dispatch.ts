import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import { boardRegisterAgent, boardListAgents, boardHeartbeat, boardGetMyStats } from './agent.js';
import { AGENT_TYPES, AGENT_STATUSES } from './constants.js';

export const AGENT_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_habitat_agent',
  description: 'Agent operations: register, list, heartbeat, get-stats',
  actions: ['register', 'list', 'heartbeat', 'get-stats'],
  sharedParams: {
    name: { type: 'string', description: 'Unique name for the agent (used with action=register)' },
    type: {
      type: 'string',
      enum: [...AGENT_TYPES],
      description: 'The type of AI agent (action=register)',
    },
    domain: { type: 'string', description: 'Primary domain (action=register)' },
    capabilities: { type: 'string', description: 'Comma-separated capabilities (action=register)' },
    status: {
      type: 'string',
      enum: [...AGENT_STATUSES],
      description: 'Filter by agent status (action=list)',
    },
    domainFilter: { type: 'string', description: 'Filter by agent domain (action=list)' },
    taskId: { type: 'string', description: 'The UUID of the task for heartbeat tracking (action=heartbeat)' },
    progress: { type: 'string', description: 'Brief description of current progress (action=heartbeat)' },
  },
});

export const AGENT_ACTIONS: Record<string, Handler> = {
  'register': boardRegisterAgent,
  'list': boardListAgents,
  'heartbeat': boardHeartbeat,
  'get-stats': boardGetMyStats,
};

export const AGENT_DISPATCH_HANDLER = createDispatchHandler(AGENT_ACTIONS);
