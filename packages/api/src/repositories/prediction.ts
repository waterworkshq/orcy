import { getDb } from "../db/index.js";
import {
  agents,
  missions,
  sprints,
  taskDependencies,
  taskEvents,
  tasks,
} from "../db/schema/index.js";
import { dateDayExpr } from "../db/dialect-helpers.js";
import { priorityOrderExpr } from "../db/sql-helpers.js";
import { and, eq, inArray, isNotNull, notInArray, sql } from "drizzle-orm";
import type { TaskPriority, TaskStatus } from "../models/index.js";

export interface AgentCompletionBucket {
  bucket: string | null;
  count: number;
}

export interface VelocityAgentRow {
  id: string;
  name: string;
}

export interface OpenTaskEstimateRow {
  id: string;
  missionId: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId: string | null;
  dueAt: string | null;
  lastActivity: string | null;
}

export interface UnmetDependencyCountRow {
  taskId: string;
  count: number;
}

export interface ActiveTaskActivityRow {
  id: string;
  title: string;
  status: TaskStatus;
  assignedAgentId: string | null;
  dueAt: string | null;
  updatedAt: string;
  lastActivity: string | null;
}

export interface BlockedTaskRow {
  id: string;
  title: string;
  status: TaskStatus;
  assignedAgentId: string | null;
  dueAt: string | null;
  lastActivity: string | null;
  unmetCount: number;
}

export interface MissionSprintRow {
  id: string;
  sprintId: string | null;
}

export interface SprintDateRange {
  startDate: string;
  endDate: string;
}

export interface BurndownTaskCounts {
  totalTasks: number;
  completedTasks: number;
}

export interface DailyCompletedCountRow {
  date: string;
  count: number;
}

export function countCompletedTasksSince(
  habitatId: string,
  sinceDate: string,
  options?: { sprintId?: string },
): number {
  const db = getDb();
  const conditions = [
    eq(missions.habitatId, habitatId),
    inArray(tasks.status, ["approved", "done"]),
    sql`${tasks.completedAt} >= ${sinceDate}`,
  ];
  if (options?.sprintId) conditions.push(eq(missions.sprintId, options.sprintId));

  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...conditions))
    .get();
  return row?.count ?? 0;
}

export function getVelocityAgents(habitatId: string): VelocityAgentRow[] {
  const db = getDb();
  return db
    .selectDistinct({ id: agents.id, name: agents.name })
    .from(agents)
    .innerJoin(tasks, eq(tasks.assignedAgentId, agents.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(missions.habitatId, habitatId))
    .all();
}

export function getAgentCompletionBuckets(
  habitatId: string,
  agentId: string,
  since7: string,
  since14: string,
  since30: string,
  options?: { sprintId?: string },
): AgentCompletionBucket[] {
  const db = getDb();
  const conditions = [
    eq(missions.habitatId, habitatId),
    inArray(tasks.status, ["approved", "done"]),
    eq(tasks.assignedAgentId, agentId),
    sql`${tasks.completedAt} >= ${since30}`,
  ];
  if (options?.sprintId) conditions.push(eq(missions.sprintId, options.sprintId));

  return db
    .select({
      bucket: sql<string>`CASE
        WHEN ${tasks.completedAt} >= ${since7} THEN 'd7'
        WHEN ${tasks.completedAt} >= ${since14} THEN 'd14'
        WHEN ${tasks.completedAt} >= ${since30} THEN 'd30'
      END`,
      count: sql<number>`count(*)`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...conditions))
    .groupBy(sql`1`)
    .all();
}

export function getOpenTaskEstimateRows(habitatId: string): OpenTaskEstimateRow[] {
  const db = getDb();
  return db
    .select({
      id: tasks.id,
      missionId: tasks.missionId,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      assignedAgentId: tasks.assignedAgentId,
      dueAt: missions.dueAt,
      lastActivity: sql<
        string | null
      >`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        notInArray(tasks.status, ["approved", "done", "failed"]),
      ),
    )
    .orderBy(priorityOrderExpr(tasks.priority), tasks.createdAt)
    .all();
}

export function getUnmetDependencyCounts(taskIds: string[]): UnmetDependencyCountRow[] {
  if (taskIds.length === 0) return [];

  const db = getDb();
  return db
    .select({
      taskId: taskDependencies.taskId,
      count: sql<number>`count(*)`,
    })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(
      and(
        inArray(taskDependencies.taskId, taskIds),
        notInArray(tasks.status, ["approved", "done"]),
      ),
    )
    .groupBy(taskDependencies.taskId)
    .all();
}

export function getActiveTaskActivityRows(habitatId: string): ActiveTaskActivityRow[] {
  const db = getDb();
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      assignedAgentId: tasks.assignedAgentId,
      dueAt: missions.dueAt,
      updatedAt: tasks.updatedAt,
      lastActivity: sql<
        string | null
      >`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(eq(missions.habitatId, habitatId), inArray(tasks.status, ["claimed", "in_progress"])),
    )
    .all();
}

export function getBlockedTaskRowsWithUnmetCounts(habitatId: string): BlockedTaskRow[] {
  const db = getDb();
  const blockedRows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      assignedAgentId: tasks.assignedAgentId,
      dueAt: missions.dueAt,
      lastActivity: sql<
        string | null
      >`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        eq(tasks.status, "pending"),
        sql`EXISTS (
          SELECT 1 FROM task_dependencies td
          INNER JOIN tasks dep ON td.depends_on_id = dep.id
          WHERE td.task_id = ${tasks.id} AND dep.status NOT IN ('approved', 'done')
        )`,
      ),
    )
    .all();

  return blockedRows.map((row) => {
    const depCountRow = db
      .select({ count: sql<number>`count(*)` })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
      .where(
        and(eq(taskDependencies.taskId, row.id), notInArray(tasks.status, ["approved", "done"])),
      )
      .get();

    return {
      ...row,
      unmetCount: depCountRow?.count ?? 0,
    };
  });
}

export function getMissionSprintRows(habitatId: string): MissionSprintRow[] {
  const db = getDb();
  return db
    .select({ id: missions.id, sprintId: missions.sprintId })
    .from(missions)
    .where(and(eq(missions.habitatId, habitatId), isNotNull(missions.sprintId)))
    .all();
}

export function getSprintDateRange(sprintId: string): SprintDateRange | undefined {
  const db = getDb();
  return db
    .select({ startDate: sprints.startDate, endDate: sprints.endDate })
    .from(sprints)
    .where(eq(sprints.id, sprintId))
    .get();
}

export function getBurndownTaskCounts(
  habitatId: string,
  options?: { sprintId?: string },
): BurndownTaskCounts {
  const db = getDb();
  const baseConditions = [eq(missions.habitatId, habitatId)];
  if (options?.sprintId) baseConditions.push(eq(missions.sprintId, options.sprintId));

  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...baseConditions))
    .get();

  const completedRow = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...baseConditions, inArray(tasks.status, ["approved", "done"])))
    .get();

  return {
    totalTasks: totalRow?.count ?? 0,
    completedTasks: completedRow?.count ?? 0,
  };
}

export function getDailyCompletedTaskCounts(
  habitatId: string,
  since: string,
  options?: { sprintId?: string },
): DailyCompletedCountRow[] {
  const db = getDb();
  const baseConditions = [eq(missions.habitatId, habitatId)];
  if (options?.sprintId) baseConditions.push(eq(missions.sprintId, options.sprintId));

  const dayExpr = dateDayExpr(tasks.completedAt);
  return db
    .select({
      date: dayExpr,
      count: sql<number>`count(*)`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        ...baseConditions,
        inArray(tasks.status, ["approved", "done"]),
        isNotNull(tasks.completedAt),
        sql`${tasks.completedAt} >= ${since}`,
      ),
    )
    .groupBy(dayExpr)
    .orderBy(dayExpr)
    .all()
    .map((row) => ({ date: row.date as string, count: row.count }));
}

export function countCompletedTasksBefore(
  habitatId: string,
  before: string,
  options?: { sprintId?: string },
): number {
  const db = getDb();
  const baseConditions = [eq(missions.habitatId, habitatId)];
  if (options?.sprintId) baseConditions.push(eq(missions.sprintId, options.sprintId));

  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        ...baseConditions,
        inArray(tasks.status, ["approved", "done"]),
        isNotNull(tasks.completedAt),
        sql`${tasks.completedAt} < ${before}`,
      ),
    )
    .get();
  return row?.count ?? 0;
}
