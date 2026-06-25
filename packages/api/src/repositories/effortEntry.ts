import { getDb } from "../db/index.js";
import { effortEntries, tasks, taskTimeRecords, missions, agents } from "../db/schema/index.js";
import { eq, and, sql, ne, inArray, gt, desc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type {
  EffortEntry,
  EffortEntryWithActor,
  EffortTotals,
  EffortSource,
  EffortActorType,
} from "../models/index.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

function lookupAgentNames(db: ReturnType<typeof getDb>, ids: string[]): Map<string, string> {
  const names = new Map<string, string>();
  if (ids.length === 0) return names;
  const unique = [...new Set(ids)];
  const rows = db
    .select({ id: agents.id, name: agents.name })
    .from(agents)
    .where(unique.length === 1 ? eq(agents.id, unique[0]) : inArray(agents.id, unique))
    .all();
  for (const r of rows) names.set(r.id, r.name);
  return names;
}

export function createEffortEntry(input: {
  taskId: string;
  actorType: EffortActorType;
  actorId?: string;
  minutes: number;
  source: EffortSource;
  note?: string;
  startedAt?: string;
  endedAt?: string;
  correctsEntryId?: string;
  correctionReason?: string;
  metadata?: Record<string, unknown>;
}): EffortEntry {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(effortEntries)
      .values({
        id,
        taskId: input.taskId,
        actorType: input.actorType,
        actorId: input.actorId ?? null,
        minutes: input.minutes,
        source: input.source,
        note: input.note ?? null,
        startedAt: input.startedAt ?? null,
        endedAt: input.endedAt ?? null,
        recordedAt: now,
        correctsEntryId: input.correctsEntryId ?? null,
        correctionReason: input.correctionReason ?? null,
        metadata: input.metadata ?? null,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("effortEntry", err as Error, id);
  }

  const created = getEffortEntryById(id);
  if (!created) {
    throw repositoryNotFoundError("effortEntry", id);
  }
  return created;
}

export function getEffortEntryById(id: string): EffortEntry | null {
  const db = getDb();
  return (
    (db.select().from(effortEntries).where(eq(effortEntries.id, id)).get() as EffortEntry) ?? null
  );
}

const DEFAULT_EFFORT_LIMIT = 100;

export function getEffortEntriesByTask(
  taskId: string,
  options?: { includeCorrections?: boolean; limit?: number; offset?: number },
): EffortEntry[] {
  const db = getDb();
  const includeCorrections = options?.includeCorrections ?? true;
  const limit = options?.limit ?? DEFAULT_EFFORT_LIMIT;
  const offset = options?.offset ?? 0;

  const conditions = [eq(effortEntries.taskId, taskId)];
  if (!includeCorrections) {
    conditions.push(ne(effortEntries.source, "correction_adjustment"));
  }

  return db
    .select()
    .from(effortEntries)
    .where(and(...conditions))
    .orderBy(effortEntries.recordedAt)
    .limit(limit)
    .offset(offset)
    .all() as EffortEntry[];
}

export function countEffortEntriesByTask(
  taskId: string,
  options?: { includeCorrections?: boolean },
): number {
  const db = getDb();
  const includeCorrections = options?.includeCorrections ?? true;

  const conditions = [eq(effortEntries.taskId, taskId)];
  if (!includeCorrections) {
    conditions.push(ne(effortEntries.source, "correction_adjustment"));
  }

  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(effortEntries)
    .where(and(...conditions))
    .get();
  return result?.count ?? 0;
}

export function getEffortEntriesWithActorByTask(
  taskId: string,
  options?: { includeCorrections?: boolean; limit?: number; offset?: number },
): EffortEntryWithActor[] {
  const db = getDb();
  const includeCorrections = options?.includeCorrections ?? true;
  const limit = options?.limit ?? DEFAULT_EFFORT_LIMIT;
  const offset = options?.offset ?? 0;

  const conditions = [eq(effortEntries.taskId, taskId)];
  if (!includeCorrections) {
    conditions.push(ne(effortEntries.source, "correction_adjustment"));
  }

  const rows = db
    .select()
    .from(effortEntries)
    .where(and(...conditions))
    .orderBy(effortEntries.recordedAt)
    .limit(limit)
    .offset(offset)
    .all() as EffortEntry[];

  const agentIds = rows.filter((r) => r.actorType === "agent" && r.actorId).map((r) => r.actorId!);

  const agentNames = lookupAgentNames(db, agentIds);

  return rows.map((entry) => ({
    ...entry,
    actorName:
      entry.actorType === "agent" && entry.actorId ? (agentNames.get(entry.actorId) ?? null) : null,
  }));
}

export function getEffortTotalsForTask(taskId: string): EffortTotals {
  const db = getDb();

  const loggedResult = db
    .select({ total: sql<number>`COALESCE(SUM(${effortEntries.minutes}), 0)` })
    .from(effortEntries)
    .where(
      and(
        eq(effortEntries.taskId, taskId),
        sql`${effortEntries.source} IN ('human_manual', 'agent_reported')`,
      ),
    )
    .get();
  const loggedEffortMinutes = loggedResult?.total ?? 0;

  const correctionResult = db
    .select({ total: sql<number>`COALESCE(SUM(${effortEntries.minutes}), 0)` })
    .from(effortEntries)
    .where(and(eq(effortEntries.taskId, taskId), eq(effortEntries.source, "correction_adjustment")))
    .get();
  const correctionAdjustmentMinutes = correctionResult?.total ?? 0;

  const inferredResult = db
    .select({ total: sql<number>`COALESCE(SUM(${taskTimeRecords.minutesSpent}), 0)` })
    .from(taskTimeRecords)
    .where(
      and(eq(taskTimeRecords.taskId, taskId), eq(taskTimeRecords.statusDuringWork, "in_progress")),
    )
    .get();
  const inferredPresenceMinutes = inferredResult?.total ?? 0;

  const totalAccountedMinutes =
    loggedEffortMinutes + correctionAdjustmentMinutes + inferredPresenceMinutes;

  return {
    loggedEffortMinutes,
    inferredPresenceMinutes,
    correctionAdjustmentMinutes,
    totalAccountedMinutes,
  };
}

export function getEffortTotalsForTasks(taskIds: string[]): Map<string, EffortTotals> {
  const result = new Map<string, EffortTotals>();
  if (taskIds.length === 0) return result;
  for (const id of taskIds) {
    result.set(id, {
      loggedEffortMinutes: 0,
      inferredPresenceMinutes: 0,
      correctionAdjustmentMinutes: 0,
      totalAccountedMinutes: 0,
    });
  }

  const db = getDb();
  const idList = sql.join(taskIds, sql`, `);

  const loggedRows = db
    .select({
      taskId: effortEntries.taskId,
      total: sql<number>`COALESCE(SUM(${effortEntries.minutes}), 0)`,
    })
    .from(effortEntries)
    .where(
      and(
        sql`${effortEntries.taskId} IN (${idList})`,
        sql`${effortEntries.source} IN ('human_manual', 'agent_reported')`,
      ),
    )
    .groupBy(effortEntries.taskId)
    .all();
  for (const row of loggedRows) {
    const t = result.get(row.taskId);
    if (t) t.loggedEffortMinutes = row.total;
  }

  const correctionRows = db
    .select({
      taskId: effortEntries.taskId,
      total: sql<number>`COALESCE(SUM(${effortEntries.minutes}), 0)`,
    })
    .from(effortEntries)
    .where(
      and(
        sql`${effortEntries.taskId} IN (${idList})`,
        eq(effortEntries.source, "correction_adjustment"),
      ),
    )
    .groupBy(effortEntries.taskId)
    .all();
  for (const row of correctionRows) {
    const t = result.get(row.taskId);
    if (t) t.correctionAdjustmentMinutes = row.total;
  }

  const inferredRows = db
    .select({
      taskId: taskTimeRecords.taskId,
      total: sql<number>`COALESCE(SUM(${taskTimeRecords.minutesSpent}), 0)`,
    })
    .from(taskTimeRecords)
    .where(
      and(
        sql`${taskTimeRecords.taskId} IN (${idList})`,
        eq(taskTimeRecords.statusDuringWork, "in_progress"),
      ),
    )
    .groupBy(taskTimeRecords.taskId)
    .all();
  for (const row of inferredRows) {
    const t = result.get(row.taskId);
    if (t) t.inferredPresenceMinutes = row.total;
  }

  for (const [, t] of result) {
    t.totalAccountedMinutes =
      t.loggedEffortMinutes + t.correctionAdjustmentMinutes + t.inferredPresenceMinutes;
  }

  return result;
}

export function getEffortBySourceForTask(taskId: string): Record<string, number> {
  const db = getDb();

  const rows = db
    .select({
      source: effortEntries.source,
      total: sql<number>`COALESCE(SUM(${effortEntries.minutes}), 0)`,
    })
    .from(effortEntries)
    .where(eq(effortEntries.taskId, taskId))
    .groupBy(effortEntries.source)
    .all();

  const result: Record<string, number> = {};
  for (const row of rows) {
    result[row.source] = row.total;
  }

  const inferredResult = db
    .select({ total: sql<number>`COALESCE(SUM(${taskTimeRecords.minutesSpent}), 0)` })
    .from(taskTimeRecords)
    .where(
      and(eq(taskTimeRecords.taskId, taskId), eq(taskTimeRecords.statusDuringWork, "in_progress")),
    )
    .get();
  const inferredMinutes = inferredResult?.total ?? 0;
  if (inferredMinutes > 0) {
    result["heartbeat_inferred"] = inferredMinutes;
  }

  return result;
}

export function getEffortByActorForTask(taskId: string): Array<{
  actorType: EffortActorType;
  actorId: string | null;
  actorName: string | null;
  loggedEffortMinutes: number;
  inferredPresenceMinutes: number;
  correctionAdjustmentMinutes: number;
}> {
  const db = getDb();

  const loggedRows = db
    .select({
      actorType: effortEntries.actorType,
      actorId: effortEntries.actorId,
      source: effortEntries.source,
      total: sql<number>`COALESCE(SUM(${effortEntries.minutes}), 0)`,
    })
    .from(effortEntries)
    .where(eq(effortEntries.taskId, taskId))
    .groupBy(effortEntries.actorType, effortEntries.actorId, effortEntries.source)
    .all();

  const actorMap = new Map<
    string,
    {
      actorType: string;
      actorId: string | null;
      loggedEffortMinutes: number;
      correctionAdjustmentMinutes: number;
      inferredPresenceMinutes: number;
    }
  >();

  for (const row of loggedRows) {
    const key = `${row.actorType}:${row.actorId ?? "null"}`;
    if (!actorMap.has(key)) {
      actorMap.set(key, {
        actorType: row.actorType,
        actorId: row.actorId,
        loggedEffortMinutes: 0,
        correctionAdjustmentMinutes: 0,
        inferredPresenceMinutes: 0,
      });
    }
    const entry = actorMap.get(key)!;
    if (row.source === "correction_adjustment") {
      entry.correctionAdjustmentMinutes += row.total;
    } else {
      entry.loggedEffortMinutes += row.total;
    }
  }

  const inferredRows = db
    .select({
      agentId: taskTimeRecords.agentId,
      total: sql<number>`COALESCE(SUM(${taskTimeRecords.minutesSpent}), 0)`,
    })
    .from(taskTimeRecords)
    .where(
      and(eq(taskTimeRecords.taskId, taskId), eq(taskTimeRecords.statusDuringWork, "in_progress")),
    )
    .groupBy(taskTimeRecords.agentId)
    .all();

  for (const row of inferredRows) {
    const agentId = row.agentId ?? "null";
    const key = `agent:${agentId}`;
    if (!actorMap.has(key)) {
      actorMap.set(key, {
        actorType: "agent",
        actorId: row.agentId,
        loggedEffortMinutes: 0,
        correctionAdjustmentMinutes: 0,
        inferredPresenceMinutes: 0,
      });
    }
    actorMap.get(key)!.inferredPresenceMinutes += row.total;
  }

  const agentIds = [...actorMap.values()]
    .filter((a) => a.actorType === "agent" && a.actorId)
    .map((a) => a.actorId!);
  const agentNames = lookupAgentNames(db, agentIds);

  return [...actorMap.values()].map((entry) => ({
    actorType: entry.actorType as EffortActorType,
    actorId: entry.actorId,
    actorName:
      entry.actorType === "agent" && entry.actorId ? (agentNames.get(entry.actorId) ?? null) : null,
    loggedEffortMinutes: entry.loggedEffortMinutes,
    inferredPresenceMinutes: entry.inferredPresenceMinutes,
    correctionAdjustmentMinutes: entry.correctionAdjustmentMinutes,
  }));
}

const MAX_RECALC_RETRIES = 3;

export interface PersistedEffortMetrics {
  actualMinutes: number;
  estimationAccuracy: number | null;
  basis: "logged_effort" | "inferred_only" | "unavailable";
}

export function getPersistedEffortMetricsForTask(
  taskId: string,
  estimatedMinutes?: number | null,
): PersistedEffortMetrics {
  const totals = getEffortTotalsForTask(taskId);
  const correctedLoggedMinutes = totals.loggedEffortMinutes + totals.correctionAdjustmentMinutes;

  let actualMinutes = 0;
  let basis: PersistedEffortMetrics["basis"] = "unavailable";

  if (totals.loggedEffortMinutes > 0 || totals.correctionAdjustmentMinutes !== 0) {
    actualMinutes = correctedLoggedMinutes;
    basis = "logged_effort";
  } else if (totals.inferredPresenceMinutes > 0) {
    actualMinutes = totals.inferredPresenceMinutes;
    basis = "inferred_only";
  }

  return {
    actualMinutes,
    estimationAccuracy:
      estimatedMinutes && basis !== "unavailable" ? actualMinutes / estimatedMinutes : null,
    basis,
  };
}

/**
 * Returns effort entries in a habitat with `recorded_at > since`, scoped via
 * `effort_entries.task_id → tasks.mission_id → missions.habitat_id`. Backs the
 * `wikiAugmentationService` delta + chunk modes (authoring time signal). `limit` defaults to
 * 100; ordered newest-first by `recorded_at`. No side effects.
 */
export function listByHabitatSince(habitatId: string, since: string, limit = 100): EffortEntry[] {
  const db = getDb();
  return db
    .select({ row: effortEntries })
    .from(effortEntries)
    .innerJoin(tasks, eq(tasks.id, effortEntries.taskId))
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(and(eq(missions.habitatId, habitatId), gt(effortEntries.recordedAt, since)))
    .orderBy(desc(effortEntries.recordedAt))
    .limit(limit)
    .all()
    .map((r) => r.row) as EffortEntry[];
}

export function recalculateTaskEffortMetrics(taskId: string): void {
  const db = getDb();

  for (let attempt = 0; attempt < MAX_RECALC_RETRIES; attempt++) {
    const task = db.select().from(tasks).where(eq(tasks.id, taskId)).get();
    if (!task) return;

    const effortMetrics = getPersistedEffortMetricsForTask(taskId, task.estimatedMinutes);

    const updates: Partial<typeof tasks.$inferInsert> = {
      actualMinutes: effortMetrics.actualMinutes,
      estimationAccuracy: effortMetrics.estimationAccuracy,
      updatedAt: new Date().toISOString(),
    };

    const expectedVersion = task.version;
    const updated = db
      .update(tasks)
      .set({ ...updates, version: sql`${tasks.version} + 1` })
      .where(and(eq(tasks.id, taskId), eq(tasks.version, expectedVersion)))
      .run();

    const succeeded = updated.changes === undefined || updated.changes > 0;
    if (succeeded) {
      recalculateMissionEffortMetrics(task.missionId);
      return;
    }
  }
}

export function recalculateMissionEffortMetrics(missionId: string): void {
  const db = getDb();
  const missionTasks = db.select().from(tasks).where(eq(tasks.missionId, missionId)).all();

  const actualSum = missionTasks.reduce((s, t) => s + (t.actualMinutes ?? 0), 0);
  const plannedSum = missionTasks.reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0);
  const planningAccuracy = plannedSum > 0 ? actualSum / plannedSum : null;

  try {
    db.update(missions)
      .set({
        actualMinutes: actualSum,
        plannedMinutes: plannedSum,
        planningAccuracy,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(missions.id, missionId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("mission", err as Error, missionId);
  }
}
