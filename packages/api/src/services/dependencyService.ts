import { getDb } from '../db/index.js';
import { taskDependencies, featureDependencies, tasks, features } from '../db/schema.js';
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

export function addFeatureDependency(featureId: string, dependsOnId: string): { success: boolean; reason?: string } {
  if (featureId === dependsOnId) {
    return { success: false, reason: 'self_dependency' };
  }

  if (wouldCreateCycle(featureId, dependsOnId, 'feature')) {
    return { success: false, reason: 'circular_dependency' };
  }

  const db = getDb();
  try {
    db.insert(featureDependencies).values({
      featureId,
      dependsOnId,
    }).run();
    return { success: true };
  } catch (err: any) {
    if (err?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return { success: false, reason: 'already_exists' };
    }
    logger.error({ err, featureId, dependsOnId }, 'Unexpected DB error adding feature dependency');
    throw err;
  }
}

export function removeFeatureDependency(featureId: string, dependsOnId: string): boolean {
  const db = getDb();
  try {
    db.delete(featureDependencies)
      .where(and(eq(featureDependencies.featureId, featureId), eq(featureDependencies.dependsOnId, dependsOnId)))
      .run();
    return true;
  } catch (err) {
    logger.warn({ err, featureId, dependsOnId }, 'Failed to remove feature dependency');
    return false;
  }
}

export function getFeatureDependencies(featureId: string): {
  dependsOn: { featureId: string; title: string; status: string }[];
  blocking: { featureId: string; title: string; status: string }[];
} {
  const db = getDb();

  const dependsOnRows = db.select({
    featureId: featureDependencies.dependsOnId,
    title: features.title,
    status: features.status,
  })
    .from(featureDependencies)
    .innerJoin(features, eq(featureDependencies.dependsOnId, features.id))
    .where(eq(featureDependencies.featureId, featureId))
    .all();

  const blockingRows = db.select({
    featureId: featureDependencies.featureId,
    title: features.title,
    status: features.status,
  })
    .from(featureDependencies)
    .innerJoin(features, eq(featureDependencies.featureId, features.id))
    .where(eq(featureDependencies.dependsOnId, featureId))
    .all();

  return {
    dependsOn: dependsOnRows,
    blocking: blockingRows,
  };
}

export function validateFeatureCompletion(featureId: string): DependencyValidationResult {
  const db = getDb();

  const featureTasks = db.select().from(tasks)
    .where(eq(tasks.featureId, featureId))
    .all();

  const incompleteTasks = featureTasks.filter(t => t.status !== 'done' && t.status !== 'approved');
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
    featureId: featureDependencies.dependsOnId,
    title: features.title,
    status: features.status,
  })
    .from(featureDependencies)
    .innerJoin(features, eq(featureDependencies.dependsOnId, features.id))
    .where(eq(featureDependencies.featureId, featureId))
    .all();

  const incompleteDeps = deps.filter(d => d.status !== 'done');
  if (incompleteDeps.length > 0) {
    return {
      canComplete: false,
      reason: 'BLOCKED_BY_FEATURE_DEPENDENCIES',
      blockedBy: incompleteDeps.map(d => ({
        taskId: d.featureId,
        title: d.title,
        status: d.status,
      })),
    };
  }

  return { canComplete: true };
}

export function getDependencyGraph(featureId: string): {
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

    const feature = db.select().from(features).where(eq(features.id, fid)).get();
    if (!feature) return;
    nodes.push({ id: feature.id, title: feature.title, status: feature.status });

    const deps = db.select({ dependsOnId: featureDependencies.dependsOnId })
      .from(featureDependencies)
      .where(eq(featureDependencies.featureId, fid))
      .all();

    for (const dep of deps) {
      edges.push({ from: fid, to: dep.dependsOnId });
      traverse(dep.dependsOnId);
    }
  }

  traverse(featureId);
  return { nodes, edges };
}

function wouldCreateCycle(fromId: string, toId: string, type: 'task' | 'feature'): boolean {
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
      const deps = db.select({ dependsOnId: featureDependencies.dependsOnId })
        .from(featureDependencies)
        .where(eq(featureDependencies.featureId, current))
        .all();
      for (const dep of deps) {
        stack.push(dep.dependsOnId);
      }
    }
  }

  return false;
}
