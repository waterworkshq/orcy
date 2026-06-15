import * as watcherRepo from "../repositories/watcher.js";
import * as taskRepo from "../repositories/task.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { TaskWatcher } from "../models/index.js";
import { notFound } from "../errors.js";

/**
 * Subscribe a user to task notifications.
 * @param taskId - ID of the task to watch
 * @param userId - ID of the user who wants to watch
 * @returns The created TaskWatcher record
 */
export function watchTask(taskId: string, userId: string): TaskWatcher {
  const task = taskRepo.getTaskById(taskId);
  if (!task) throw notFound("Task not found");

  return watcherRepo.addWatcher(taskId, userId);
}

/**
 * Unsubscribe a user from task notifications.
 * @param taskId - ID of the task to stop watching
 * @param userId - ID of the user to remove
 * @returns True if removed, false otherwise
 */
export function unwatchTask(taskId: string, userId: string): boolean {
  return watcherRepo.removeWatcher(taskId, userId);
}

/**
 * Check if a user is watching a task.
 * @param taskId - ID of the task
 * @param userId - ID of the user
 * @returns True if the user is watching the task
 */
export function isWatching(taskId: string, userId: string): boolean {
  return watcherRepo.isWatching(taskId, userId);
}

/**
 * Get all watchers for a task.
 * @param taskId - ID of the task
 * @returns Array of TaskWatcher records
 */
export function getWatchers(taskId: string): TaskWatcher[] {
  return watcherRepo.getWatchersForTask(taskId);
}

/**
 * Notify all watchers of a task event via SSE.
 * @param taskId - ID of the task
 * @param habitatId - ID of the habitat (for SSE broadcast scope)
 * @param eventType - Type of event (e.g., 'task.created')
 */
export function notifyWatchers(taskId: string, habitatId: string, eventType: string): void {
  const watcherUserIds = watcherRepo.getWatcherUserIdsForTask(taskId);
  if (watcherUserIds.length === 0) return;

  const task = taskRepo.getTaskById(taskId);
  const taskTitle = task?.title ?? "Unknown task";

  sseBroadcaster.publish(habitatId, {
    type: "task.watcher_notify",
    data: {
      taskId,
      taskTitle,
      eventType,
      watcherUserIds,
      habitatId,
    },
  });
}
