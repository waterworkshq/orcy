/**
 * Mission lifecycle audit source adapter.
 *
 * Canonical identity: `mission_event:<rowId>` with `collector_family=lifecycle`
 * and the underlying mission-event row ID. The row is append-only, so
 * `source_version` is the projection contract version and the resolver never
 * returns `changed` — only `available | dangling | unauthorized`.
 *
 * Collection reuses the audit-projection mission join (`listMissionEventsForAudit`)
 * read-only and bounds the batch by the captured upper-bound token. Resolution
 * uses direct row-by-ID lookup (`getMissionEventById`) plus mission→habitat —
 * never a whole-habitat audit-projection rebuild.
 */
import { getMissionById } from "../../../repositories/mission.js";
import { getMissionEventById } from "../../../repositories/events/event-feature.js";
import {
  listMissionEventsForAudit,
  type MissionAuditRow,
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

const SOURCE_TYPE = "mission_lifecycle_audit" as const;
const COLLECTOR_FAMILY = "lifecycle";
const CONTRACT_VERSION = "lifecycle-mission-v1";
const SOURCE_ID_PREFIX = "mission_event";

function rowToObservation(row: MissionAuditRow, fallbackHabitatId: string): ExtractionObservation {
  const habitatId = row.missionHabitatId ?? fallbackHabitatId;
  return {
    observationId: mintObservationId(SOURCE_TYPE, row.id),
    sourceType: SOURCE_TYPE,
    underlyingId: row.id,
    occurredAt: row.timestamp,
    entityRefs: [{ type: "mission", id: row.missionId }],
    // Missions carry no source-owned domain projection on their event rows;
    // domains are intentionally empty (labels/subject text never grant scope).
    domains: [],
    digest: computeDigest({
      action: row.action,
      missionId: row.missionId,
      timestamp: row.timestamp,
      actorType: row.actorType,
      actorId: row.actorId,
    }),
    contractVersion: CONTRACT_VERSION,
    collectorFamily: COLLECTOR_FAMILY,
    habitatId,
    visibilityClass: "habitat_member",
  };
}

function listBoundedRows(habitatId: string): MissionAuditRow[] {
  return listMissionEventsForAudit(habitatId);
}

export const missionLifecycleAuditAdapter: ExtractionSourceAdapter = {
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
        observations: rows.map((row) => rowToObservation(row, request.habitatId)),
        completeness: "complete",
        warnings: [],
        boundaryToken: boundaryToken!,
      };
    } catch {
      return {
        sourceType: SOURCE_TYPE,
        observations: [],
        completeness: "partial",
        warnings: ["mission_lifecycle_source_unavailable"],
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
      const event = getMissionEventById(underlyingId);
      if (!event) return { ref, state: "dangling" };

      const mission = getMissionById(event.missionId);
      const habitatId = mission?.habitatId ?? null;
      if (habitatId === null) {
        return { ref, state: "dangling" };
      }
      if (habitatId !== viewer.habitatId) {
        return { ref, state: "unauthorized" };
      }
      return {
        ref,
        state: "available",
        digest: computeDigest({
          action: event.action,
          missionId: event.missionId,
          timestamp: event.timestamp,
          actorType: event.actorType,
          actorId: event.actorId,
        }),
        entityRefs: [{ type: "mission", id: event.missionId }],
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
