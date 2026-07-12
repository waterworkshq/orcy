import { getDb } from "../db/index.js";
import {
  tasks,
  taskDependencies,
  missions,
  missionDependencies,
  taskWorkflowGates,
  releases as releasesTable,
} from "../db/schema/index.js";
import {
  eq,
  and,
  or,
  lt,
  isNull,
  isNotNull,
  sql,
  count,
  notInArray,
  notExists,
  exists,
  inArray,
  asc,
  desc,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { priorityOrderExpr } from "../db/sql-helpers.js";
import type { Task, TaskStatus, TaskPriority } from "../models/index.js";
import { isReleaseGateSatisfied, normalizeTaskId, type ReleaseType } from "@orcy/shared";
import { areAllWorkflowGatesSatisfied } from "./workflow.js";

export type TaskSortField =
  | "priority"
  | "title"
  | "status"
  | "createdAt"
  | "updatedAt"
  | "assignedAgentId"
  | "estimatedMinutes";

export interface TaskListFilters {
  status?: TaskStatus;
  priority?: TaskPriority;
  search?: string;
  assignedAgentId?: string | null;
  limit?: number;
  offset?: number;
  isArchived?: boolean;
  sortBy?: TaskSortField;
  sortDirection?: "asc" | "desc";
  hasUnmetWorkflowGates?: boolean;
}

export function getTasksByMissionId(
  missionId: string,
  filters?: { status?: TaskStatus; priority?: TaskPriority; limit?: number; offset?: number },
): Task[] {
  const db = getDb();

  const ids = missionId.startsWith("miss-") ? [missionId] : [missionId, `miss-${missionId}`];

  const conditions = [inArray(tasks.missionId, ids)];
  if (filters?.status) conditions.push(eq(tasks.status, filters.status));
  if (filters?.priority) conditions.push(eq(tasks.priority, filters.priority));

  const where = and(...conditions);

  const query = db
    .select()
    .from(tasks)
    .where(where)
    .orderBy(asc(tasks.order), asc(tasks.createdAt));
  return filters?.limit !== undefined
    ? query
        .limit(filters.limit)
        .offset(filters?.offset ?? 0)
        .all()
    : query.all();
}

export function getTasksByMissionIds(missionIds: string[]): Task[] {
  if (missionIds.length === 0) return [];
  const db = getDb();
  const expanded = missionIds.flatMap((id) => (id.startsWith("miss-") ? [id] : [id, `miss-${id}`]));
  return db
    .select()
    .from(tasks)
    .where(inArray(tasks.missionId, expanded))
    .orderBy(asc(tasks.order), asc(tasks.createdAt))
    .all();
}

export function getTasksByIds(ids: string[]): Task[] {
  if (ids.length === 0) return [];
  const db = getDb();
  const normalized: string[] = [...new Set(ids.map(normalizeTaskId))];
  return db.select().from(tasks).where(inArray(tasks.id, normalized)).all();
}

export function getAvailableTasksForAgent(
  habitatId: string,
  agentDomain: string,
  filters?: { status?: TaskStatus; priority?: TaskPriority; limit?: number },
): Task[] {
  const db = getDb();
  const outerTasks = alias(tasks, "outer_tasks");

  const statusCondition = filters?.status
    ? eq(outerTasks.status, filters.status)
    : or(
        eq(outerTasks.status, "pending"),
        eq(outerTasks.status, "claimed"),
        eq(outerTasks.status, "in_progress"),
      )!;

  const domainCondition = or(
    isNull(outerTasks.requiredDomain),
    eq(outerTasks.requiredDomain, agentDomain),
  )!;

  const habitatMissions = db
    .select({
      id: missions.id,
      releaseGateType: missions.releaseGateType,
      releaseGateVersion: missions.releaseGateVersion,
    })
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all();
  const habitatMissionIds = habitatMissions.map((f) => f.id);

  if (habitatMissionIds.length === 0) return [];

  const unmetDeps = db
    .select()
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(
      and(
        eq(taskDependencies.taskId, outerTasks.id),
        notInArray(tasks.status, ["done", "approved"]),
      ),
    );

  const habitatReleaseTypes = new Set(
    db
      .select({ releaseType: releasesTable.releaseType })
      .from(releasesTable)
      .where(eq(releasesTable.habitatId, habitatId))
      .all()
      .map((r) => r.releaseType as ReleaseType),
  );
  const habitatReleaseVersions = db
    .select({ version: releasesTable.version })
    .from(releasesTable)
    .where(eq(releasesTable.habitatId, habitatId))
    .all()
    .map((r) => r.version);
  const missionGateMap = new Map(habitatMissions.map((m) => [m.id, m]));

  const eligibleMissionIds = habitatMissionIds.filter((fid) => {
    const deps = db
      .select()
      .from(missionDependencies)
      .innerJoin(missions, eq(missionDependencies.dependsOnId, missions.id))
      .where(and(eq(missionDependencies.missionId, fid), notInArray(missions.status, ["done"])))
      .all();
    if (deps.length > 0) return false;
    const mission = missionGateMap.get(fid);
    if (mission && !isReleaseGateSatisfied(mission, habitatReleaseTypes, habitatReleaseVersions))
      return false;
    return true;
  });

  if (eligibleMissionIds.length === 0) return [];

  const conditions = [
    inArray(outerTasks.missionId, eligibleMissionIds),
    statusCondition,
    domainCondition,
    notExists(unmetDeps),
  ];

  if (filters?.priority) {
    conditions.push(eq(outerTasks.priority, filters.priority));
  }

  const priorityOrder = priorityOrderExpr(outerTasks.priority);

  const candidates = filters?.limit
    ? db
        .select()
        .from(outerTasks)
        .where(and(...conditions))
        .orderBy(priorityOrder, asc(outerTasks.createdAt))
        .limit(filters.limit)
        .all()
    : db
        .select()
        .from(outerTasks)
        .where(and(...conditions))
        .orderBy(priorityOrder, asc(outerTasks.createdAt))
        .all();

  return candidates.filter((task) => areAllWorkflowGatesSatisfied(task.id));
}

export function getTasksByDependency(dependsOnId: string): Task[] {
  const db = getDb();
  return db
    .select()
    .from(tasks)
    .innerJoin(taskDependencies, eq(tasks.id, taskDependencies.taskId))
    .where(eq(taskDependencies.dependsOnId, dependsOnId))
    .all()
    .map((row: { tasks: Task }) => row.tasks);
}

export function areAllDependenciesMet(taskId: string): boolean {
  const db = getDb();
  const result = db
    .select({ count: count() })
    .from(taskDependencies)
    .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
    .where(and(eq(taskDependencies.taskId, taskId), notInArray(tasks.status, ["done", "approved"])))
    .get();
  return (result?.count ?? 0) === 0;
}

/**
 * Canonical-path mirror of the read-path mission-dependency filter
 * (`getAvailableTasksForAgent` lines ~164-170). Returns true when every mission
 * this task's mission depends on is `done` (or there are no deps / no mission).
 */
export function areAllMissionDependenciesMet(taskId: string): boolean {
  const db = getDb();
  const task = db
    .select({ missionId: tasks.missionId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!task?.missionId) return true;
  const result = db
    .select({ count: count() })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.dependsOnId, missions.id))
    .where(
      and(eq(missionDependencies.missionId, task.missionId), notInArray(missions.status, ["done"])),
    )
    .get();
  return (result?.count ?? 0) === 0;
}

/**
 * Canonical-path mirror of the read-path release-gate check
 * (`getAvailableTasksForAgent` lines ~148-174). Returns true when the task's
 * mission has no gate set, is missing, or its gate is satisfied by shipped
 * habitat releases.
 */
export function isReleaseGateSatisfiedForTask(taskId: string): boolean {
  const db = getDb();
  const task = db
    .select({ missionId: tasks.missionId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!task?.missionId) return true;
  const mission = db.select().from(missions).where(eq(missions.id, task.missionId)).get();
  if (!mission) return true;
  const habitatReleaseTypes = new Set(
    db
      .select({ releaseType: releasesTable.releaseType })
      .from(releasesTable)
      .where(eq(releasesTable.habitatId, mission.habitatId))
      .all()
      .map((r) => r.releaseType as ReleaseType),
  );
  const habitatReleaseVersions = db
    .select({ version: releasesTable.version })
    .from(releasesTable)
    .where(eq(releasesTable.habitatId, mission.habitatId))
    .all()
    .map((r) => r.version);
  return isReleaseGateSatisfied(mission, habitatReleaseTypes, habitatReleaseVersions);
}

/**
 * Thin shared predicate that aggregates all four claimability guards
 * (dependencies, mission dependencies, release gate, workflow gates) into a
 * single result. This is the mutation authority used inside claim transactions
 * and by batch assignment so guard ordering and failure reasons cannot drift.
 */
export function checkClaimability(taskId: string): { claimable: boolean; reason?: string } {
  if (!areAllDependenciesMet(taskId)) return { claimable: false, reason: "dependencies_unmet" };
  if (!areAllMissionDependenciesMet(taskId))
    return { claimable: false, reason: "mission_dependencies_unmet" };
  if (!isReleaseGateSatisfiedForTask(taskId))
    return { claimable: false, reason: "release_gate_unmet" };
  if (!areAllWorkflowGatesSatisfied(taskId))
    return { claimable: false, reason: "workflow_gates_unmet" };
  return { claimable: true };
}

export function getTasksPendingRetry(): Task[] {
  const db = getDb();
  const now = new Date().toISOString();
  return db
    .select()
    .from(tasks)
    .where(
      and(
        isNotNull(tasks.nextRetryAt),
        lt(tasks.nextRetryAt, now),
        inArray(tasks.status, ["rejected", "failed"]),
      ),
    )
    .all();
}

export function getTasksByHabitatId(
  habitatId: string,
  filters?: TaskListFilters,
): { tasks: Task[]; total: number } {
  const db = getDb();

  const missionConditions = [eq(missions.habitatId, habitatId)];
  if (filters?.isArchived !== undefined) {
    missionConditions.push(eq(missions.isArchived, filters.isArchived));
  }

  const habitatMissions = db
    .select({ id: missions.id })
    .from(missions)
    .where(and(...missionConditions))
    .all();
  const habitatMissionIds = habitatMissions.map((f) => f.id);

  if (habitatMissionIds.length === 0) return { tasks: [], total: 0 };

  const conditions = [inArray(tasks.missionId, habitatMissionIds)];
  if (filters?.status) conditions.push(eq(tasks.status, filters.status));
  if (filters?.priority) conditions.push(eq(tasks.priority, filters.priority));
  if (filters?.search) {
    const escaped = filters.search.replace(/\\/g, "\\\\").replace(/%/g, "\\%").replace(/_/g, "\\_");
    const term = `%${escaped}%`;
    conditions.push(
      or(
        sql`${tasks.title} LIKE ${term} ESCAPE '\\'`,
        sql`${tasks.description} LIKE ${term} ESCAPE '\\'`,
      )!,
    );
  }
  if (filters?.assignedAgentId === null) {
    conditions.push(isNull(tasks.assignedAgentId));
  } else if (filters?.assignedAgentId) {
    conditions.push(eq(tasks.assignedAgentId, filters.assignedAgentId));
  }
  if (filters?.hasUnmetWorkflowGates === true) {
    conditions.push(
      exists(
        db
          .select({ id: taskWorkflowGates.id })
          .from(taskWorkflowGates)
          .where(
            and(
              eq(taskWorkflowGates.downstreamTaskId, tasks.id),
              eq(taskWorkflowGates.satisfied, false),
            ),
          ),
      ),
    );
  }

  const where = and(...conditions);

  const countResult = db.select({ total: count() }).from(tasks).where(where).get();
  const total = countResult?.total ?? 0;

  const sortColumnMap: Record<TaskSortField, unknown> = {
    priority: priorityOrderExpr(tasks.priority),
    title: tasks.title,
    status: tasks.status,
    createdAt: tasks.createdAt,
    updatedAt: tasks.updatedAt,
    assignedAgentId: tasks.assignedAgentId,
    estimatedMinutes: tasks.estimatedMinutes,
  };

  const directionFn = filters?.sortDirection === "desc" ? desc : asc;

  let orderByClauses: unknown[];
  if (filters?.sortBy && filters.sortBy in sortColumnMap) {
    orderByClauses = [directionFn(sortColumnMap[filters.sortBy] as any)];
  } else {
    orderByClauses = [priorityOrderExpr(tasks.priority), asc(tasks.createdAt)];
  }

  const results =
    filters?.limit !== undefined
      ? db
          .select()
          .from(tasks)
          .where(where)
          .orderBy(...(orderByClauses as any))
          .limit(filters.limit)
          .offset(filters?.offset ?? 0)
          .all()
      : db
          .select()
          .from(tasks)
          .where(where)
          .orderBy(...(orderByClauses as any))
          .all();

  return { tasks: results, total };
}
