import * as subtaskRepo from "../repositories/subtask.js";
import { getTaskById, getHabitatIdForTask } from "../repositories/task.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { SSEEvent } from "../models/index.js";

/**
 * Get all subtasks for a task with completion stats.
 * @param taskId - ID of the parent task
 * @returns Subtask list with total and completedCount
 */
export function getSubtasks(taskId: string) {
  const subtasks = subtaskRepo.getSubtasksByTaskId(taskId);
  const total = subtasks.length;
  const completedCount = subtasks.filter((s) => s.completed).length;
  return { subtasks, total, completedCount };
}

/**
 * Create a new subtask on a task.
 * @param taskId - ID of the parent task
 * @param input - Subtask title, optional order and assigneeId
 * @returns The created subtask, or null if parent task not found
 */
export function createSubtask(
  taskId: string,
  input: { title: string; order?: number; assigneeId?: string | null },
) {
  const task = getTaskById(taskId);
  if (!task) return null;

  const subtask = subtaskRepo.createSubtask({ taskId, ...input });

  const habitatId = getHabitatIdForTask(taskId);
  if (habitatId) {
    sseBroadcaster.publish(habitatId, {
      type: "subtask.created",
      data: { taskId, subtask },
    } as SSEEvent);
  }

  return subtask;
}

/**
 * Update a subtask's title, completion status, order, or assignee — only
 * under its required parent Task.
 * @param taskId - ID of the required parent task (the URL parent on HTTP)
 * @param subtaskId - ID of the subtask to update
 * @param data - Fields to update
 * @returns The updated subtask, or null when the child is absent or belongs
 *   to a different Task (indistinguishable); no mutation or SSE then.
 */
export function updateSubtask(
  taskId: string,
  subtaskId: string,
  data: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null },
) {
  const existing = subtaskRepo.getSubtaskById(subtaskId);
  if (!existing || existing.taskId !== taskId) return null;

  const updated = subtaskRepo.updateSubtask(taskId, subtaskId, data);
  if (!updated) return null;

  // The event's parent derives from the matched row's actual taskId — never
  // from body fields or the pre-read alone.
  const habitatId = getHabitatIdForTask(updated.taskId);
  if (habitatId) {
    sseBroadcaster.publish(habitatId, {
      type: "subtask.updated",
      data: { taskId: updated.taskId, subtask: updated },
    } as SSEEvent);
  }

  return updated;
}

/**
 * Delete a subtask — only under its required parent Task.
 * @param taskId - ID of the required parent task (the URL parent on HTTP)
 * @param subtaskId - ID of the subtask to delete
 * @returns True when the exact (taskId, subtaskId) pair matched and was
 *   deleted; false when the child is absent, belongs to a different Task,
 *   or the final statement matched no row. No SSE unless matched.
 */
export function deleteSubtask(taskId: string, subtaskId: string) {
  const existing = subtaskRepo.getSubtaskById(subtaskId);
  if (!existing || existing.taskId !== taskId) return false;

  const matched = subtaskRepo.deleteSubtask(taskId, subtaskId);
  if (!matched) return false;

  // The pre-read's confirmed parent equals the SQL-required parent Task.
  const habitatId = getHabitatIdForTask(taskId);
  if (habitatId) {
    sseBroadcaster.publish(habitatId, {
      type: "subtask.deleted",
      data: { taskId, subtaskId },
    } as SSEEvent);
  }

  return true;
}
