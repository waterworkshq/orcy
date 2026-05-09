import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import { PRIORITY_LEVELS } from './constants.js';

export const BOARD_BATCH_ASSIGN_TASKS_TOOL: Tool = {
  name: 'board_batch_assign_tasks',
  description:
    'Batch-assign multiple tasks to a specific agent. ' +
    'Validates each task against the agent\'s domain and capabilities before assigning. ' +
    'Returns per-task results with success/failure status for each assignment.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the board containing the tasks',
      },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 100,
        description: 'Array of task UUIDs to assign',
      },
      agentId: {
        type: 'string',
        description: 'The UUID of the agent to assign the tasks to',
      },
    },
    required: ['boardId', 'taskIds', 'agentId'],
  },
};

export const BOARD_BATCH_SET_TASK_PRIORITY_TOOL: Tool = {
  name: 'board_batch_set_task_priority',
  description:
    'Batch-update task priorities for multiple tasks. ' +
    'Validates priority is one of low/medium/high/critical. ' +
    'Returns per-task results with success/failure status for each update.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the board containing the tasks',
      },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 100,
        description: 'Array of task UUIDs to update',
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'New priority level for the tasks',
      },
    },
    required: ['boardId', 'taskIds', 'priority'],
  },
};

export async function boardBatchAssignTasks(
  client: KanbanApiClient,
  args: { boardId: string; taskIds: string[]; agentId: string }
) {
  return client.batchAssignTasks(args.boardId, args.taskIds, args.agentId);
}

export async function boardBatchSetTaskPriority(
  client: KanbanApiClient,
  args: { boardId: string; taskIds: string[]; priority: string }
) {
  return client.batchSetTaskPriority(args.boardId, args.taskIds, args.priority);
}

export const BOARD_BATCH_DELETE_TASKS_TOOL: Tool = {
  name: 'board_batch_delete_tasks',
  description:
    'Batch-delete multiple tasks. ' +
    'Tasks with active dependencies cannot be deleted. ' +
    'Returns per-task results with success/failure status for each deletion.',
  inputSchema: {
    type: 'object',
    properties: {
      boardId: {
        type: 'string',
        description: 'The UUID of the board containing the tasks',
      },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 100,
        description: 'Array of task UUIDs to delete',
      },
    },
    required: ['boardId', 'taskIds'],
  },
};

export async function boardBatchDeleteTasks(
  client: KanbanApiClient,
  args: { boardId: string; taskIds: string[] }
) {
  return client.batchDeleteTasks(args.boardId, args.taskIds);
}
