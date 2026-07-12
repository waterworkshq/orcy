import { getDb } from "../../db/index.js";
import { agents, missionEvents, missions, taskEvents, tasks } from "../../db/schema/index.js";
import { eq, sql } from "drizzle-orm";

export interface TaskAuditRow {
  id: string;
  taskId: string;
  taskTitle: string;
  missionId: string;
  missionTitle: string;
  missionHabitatId: string;
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  actorId: string;
  actorName: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  fromColumnId: string | null;
  toColumnId: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

export interface MissionAuditRow {
  id: string;
  missionId: string;
  missionTitle: string | null;
  missionHabitatId: string | null;
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  actorId: string;
  actorName: string | null;
  action: string;
  fromStatus: string | null;
  toStatus: string | null;
  fromColumnId: string | null;
  toColumnId: string | null;
  metadata: Record<string, unknown>;
  timestamp: string;
}

/**
 * Habitat-scoped join: every task event whose mission belongs to the habitat,
 * with task/mission title and agent name resolved via inner/left joins.
 */
export function listTaskEventsForAudit(habitatId: string): TaskAuditRow[] {
  const db = getDb();
  return db
    .select({
      id: taskEvents.id,
      taskId: taskEvents.taskId,
      taskTitle: tasks.title,
      missionId: tasks.missionId,
      missionTitle: missions.title,
      missionHabitatId: missions.habitatId,
      actorType: taskEvents.actorType,
      actorId: taskEvents.actorId,
      actorName: agents.name,
      action: taskEvents.action,
      fromStatus: taskEvents.fromStatus,
      toStatus: taskEvents.toStatus,
      fromColumnId: taskEvents.fromColumnId,
      toColumnId: taskEvents.toColumnId,
      metadata: taskEvents.metadata,
      timestamp: taskEvents.timestamp,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .leftJoin(agents, eq(taskEvents.actorId, agents.id))
    .where(eq(missions.habitatId, habitatId))
    .all() as TaskAuditRow[];
}

/**
 * Habitat-scoped mission events. Uses a left join on `missions` so that
 * retained-delete events (mission row removed but event retained) still
 * surface — the `missions.id IS NULL` arm of the where clause matches those
 * orphaned rows.
 */
export function listMissionEventsForAudit(habitatId: string): MissionAuditRow[] {
  const db = getDb();
  return db
    .select({
      id: missionEvents.id,
      missionId: missionEvents.missionId,
      missionTitle: missions.title,
      missionHabitatId: missions.habitatId,
      actorType: missionEvents.actorType,
      actorId: missionEvents.actorId,
      actorName: agents.name,
      action: missionEvents.action,
      fromStatus: missionEvents.fromStatus,
      toStatus: missionEvents.toStatus,
      fromColumnId: missionEvents.fromColumnId,
      toColumnId: missionEvents.toColumnId,
      metadata: missionEvents.metadata,
      timestamp: missionEvents.timestamp,
    })
    .from(missionEvents)
    .leftJoin(missions, eq(missionEvents.missionId, missions.id))
    .leftJoin(agents, eq(missionEvents.actorId, agents.id))
    .where(sql`(${missions.habitatId} = ${habitatId} OR ${missions.id} IS NULL)`)
    .all() as MissionAuditRow[];
}
