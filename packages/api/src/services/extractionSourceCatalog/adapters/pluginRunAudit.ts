/**
 * Terminal plugin-run audit source adapter.
 *
 * Canonical identity: `plugin_run:<runId>` with `collector_family=plugin` and
 * the underlying run ID. `source_version` is a hash of projection contract
 * version + terminal status + finished timestamp + normalized projected digest.
 * The run is a mutable current-state projection (ADR-0035), so the resolver
 * distinguishes `changed` from `available` by recomputing the digest.
 *
 * Admission: only `succeeded | failed | rate_limited | skipped` with non-null
 * `finishedAt` may enter a batch. Running runs never enter. Resolution uses
 * direct run-by-ID lookup (`getById`) — never a whole-habitat audit-projection
 * rebuild.
 */
import type { PluginRunRow } from "../../../db/schema/plugin.js";
import { getById } from "../../../repositories/pluginRun.js";
import { listForAudit } from "../../../repositories/auditProjection/pluginRuns.js";
import { computeDigest, composeVersion } from "../digest.js";
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

const SOURCE_TYPE = "plugin_run_audit" as const;
const COLLECTOR_FAMILY = "plugin";
const CONTRACT_VERSION = "plugin-run-v1";
const SOURCE_ID_PREFIX = "plugin_run";

/** Terminal statuses a plugin run may carry (ADR-0039). */
const TERMINAL_STATUSES = new Set(["succeeded", "failed", "rate_limited", "skipped"]);

function isAdmissible(run: PluginRunRow): boolean {
  return run.finishedAt !== null && TERMINAL_STATUSES.has(run.status);
}

function normalizedRunDigest(run: PluginRunRow): string {
  return computeDigest({
    status: run.status,
    finishedAt: run.finishedAt,
    pluginId: run.pluginId,
    contributionId: run.contributionId,
    contributionKind: run.contributionKind,
    triggerType: run.triggerType,
    triggerEventId: run.triggerEventId,
    signalsEmitted: run.signalsEmitted,
  });
}

function occurredAt(run: PluginRunRow): string {
  return run.finishedAt ?? run.startedAt;
}

function rowToObservation(run: PluginRunRow): ExtractionObservation {
  const digest = normalizedRunDigest(run);
  return {
    observationId: mintObservationId(SOURCE_TYPE, run.id),
    sourceType: SOURCE_TYPE,
    underlyingId: run.id,
    occurredAt: occurredAt(run),
    // Operational record: carries its own entity ref only. Never projects
    // task/mission/domain scope (habitat-wide operational evidence).
    entityRefs: [{ type: "plugin_run", id: run.id }],
    domains: [],
    digest,
    contractVersion: CONTRACT_VERSION,
    collectorFamily: COLLECTOR_FAMILY,
    habitatId: run.habitatId,
    visibilityClass: "habitat_member",
  };
}

function listAdmissibleRows(habitatId: string): PluginRunRow[] {
  return listForAudit(habitatId).filter(isAdmissible);
}

export const pluginRunAuditAdapter: ExtractionSourceAdapter = {
  type: SOURCE_TYPE,

  captureBoundary(request: SourceWindowRequest): SourceBoundaryToken {
    const rows = listAdmissibleRows(request.habitatId);
    const highWaterMark = rows.reduce((max, run) => {
      const ts = occurredAt(run);
      return ts > max ? ts : max;
    }, EPOCH_ISO);
    return makeBoundaryToken(SOURCE_TYPE, highWaterMark);
  },
  collect(request: SourceWindowRequest): SourceBatch {
    let boundaryToken = request.boundaryToken;
    try {
      boundaryToken = boundaryToken ?? this.captureBoundary(request);
      const rows = listAdmissibleRows(request.habitatId).filter((run) =>
        isWithinWindow(occurredAt(run), request, boundaryToken!.highWaterMark),
      );
      return {
        sourceType: SOURCE_TYPE,
        observations: rows.map(rowToObservation),
        completeness: "complete",
        warnings: [],
        boundaryToken: boundaryToken!,
        collectionOutcome: "collected" as const,
      };
    } catch {
      return {
        sourceType: SOURCE_TYPE,
        observations: [],
        completeness: "partial",
        warnings: ["plugin_run_source_unavailable"],
        boundaryToken: boundaryToken ?? makeBoundaryToken(SOURCE_TYPE, EPOCH_ISO),
        collectionOutcome: "failed" as const,
      };
    }
  },

  resolveByRefs(refs: ResolveRef[], viewer: ViewerContext): ResolvedSource[] {
    return refs.map((ref) => {
      const underlyingId = parseUnderlyingId(ref.sourceId, SOURCE_ID_PREFIX);
      if (!underlyingId) {
        return { ref, state: "dangling" };
      }
      const run = getById(underlyingId);
      if (!run) return { ref, state: "dangling" };

      if (run.habitatId !== viewer.habitatId) {
        return { ref, state: "unauthorized" };
      }
      if (!isAdmissible(run)) {
        return { ref, state: "dangling" };
      }
      const currentDigest = normalizedRunDigest(run);
      if (
        ref.sourceDigest !== undefined &&
        ref.sourceDigest !== null &&
        ref.sourceDigest !== currentDigest
      ) {
        return { ref, state: "changed", digest: currentDigest };
      }
      return {
        ref,
        state: "available",
        digest: currentDigest,
        entityRefs: [{ type: "plugin_run", id: run.id }],
        occurredAt: occurredAt(run),
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
      sourceVersion: composeVersion(observation.contractVersion, {
        digest: observation.digest,
      }),
      underlyingId: observation.underlyingId,
      collectorFamily: observation.collectorFamily,
      contractVersion: observation.contractVersion,
      digest: observation.digest,
    };
  },
};
