import * as missionRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as columnRepo from '../repositories/column.js';
import * as eventRepo from '../repositories/event.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import type { Mission, MissionStatus, Task, TaskPriority } from '../models/index.js';

export interface CreateMissionInput {
  habitatId: string;
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

export interface MissionWithProgress extends Mission {
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

export function deriveMissionStatus(missionId: string): MissionStatus {
  const tasks = taskRepo.getTasksByMissionId(missionId);

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

export function resolveTargetColumn(habitatId: string, status: MissionStatus): string | null {
  const boardColumns = columnRepo.getColumnsByHabitatId(habitatId);
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

export function autoAdvanceMissionColumn(mission: Mission, newStatus: MissionStatus): Mission | null {
  if (newStatus === 'failed') return mission;

  const targetColumnId = resolveTargetColumn(mission.habitatId, newStatus);
  if (!targetColumnId || targetColumnId === mission.columnId) return mission;

  const fromColumnId = mission.columnId;
  const updated = missionRepo.moveMission(mission.id, targetColumnId);
  if (!updated) return mission;

  eventRepo.createMissionEvent({
    missionId: mission.id,
    actorType: 'system',
    actorId: 'status-engine',
    action: 'moved',
    fromColumnId,
    toColumnId: targetColumnId,
    metadata: { reason: 'auto_advance', derivedStatus: newStatus },
  });

  sseBroadcaster.publish(mission.habitatId, {
    type: 'mission.moved',
    data: { missionId: mission.id, fromColumnId, toColumnId: targetColumnId },
  });

  return updated;
}

export function recalculateMissionStatus(missionId: string): { mission: Mission; statusChanged: boolean; columnChanged: boolean } | null {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return null;

  const oldStatus = mission.status;
  const newStatus = deriveMissionStatus(missionId);

  let statusChanged = oldStatus !== newStatus;
  let columnChanged = false;

  if (statusChanged) {
    missionRepo.updateMission(missionId, { status: newStatus });

    eventRepo.createMissionEvent({
      missionId,
      actorType: 'system',
      actorId: 'status-engine',
      action: 'status_changed',
      fromStatus: oldStatus,
      toStatus: newStatus,
      metadata: { reason: 'task_state_change' },
    });

    sseBroadcaster.publish(mission.habitatId, {
      type: 'mission.status_changed',
      data: { missionId, fromStatus: oldStatus, toStatus: newStatus },
    });
  }

  const updatedMission = missionRepo.getMissionById(missionId)!;

  const movedMission = autoAdvanceMissionColumn(updatedMission, newStatus);
  if (movedMission && movedMission.columnId !== mission.columnId) {
    columnChanged = true;
  }

  const finalMission = missionRepo.getMissionById(missionId)!;

  const tasks = taskRepo.getTasksByMissionId(missionId);
  const doneCount = tasks.filter(t => ['done', 'approved'].includes(t.status)).length;
  sseBroadcaster.publish(mission.habitatId, {
    type: 'mission.progress',
    data: { missionId, completed: doneCount, total: tasks.length },
  });

  return { mission: finalMission, statusChanged, columnChanged };
}

export function createMission(input: CreateMissionInput): Mission {
  const mission = missionRepo.createMission(input);

  eventRepo.createMissionEvent({
    missionId: mission.id,
    actorType: 'human',
    actorId: input.createdBy,
    action: 'created',
    metadata: { title: mission.title },
  });

  sseBroadcaster.publish(mission.habitatId, { type: 'mission.created', data: mission });

  return mission;
}

export function updateMission(
  missionId: string,
  input: Parameters<typeof missionRepo.updateMission>[1] & { version?: number },
  editorId: string
): { success: true; mission: Mission } | { success: false; notFound?: true; versionMismatch?: true; currentVersion?: number; archived?: true } {
  const current = missionRepo.getMissionById(missionId);
  if (!current) return { success: false, notFound: true };
  if (current.isArchived) return { success: false, archived: true };

  const { version, ...updateFields } = input;
  const result = missionRepo.updateMission(missionId, updateFields, version);
  if (!result.success) return result;

  eventRepo.createMissionEvent({
    missionId,
    actorType: 'human',
    actorId: editorId,
    action: 'updated',
    metadata: { changedFields: Object.keys(input) },
  });

  sseBroadcaster.publish(result.mission.habitatId, { type: 'mission.updated', data: result.mission });

  return result;
}

export function deleteMission(missionId: string): { success: true } | { success: false; reason: string } {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return { success: false, reason: 'not_found' };

  const dependents = missionRepo.getMissionsByDependency(missionId);
  if (dependents.length > 0) {
    return { success: false, reason: 'has_dependents' };
  }

  missionRepo.deleteMission(missionId);
  sseBroadcaster.publish(mission.habitatId, { type: 'mission.deleted', data: { missionId } });

  return { success: true };
}

export function moveMissionToColumn(missionId: string, toColumnId: string, actorId: string, actorType: 'human' | 'agent' = 'human'): Mission | null {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return null;

  const fromColumnId = mission.columnId;
  const updated = missionRepo.moveMission(missionId, toColumnId);
  if (!updated) return null;

  eventRepo.createMissionEvent({
    missionId,
    actorType,
    actorId,
    action: 'moved',
    fromColumnId,
    toColumnId,
  });

  sseBroadcaster.publish(mission.habitatId, {
    type: 'mission.moved',
    data: { missionId, fromColumnId, toColumnId },
  });
  sseBroadcaster.publish(mission.habitatId, { type: 'mission.updated', data: updated });

  return updated;
}

export function getMission(missionId: string): Mission | null {
  return missionRepo.getMissionById(missionId);
}

function computeProgress(taskList: Task[]): MissionWithProgress['progress'] {
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

export function getMissionWithProgress(missionId: string): MissionWithProgress | null {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return null;

  const tasks = taskRepo.getTasksByMissionId(missionId);
  return { ...mission, progress: computeProgress(tasks) };
}

export function listMissions(habitatId: string, filters?: Parameters<typeof missionRepo.getMissionsByHabitatId>[1]): { missions: MissionWithProgress[]; total: number } {
  const actualFilters = { ...filters };
  if (actualFilters.isArchived === undefined) {
    actualFilters.isArchived = false;
  }
  const { missions: rawMissions, total } = missionRepo.getMissionsByHabitatId(habitatId, actualFilters);

  const missionIds = rawMissions.map(f => f.id);
  const allTasks = taskRepo.getTasksByMissionIds(missionIds);

  const tasksByMission = new Map<string, Task[]>();
  for (const task of allTasks) {
    const list = tasksByMission.get(task.missionId) || [];
    list.push(task);
    tasksByMission.set(task.missionId, list);
  }

  const missionsWithProgress: MissionWithProgress[] = rawMissions.map(mission => ({
    ...mission,
    progress: computeProgress(tasksByMission.get(mission.id) || []),
  }));

  return { missions: missionsWithProgress, total };
}

export function archiveMission(missionId: string, actorId: string): { success: true; mission: Mission } | { success: false; reason: string } {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return { success: false, reason: 'not_found' };
  if (mission.status !== 'done') return { success: false, reason: 'not_done' };
  if (mission.isArchived) return { success: false, reason: 'already_archived' };

  const result = missionRepo.updateMission(missionId, { isArchived: true });
  if (!result.success) return { success: false, reason: 'update_failed' };

  eventRepo.createMissionEvent({
    missionId,
    actorType: 'human',
    actorId,
    action: 'updated',
    metadata: { reason: 'archived' },
  });

  sseBroadcaster.publish(mission.habitatId, { type: 'mission.updated', data: result.mission });
  return { success: true, mission: result.mission };
}

export function unarchiveMission(missionId: string, actorId: string): { success: true; mission: Mission } | { success: false; reason: string } {
  const mission = missionRepo.getMissionById(missionId);
  if (!mission) return { success: false, reason: 'not_found' };
  if (!mission.isArchived) return { success: false, reason: 'not_archived' };

  const result = missionRepo.updateMission(missionId, { isArchived: false });
  if (!result.success) return { success: false, reason: 'update_failed' };

  eventRepo.createMissionEvent({
    missionId,
    actorType: 'human',
    actorId,
    action: 'updated',
    metadata: { reason: 'unarchived' },
  });

  sseBroadcaster.publish(mission.habitatId, { type: 'mission.updated', data: result.mission });
  return { success: true, mission: result.mission };
}
