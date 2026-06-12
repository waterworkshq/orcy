import type { DependencyValidationResult } from "../models/index.js";
import { logger } from "../lib/logger.js";
import * as dependencyRepo from "../repositories/dependency.js";

export function addTaskDependency(
  taskId: string,
  dependsOnId: string,
): { success: boolean; reason?: string } {
  if (taskId === dependsOnId) {
    return { success: false, reason: "self_dependency" };
  }

  if (dependencyRepo.wouldCreateTaskCycle(taskId, dependsOnId)) {
    return { success: false, reason: "circular_dependency" };
  }

  try {
    dependencyRepo.addTaskDependency(taskId, dependsOnId);
    return { success: true };
  } catch (err: any) {
    if (err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return { success: false, reason: "already_exists" };
    }
    logger.error({ err, taskId, dependsOnId }, "Unexpected DB error adding task dependency");
    throw err;
  }
}

export function removeTaskDependency(taskId: string, dependsOnId: string): boolean {
  try {
    dependencyRepo.removeTaskDependency(taskId, dependsOnId);
    return true;
  } catch (err) {
    logger.warn({ err, taskId, dependsOnId }, "Failed to remove task dependency");
    return false;
  }
}

export function getTaskDependencies(taskId: string): {
  dependsOn: { taskId: string; title: string; status: string; completedAt: string | null }[];
  blocking: { taskId: string; title: string; status: string }[];
} {
  return dependencyRepo.getTaskDependencies(taskId);
}

export function validateTaskCompletion(taskId: string): DependencyValidationResult {
  const deps = dependencyRepo.getTaskDependencyStatuses(taskId);

  const incompleteDeps = deps.filter((d) => d.status !== "done" && d.status !== "approved");

  if (incompleteDeps.length > 0) {
    return {
      canComplete: false,
      reason: "BLOCKED_BY_DEPENDENCIES",
      blockedBy: incompleteDeps.map((d) => ({
        taskId: d.taskId,
        title: d.title,
        status: d.status,
      })),
    };
  }

  return { canComplete: true };
}

export function addMissionDependency(
  missionId: string,
  dependsOnId: string,
): { success: boolean; reason?: string } {
  if (missionId === dependsOnId) {
    return { success: false, reason: "self_dependency" };
  }

  if (dependencyRepo.wouldCreateMissionCycle(missionId, dependsOnId)) {
    return { success: false, reason: "circular_dependency" };
  }

  try {
    dependencyRepo.addMissionDependency(missionId, dependsOnId);
    return { success: true };
  } catch (err: any) {
    if (err?.code === "SQLITE_CONSTRAINT_UNIQUE") {
      return { success: false, reason: "already_exists" };
    }
    logger.error({ err, missionId, dependsOnId }, "Unexpected DB error adding mission dependency");
    throw err;
  }
}

export function removeMissionDependency(missionId: string, dependsOnId: string): boolean {
  try {
    dependencyRepo.removeMissionDependency(missionId, dependsOnId);
    return true;
  } catch (err) {
    logger.warn({ err, missionId, dependsOnId }, "Failed to remove mission dependency");
    return false;
  }
}

export function getMissionDependencies(missionId: string): {
  dependsOn: { missionId: string; title: string; status: string }[];
  blocking: { missionId: string; title: string; status: string }[];
} {
  return dependencyRepo.getMissionDependencies(missionId);
}

export function validateMissionCompletion(missionId: string): DependencyValidationResult {
  const missionTasks = dependencyRepo.getMissionTasks(missionId);

  const incompleteTasks = missionTasks.filter(
    (t) => t.status !== "done" && t.status !== "approved",
  );
  if (incompleteTasks.length > 0) {
    return {
      canComplete: false,
      reason: "INCOMPLETE_TASKS",
      incompleteTasks: incompleteTasks.map((t) => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
      })),
    };
  }

  const deps = dependencyRepo.getMissionDependencyStatuses(missionId);

  const incompleteDeps = deps.filter((d) => d.status !== "done");
  if (incompleteDeps.length > 0) {
    return {
      canComplete: false,
      reason: "BLOCKED_BY_FEATURE_DEPENDENCIES",
      blockedBy: incompleteDeps.map((d) => ({
        taskId: d.missionId,
        title: d.title,
        status: d.status,
      })),
    };
  }

  return { canComplete: true };
}

export function getDependencyGraph(missionId: string): {
  nodes: { id: string; title: string; status: string }[];
  edges: { from: string; to: string }[];
} {
  return dependencyRepo.getDependencyGraph(missionId);
}
