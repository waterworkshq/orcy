/**
 * Task lifecycle audit source adapter.
 *
 * Canonical identity: `task_event:<rowId>` with `collector_family=lifecycle` and
 * the underlying task-event row ID. The row is append-only, so `source_version`
 * is the projection contract version and the resolver never returns `changed` —
 * only `available | dangling | unauthorized` (architecture §Source identity and
 * resolution matrix).
 *
 * Collection reuses the audit-projection lifecycle join (`listTaskEventsForAudit`)
 * read-only, applies the same effort-action exclusion as the lifecycle collector,
 * and bounds the batch by the captured upper-bound token. Resolution uses direct
 * row-by-ID lookup (`getEventById`) plus the task→mission→habitat chain — never a
 * whole-habitat audit-projection rebuild.
 */
import { getEventById } from "../../../repositories/events/event-crud.js";
import { getMissionById } from "../../../repositories/mission.js";
import { getTaskById } from "../../../repositories/taskCrud.js";
import {
  listTaskEventsForAudit,
  type TaskAuditRow,
} from "../../../repositories/auditProjection/lifecycleEvents.js";
import { computeDigest } from "../digest.js";
import {
  EPOCH_ISO,
  isWithinWindow,
  makeBoundaryToken,
  mintObservationId,
  parseUnderlyingId,
} from "../helpers.js";
import type {
  ExtractionSourceAdapter,
  ExtractionObservation,
  ExtractionSourceRef,
  ResolvedSource,
  ResolveRef,
  SourceBatch,
  SourceBoundaryToken,
  SourceWindowRequest,
  ViewerContext,
} from "../types.js";

const SOURCE_TYPE = "task_lifecycle_audit" as const;
const COLLECTOR_FAMILY = "lifecycle";
const CONTRACT_VERSION = "lifecycle-task-v1";
const SOURCE_ID_PREFIX = "task_event";

/** Effort actions are excluded (mirrors the audit lifecycle collector). */
const EXCLUDED_ACTIONS = new Set(["effort_logged", "effort_corrected"]);

function rowToObservation(row: TaskAuditRow): ExtractionObservation {
  // Source-owned domain projection: the task's `requiredDomain`, when non-null.
  // Free text, labels, and subject text never enter `domains`.
  const task = getTaskById(row.taskId);
  const domains = task?.requiredDomain ? [task.requiredDomain.toLowerCase()] : [];

  return {
    observationId: mintObservationId(SOURCE_TYPE, row.id),
    sourceType: SOURCE_TYPE,
    underlyingId: row.id,
    occurredAt: row.timestamp,
    entityRefs: [
      { type: "task", id: row.taskId },
      { type: "mission", id: row.missionId },
    ],
    domains,
    digest: computeDigest({
      action: row.action,
      taskId: row.taskId,
      missionId: row.missionId,
      timestamp: row.timestamp,
      actorType: row.actorType,
      actorId: row.actorId,
    }),
    contractVersion: CONTRACT_VERSION,
    collectorFamily: COLLECTOR_FAMILY,
    habitatId: row.missionHabitatId,
    visibilityClass: "habitat_member",
  };
}

function listBoundedRows(habitatId: string): TaskAuditRow[] {
  return listTaskEventsForAudit(habitatId).filter((row) => !EXCLUDED_ACTIONS.has(row.action));
}

export const taskLifecycleAuditAdapter: ExtractionSourceAdapter = {
  type: SOURCE_TYPE,

  captureBoundary(request: SourceWindowRequest): SourceBoundaryToken {
    const rows = listBoundedRows(request.habitatId);
    const highWaterMark = rows.reduce(
      (max, row) => (row.timestamp > max ? row.timestamp : max),
      EPOCH_ISO,
    );
    return makeBoundaryToken(SOURCE_TYPE, highWaterMark);
  },
  collect(request: SourceWindowRequest): SourceBatch {
    let boundaryToken = request.boundaryToken;
    try {
      boundaryToken = boundaryToken ?? this.captureBoundary(request);
      const rows = listBoundedRows(request.habitatId).filter((row) =>
        isWithinWindow(row.timestamp, request, boundaryToken!.highWaterMark),
      );
      return {
        sourceType: SOURCE_TYPE,
        observations: rows.map(rowToObservation),
        completeness: "complete",
        warnings: [],
        boundaryToken: boundaryToken!,
      };
    } catch {
      // Failed source honesty: a source whose collection fails records a
      // partial/failed snapshot with warnings, never an empty success.
      return {
        sourceType: SOURCE_TYPE,
        observations: [],
        completeness: "partial",
        warnings: ["task_lifecycle_source_unavailable"],
        boundaryToken: boundaryToken ?? makeBoundaryToken(SOURCE_TYPE, EPOCH_ISO),
      };
    }
  },

  resolveByRefs(refs: ResolveRef[], viewer: ViewerContext): ResolvedSource[] {
    return refs.map((ref) => {
      const underlyingId = parseUnderlyingId(ref.sourceId, SOURCE_ID_PREFIX);
      if (!underlyingId) {
        return { ref, state: "dangling" };
      }
      const event = getEventById(underlyingId);
      if (!event) return { ref, state: "dangling" };

      // Resolve habitat through task → mission (task events have no direct
      // habitat column). Direct family-specific lookup, no whole-habitat rebuild.
      const task = getTaskById(event.taskId);
      const mission = task ? getMissionById(task.missionId) : null;
      const habitatId = mission?.habitatId ?? null;

      if (habitatId === null) {
        // Underlying task/mission gone: the append-only event no longer resolves.
        return { ref, state: "dangling" };
      }
      // Cross-Habitat denial. The response carries no content, so an
      // unauthorized viewer learns only "not accessible" — not whether the row
      // exists in another Habitat or what it contained.
      if (habitatId !== viewer.habitatId) {
        return { ref, state: "unauthorized" };
      }
      return {
        ref,
        state: "available",
        digest: computeDigest({
          action: event.action,
          taskId: event.taskId,
          timestamp: event.timestamp,
          actorType: event.actorType,
          actorId: event.actorId,
        }),
        entityRefs: [
          { type: "task", id: event.taskId },
          ...(task ? [{ type: "mission", id: task.missionId }] : []),
        ],
        occurredAt: event.timestamp,
      };
    });
  },

  classify(): "habitat_member" {
    return "habitat_member";
  },

  canonicalIdentity(observation: ExtractionObservation): ExtractionSourceRef {
    return {
      sourceType: SOURCE_TYPE,
      sourceId: `${SOURCE_ID_PREFIX}:${observation.underlyingId}`,
      sourceVersion: observation.contractVersion,
      underlyingId: observation.underlyingId,
      collectorFamily: observation.collectorFamily,
      contractVersion: observation.contractVersion,
      digest: observation.digest,
    };
  },
};
