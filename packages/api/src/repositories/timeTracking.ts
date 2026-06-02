import { getDb } from "../db/index.js";
import { taskTimeRecords, tasks, missions, agents, effortEntries } from "../db/schema/index.js";
import { eq, and, sql, count, isNotNull, notInArray, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { TaskTimeRecord, HabitatMetrics } from "../models/index.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

const DEFAULT_TIME_RECORD_LIST_LIMIT = 1000;

export function createTimeRecord(input: {
  taskId: string;
  agentId?: string;
  minutesSpent: number;
  statusDuringWork: string;
}): TaskTimeRecord {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(taskTimeRecords)
      .values({
        id,
        taskId: input.taskId,
        agentId: input.agentId ?? null,
        minutesSpent: input.minutesSpent,
        recordedAt: now,
        statusDuringWork: input.statusDuringWork,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("taskTimeRecord", err as Error, id);
  }

  const created = getTimeRecordById(id);
  if (!created) {
    throw repositoryNotFoundError("taskTimeRecord", id);
  }
  return created;
}

export function getTimeRecordById(id: string): TaskTimeRecord | null {
  const db = getDb();
  return (
    (db.select().from(taskTimeRecords).where(eq(taskTimeRecords.id, id)).get() as TaskTimeRecord) ??
    null
  );
}

export function getTimeRecordsByTask(
  taskId: string,
  options?: { limit?: number },
): TaskTimeRecord[] {
  const db = getDb();
  const limit = options?.limit ?? DEFAULT_TIME_RECORD_LIST_LIMIT;
  return db
    .select()
    .from(taskTimeRecords)
    .where(eq(taskTimeRecords.taskId, taskId))
    .orderBy(taskTimeRecords.recordedAt)
    .limit(limit)
    .all() as TaskTimeRecord[];
}

export function getTotalMinutesForTask(taskId: string): number {
  const db = getDb();
  const result = db
    .select({ total: sql<number>`COALESCE(SUM(${taskTimeRecords.minutesSpent}), 0)` })
    .from(taskTimeRecords)
    .where(eq(taskTimeRecords.taskId, taskId))
    .get();
  return result?.total ?? 0;
}

export function getLatestTimeRecord(taskId: string): TaskTimeRecord | null {
  const db = getDb();
  const records = db
    .select()
    .from(taskTimeRecords)
    .where(eq(taskTimeRecords.taskId, taskId))
    .orderBy(sql`${taskTimeRecords.recordedAt} DESC`)
    .limit(1)
    .all() as TaskTimeRecord[];
  return records[0] ?? null;
}

export function getHabitatMetrics(habitatId: string): HabitatMetrics {
  const db = getDb();

  const habitatMissions = db
    .select({ id: missions.id, dueAt: missions.dueAt })
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all();
  const missionIds = habitatMissions.map((f) => f.id);
  const missionMap = new Map(habitatMissions.map((f) => [f.id, f]));

  if (missionIds.length === 0) {
    return {
      averageCycleTime: 0,
      averageLeadTime: 0,
      averageEstimationAccuracy: 0,
      totalPlannedMinutes: 0,
      totalActualMinutes: 0,
      overdueTasks: 0,
      onTimeCompletionRate: 0,
      agentMetrics: [],
      totalLoggedEffortMinutes: 0,
      totalInferredPresenceMinutes: 0,
      totalAccountedMinutes: 0,
    };
  }

  const completedTasks = db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.missionId, missionIds), isNotNull(tasks.completedAt)))
    .all();

  const totalCycleTime = completedTasks.reduce((acc, t) => acc + (t.cycleTimeMinutes ?? 0), 0);
  const totalLeadTime = completedTasks.reduce((acc, t) => acc + (t.leadTimeMinutes ?? 0), 0);
  const totalActual = completedTasks.reduce((acc, t) => acc + (t.actualMinutes ?? 0), 0);
  const totalPlanned = completedTasks.reduce((acc, t) => acc + (t.estimatedMinutes ?? 0), 0);

  const tasksWithAccuracy = completedTasks.filter((t) => t.estimationAccuracy !== null);
  const avgAccuracy =
    tasksWithAccuracy.length > 0
      ? tasksWithAccuracy.reduce((acc, t) => acc + (t.estimationAccuracy ?? 0), 0) /
        tasksWithAccuracy.length
      : 0;

  const overdueTasks = db
    .select({ count: count() })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        notInArray(tasks.status, ["done", "approved", "failed"]),
        sql`${missions.dueAt} IS NOT NULL AND ${missions.dueAt} < datetime('now')`,
      ),
    )
    .get();

  const onTimeTasks = completedTasks.filter((t) => {
    if (!t.completedAt) return false;
    const mission = missionMap.get(t.missionId);
    if (!mission?.dueAt) return true;
    return new Date(t.completedAt) <= new Date(mission.dueAt);
  });

  const agentRows = db
    .select({
      agentId: tasks.assignedAgentId,
      agentName: agents.name,
      tasksCompleted: count(),
      cycleSum: sql<number>`COALESCE(SUM(${tasks.cycleTimeMinutes}), 0)`,
      accuracySum: sql<number>`COALESCE(SUM(CASE WHEN ${tasks.estimationAccuracy} IS NOT NULL THEN ${tasks.estimationAccuracy} ELSE 0 END), 0)`,
      accuracyCount: sql<number>`SUM(CASE WHEN ${tasks.estimationAccuracy} IS NOT NULL THEN 1 ELSE 0 END)`,
      totalTimeTracked: sql<number>`COALESCE(SUM(${tasks.actualMinutes}), 0)`,
    })
    .from(tasks)
    .innerJoin(agents, eq(tasks.assignedAgentId, agents.id))
    .where(
      and(
        inArray(tasks.missionId, missionIds),
        isNotNull(tasks.completedAt),
        isNotNull(tasks.assignedAgentId),
      ),
    )
    .groupBy(tasks.assignedAgentId, agents.name)
    .all();

  const agentMetrics: HabitatMetrics["agentMetrics"] = agentRows
    .filter((row) => row.agentId !== null)
    .map((row) => ({
      agentId: row.agentId!,
      agentName: row.agentName,
      tasksCompleted: row.tasksCompleted,
      averageCycleTime: row.tasksCompleted > 0 ? row.cycleSum / row.tasksCompleted : 0,
      averageEstimationAccuracy: row.accuracyCount > 0 ? row.accuracySum / row.accuracyCount : 0,
      totalTimeTracked: row.totalTimeTracked,
    }));

  const completedTaskIds = completedTasks.map((t) => t.id);

  let totalLoggedEffortMinutes = 0;
  let totalInferredPresenceMinutes = 0;

  if (completedTaskIds.length > 0) {
    const loggedResult = db
      .select({
        total: sql<number>`COALESCE(SUM(${effortEntries.minutes}), 0)`,
      })
      .from(effortEntries)
      .where(
        and(
          inArray(effortEntries.taskId, completedTaskIds),
          sql`${effortEntries.source} IN ('human_manual', 'agent_reported')`,
        ),
      )
      .get();
    totalLoggedEffortMinutes = loggedResult?.total ?? 0;

    const correctionResult = db
      .select({
        total: sql<number>`COALESCE(SUM(${effortEntries.minutes}), 0)`,
      })
      .from(effortEntries)
      .where(
        and(
          inArray(effortEntries.taskId, completedTaskIds),
          eq(effortEntries.source, "correction_adjustment"),
        ),
      )
      .get();
    totalLoggedEffortMinutes += correctionResult?.total ?? 0;

    const inferredResult = db
      .select({
        total: sql<number>`COALESCE(SUM(${taskTimeRecords.minutesSpent}), 0)`,
      })
      .from(taskTimeRecords)
      .where(
        and(
          inArray(taskTimeRecords.taskId, completedTaskIds),
          eq(taskTimeRecords.statusDuringWork, "in_progress"),
        ),
      )
      .get();
    totalInferredPresenceMinutes = inferredResult?.total ?? 0;
  }

  const totalAccountedMinutes = totalLoggedEffortMinutes + totalInferredPresenceMinutes;

  return {
    averageCycleTime: completedTasks.length > 0 ? totalCycleTime / completedTasks.length : 0,
    averageLeadTime: completedTasks.length > 0 ? totalLeadTime / completedTasks.length : 0,
    averageEstimationAccuracy: avgAccuracy,
    totalPlannedMinutes: totalPlanned,
    totalActualMinutes: totalAccountedMinutes,
    overdueTasks: overdueTasks?.count ?? 0,
    onTimeCompletionRate:
      completedTasks.length > 0 ? onTimeTasks.length / completedTasks.length : 0,
    agentMetrics,
    totalLoggedEffortMinutes,
    totalInferredPresenceMinutes,
    totalAccountedMinutes,
  };
}

const MAX_TIME_METRICS_RETRIES = 3;

export function updateTaskTimeMetrics(taskId: string): void {
  const db = getDb();

  for (let attempt = 0; attempt < MAX_TIME_METRICS_RETRIES; attempt++) {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return;

    const totalMinutes = getTotalMinutesForTask(taskId);

    const updates: Partial<typeof tasks.$inferInsert> = {
      actualMinutes: totalMinutes,
      updatedAt: new Date().toISOString(),
    };

    if (task.estimatedMinutes && totalMinutes > 0) {
      updates.estimationAccuracy = totalMinutes / task.estimatedMinutes;
    }

    if (task.completedAt && task.createdAt) {
      const created = new Date(task.createdAt).getTime();
      const completed = new Date(task.completedAt).getTime();
      updates.cycleTimeMinutes = Math.round((completed - created) / 60000);

      if (task.startedAt) {
        const started = new Date(task.startedAt).getTime();
        updates.leadTimeMinutes = Math.round((completed - started) / 60000);
      }
    }

    const expectedVersion = task.version;
    const updated = db
      .update(tasks)
      .set({ ...updates, version: sql`${tasks.version} + 1` })
      .where(and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion)))
      .run();

    const succeeded = updated.changes === undefined || updated.changes > 0;
    if (succeeded) return;
  }
}

export function recalculateMissionMetrics(missionId: string): void {
  const db = getDb();
  const missionTasks = db.select().from(tasks).where(eq(tasks.missionId, missionId)).all();

  const actualSum = missionTasks.reduce((s, t) => s + (t.actualMinutes ?? 0), 0);
  const plannedSum = missionTasks.reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0);
  const planningAccuracy = plannedSum > 0 ? actualSum / plannedSum : null;
  const allDone =
    missionTasks.length > 0 &&
    missionTasks.every((t) => t.status === "done" || t.status === "approved");

  try {
    db.update(missions)
      .set({
        actualMinutes: actualSum,
        plannedMinutes: plannedSum,
        planningAccuracy,
        completedAt: allDone ? new Date().toISOString() : null,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(missions.id, missionId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("mission", err as Error, missionId);
  }
}
