import * as taskRepo from '../../repositories/task.js';
import * as featureRepo from '../../repositories/feature.js';
import * as eventRepo from '../../repositories/event.js';
import { sseBroadcaster } from '../../sse/broadcaster.js';
import * as watcherService from '../watcherService.js';
import * as autoAssignService from '../autoAssignService.js';
import * as pluginManager from '../../plugins/pluginManager.js';
import * as boardRepo from '../../repositories/board.js';
import * as featureService from '../featureService.js';
import * as subtaskRepo from '../../repositories/subtask.js';
import * as commentRepo from '../../repositories/comment.js';
import type { Task, TaskStatus } from '../../models/index.js';
import { formatClonedTitle } from './helpers.js';
import { logger } from '../../lib/logger.js';

export function createTask(input: { featureId: string; title: string; description?: string; priority?: import('../../models/index.js').TaskPriority; requiredDomain?: string | null; requiredCapabilities?: string[]; createdBy: string; order?: number; estimatedMinutes?: number | null }): Task {
  const task = taskRepo.createTask(input);

  const feature = featureRepo.getFeatureById(input.featureId);
  const boardId = feature?.boardId ?? '';

  eventRepo.createEvent({
    taskId: task.id,
    actorType: 'human',
    actorId: input.createdBy,
    action: 'created',
    toStatus: task.status,
    metadata: { title: task.title, featureId: input.featureId },
  });

  sseBroadcaster.publish(boardId, { type: 'task.created', data: task });

  if (boardId) {
    autoAssignService.assignTask(task.id, boardId);
    const board = boardRepo.getBoardById(boardId);
    pluginManager.emitTaskCreated(task, board).catch(() => {});
  }

  if (feature) {
    featureService.recalculateFeatureStatus(feature.id);
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
    featureId: source.featureId,
    title: clonedTitle,
    description: source.description,
    priority: source.priority,
    requiredDomain: source.requiredDomain,
    requiredCapabilities: source.requiredCapabilities,
    estimatedMinutes: source.estimatedMinutes,
    createdBy: clonedBy,
  });

  const feature = featureRepo.getFeatureById(source.featureId);
  const boardId = feature?.boardId ?? '';

  eventRepo.createEvent({
    taskId: cloned.id,
    actorType: 'human',
    actorId: clonedBy,
    action: 'cloned',
    toStatus: cloned.status,
    metadata: { sourceTaskId: taskId, sourceTitle: source.title },
  });

  sseBroadcaster.publish(boardId, {
    type: 'task.cloned',
    data: { sourceTaskId: taskId, clonedTask: cloned },
  });

  sseBroadcaster.publish(boardId, { type: 'task.created', data: cloned });

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

  if (feature) {
    featureService.recalculateFeatureStatus(feature.id);
  }

  return { success: true, task: cloned };
}

export function getTask(taskId: string): Task | null {
  return taskRepo.getTaskById(taskId);
}

export function getTasksByBoard(
  boardId: string,
  filters?: { status?: TaskStatus; search?: string; limit?: number; offset?: number }
): { tasks: Task[]; total: number } {
  return taskRepo.getTasksByBoardId(boardId, filters);
}

export function updateTask(
  taskId: string,
  input: Parameters<typeof taskRepo.updateTask>[1],
  editorId: string
): { success: true; task: Task } | { success: false; notFound?: true; versionMismatch?: true; currentVersion?: number; archived?: true } {
  const current = taskRepo.getTaskById(taskId);
  if (!current) return { success: false, notFound: true };

  const feature = featureRepo.getFeatureById(current.featureId);
  if (feature?.isArchived) return { success: false, archived: true };

  const { version, ...fields } = input as typeof input & { version?: number };
  const result = taskRepo.updateTask(taskId, fields, version);
  if (!result.success) return result;

  const task = result.task;
  const boardId = taskRepo.getBoardIdForTask(taskId) ?? '';

  eventRepo.createEvent({
    taskId,
    actorType: 'human',
    actorId: editorId,
    action: 'updated',
    metadata: { changedFields: Object.keys(fields) },
  });

  sseBroadcaster.publish(boardId, { type: 'task.updated', data: task });
  if (boardId) watcherService.notifyWatchers(taskId, boardId, 'task.updated');

  if ('status' in fields && fields.status !== undefined && fields.status !== current.status) {
    try {
      featureService.recalculateFeatureStatus(current.featureId);
    } catch (err) {
      logger.error({ err, featureId: current.featureId }, 'Feature recalculation failed');
    }
  }

  return { success: true, task };
}

export function deleteTask(taskId: string): { success: true } | { success: false; reason: 'not_found' | 'has_dependents' | 'archived'; dependentCount?: number } {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return { success: false, reason: 'not_found' };

  const feature = featureRepo.getFeatureById(task.featureId);
  if (feature?.isArchived) return { success: false, reason: 'archived' };

  const dependents = taskRepo.getTasksByDependency(taskId);
  if (dependents.length > 0) {
    return { success: false, reason: 'has_dependents', dependentCount: dependents.length };
  }

  const boardId = taskRepo.getBoardIdForTask(taskId) ?? '';
  const featureId = task.featureId;

  if (boardId) watcherService.notifyWatchers(taskId, boardId, 'task.deleted');
  taskRepo.deleteTask(taskId);

  sseBroadcaster.publish(boardId, { type: 'task.deleted', data: { taskId } });

  if (featureId) {
    featureService.recalculateFeatureStatus(featureId);
  }

  return { success: true };
}
