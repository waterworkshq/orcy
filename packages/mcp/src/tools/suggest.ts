import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import { getCurrentAgentId } from './agent-id.js';

export const BOARD_SUGGEST_NEXT_TASK_TOOL: Tool = {
  name: 'board_suggest_next_task',
  description:
    'Recommend the next task for the calling agent based on skills, current board state, ' +
    'resolved dependencies, and priority weighting. Uses multi-factor scoring: base smart score ' +
    '(priority + urgency + age + capability match), dependency bonus, workload balancing, ' +
    'specialization bonus, and stale pickup detection. Returns top N suggestions with scores and reasoning.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the Kanban board',
      },
      limit: {
        type: 'number',
        description: 'Maximum number of suggestions to return (default: 3, max: 20)',
        minimum: 1,
        maximum: 20,
      },
    },
    required: ['boardId'],
  },
};

export async function boardSuggestNextTask(
  client: KanbanApiClient,
  args: { boardId: string; limit?: number }
) {
  return client.getSuggestions(getCurrentAgentId(), args.boardId, args.limit ?? 3);
}
