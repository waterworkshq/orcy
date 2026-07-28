import { getDb } from "../../db/index.js";
import { taskEvents, tasks, missions, agents, columns } from "../../db/schema/index.js";
import { alias } from "drizzle-orm/sqlite-core";
import { eq, and, sql, count, desc, inArray } from "drizzle-orm";
import {
  computeCycleTimeStats,
  computeHabitatThroughput,
  getDateThresholds,
} from "./stats-helpers.js";
import type { ActorType, EventAction, TaskStatus } from "../../models/index.js";

const fromColumns = alias(columns, "from_columns");
const toColumns = alias(columns, "to_columns");

export interface EnrichedHabitatEventRow {
  id: string;
  taskId: string;
  taskTitle: string;
  habitatId: string;
  actorType: ActorType;
  actorId: string;
  actorName: string | null;
  action: EventAction;
  fromColumnId: string | null;
  toColumnId: string | null;
  fromColumnName: string | null;
  toColumnName: string | null;
  fromStatus: TaskStatus | null;
  toStatus: TaskStatus | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface HabitatEventsFilters {
  action?: EventAction | EventAction[];
  actorType?: ActorType;
  actorId?: string;
  since?: string;
}

export function getEventsByHabitatId(
  habitatId: string,
  limit: number,
  offset: number,
  filters?: HabitatEventsFilters,
): { events: EnrichedHabitatEventRow[]; total: number } {
  const db = getDb();

  const habitatMissionIds = db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all()
    .map((f) => f.id);

  if (habitatMissionIds.length === 0) return { events: [], total: 0 };

  const conditions = [inArray(tasks.missionId, habitatMissionIds)];

  if (filters?.action) {
    const actions = Array.isArray(filters.action) ? filters.action : [filters.action];
    conditions.push(inArray(taskEvents.action, [...actions] as EventAction[]));
  }
  if (filters?.actorType) {
    conditions.push(eq(taskEvents.actorType, filters.actorType));
  }
  if (filters?.actorId) {
    conditions.push(eq(taskEvents.actorId, filters.actorId));
  }
  if (filters?.since) {
    conditions.push(sql`${taskEvents.timestamp} >= ${filters.since}`);
  }

  const whereClause = and(...conditions);

  const events = db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      actorType: taskEvents.actorType,
      actorId: taskEvents.actorId,
      action: taskEvents.action,
      fromColumnId: taskEvents.fromColumnId,
      toColumnId: taskEvents.toColumnId,
      fromStatus: taskEvents.fromStatus,
      toStatus: taskEvents.toStatus,
      metadata: taskEvents.metadata,
      timestamp: taskEvents.timestamp,
      taskTitle: tasks.title,
      habitatId: missions.habitatId,
      actorName: agents.name,
      fromColumnName: fromColumns.name,
      toColumnName: toColumns.name,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .leftJoin(agents, eq(taskEvents.actorId, agents.id))
    .leftJoin(fromColumns, eq(taskEvents.fromColumnId, fromColumns.id))
    .leftJoin(toColumns, eq(taskEvents.toColumnId, toColumns.id))
    .where(whereClause)
    .orderBy(desc(taskEvents.timestamp))
    .limit(limit)
    .offset(offset)
    .all();

  const enrichedEvents: EnrichedHabitatEventRow[] = events.map((row: any) => ({
    id: row.id,
    taskId: row.taskId,
    taskTitle: row.taskTitle,
    habitatId: row.habitatId,
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    action: row.action,
    fromColumnId: row.fromColumnId,
    toColumnId: row.toColumnId,
    fromColumnName: row.fromColumnName ?? null,
    toColumnName: row.toColumnName ?? null,
    fromStatus: row.fromStatus,
    toStatus: row.toStatus,
    metadata: row.metadata as Record<string, unknown>,
    timestamp: row.timestamp,
  }));

  const totalResult = db
    .select({ count: count() })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(whereClause)
    .get();

  return { events: enrichedEvents, total: totalResult?.count ?? 0 };
}

export interface HabitatStats {
  cycleTime: {
    averageMinutes: number;
    medianMinutes: number;
    count: number;
  };
  throughput: {
    today: number;
    thisWeek: number;
    thisMonth: number;
  };
  wipHealth: {
    columnId: string;
    columnName: string;
    current: number;
    limit: number | null;
    health: "ok" | "warning" | "exceeded";
  }[];
  missionSummary: {
    total: number;
    completed: number;
    blocked: number;
    byStatus: Record<string, number>;
  };
}

const EMPTY_MISSION_SUMMARY = {
  total: 0,
  completed: 0,
  blocked: 0,
  byStatus: { not_started: 0, in_progress: 0, review: 0, done: 0, failed: 0 },
} as const;

export function getHabitatStats(habitatId: string): HabitatStats {
  const db = getDb();

  const habitatMissionIds = db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all()
    .map((f) => f.id);

  if (habitatMissionIds.length === 0) {
    return {
      cycleTime: { averageMinutes: 0, medianMinutes: 0, count: 0 },
      throughput: { today: 0, thisWeek: 0, thisMonth: 0 },
      wipHealth: [],
      missionSummary: EMPTY_MISSION_SUMMARY,
    };
  }

  const cycleRows = db
    .select({
      taskId: taskEvents.taskId,
      claimedAt: sql<
        string | null
      >`MIN(CASE WHEN ${taskEvents.action} = 'claimed' THEN ${taskEvents.timestamp} END)`,
      completedAt: sql<
        string | null
      >`MIN(CASE WHEN ${taskEvents.action} = 'completed' THEN ${taskEvents.timestamp} END)`,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .where(inArray(tasks.missionId, habitatMissionIds))
    .groupBy(taskEvents.taskId)
    .having(
      sql`MIN(CASE WHEN ${taskEvents.action} = 'claimed' THEN ${taskEvents.timestamp} END) IS NOT NULL AND MIN(CASE WHEN ${taskEvents.action} = 'completed' THEN ${taskEvents.timestamp} END) IS NOT NULL`,
    )
    .all();

  const cycleTimes: number[] = [];
  for (const row of cycleRows) {
    if (row.claimedAt && row.completedAt) {
      const claimed = new Date(row.claimedAt).getTime();
      const completed = new Date(row.completedAt).getTime();
      if (!isNaN(claimed) && !isNaN(completed)) {
        cycleTimes.push((completed - claimed) / 60_000);
      }
    }
  }

  const { todayStart, weekStart, monthStart } = getDateThresholds("calendar");

  const throughputRows = db
    .select({ ts: taskEvents.timestamp })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .where(and(inArray(tasks.missionId, habitatMissionIds), eq(taskEvents.action, "completed")))
    .orderBy(desc(taskEvents.timestamp))
    .all();

  return {
    cycleTime: computeCycleTimeStats(cycleTimes),
    throughput: computeHabitatThroughput(throughputRows, todayStart, weekStart, monthStart),
    wipHealth: [],
    missionSummary: EMPTY_MISSION_SUMMARY,
  };
}
