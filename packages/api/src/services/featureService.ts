import * as featureRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as columnRepo from '../repositories/column.js';
import * as eventRepo from '../repositories/event.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import type { Feature, FeatureStatus, Task, TaskPriority } from '../models/index.js';

export interface CreateFeatureInput {
  boardId: string;
  columnId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: TaskPriority;
  labels?: string[];
  dependsOn?: string[];
  blocks?: string[];
  dueAt?: string | null;
  slaMinutes?: number | null;
  createdBy: string;
}

export interface FeatureWithProgress extends Feature {
  progress: {
    total: number;
    pending: number;
    claimed: number;
    inProgress: number;
    submitted: number;
    approved: number;
    done: number;
    failed: number;
    rejected: number;
  };
}

export function deriveFeatureStatus(featureId: string): FeatureStatus {
  const tasks = taskRepo.getTasksByFeatureId(featureId);

  if (tasks.length === 0) return 'not_started';

  const statuses = tasks.map(t => t.status);

  const activeStatuses = ['pending', 'claimed', 'in_progress', 'rejected'];

  if (statuses.every(s => s === 'done' || s === 'approved') && statuses.some(s => s === 'done')) {
    return 'done';
  }

  if (statuses.every(s => s === 'submitted' || s === 'approved' || s === 'done')) {
    return 'review';
  }

  if (statuses.some(s => s === 'failed') && !statuses.some(s => ['claimed', 'in_progress', 'submitted'].includes(s))) {
    return 'failed';
  }

  const nonPendingStatuses = ['claimed', 'in_progress', 'submitted', 'approved', 'done', 'failed', 'rejected'];
  if (statuses.some(s => nonPendingStatuses.includes(s))) {
    return 'in_progress';
  }

  return 'not_started';
}

export function resolveTargetColumn(boardId: string, status: FeatureStatus): string | null {
  const boardColumns = columnRepo.getColumnsByBoardId(boardId);
  if (boardColumns.length === 0) return null;

  const nonTerminal = boardColumns.filter(c => !c.isTerminal);
  const terminal = boardColumns.find(c => c.isTerminal);

  switch (status) {
    case 'not_started':
      return boardColumns[0]?.id ?? null;
    case 'in_progress':
      if (nonTerminal.length < 2) return null;
      return boardColumns[1]?.id ?? null;
    case 'review':
      if (nonTerminal.length < 3) return null;
      return nonTerminal[nonTerminal.length - 1]?.id ?? null;
    case 'done':
      return terminal?.id ?? boardColumns[boardColumns.length - 1]?.id ?? null;
    case 'failed':
      return null;
    default:
      return null;
  }
}

export function autoAdvanceFeatureColumn(feature: Feature, newStatus: FeatureStatus): Feature | null {
  if (newStatus === 'failed') return feature;

  const targetColumnId = resolveTargetColumn(feature.boardId, newStatus);
  if (!targetColumnId || targetColumnId === feature.columnId) return feature;

  const fromColumnId = feature.columnId;
  const updated = featureRepo.moveFeature(feature.id, targetColumnId);
  if (!updated) return feature;

  eventRepo.createFeatureEvent({
    featureId: feature.id,
    actorType: 'system',
    actorId: 'status-engine',
    action: 'moved',
    fromColumnId,
    toColumnId: targetColumnId,
    metadata: { reason: 'auto_advance', derivedStatus: newStatus },
  });

  sseBroadcaster.publish(feature.boardId, {
    type: 'feature.moved',
    data: { featureId: feature.id, fromColumnId, toColumnId: targetColumnId },
  });

  return updated;
}

export function recalculateFeatureStatus(featureId: string): { feature: Feature; statusChanged: boolean; columnChanged: boolean } | null {
  const feature = featureRepo.getFeatureById(featureId);
  if (!feature) return null;

  const oldStatus = feature.status;
  const newStatus = deriveFeatureStatus(featureId);

  let statusChanged = oldStatus !== newStatus;
  let columnChanged = false;

  if (statusChanged) {
    featureRepo.updateFeature(featureId, { status: newStatus });

    eventRepo.createFeatureEvent({
      featureId,
      actorType: 'system',
      actorId: 'status-engine',
      action: 'status_changed',
      fromStatus: oldStatus,
      toStatus: newStatus,
      metadata: { reason: 'task_state_change' },
    });

    sseBroadcaster.publish(feature.boardId, {
      type: 'feature.status_changed',
      data: { featureId, fromStatus: oldStatus, toStatus: newStatus },
    });
  }

  const updatedFeature = featureRepo.getFeatureById(featureId)!;

  const movedFeature = autoAdvanceFeatureColumn(updatedFeature, newStatus);
  if (movedFeature && movedFeature.columnId !== feature.columnId) {
    columnChanged = true;
  }

  const finalFeature = featureRepo.getFeatureById(featureId)!;

  const tasks = taskRepo.getTasksByFeatureId(featureId);
  const doneCount = tasks.filter(t => ['done', 'approved'].includes(t.status)).length;
  sseBroadcaster.publish(feature.boardId, {
    type: 'feature.progress',
    data: { featureId, completed: doneCount, total: tasks.length },
  });

  return { feature: finalFeature, statusChanged, columnChanged };
}

export function createFeature(input: CreateFeatureInput): Feature {
  const feature = featureRepo.createFeature(input);

  eventRepo.createFeatureEvent({
    featureId: feature.id,
    actorType: 'human',
    actorId: input.createdBy,
    action: 'created',
    metadata: { title: feature.title },
  });

  sseBroadcaster.publish(feature.boardId, { type: 'feature.created', data: feature });

  return feature;
}

export function updateFeature(
  featureId: string,
  input: Parameters<typeof featureRepo.updateFeature>[1] & { version?: number },
  editorId: string
): { success: true; feature: Feature } | { success: false; notFound?: true; versionMismatch?: true; currentVersion?: number; archived?: true } {
  const current = featureRepo.getFeatureById(featureId);
  if (!current) return { success: false, notFound: true };
  if (current.isArchived) return { success: false, archived: true };

  const { version, ...updateFields } = input;
  const result = featureRepo.updateFeature(featureId, updateFields, version);
  if (!result.success) return result;

  eventRepo.createFeatureEvent({
    featureId,
    actorType: 'human',
    actorId: editorId,
    action: 'updated',
    metadata: { changedFields: Object.keys(input) },
  });

  sseBroadcaster.publish(result.feature.boardId, { type: 'feature.updated', data: result.feature });

  return result;
}

export function deleteFeature(featureId: string): { success: true } | { success: false; reason: string } {
  const feature = featureRepo.getFeatureById(featureId);
  if (!feature) return { success: false, reason: 'not_found' };

  const dependents = featureRepo.getFeaturesByDependency(featureId);
  if (dependents.length > 0) {
    return { success: false, reason: 'has_dependents' };
  }

  featureRepo.deleteFeature(featureId);
  sseBroadcaster.publish(feature.boardId, { type: 'feature.deleted', data: { featureId } });

  return { success: true };
}

export function moveFeatureToColumn(featureId: string, toColumnId: string, actorId: string, actorType: 'human' | 'agent' = 'human'): Feature | null {
  const feature = featureRepo.getFeatureById(featureId);
  if (!feature) return null;

  const fromColumnId = feature.columnId;
  const updated = featureRepo.moveFeature(featureId, toColumnId);
  if (!updated) return null;

  eventRepo.createFeatureEvent({
    featureId,
    actorType,
    actorId,
    action: 'moved',
    fromColumnId,
    toColumnId,
  });

  sseBroadcaster.publish(feature.boardId, {
    type: 'feature.moved',
    data: { featureId, fromColumnId, toColumnId },
  });
  sseBroadcaster.publish(feature.boardId, { type: 'feature.updated', data: updated });

  return updated;
}

export function getFeature(featureId: string): Feature | null {
  return featureRepo.getFeatureById(featureId);
}

function computeProgress(taskList: Task[]): FeatureWithProgress['progress'] {
  return {
    total: taskList.length,
    pending: taskList.filter(t => t.status === 'pending').length,
    claimed: taskList.filter(t => t.status === 'claimed').length,
    inProgress: taskList.filter(t => t.status === 'in_progress').length,
    submitted: taskList.filter(t => t.status === 'submitted').length,
    approved: taskList.filter(t => t.status === 'approved').length,
    done: taskList.filter(t => t.status === 'done').length,
    failed: taskList.filter(t => t.status === 'failed').length,
    rejected: taskList.filter(t => t.status === 'rejected').length,
  };
}

export function getFeatureWithProgress(featureId: string): FeatureWithProgress | null {
  const feature = featureRepo.getFeatureById(featureId);
  if (!feature) return null;

  const tasks = taskRepo.getTasksByFeatureId(featureId);
  return { ...feature, progress: computeProgress(tasks) };
}

export function listFeatures(boardId: string, filters?: Parameters<typeof featureRepo.getFeaturesByBoardId>[1]): { features: FeatureWithProgress[]; total: number } {
  const actualFilters = { ...filters };
  if (actualFilters.isArchived === undefined) {
    actualFilters.isArchived = false;
  }
  const { features: rawFeatures, total } = featureRepo.getFeaturesByBoardId(boardId, actualFilters);

  const featureIds = rawFeatures.map(f => f.id);
  const allTasks = taskRepo.getTasksByFeatureIds(featureIds);

  const tasksByFeature = new Map<string, Task[]>();
  for (const task of allTasks) {
    const list = tasksByFeature.get(task.featureId) || [];
    list.push(task);
    tasksByFeature.set(task.featureId, list);
  }

  const featuresWithProgress: FeatureWithProgress[] = rawFeatures.map(feature => ({
    ...feature,
    progress: computeProgress(tasksByFeature.get(feature.id) || []),
  }));

  return { features: featuresWithProgress, total };
}

export function archiveFeature(featureId: string, actorId: string): { success: true; feature: Feature } | { success: false; reason: string } {
  const feature = featureRepo.getFeatureById(featureId);
  if (!feature) return { success: false, reason: 'not_found' };
  if (feature.status !== 'done') return { success: false, reason: 'not_done' };
  if (feature.isArchived) return { success: false, reason: 'already_archived' };

  const result = featureRepo.updateFeature(featureId, { isArchived: true });
  if (!result.success) return { success: false, reason: 'update_failed' };

  eventRepo.createFeatureEvent({
    featureId,
    actorType: 'human',
    actorId,
    action: 'updated',
    metadata: { reason: 'archived' },
  });

  sseBroadcaster.publish(feature.boardId, { type: 'feature.updated', data: result.feature });
  return { success: true, feature: result.feature };
}

export function unarchiveFeature(featureId: string, actorId: string): { success: true; feature: Feature } | { success: false; reason: string } {
  const feature = featureRepo.getFeatureById(featureId);
  if (!feature) return { success: false, reason: 'not_found' };
  if (!feature.isArchived) return { success: false, reason: 'not_archived' };

  const result = featureRepo.updateFeature(featureId, { isArchived: false });
  if (!result.success) return { success: false, reason: 'update_failed' };

  eventRepo.createFeatureEvent({
    featureId,
    actorType: 'human',
    actorId,
    action: 'updated',
    metadata: { reason: 'unarchived' },
  });

  sseBroadcaster.publish(feature.boardId, { type: 'feature.updated', data: result.feature });
  return { success: true, feature: result.feature };
}
