import * as taskRepo from '../../repositories/task.js';
import * as missionRepo from '../../repositories/mission.js';
import * as eventRepo from '../../repositories/event.js';
import { sseBroadcaster } from '../../sse/broadcaster.js';
import * as watcherService from '../watcherService.js';
import * as autoAssignService from '../autoAssignService.js';
import * as pluginManager from '../../plugins/pluginManager.js';
import * as missionService from '../missionService.js';
import * as subtaskRepo from '../../repositories/subtask.js';
import * as commentRepo from '../../repositories/comment.js';
import type { Task, TaskStatus } from '../../models/index.js';
import { formatClonedTitle } from './helpers.js';
import { logger } from '../../lib/logger.js';

export function createTask(input: { missionId: string; title: string; description?: string; labels?: string[]; priority?: import('../../models/index.js').TaskPriority; requiredDomain?: string | null; requiredCapabilities?: string[]; createdBy: string; order?: number; estimatedMinutes?: number | null }): Task {
  const task = taskRepo.createTask(input);

  const mission = missionRepo.getMissionById(input.missionId);
  const habitatId = mission?.habitatId ?? '';

  eventRepo.createEvent({
    taskId: task.id,
    actorType: 'human',
    actorId: input.createdBy,
    action: 'created',
    toStatus: task.status,
    metadata: { title: task.title, missionId: input.missionId },
  });

  sseBroadcaster.publish(habitatId, { type: 'task.created', data: task });

  if (habitatId) {
    autoAssignService.assignTask(task.id, habitatId);
    pluginManager.emitTaskCreated(task, habitatId).catch(() => {});
  }

  if (mission) {
    missionService.recalculateMissionStatus(mission.id);
  }

  return task;
}

export function cloneTask(
  taskId: string,
  clonedBy: string,
  options?: { includeSubtasks?: boolean; includeComments?: boolean }
): { success: true; task: Task } | { success: false; reason: 'not_found' } {
  const source = taskRepo.getTaskById(taskId);
  if (!source) return { success: false, reason: 'not_found' };

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
  const habitatId = mission?.habitatId ?? '';

  eventRepo.createEvent({
    taskId: cloned.id,
    actorType: 'human',
    actorId: clonedBy,
    action: 'cloned',
    toStatus: cloned.status,
    metadata: { sourceTaskId: taskId, sourceTitle: source.title },
  });

  sseBroadcaster.publish(habitatId, {
    type: 'task.cloned',
    data: { sourceTaskId: taskId, clonedTask: cloned },
  });

  sseBroadcaster.publish(habitatId, { type: 'task.created', data: cloned });

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

export function getTask(taskId: string): Task | null {
  return taskRepo.getTaskById(taskId);
}

export function getTasksByHabitat(
  habitatId: string,
  filters?: { status?: TaskStatus; search?: string; limit?: number; offset?: number }
): { tasks: Task[]; total: number } {
  return taskRepo.getTasksByHabitatId(habitatId, filters);
}

export function updateTask(
  taskId: string,
  input: Parameters<typeof taskRepo.updateTask>[1],
  editorId: string
): { success: true; task: Task } | { success: false; notFound?: true; versionMismatch?: true; currentVersion?: number; archived?: true } {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return { success: false, notFound: true };

  const mission = missionRepo.getMissionById(current.missionId);
  if (mission?.isArchived) return { success: false, archived: true };

  const { version, ...fields } = input as typeof input & { version?: number };
  const result = taskRepo.updateTask(taskId, fields, version);
  if (!result.success) return result;

  const task = result.task;
  const habitatId = taskRepo.getHabitatIdForTask(taskId) ?? '';

  eventRepo.createEvent({
    taskId,
    actorType: 'human',
    actorId: editorId,
    action: 'updated',
    metadata: { changedFields: Object.keys(fields) },
  });

  sseBroadcaster.publish(habitatId, { type: 'task.updated', data: task });
  if (habitatId) watcherService.notifyWatchers(taskId, habitatId, 'task.updated');

  if ('status' in fields && fields.status !== undefined && fields.status !== current.status) {
    try {
      missionService.recalculateMissionStatus(current.missionId);
    } catch (err) {
      logger.error({ err, missionId: current.missionId }, 'Mission recalculation failed');
    }
  }

  return { success: true, task };
}

export function deleteTask(taskId: string): { success: true } | { success: false; reason: 'not_found' | 'has_dependents' | 'archived'; dependentCount?: number } {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return { success: false, reason: 'not_found' };

  const mission = missionRepo.getMissionById(task.missionId);
  if (mission?.isArchived) return { success: false, reason: 'archived' };

  const dependents = taskRepo.getTasksByDependency(taskId);
  if (dependents.length > 0) {
    return { success: false, reason: 'has_dependents', dependentCount: dependents.length };
  }

  const habitatId = taskRepo.getHabitatIdForTask(taskId) ?? '';
  const missionId = task.missionId;

  if (habitatId) watcherService.notifyWatchers(taskId, habitatId, 'task.deleted');
  taskRepo.deleteTask(taskId);

  sseBroadcaster.publish(habitatId, { type: 'task.deleted', data: { taskId } });

  if (missionId) {
    missionService.recalculateMissionStatus(missionId);
  }

  return { success: true };
}