import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import { pulsePost, pulseCheck } from './pulse.js';

export const PULSE_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_pulse',
  description:
    'Mission Pulse operations: post structured signals (finding, blocker, offer, warning, ' +
    'question, answer, directive, context, handoff) to the mission pulse board, ' +
    'or check the pulse board for signals from mission partners. ' +
    'Use action="post" to share discoveries, report blockers (auto-creates clearance tasks), ' +
    'offer results, ask questions, or issue directives. Use action="check" to read signals ' +
    'filtered by mission or signal type. When no missionId is provided, returns your cross-mission inbox. ' +
    'Read the Pulse Skill Guide (orcy_pulse_instructions) for the full communication protocol.',
  actions: ['post', 'check'],
  sharedParams: {
    missionId: {
      type: 'string',
      description: 'Mission ID (required for post, optional for check)',
    },
    signalType: {
      type: 'string',
      enum: ['finding', 'blocker', 'offer', 'warning',
             'question', 'answer', 'directive', 'context', 'handoff'],
      description: 'Signal type (required for post, optional filter for check)',
    },
    subject: {
      type: 'string',
      description: 'Brief signal subject (action=post, required)',
    },
    body: {
      type: 'string',
      description: 'Full signal body with details (action=post)',
    },
    taskId: {
      type: 'string',
      description: 'Task this signal relates to (action=post)',
    },
    toAgentName: {
      type: 'string',
      description: 'Target agent name for directed signal (action=post)',
    },
    replyToId: {
      type: 'string',
      description: 'Pulse ID to reply to (action=post, for ANSWER signals)',
    },
    metadata: {
      type: 'object',
      description: 'Freeform metadata JSON (action=post)',
    },
    limit: {
      type: 'number',
      description: 'Max signals to return (action=check, default 20)',
    },
    offset: {
      type: 'number',
      description: 'Pagination offset (action=check)',
    },
  },
});

export const PULSE_ACTIONS: Record<string, Handler> = {
  'post': pulsePost,
  'check': pulseCheck,
};

export const PULSE_DISPATCH_HANDLER = createDispatchHandler(PULSE_ACTIONS);
