import * as taskRepo from "../../repositories/task.js";
import * as eventRepo from "../../repositories/event.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";
import type { Task, TaskStatus } from "../../models/index.js";

/** Updates a task's status and broadcasts the change, returning the updated task. */
export function moveTask(
  taskId: string,
  _columnId: string,
  _actorId: string,
  _actorType: "human" | "agent",
  status?: TaskStatus,
): Task | null {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return null;

  if (status) {
    const result = taskRepo.updateTask(taskId, { status });
    if (!result.success) return null;
    const habitatId = taskRepo.getHabitatIdForTask(taskId) ?? "";
    eventRepo.createEvent({
      taskId,
      actorType: _actorType,
      actorId: _actorId,
      action: "updated",
      metadata: { changedFields: ["status"], fromStatus: current.status, toStatus: status },
    });
    sseBroadcaster.publish(habitatId, { type: "task.updated", data: result.task });
    return result.task;
  }

  return current;
}

/** Returns the requested task without modifying its order. */
export function reorderTask(
  taskId: string,
  _columnId: string,
  _afterTaskId: string | null,
  _beforeTaskId: string | null,
): Task | null {
  return taskRepo.getTaskById(taskId);
}
