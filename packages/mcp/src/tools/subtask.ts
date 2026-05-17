import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';

export const BOARD_LIST_SUBTASKS_TOOL: Tool = {
  name: 'board_list_task_subtasks',
  description:
    'List all subtasks for a given task. ' +
    'Returns subtasks with their completion status, order, and assignee. ' +
    'Use this to understand the breakdown of work for a task before claiming it. ' +
    'Each subtask can be independently completed by calling board_update_task with subtaskId and subtaskCompleted=true.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the parent task',
      },
    },
    required: ['taskId'],
  },
};

export async function habitatListTaskSubtasks(
  client: KanbanApiClient,
  args: { taskId: string }
) {
  return client.listSubtasks(args.taskId);
}

export const BOARD_CREATE_SUBTASK_TOOL: Tool = {
  name: 'board_create_task_subtask',
  description:
    'Create a new subtask under a parent task. ' +
    'Use this to break down complex tasks into smaller, independent units of work. ' +
    'Subtasks inherit the parent task\'s board and can be completed in any order. ' +
    'After creating, use board_update_task with subtaskId and subtaskCompleted=true to mark completion.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the parent task to add a subtask to',
      },
      title: {
        type: 'string',
        description: 'The subtask title — be specific about what needs to be done (max 200 chars)',
      },
      order: {
        type: 'number',
        description: 'Optional sort order within the parent task (default: append to end)',
      },
      assigneeId: {
        type: 'string',
        description: 'Optional UUID of an agent to assign this subtask to',
      },
    },
    required: ['taskId', 'title'],
  },
};

export async function habitatCreateTaskSubtask(
  client: KanbanApiClient,
  args: { taskId: string; title: string; order?: number; assigneeId?: string }
) {
  return client.createSubtask(args.taskId, {
    title: args.title,
    order: args.order,
    assigneeId: args.assigneeId,
  });
}

export const BOARD_DELETE_SUBTASK_TOOL: Tool = {
  name: 'board_delete_task_subtask',
  description:
    'Delete a subtask from its parent task. ' +
    'Use this when a subtask is no longer relevant or was created in error. ' +
    'Deletion is permanent. Consider marking it completed=false instead if the work may be needed later.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the parent task',
      },
      subtaskId: {
        type: 'string',
        description: 'The UUID of the subtask to delete',
      },
    },
    required: ['taskId', 'subtaskId'],
  },
};

export async function habitatDeleteTaskSubtask(
  client: KanbanApiClient,
  args: { taskId: string; subtaskId: string }
) {
  await client.deleteSubtask(args.taskId, args.subtaskId);
  return { success: true };
}
