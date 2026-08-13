import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { TaskClient } from '../api/interfaces.js';
import { PRIORITY_LEVELS } from './constants.js';

/**
 * @requires TaskClient
 */
export const BOARD_BATCH_ASSIGN_TASKS_TOOL: Tool = {
  name: 'board_batch_assign_tasks',
  description:
    'Batch-assign multiple tasks to a specific agent. ' +
    'Validates each task against the agent\'s domain and capabilities before assigning. ' +
    'Returns per-task results with success/failure status for each assignment.',
  inputSchema: {
    type: 'object',
    properties: {
      habitatId: {
        type: 'string',
        description: 'The UUID of the habitat containing the tasks',
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
    required: ['habitatId', 'taskIds', 'agentId'],
  },
};

/**
 * @requires TaskClient
 */
export const BOARD_BATCH_SET_TASK_PRIORITY_TOOL: Tool = {
  name: 'board_batch_set_task_priority',
  description:
    'Batch-update task priorities for multiple tasks. ' +
    'Validates priority is one of low/medium/high/critical. ' +
    'Returns per-task results with success/failure status for each update.',
  inputSchema: {
    type: 'object',
    properties: {
      habitatId: {
        type: 'string',
        description: 'The UUID of the habitat containing the tasks',
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
    required: ['habitatId', 'taskIds', 'priority'],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatBatchAssignTasks(
  client: TaskClient,
  args: { habitatId?: string; boardId?: string; taskIds: string[]; agentId: string }
) {
  const habitatId = args.habitatId ?? args.boardId ?? '';
  return client.batchAssignTasks(habitatId, args.taskIds, args.agentId);
}

/**
 * @requires TaskClient
 */
export async function habitatBatchSetTaskPriority(
  client: TaskClient,
  args: { habitatId?: string; boardId?: string; taskIds: string[]; priority: string }
) {
  const habitatId = args.habitatId ?? args.boardId ?? '';
  return client.batchSetTaskPriority(habitatId, args.taskIds, args.priority);
}

/**
 * @requires TaskClient
 */
export const BOARD_BATCH_DELETE_TASKS_TOOL: Tool = {
  name: 'board_batch_delete_tasks',
  description:
    'Batch-delete multiple tasks. ' +
    'Tasks with active dependencies cannot be deleted. ' +
    'Returns per-task results with success/failure status for each deletion.',
  inputSchema: {
    type: 'object',
    properties: {
      habitatId: {
        type: 'string',
        description: 'The UUID of the habitat containing the tasks',
      },
      taskIds: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        maxItems: 100,
        description: 'Array of task UUIDs to delete',
      },
    },
    required: ['habitatId', 'taskIds'],
  },
};

/**
 * @requires TaskClient
 */
export async function habitatBatchDeleteTasks(
  client: TaskClient,
  args: { habitatId?: string; boardId?: string; taskIds: string[] }
) {
  const habitatId = args.habitatId ?? args.boardId ?? '';
  return client.batchDeleteTasks(habitatId, args.taskIds);
}
