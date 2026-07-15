import { getDb } from "../db/index.js";
import { missions, missionDependencies, columns } from "../db/schema/index.js";
import { eq, and, sql, count, max, asc, notInArray } from "drizzle-orm";
import { priorityOrderExpr } from "../db/sql-helpers.js";
import type { Mission, MissionStatus, TaskPriority } from "../models/index.js";
import { v4 as uuid } from "uuid";
import { badRequest } from "../errors.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
  repositoryTransactionError,
} from "../errors/repository.js";

function normalizeMissionId(id: string): { exact: string; withPrefix: string | null } {
  if (id.startsWith("mission-")) {
    return { exact: id, withPrefix: null };
  }
  return { exact: id, withPrefix: `mission-${id}` };
}

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
  displayOrder?: number;
  releaseGateType?: "patch" | "minor" | "major" | null;
  releaseGateVersion?: string | null;
  releaseDeadlineType?: "patch" | "minor" | "major" | null;
  releaseDeadlineVersion?: string | null;
}

export interface UpdateMissionInput {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: TaskPriority;
  labels?: string[];
  columnId?: string;
  status?: MissionStatus;
  dependsOn?: string[];
  blocks?: string[];
  dueAt?: string | null;
  slaMinutes?: number | null;
  slaDeadlineAt?: string | null;
  displayOrder?: number;
  isArchived?: boolean;
  releaseGateType?: "patch" | "minor" | "major" | null;
  releaseGateVersion?: string | null;
  releaseDeadlineType?: "patch" | "minor" | "major" | null;
  releaseDeadlineVersion?: string | null;
}

export function createMission(input: CreateMissionInput): Mission {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  let columnId = input.columnId;
  if (!columnId) {
    const habitatColumns = db
      .select()
      .from(columns)
      .where(eq(columns.habitatId, input.habitatId))
      .orderBy(columns.order)
      .all();
    columnId = habitatColumns[0]?.id;
    if (!columnId) throw badRequest("Habitat has no columns");
  }

  let displayOrder = input.displayOrder;
  if (displayOrder === undefined) {
    const result = db
      .select({ maxOrder: max(missions.displayOrder) })
      .from(missions)
      .where(eq(missions.columnId, columnId))
      .get();
    displayOrder = (result?.maxOrder ?? -1) + 1;
  }

  try {
    db.transaction((tx) => {
      tx.insert(missions)
        .values({
          id,
          habitatId: input.habitatId,
          columnId,
          title: input.title,
          description: input.description ?? "",
          acceptanceCriteria: input.acceptanceCriteria ?? "",
          priority: input.priority ?? "medium",
          labels: input.labels ?? [],
          status: "not_started",
          displayOrder,
          dependsOn: input.dependsOn ?? [],
          blocks: input.blocks ?? [],
          dueAt: input.dueAt ?? null,
          slaMinutes: input.slaMinutes ?? null,
          createdBy: input.createdBy,
          createdAt: now,
          updatedAt: now,
          version: 1,
          releaseGateType: input.releaseGateType ?? null,
          releaseGateVersion: input.releaseGateVersion ?? null,
          releaseDeadlineType: input.releaseDeadlineType ?? null,
          releaseDeadlineVersion: input.releaseDeadlineVersion ?? null,
        })
        .run();

      if (input.dependsOn && input.dependsOn.length > 0) {
        tx.insert(missionDependencies)
          .values(input.dependsOn.map((depId) => ({ missionId: id, dependsOnId: depId })))
          .run();
      }

      if (input.blocks && input.blocks.length > 0) {
        tx.insert(missionDependencies)
          .values(input.blocks.map((blockedId) => ({ missionId: blockedId, dependsOnId: id })))
          .run();
      }
    });
  } catch (err) {
    throw repositoryCreateError("mission", err as Error, id);
  }

  const mission = getMissionById(id);
  if (!mission) throw repositoryNotFoundError("mission", id);
  return mission;
}

export function getMissionById(id: string): Mission | null {
  const db = getDb();
  const { exact, withPrefix } = normalizeMissionId(id);
  const result = db.select().from(missions).where(eq(missions.id, exact)).get() as Mission | null;
  if (result) return result;
  if (withPrefix) {
    return (db.select().from(missions).where(eq(missions.id, withPrefix)).get() as Mission) ?? null;
  }
  return null;
}

export function getMissionsByHabitatId(
  habitatId: string,
  filters?: {
    columnId?: string;
    status?: MissionStatus;
    priority?: TaskPriority;
    limit?: number;
    offset?: number;
    isArchived?: boolean;
  },
): { missions: Mission[]; total: number } {
  const db = getDb();

  const conditions = [eq(missions.habitatId, habitatId)];
  if (filters?.columnId) conditions.push(eq(missions.columnId, filters.columnId));
  if (filters?.status) conditions.push(eq(missions.status, filters.status));
  if (filters?.priority) conditions.push(eq(missions.priority, filters.priority));
  if (filters?.isArchived !== undefined)
    conditions.push(eq(missions.isArchived, filters.isArchived));

  const where = and(...conditions);

  const countResult = db.select({ total: count() }).from(missions).where(where).get();
  const total = countResult?.total ?? 0;

  const priorityOrder = priorityOrderExpr(missions.priority);

  const query = db
    .select()
    .from(missions)
    .where(where)
    .orderBy(asc(missions.displayOrder), priorityOrder, asc(missions.createdAt));
  const results =
    filters?.limit !== undefined
      ? query
          .limit(filters.limit)
          .offset(filters?.offset ?? 0)
          .all()
      : query.all();

  return { missions: results as Mission[], total };
}

export function updateMission(
  id: string,
  input: UpdateMissionInput,
  expectedVersion?: number,
):
  | { success: true; mission: Mission }
  | { success: false; notFound: true }
  | { success: false; versionMismatch: true; currentVersion: number } {
  const db = getDb();
  const now = new Date().toISOString();

  if (expectedVersion !== undefined) {
    const existing = db
      .select({ id: missions.id, version: missions.version })
      .from(missions)
      .where(eq(missions.id, id))
      .get();
    if (!existing) return { success: false, notFound: true };
    if (existing.version !== expectedVersion) {
      return { success: false, versionMismatch: true, currentVersion: existing.version };
    }
  } else {
    const existing = db.select({ id: missions.id }).from(missions).where(eq(missions.id, id)).get();
    if (!existing) return { success: false, notFound: true };
  }

  const set: Partial<typeof missions.$inferInsert> = { updatedAt: now };

  if (input.title !== undefined) set.title = input.title;
  if (input.description !== undefined) set.description = input.description;
  if (input.acceptanceCriteria !== undefined) set.acceptanceCriteria = input.acceptanceCriteria;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.labels !== undefined) set.labels = input.labels;
  if (input.columnId !== undefined) set.columnId = input.columnId;
  if (input.status !== undefined) set.status = input.status;
  if (input.dependsOn !== undefined) set.dependsOn = input.dependsOn;
  if (input.blocks !== undefined) set.blocks = input.blocks;
  if (input.dueAt !== undefined) set.dueAt = input.dueAt;
  if (input.slaMinutes !== undefined) set.slaMinutes = input.slaMinutes;
  if (input.slaDeadlineAt !== undefined) set.slaDeadlineAt = input.slaDeadlineAt;
  if (input.displayOrder !== undefined) set.displayOrder = input.displayOrder;
  if (input.isArchived !== undefined) set.isArchived = input.isArchived;
  if (input.releaseGateType !== undefined) set.releaseGateType = input.releaseGateType;
  if (input.releaseGateVersion !== undefined) set.releaseGateVersion = input.releaseGateVersion;
  if (input.releaseDeadlineType !== undefined) set.releaseDeadlineType = input.releaseDeadlineType;
  if (input.releaseDeadlineVersion !== undefined)
    set.releaseDeadlineVersion = input.releaseDeadlineVersion;

  try {
    db.transaction((tx) => {
      tx.update(missions)
        .set({ ...set, version: sql`${missions.version} + 1` })
        .where(eq(missions.id, id))
        .run();

      if (input.dependsOn !== undefined) {
        tx.delete(missionDependencies).where(eq(missionDependencies.missionId, id)).run();
        if (input.dependsOn.length > 0) {
          tx.insert(missionDependencies)
            .values(input.dependsOn.map((depId) => ({ missionId: id, dependsOnId: depId })))
            .run();
        }
      }

      if (input.blocks !== undefined) {
        tx.delete(missionDependencies).where(eq(missionDependencies.dependsOnId, id)).run();
        if (input.blocks.length > 0) {
          tx.insert(missionDependencies)
            .values(input.blocks.map((blockedId) => ({ missionId: blockedId, dependsOnId: id })))
            .run();
        }
      }
    });
  } catch (err) {
    throw repositoryTransactionError("mission", err as Error, id);
  }

  const mission = getMissionById(id);
  return { success: true, mission: mission! };
}

export function deleteMission(id: string): void {
  const db = getDb();
  try {
    db.delete(missions).where(eq(missions.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("mission", err as Error, id);
  }
}

export function moveMission(
  missionId: string,
  toColumnId: string,
  expectedVersion?: number,
):
  | { success: true; mission: Mission }
  | { success: false; notFound: true }
  | { success: false; versionMismatch: true; currentVersion: number } {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = db
    .select({ id: missions.id, version: missions.version })
    .from(missions)
    .where(eq(missions.id, missionId))
    .get();
  if (!existing) return { success: false, notFound: true };
  if (expectedVersion !== undefined && existing.version !== expectedVersion) {
    return { success: false, versionMismatch: true, currentVersion: existing.version };
  }

  try {
    db.update(missions)
      .set({ columnId: toColumnId, updatedAt: now, version: sql`${missions.version} + 1` })
      .where(eq(missions.id, missionId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("mission", err as Error, missionId);
  }
  const updated = getMissionById(missionId);
  return { success: true, mission: updated! };
}

export function reorderMission(
  missionId: string,
  afterMissionId: string | null,
  beforeMissionId: string | null,
): Mission | null {
  const db = getDb();
  const now = new Date().toISOString();

  const mission = getMissionById(missionId);
  if (!mission) return null;

  const columnId = mission.columnId;

  let newOrder: number;
  if (afterMissionId === null && beforeMissionId === null) {
    const result = db
      .select({ maxOrder: max(missions.displayOrder) })
      .from(missions)
      .where(eq(missions.columnId, columnId))
      .get();
    newOrder = (result?.maxOrder ?? -1) + 1;
  } else if (afterMissionId !== null) {
    const afterRow = db
      .select({ displayOrder: missions.displayOrder })
      .from(missions)
      .where(eq(missions.id, afterMissionId))
      .get();
    if (!afterRow) return null;
    newOrder = afterRow.displayOrder + 1;
    db.update(missions)
      .set({ displayOrder: sql`${missions.displayOrder} + 1` })
      .where(
        and(
          eq(missions.columnId, columnId),
          sql`${missions.displayOrder} > ${afterRow.displayOrder}`,
        ),
      )
      .run();
  } else {
    const beforeRow = db
      .select({ displayOrder: missions.displayOrder })
      .from(missions)
      .where(eq(missions.id, beforeMissionId!))
      .get();
    if (!beforeRow) return null;
    newOrder = beforeRow.displayOrder;
    db.update(missions)
      .set({ displayOrder: sql`${missions.displayOrder} + 1` })
      .where(
        and(
          eq(missions.columnId, columnId),
          sql`${missions.displayOrder} >= ${beforeRow.displayOrder}`,
        ),
      )
      .run();
  }

  try {
    db.update(missions)
      .set({ displayOrder: newOrder, updatedAt: now, version: sql`${missions.version} + 1` })
      .where(eq(missions.id, missionId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("mission", err as Error, missionId);
  }
  return getMissionById(missionId);
}

export function addMissionDependency(missionId: string, dependsOnId: string): void {
  const db = getDb();
  try {
    db.insert(missionDependencies).values({ missionId, dependsOnId }).run();
  } catch (err) {
    throw repositoryCreateError("missionDependency", err as Error, `${missionId}->${dependsOnId}`);
  }
}

export function removeMissionDependency(missionId: string, dependsOnId: string): void {
  const db = getDb();
  try {
    db.delete(missionDependencies)
      .where(
        and(
          eq(missionDependencies.missionId, missionId),
          eq(missionDependencies.dependsOnId, dependsOnId),
        ),
      )
      .run();
  } catch (err) {
    throw repositoryDeleteError("missionDependency", err as Error, `${missionId}->${dependsOnId}`);
  }
}

export function areAllMissionDependenciesMet(missionId: string): boolean {
  const db = getDb();
  const result = db
    .select({ count: count() })
    .from(missionDependencies)
    .innerJoin(missions, eq(missionDependencies.dependsOnId, missions.id))
    .where(and(eq(missionDependencies.missionId, missionId), notInArray(missions.status, ["done"])))
    .get();
  return (result?.count ?? 0) === 0;
}

export function getMissionsByDependency(dependsOnId: string): Mission[] {
  const db = getDb();
  return db
    .select()
    .from(missions)
    .innerJoin(missionDependencies, eq(missions.id, missionDependencies.missionId))
    .where(eq(missionDependencies.dependsOnId, dependsOnId))
    .all()
    .map((row: any) => row.missions);
}
