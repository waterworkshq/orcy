import * as subtaskRepo from '../repositories/subtask.js';
import { getTaskById, getBoardIdForTask } from '../repositories/task.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import type { SSEEvent } from '../models/index.js';

/**
 * Get all subtasks for a task with completion stats.
 * @param taskId - ID of the parent task
 * @returns Subtask list with total and completedCount
 */
export function getSubtasks(taskId: string) {
  const subtasks = subtaskRepo.getSubtasksByTaskId(taskId);
  const total = subtasks.length;
  const completedCount = subtasks.filter(s => s.completed).length;
  return { subtasks, total, completedCount };
}

/**
 * Create a new subtask on a task.
 * @param taskId - ID of the parent task
 * @param input - Subtask title, optional order and assigneeId
 * @returns The created subtask, or null if parent task not found
 */
export function createSubtask(taskId: string, input: { title: string; order?: number; assigneeId?: string | null }) {
  const task = getTaskById(taskId);
  if (!task) return null;

  const subtask = subtaskRepo.createSubtask({ taskId, ...input });
  
  const boardId = getBoardIdForTask(taskId);
  if (boardId) {
    sseBroadcaster.publish(boardId, {
      type: 'subtask.created',
      data: { taskId, subtask },
    } as SSEEvent);
  }

  return subtask;
}

/**
 * Update a subtask's title, completion status, order, or assignee.
 * @param subtaskId - ID of the subtask to update
 * @param data - Fields to update
 * @returns The updated subtask, or null if not found
 */
export function updateSubtask(subtaskId: string, data: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null }) {
  const existing = subtaskRepo.getSubtaskById(subtaskId);
  if (!existing) return null;

  const updated = subtaskRepo.updateSubtask(subtaskId, data);
  if (!updated) return null;

  const task = getTaskById(existing.taskId);
  if (task) {
    const boardId = getBoardIdForTask(existing.taskId);
    if (boardId) {
      sseBroadcaster.publish(boardId, {
        type: 'subtask.updated',
        data: { taskId: existing.taskId, subtask: updated },
      } as SSEEvent);
    }
  }

  return updated;
}

/**
 * Delete a subtask.
 * @param subtaskId - ID of the subtask to delete
 * @returns True if deleted, false if not found
 */
export function deleteSubtask(subtaskId: string) {
  const existing = subtaskRepo.getSubtaskById(subtaskId);
  if (!existing) return false;

  const task = getTaskById(existing.taskId);
  subtaskRepo.deleteSubtask(subtaskId);

  if (task) {
    const boardId = getBoardIdForTask(existing.taskId);
    if (boardId) {
      sseBroadcaster.publish(boardId, {
        type: 'subtask.deleted',
        data: { taskId: existing.taskId, subtaskId },
      } as SSEEvent);
    }
  }

  return true;
}