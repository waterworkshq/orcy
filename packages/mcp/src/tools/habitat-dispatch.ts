import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import { habitatListHabitats, habitatFind, habitatGetSettings, habitatUpdateSettings, habitatGetSummary } from './habitat.js';
import { habitatGetMetrics } from './lifecycle-gaps.js';

export const HABITAT_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_habitat',
  description: 'Board-level operations: list, find, get-settings, update-settings, summary, metrics',
  actions: ['list', 'find', 'get-settings', 'update-settings', 'summary', 'metrics'],
  sharedParams: {
    boardId: { type: 'string', description: 'The UUID of the Orcy habitat' },
    name: { type: 'string', description: 'Habitat name or partial name to search for (used with action=find)' },
    since: {
      type: 'string',
      enum: ['24h', '7d', '30d', 'all'],
      description: 'Time range for activity summary (action=summary)',
    },
    maxTasks: { type: 'number', description: 'Maximum number of task narratives to return (action=summary)' },
    includeDigest: { type: 'boolean', description: 'Whether to include markdown digest (action=summary)' },
    description: { type: 'string', description: 'Updated habitat description (action=update-settings)' },
  },
});

export const HABITAT_ACTIONS: Record<string, Handler> = {
  'list': habitatListHabitats,
  'find': habitatFind,
  'get-settings': habitatGetSettings,
  'update-settings': habitatUpdateSettings,
  'summary': habitatGetSummary,
  'metrics': habitatGetMetrics,
};

export const HABITAT_DISPATCH_HANDLER = createDispatchHandler(HABITAT_ACTIONS);
