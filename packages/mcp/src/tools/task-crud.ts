import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import type { KanbanApiClient } from '../api.js';
import { enrichTaskWithAgentName } from './enrichment.js';
import { PRIORITY_LEVELS, TASK_UPDATE_STATUSES } from './constants.js';

export const BOARD_UPDATE_TASK_TOOL: Tool = {
  name: 'board_update_task',
  description:
    'Update a task\'s fields, transition its status, or manage subtasks. ' +
    'NOTE: These operations are mutually exclusive in a single call — if status is set, any field updates or subtask operations are ignored. Use separate calls for combined changes. ' +
    'FIELDS: Update title, description, priority, or estimated time. ' +
    'STATUS: Set status="in_progress" after claiming. "submitted" to submit for review (provide result). "approved" to approve a submitted task. "done" to mark an approved task as done. "failed" when the task cannot be completed (provide failureReason). ' +
    'SUBTASKS: Provide subtaskId to update/delete a specific subtask. ' +
    'set subtaskCompleted=true/false to toggle completion, subtaskTitle to rename, ' +
    'subtaskAssigneeId to reassign, subtaskOrder to reorder. ' +
    'deleteSubtask=true to delete a subtask. ' +
    'Supports optimistic locking — include version from your last read to prevent lost updates.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task to update',
      },
      title: {
        type: 'string',
        description: 'Updated task title (clear, actionable imperative)',
        minLength: 1,
        maxLength: 200,
      },
      description: {
        type: 'string',
        description: 'Updated detailed description',
        maxLength: 5000,
      },
      priority: {
        type: 'string',
        enum: [...PRIORITY_LEVELS],
        description: 'Updated priority',
      },
      requiredDomain: {
        type: 'string',
        description: 'Required agent domain (e.g., frontend, backend, devops)',
      },
      requiredCapabilities: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required agent capabilities (e.g., ["typescript", "react"])',
      },
      version: {
        type: 'number',
        description: 'Expected version for optimistic locking. If the task has been modified since you last read it, the update will fail.',
      },
      estimatedMinutes: {
        type: 'number',
        description: 'Optional estimated time to complete the task in minutes',
      },
      status: {
        type: 'string',
        enum: [...TASK_UPDATE_STATUSES],
        description: 'Transition task status. Use "in_progress" after claiming. "submitted" to submit work for review. "approved" to approve a submitted task. "done" to mark an approved task as done. "failed" when the task cannot be completed.',
      },
      failureReason: {
        type: 'string',
        description: 'Required when status="failed". Describes why the task could not be completed.',
      },
      result: {
        type: 'string',
        description: 'Summary of what was accomplished. Used with status="submitted".',
      },
      reviewNote: {
        type: 'string',
        description: 'Review note when status="done".',
      },
      subtaskId: {
        type: 'string',
        description: 'Operate on a specific subtask (required for subtask updates)',
      },
      subtaskTitle: {
        type: 'string',
        description: 'Rename a subtask',
      },
      subtaskCompleted: {
        type: 'boolean',
        description: 'Mark a subtask as completed (true) or reopen it (false)',
      },
      subtaskOrder: {
        type: 'number',
        description: 'Change a subtask\'s sort order',
      },
      subtaskAssigneeId: {
        type: 'string',
        description: 'Reassign a subtask to a different agent (provide agent UUID)',
      },
      deleteSubtask: {
        type: 'boolean',
        description: 'Set true to permanently delete a subtask (requires subtaskId)',
      },
    },
    required: ['taskId'],
  },
};

export async function habitatUpdateTask(
  client: KanbanApiClient,
  args: {
    taskId: string;
    title?: string;
    description?: string;
    priority?: 'low' | 'medium' | 'high' | 'critical';
    requiredDomain?: string | null;
    requiredCapabilities?: string[];
    version?: number;
    estimatedMinutes?: number;
    status?: 'in_progress' | 'submitted' | 'approved' | 'done' | 'failed';
    failureReason?: string;
    result?: string;
    reviewNote?: string;
    subtaskId?: string;
    subtaskTitle?: string;
    subtaskCompleted?: boolean;
    subtaskOrder?: number;
    subtaskAssigneeId?: string;
    deleteSubtask?: boolean;
  }
) {
  const STATUS_HANDLERS: Record<string, () => Promise<{ success: true; task?: any } | { success: true }>> = {
    in_progress: async () => {
      const result = await client.startTask(args.taskId);
      const enrichedTask = await enrichTaskWithAgentName(client, result.task);
      return { success: true, task: enrichedTask };
    },
    submitted: async () => {
      await client.submitTask(args.taskId, args.result ?? '', []);
      return { success: true };
    },
    approved: async () => {
      const result = await client.updateTaskStatus(args.taskId, 'approved');
      const enrichedTask = await enrichTaskWithAgentName(client, result.task);
      return { success: true, task: enrichedTask };
    },
    done: async () => {
      await client.completeTask(args.taskId, args.reviewNote, []);
      return { success: true };
    },
    failed: async () => {
      const result = await client.failTask(args.taskId, args.failureReason ?? 'Task failed');
      const enrichedTask = await enrichTaskWithAgentName(client, result.task);
      return { success: true, task: enrichedTask };
    },
  };

  if (args.status && STATUS_HANDLERS[args.status]) {
    return STATUS_HANDLERS[args.status]();
  }

  if (args.subtaskId) {
    if (args.deleteSubtask) {
      await client.deleteSubtask(args.taskId, args.subtaskId);
    } else {
      await client.updateSubtask(args.taskId, args.subtaskId, {
        title: args.subtaskTitle,
        completed: args.subtaskCompleted,
        order: args.subtaskOrder,
        assigneeId: args.subtaskAssigneeId,
      });
    }
  }

  const hasTaskLevelFields = args.title !== undefined || args.description !== undefined || args.priority !== undefined || args.requiredDomain !== undefined || (args.requiredCapabilities !== undefined && args.requiredCapabilities.length > 0) || args.estimatedMinutes !== undefined || args.version !== undefined;

  if (!hasTaskLevelFields && args.subtaskId) {
    return { success: true };
  }

  const result = await client.updateTask(args.taskId, {
    title: args.title,
    description: args.description,
    priority: args.priority,
    requiredDomain: args.requiredDomain,
    requiredCapabilities: args.requiredCapabilities,
    version: args.version,
    estimatedMinutes: args.estimatedMinutes,
  });
  const enrichedTask = await enrichTaskWithAgentName(client, result.task);
  return { success: true, task: enrichedTask };
}

export const BOARD_DELETE_TASK_TOOL: Tool = {
  name: 'board_delete_task',
  description:
    'Delete a task from a feature. Only tasks with no dependents (no other tasks depend on this one) can be deleted. ' +
    'This action is permanent and cannot be undone. Use with caution.',
  inputSchema: {
    type: 'object',
    properties: {
      taskId: {
        type: 'string',
        description: 'The UUID of the task to delete',
      },
    },
    required: ['taskId'],
  },
};

export async function habitatDeleteTask(
  client: KanbanApiClient,
  args: { taskId: string }
) {
  await client.deleteTask(args.taskId);
  return { success: true, taskId: args.taskId, message: `Task ${args.taskId} deleted` };
}
