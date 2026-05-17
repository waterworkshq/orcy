import { getDb } from '../db/index.js';
import { taskDependencies, missionDependencies, tasks, missions } from '../db/schema/index.js';
import { eq, and, notInArray, inArray } from 'drizzle-orm';
import type { DependencyValidationResult } from '../models/index.js';
import { logger } from '../lib/logger.js';

export function addTaskDependency(taskId: string, dependsOnId: string): { success: boolean; reason?: string } {
  if (taskId === dependsOnId) {
    return { success: false, reason: 'self_dependency' };
  }

  if (wouldCreateCycle(taskId, dependsOnId, 'task')) {
    return { success: false, reason: 'circular_dependency' };
  }

  const db = getDb();
  try {
    db.insert(taskDependencies).values({
      taskId,
      dependsOnId,
    }).run();
    return { success: true };
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { success: false, reason: 'already_exists' };
    }
    logger.error({ err, taskId, dependsOnId }, 'Unexpected DB error adding task dependency');
    throw err;
  }
}

export function removeTaskDependency(taskId: string, dependsOnId: string): boolean {
  const db = getDb();
  try {
    db.delete(taskDependencies)
      .where(and(eq(taskDependencies.taskId, taskId), eq(taskDependencies.dependsOnId, dependsOnId)))
      .run();
    return true;
  } catch (err) {
    logger.warn({ err, taskId, dependsOnId }, 'Failed to remove task dependency');
    return false;
  }
}

export function getTaskDependencies(taskId: string): {
  dependsOn: { taskId: string; title: string; status: string; completedAt: string | null }[];
  blocking: { taskId: string; title: string; status: string }[];
} {
  const db = getDb();

  const dependsOnRows = db.select({
    taskId: taskDependencies.dependsOnId,
    title: tasks.title,
    status: tasks.status,
    completedAt: tasks.completedAt,
  })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(eq(taskDependencies.taskId, taskId))
    .all();

  const blockingRows = db.select({
    taskId: taskDependencies.taskId,
    title: tasks.title,
    status: tasks.status,
  })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.taskId, tasks.id))
    .where(eq(taskDependencies.dependsOnId, taskId))
    .all();

  return {
    dependsOn: dependsOnRows,
    blocking: blockingRows,
  };
}

export function validateTaskCompletion(taskId: string): DependencyValidationResult {
  const db = getDb();

  const deps = db.select({
    taskId: taskDependencies.dependsOnId,
    title: tasks.title,
    status: tasks.status,
  })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(eq(taskDependencies.taskId, taskId))
    .all();

  const incompleteDeps = deps.filter(d =>
    d.status !== 'done' && d.status !== 'approved'
  );

  if (incompleteDeps.length > 0) {
    return {
      canComplete: false,
      reason: 'BLOCKED_BY_DEPENDENCIES',
      blockedBy: incompleteDeps.map(d => ({
        taskId: d.taskId,
        title: d.title,
        status: d.status,
      })),
    };
  }

  return { canComplete: true };
}

export function addMissionDependency(missionId: string, dependsOnId: string): { success: boolean; reason?: string } {
  if (missionId === dependsOnId) {
    return { success: false, reason: 'self_dependency' };
  }

  if (wouldCreateCycle(missionId, dependsOnId, 'mission')) {
    return { success: false, reason: 'circular_dependency' };
  }

  const db = getDb();
  try {
    db.insert(missionDependencies).values({
      missionId,
      dependsOnId,
    }).run();
    return { success: true };
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { success: false, reason: 'already_exists' };
    }
    logger.error({ err, missionId, dependsOnId }, 'Unexpected DB error adding mission dependency');
    throw err;
  }
}

export function removeMissionDependency(missionId: string, dependsOnId: string): boolean {
  const db = getDb();
  try {
    db.delete(missionDependencies)
      .where(and(eq(missionDependencies.missionId, missionId), eq(missionDependencies.dependsOnId, dependsOnId)))
      .run();
    return true;
  } catch (err) {
    logger.warn({ err, missionId, dependsOnId }, 'Failed to remove mission dependency');
    return false;
  }
}

export function getMissionDependencies(missionId: string): {
  dependsOn: { missionId: string; title: string; status: string }[];
  blocking: { missionId: string; title: string; status: string }[];
} {
  const db = getDb();

  const dependsOnRows = db.select({
    missionId: missionDependencies.dependsOnId,
    title: missions.title,
    status: missions.status,
  })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.dependsOnId, missions.id))
    .where(eq(missionDependencies.missionId, missionId))
    .all();

  const blockingRows = db.select({
    missionId: missionDependencies.missionId,
    title: missions.title,
    status: missions.status,
  })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.missionId, missions.id))
    .where(eq(missionDependencies.dependsOnId, missionId))
    .all();

  return {
    dependsOn: dependsOnRows,
    blocking: blockingRows,
  };
}

export function validateMissionCompletion(missionId: string): DependencyValidationResult {
  const db = getDb();

  const missionTasks = db.select().from(tasks)
    .where(eq(tasks.missionId, missionId))
    .all();

  const incompleteTasks = missionTasks.filter(t => t.status !== 'done' && t.status !== 'approved');
  if (incompleteTasks.length > 0) {
    return {
      canComplete: false,
      reason: 'INCOMPLETE_TASKS',
      incompleteTasks: incompleteTasks.map(t => ({
        taskId: t.id,
        title: t.title,
        status: t.status,
      })),
    };
  }

  const deps = db.select({
    missionId: missionDependencies.dependsOnId,
    title: missions.title,
    status: missions.status,
  })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.dependsOnId, missions.id))
    .where(eq(missionDependencies.missionId, missionId))
    .all();

  const incompleteDeps = deps.filter(d => d.status !== 'done');
  if (incompleteDeps.length > 0) {
    return {
      canComplete: false,
      reason: 'BLOCKED_BY_FEATURE_DEPENDENCIES',
      blockedBy: incompleteDeps.map(d => ({
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
  const db = getDb();
  const nodes: { id: string; title: string; status: string }[] = [];
  const edges: { from: string; to: string }[] = [];
  const visited = new Set<string>();

  function traverse(fid: string) {
    if (visited.has(fid)) return;
    visited.add(fid);

    const mission = db.select().from(missions).where(eq(missions.id, fid)).get();
    if (!mission) return;
    nodes.push({ id: mission.id, title: mission.title, status: mission.status });

    const deps = db.select({ dependsOnId: missionDependencies.dependsOnId })
      .from(missionDependencies)
      .where(eq(missionDependencies.missionId, fid))
      .all();

    for (const dep of deps) {
      edges.push({ from: fid, to: dep.dependsOnId });
      traverse(dep.dependsOnId);
    }
  }

  traverse(missionId);
  return { nodes, edges };
}

function wouldCreateCycle(fromId: string, toId: string, type: 'task' | 'mission'): boolean {
  const db = getDb();
  const visited = new Set<string>();
  const stack = [toId];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === fromId) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    if (type === 'task') {
      const deps = db.select({ dependsOnId: taskDependencies.dependsOnId })
        .from(taskDependencies)
        .where(eq(taskDependencies.taskId, current))
        .all();
      for (const dep of deps) {
        stack.push(dep.dependsOnId);
      }
    } else {
      const deps = db.select({ dependsOnId: missionDependencies.dependsOnId })
        .from(missionDependencies)
        .where(eq(missionDependencies.missionId, current))
        .all();
      for (const dep of deps) {
        stack.push(dep.dependsOnId);
      }
    }
  }

  return false;
}
