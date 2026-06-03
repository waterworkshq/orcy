import * as timeRepo from "../repositories/timeTracking.js";
import * as taskRepo from "../repositories/task.js";
import * as effortRepo from "../repositories/effortEntry.js";
import type { TaskTimeReport, TaskTimeRecord, HabitatMetrics } from "../models/index.js";

export function recordWork(
  taskId: string,
  agentId: string | undefined,
  minutesSpent: number,
  statusDuringWork: string,
): TaskTimeRecord {
  const record = timeRepo.createTimeRecord({
    taskId,
    agentId,
    minutesSpent,
    statusDuringWork,
  });

  timeRepo.updateTaskTimeMetrics(taskId);

  const task = taskRepo.getTaskById(taskId);
  if (task) {
    timeRepo.recalculateMissionMetrics(task.missionId);
  }

  return record;
}

export function getTaskTimeReport(taskId: string): TaskTimeReport | null {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return null;

  const history = timeRepo.getTimeRecordsByTask(taskId);

  return {
    taskId: task.id,
    estimatedMinutes: task.estimatedMinutes,
    actualMinutes: task.actualMinutes,
    cycleTimeMinutes: task.cycleTimeMinutes,
    leadTimeMinutes: task.leadTimeMinutes,
    estimationAccuracy: task.estimationAccuracy,
    heartbeatHistory: history,
  };
}

export function getHabitatMetrics(habitatId: string): HabitatMetrics {
  return timeRepo.getHabitatMetrics(habitatId);
}

export function calculateAndSetCompletionMetrics(taskId: string): void {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return;

  const now = new Date().toISOString();
  const created = new Date(task.createdAt).getTime();
  const completed = new Date(now).getTime();
  const cycleTimeMinutes = Math.round((completed - created) / 60000);
  let leadTimeMinutes: number | null = null;

  if (task.startedAt) {
    const started = new Date(task.startedAt).getTime();
    leadTimeMinutes = Math.round((completed - started) / 60000);
  }

  const effortMetrics = effortRepo.getPersistedEffortMetricsForTask(taskId, task.estimatedMinutes);

  taskRepo.updateTask(taskId, {
    actualMinutes: effortMetrics.actualMinutes,
    cycleTimeMinutes,
    leadTimeMinutes,
    estimationAccuracy: effortMetrics.estimationAccuracy,
    completedAt: now,
  });

  timeRepo.recalculateMissionMetrics(task.missionId);
}
