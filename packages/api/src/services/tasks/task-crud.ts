import * as taskRepo from "../../repositories/task.js";
import * as missionRepo from "../../repositories/mission.js";
import * as eventRepo from "../../repositories/event.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";
import * as watcherService from "../watcherService.js";
import * as autoAssignService from "../autoAssignService.js";
import * as missionService from "../missionService.js";
import * as subtaskRepo from "../../repositories/subtask.js";
import * as commentRepo from "../../repositories/comment.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import { InterceptorVetoError } from "../../errors.js";
import { getDb } from "../../db/index.js";
import { retireTaskCustodyWithClient, type CustodyActor } from "../governanceCustody.js";
import type { Task, TaskStatus } from "../../models/index.js";
import { formatClonedTitle } from "./helpers.js";
import { emitTransition } from "./transition-emitter.js";

/**
 * Creates a new {@link Task} in its mission, emits a `created` transition, and
 * triggers habitat auto-assignment and plugin hooks when possible.
 */
export function createTask(input: {
  missionId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: import("../../models/index.js").TaskPriority;
  requiredDomain?: string | null;
  requiredCapabilities?: string[];
  createdBy: string;
  order?: number;
  estimatedMinutes?: number | null;
}): Task {
  const mission = missionRepo.getMissionById(input.missionId);
  const habitatId = mission?.habitatId ?? "";

  // Pre-interceptor seam (ADR-0014): gates run BEFORE the task row is written.
  // No task exists yet, so the context carries only the prospective fields.
  // Always call — the runner's isEnrolled check handles empty habitatId.
  {
    const veto = pluginManager.runPreInterceptors(input.missionId, "taskCreated", habitatId, {
      actorType: "human",
      actorId: input.createdBy,
      newStatus: "pending",
      metadata: { title: input.title, missionId: input.missionId },
    });
    if (veto) throw new InterceptorVetoError(veto);
  }

  const task = taskRepo.createTask(input);

  emitTransition(task.id, "created", habitatId, {
    actorType: "human",
    actorId: input.createdBy,
    newStatus: task.status,
    metadata: { title: task.title, missionId: input.missionId },
    task,
  });

  // Post-interceptor seam (ADR-0014): fire-and-forget after the transition commits.
  pluginManager.runPostInterceptors(task.id, "taskCreated", habitatId, {
    actorType: "human",
    actorId: input.createdBy,
    newStatus: task.status,
    task,
  });

  if (habitatId) {
    autoAssignService.assignTask(task.id, habitatId);
  }

  return task;
}

/**
 * Clones an existing {@link Task} into a new task, optionally copying its
 * subtasks and comments, recalculating the parent mission status, and emitting
 * audit and SSE events for the clone.
 */
export function cloneTask(
  taskId: string,
  clonedBy: string,
  options?: { includeSubtasks?: boolean; includeComments?: boolean },
): { success: true; task: Task } | { success: false; reason: "not_found" } {
  const source = taskRepo.getTaskById(taskId);
  if (!source) return { success: false, reason: "not_found" };

  const clonedTitle = formatClonedTitle(source.title);

  const cloned = taskRepo.createTask({
    missionId: source.missionId,
    title: clonedTitle,
    description: source.description,
    priority: source.priority,
    requiredDomain: source.requiredDomain,
    requiredCapabilities: source.requiredCapabilities,
    estimatedMinutes: source.estimatedMinutes,
    createdBy: clonedBy,
  });

  const mission = missionRepo.getMissionById(source.missionId);
  const habitatId = mission?.habitatId ?? "";

  // cloneTask is a separate flow: the canonical 'cloned' event action is
  // specific to cloning (not in the TaskAction union), so we emit the audit
  // event directly while letting the SSE `task.cloned` + `task.created` fan out.
  eventRepo.createEvent({
    taskId: cloned.id,
    actorType: "human",
    actorId: clonedBy,
    action: "cloned",
    toStatus: cloned.status,
    metadata: { sourceTaskId: taskId, sourceTitle: source.title },
  });

  sseBroadcaster.publish(habitatId, {
    type: "task.cloned",
    data: { sourceTaskId: taskId, clonedTask: cloned },
  });

  sseBroadcaster.publish(habitatId, { type: "task.created", data: cloned });

  if (options?.includeSubtasks) {
    const subtasks = subtaskRepo.getSubtasksByTaskId(taskId);
    for (const subtask of subtasks) {
      subtaskRepo.createSubtask({
        taskId: cloned.id,
        title: subtask.title,
        order: subtask.order,
      });
    }
  }

  if (options?.includeComments) {
    const comments = commentRepo.getCommentsByTaskId(taskId, 200);
    for (const comment of comments.comments) {
      commentRepo.createComment({
        taskId: cloned.id,
        content: comment.content,
        authorType: comment.authorType,
        authorId: comment.authorId,
        parentId: null,
      });
    }
  }

  if (mission) {
    missionService.recalculateMissionStatus(mission.id);
  }

  return { success: true, task: cloned };
}

/**
 * Returns the {@link Task} with the given id, or `null` if it does not exist.
 */
export function getTask(taskId: string): Task | null {
  return taskRepo.getTaskById(taskId);
}

/**
 * Lists {@link Task}s in a habitat, optionally filtered by status, search term,
 * and pagination.
 */
export function getTasksByHabitat(
  habitatId: string,
  filters?: { status?: TaskStatus; search?: string; limit?: number; offset?: number },
): { tasks: Task[]; total: number } {
  return taskRepo.getTasksByHabitatId(habitatId, filters);
}

/**
 * Updates a {@link Task}'s fields with optional optimistic version checking and
 * emits an `updated` transition when successful.
 */
export function updateTask(
  taskId: string,
  input: Parameters<typeof taskRepo.updateTask>[1],
  editorId: string,
):
  | { success: true; task: Task }
  | {
      success: false;
      notFound?: true;
      versionMismatch?: true;
      currentVersion?: number;
      archived?: true;
    } {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return { success: false, notFound: true };

  const mission = missionRepo.getMissionById(current.missionId);
  if (mission?.isArchived) return { success: false, archived: true };

  const { version, ...fields } = input as typeof input & { version?: number };
  const result = taskRepo.updateTask(taskId, fields, version);
  if (!result.success) return result;

  const task = result.task;
  const habitatId = taskRepo.getHabitatIdForTask(taskId) ?? "";

  emitTransition(taskId, "updated", habitatId, {
    actorType: "human",
    actorId: editorId,
    oldStatus: current.status,
    newStatus:
      "status" in fields && fields.status !== undefined
        ? (fields.status as string)
        : current.status,
    changedFields: Object.keys(fields),
    metadata: { changedFields: Object.keys(fields) },
    task,
  });

  return { success: true, task };
}

/**
 * Deletes a {@link Task} after checking it has no dependents and is not in an
 * archived mission, notifying watchers and emitting a `deleted` transition.
 *
 * `actor`: the authenticated human/agent driving the delete; reaches the
 * custody-retirement audit. Omitted only for legacy internal callers with no
 * authenticated identity — the audit then records unknown attribution.
 */
export function deleteTask(taskId: string, actor?: CustodyActor):
  | { success: true }
  | {
      success: false;
      reason: "not_found" | "has_dependents" | "archived";
      dependentCount?: number;
    } {
  // Resolve the CANONICAL persisted id before every dependent check.
  // getTaskById normalizes `feat-` aliases, but the raw input used to flow
  // into the dependency query, custody retire, watcher notify, row delete
  // and the `deleted` transition. A caller spelling `feat-<id>` got a
  // normalized lookup that found the row (passing the not-found guard) and
  // then a delete of the LITERAL `feat-<id>` string — a no-op on the real
  // row, reported as a false 204. From here on, every write, check and
  // emission uses the resolved canonical `task.id`.
  const task = taskRepo.getTaskById(taskId);
  if (!task) return { success: false, reason: "not_found" };
  const canonicalTaskId = task.id;

  const mission = missionRepo.getMissionById(task.missionId);
  if (mission?.isArchived) return { success: false, reason: "archived" };

  const dependents = taskRepo.getTasksByDependency(canonicalTaskId);
  if (dependents.length > 0) {
    return { success: false, reason: "has_dependents", dependentCount: dependents.length };
  }

  const habitatId = mission?.habitatId ?? "";

  if (habitatId) watcherService.notifyWatchers(canonicalTaskId, habitatId, "task.deleted");
  // Governance custody (administration ticket): retire the Task ledger and
  // revoke its grants atomically with the row delete — one reservation.
  getDb().transaction(
    (tx) => {
      retireTaskCustodyWithClient(tx, canonicalTaskId, "task deleted", actor);
      taskRepo.deleteTask(canonicalTaskId);
    },
    { behavior: "immediate" },
  );

  emitTransition(canonicalTaskId, "deleted", habitatId, {
    actorType: "human",
    actorId: "system",
  });

  return { success: true };
}
