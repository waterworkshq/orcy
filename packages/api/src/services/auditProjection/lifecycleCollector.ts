import type { AuditEvent } from "@orcy/shared/types";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import {
  agents,
  missionEvents,
  missions,
  taskEvents,
  tasks,
} from "../../db/schema/index.js";
import type { AuditProjectionCollector } from "./types.js";
import {
  buildCompleteness,
  missionSummary,
  normalizeAuditActorAndSource,
  readString,
  taskSummary,
} from "./helpers.js";

interface TaskAuditRow {
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

interface MissionAuditRow {
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

function projectTaskRow(row: TaskAuditRow): AuditEvent {
  const normalized = normalizeAuditActorAndSource({
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    metadata: row.metadata,
  });

  return {
    id: `task_event:${row.id}`,
    habitatId: row.missionHabitatId,
    occurredAt: row.timestamp,
    entity: { type: "task", id: row.taskId, title: row.taskTitle },
    action: row.action,
    actor: normalized.actor,
    source: normalized.source,
    provenance: normalized.provenance,
    linkedEntities: [{ type: "mission", id: row.missionId, title: row.missionTitle }],
    summary: taskSummary(row),
    metadata: row.metadata,
    completeness: buildCompleteness(row.metadata),
  };
}

function projectMissionRow(row: MissionAuditRow, fallbackHabitatId: string): AuditEvent {
  const title = row.missionTitle ?? readString(row.metadata.title) ?? row.missionId;
  const habitatId = row.missionHabitatId ?? readString(row.metadata.habitatId) ?? fallbackHabitatId;
  const normalized = normalizeAuditActorAndSource({
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    metadata: row.metadata,
  });

  return {
    id: `mission_event:${row.id}`,
    habitatId,
    occurredAt: row.timestamp,
    entity: { type: "mission", id: row.missionId, title },
    action: row.action,
    actor: normalized.actor,
    source: normalized.source,
    provenance: normalized.provenance,
    linkedEntities: [],
    summary: missionSummary(row, title),
    metadata: row.metadata,
    completeness: buildCompleteness(row.metadata),
  };
}

export const lifecycleCollector: AuditProjectionCollector = {
  key: "lifecycle",
  entityTypes: ["task", "mission"],
  failurePolicy: "fatal",
  collect(request) {
    const db = getDb();
    const habitatId = request.habitatId;
    const shouldQueryTasks = !request.selectedEntityTypes.size
      || request.selectedEntityTypes.has("task");
    const shouldQueryMissions = !request.selectedEntityTypes.size
      || request.selectedEntityTypes.has("mission");

    const taskRows = shouldQueryTasks
      ? (db
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
          .all() as TaskAuditRow[])
      : [];

    const missionRows = shouldQueryMissions
      ? (db
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
          .all() as MissionAuditRow[])
      : [];

    const projectedTaskEvents = taskRows
      .filter((row) => row.action !== "effort_logged" && row.action !== "effort_corrected")
      .map(projectTaskRow);

    const events: AuditEvent[] = [
      ...projectedTaskEvents,
      ...missionRows.map((row) => projectMissionRow(row, habitatId)),
    ];

    return { events, warnings: [], caveats: [] };
  },
};