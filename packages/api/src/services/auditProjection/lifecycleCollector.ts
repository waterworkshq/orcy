import type { AuditEvent } from "@orcy/shared/types";
import {
  listMissionEventsForAudit,
  listTaskEventsForAudit,
  type MissionAuditRow,
  type TaskAuditRow,
} from "../../repositories/auditProjection/lifecycleEvents.js";
import type { AuditProjectionCollector } from "./types.js";
import {
  buildCompleteness,
  missionSummary,
  normalizeAuditActorAndSource,
  readString,
  taskSummary,
} from "./helpers.js";

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
    const habitatId = request.habitatId;
    const shouldQueryTasks =
      !request.selectedEntityTypes.size || request.selectedEntityTypes.has("task");
    const shouldQueryMissions =
      !request.selectedEntityTypes.size || request.selectedEntityTypes.has("mission");

    const taskRows = shouldQueryTasks ? listTaskEventsForAudit(habitatId) : [];
    const missionRows = shouldQueryMissions ? listMissionEventsForAudit(habitatId) : [];

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
