import type { AuditEvent } from "@orcy/shared/types";
import { eq } from "drizzle-orm";
import { getDb } from "../../db/index.js";
import { agents, effortEntries, missions, tasks } from "../../db/schema/index.js";
import { listForAudit as listTimeRecordsForAudit } from "../../repositories/auditProjection/timeRecords.js";
import type { AuditProjectionCollector } from "./types.js";
import {
  buildCompleteness,
  effortSummary,
  normalizeAuditActorAndSource,
} from "./helpers.js";

interface EffortAuditRow {
  id: string;
  taskId: string;
  taskTitle: string;
  missionId: string;
  missionTitle: string;
  missionHabitatId: string;
  actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
  actorId: string | null;
  actorName: string | null;
  minutes: number;
  source: string;
  note: string | null;
  correctsEntryId: string | null;
  correctionReason: string | null;
  metadata: Record<string, unknown> | null;
  recordedAt: string;
}

function projectEffortRow(row: EffortAuditRow): AuditEvent {
  const metadata = row.metadata ?? {};
  const taskTitle = row.taskTitle;
  const normalized = normalizeAuditActorAndSource({
    actorType: row.actorType,
    actorId: row.actorId,
    actorName: row.actorName,
    metadata,
  });

  return {
    id: `effort_entry:${row.id}`,
    habitatId: row.missionHabitatId,
    occurredAt: row.recordedAt,
    entity: { type: "effort_entry", id: row.id, title: effortSummary(row, taskTitle) },
    action: row.correctsEntryId ? "corrected" : "logged",
    actor: normalized.actor,
    source: normalized.source,
    provenance: normalized.provenance,
    linkedEntities: [
      { type: "task", id: row.taskId, title: row.taskTitle },
      { type: "mission", id: row.missionId, title: row.missionTitle },
      ...(row.correctsEntryId
        ? [
            {
              type: "effort_entry" as const,
              id: row.correctsEntryId,
              title: "Corrected effort entry",
            },
          ]
        : []),
    ],
    summary: effortSummary(row, taskTitle),
    metadata: {
      ...metadata,
      minutes: row.minutes,
      effortSource: row.source,
      note: row.note,
      correctsEntryId: row.correctsEntryId,
      correctionReason: row.correctionReason,
    },
    completeness: buildCompleteness(metadata),
  };
}

export const effortCollector: AuditProjectionCollector = {
  key: "effort",
  entityTypes: ["effort_entry", "time_record"],
  failurePolicy: "fatal",
  collect(request) {
    const db = getDb();
    const habitatId = request.habitatId;
    const shouldQueryEffort = !request.selectedEntityTypes.size
      || request.selectedEntityTypes.has("effort_entry");

    const effortRows = shouldQueryEffort
      ? (db
          .select({
            id: effortEntries.id,
            taskId: effortEntries.taskId,
            taskTitle: tasks.title,
            missionId: tasks.missionId,
            missionTitle: missions.title,
            missionHabitatId: missions.habitatId,
            actorType: effortEntries.actorType,
            actorId: effortEntries.actorId,
            actorName: agents.name,
            minutes: effortEntries.minutes,
            source: effortEntries.source,
            note: effortEntries.note,
            correctsEntryId: effortEntries.correctsEntryId,
            correctionReason: effortEntries.correctionReason,
            metadata: effortEntries.metadata,
            recordedAt: effortEntries.recordedAt,
          })
          .from(effortEntries)
          .innerJoin(tasks, eq(effortEntries.taskId, tasks.id))
          .innerJoin(missions, eq(tasks.missionId, missions.id))
          .leftJoin(agents, eq(effortEntries.actorId, agents.id))
          .where(eq(missions.habitatId, habitatId))
          .all() as EffortAuditRow[])
      : [];

    // time_record query is gated behind explicit selection — DEFAULT_AUDIT_QUERY_ENTITY_TYPES
    // excludes `time_record`. The projector is added in Phase 4 T4.7.
    const shouldQueryTimeRecords = request.selectedEntityTypes.has("time_record");
    const timeRecordRows = shouldQueryTimeRecords
      ? listTimeRecordsForAudit(habitatId)
      : [];

    const timeRecordEvents: AuditEvent[] = timeRecordRows.map((row) => {
      const caveats: string[] = ["Inferred presence record has no heartbeat session provenance."];
      if (!row.record.agentId) caveats.push("Inferred presence record has no agent attribution.");

      return {
        id: `time_record:${row.record.id}`,
        habitatId: row.missionHabitatId,
        occurredAt: row.record.recordedAt,
        entity: {
          type: "time_record",
          id: row.record.id,
          title: `${row.record.minutesSpent}m inferred presence`,
        },
        action: "presence_recorded",
        actor: row.record.agentId
          ? {
              type: "agent",
              id: row.record.agentId,
              ...(row.agentName ? { name: row.agentName } : {}),
            }
          : { type: "system", id: "system:presence" },
        source: row.record.agentId ? "daemon" : "unknown",
        provenance: {},
        linkedEntities: [
          { type: "task", id: row.record.taskId, title: row.taskTitle },
          { type: "mission", id: row.missionId, title: row.missionTitle },
        ],
        summary: `Inferred presence recorded: ${row.record.minutesSpent}m on ${row.taskTitle}`,
        metadata: {
          minutesSpent: row.record.minutesSpent,
          statusDuringWork: row.record.statusDuringWork,
        },
        completeness: { status: "source_unavailable", caveats },
      };
    });

    const events: AuditEvent[] = [...effortRows.map(projectEffortRow), ...timeRecordEvents];

    return { events, warnings: [], caveats: [] };
  },
};