/**
 * Terminal automation-run audit source adapter.
 *
 * Canonical identity: `automation_run:<runId>` with `collector_family=automation`
 * and the underlying run ID. `source_version` is a hash of projection contract
 * version + terminal status + finished timestamp + normalized projected digest
 * (architecture §Source identity and resolution matrix). The run is a mutable
 * current-state projection (ADR-0035), so the resolver distinguishes `changed`
 * from `available` by recomputing the digest.
 *
 * Admission: only a run with non-null `finishedAt` AND a terminal status
 * (not `running`, not `matched`) may enter a batch. Running/non-terminal runs
 * never enter. Resolution uses direct run-by-ID lookup (`getRuleRunById`) —
 * never a whole-habitat audit-projection rebuild.
 */
import type { AutomationRuleRun } from "@orcy/shared";
import { getRuleRunById } from "../../../repositories/automationRuleRun.js";
import {
  listForAudit,
  type AutomationRunAuditRow,
} from "../../../repositories/auditProjection/automationRuns.js";
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

const SOURCE_TYPE = "automation_run_audit" as const;
const COLLECTOR_FAMILY = "automation";
const CONTRACT_VERSION = "automation-run-v1";
const SOURCE_ID_PREFIX = "automation_run";

/** Non-terminal statuses that may never enter a batch. */
const NON_TERMINAL_STATUSES = new Set(["running", "matched"]);

function isTerminal(run: AutomationRuleRun): boolean {
  return run.finishedAt !== null && !NON_TERMINAL_STATUSES.has(run.status as string);
}

/** Normalized projected digest of a terminal run's content. */
function normalizedRunDigest(run: AutomationRuleRun): string {
  return computeDigest({
    status: run.status,
    finishedAt: run.finishedAt,
    ruleId: run.ruleId,
    triggerType: run.triggerType,
    targetType: run.targetType,
    targetId: run.targetId,
    fingerprint: run.fingerprint,
  });
}

function occurredAt(run: AutomationRuleRun): string {
  return run.finishedAt ?? run.startedAt;
}

function rowToObservation(row: AutomationRunAuditRow): ExtractionObservation {
  const { run } = row;
  const digest = normalizedRunDigest(run);
  return {
    observationId: mintObservationId(SOURCE_TYPE, run.id),
    sourceType: SOURCE_TYPE,
    underlyingId: run.id,
    occurredAt: occurredAt(run),
    // Operational record: carries its own entity ref only. Target-derived
    // task/mission refs are intentionally NOT projected, so an automation-run
    // citation never establishes task/mission/domain scope (habitat-wide only).
    entityRefs: [{ type: "automation_run", id: run.id }],
    domains: [],
    digest,
    contractVersion: CONTRACT_VERSION,
    collectorFamily: COLLECTOR_FAMILY,
    habitatId: run.habitatId,
    visibilityClass: "habitat_member",
  };
}

function listTerminalRows(
  habitatId: string,
): { row: AutomationRunAuditRow; run: AutomationRuleRun }[] {
  return listForAudit(habitatId)
    .map((row) => ({ row, run: row.run }))
    .filter((entry) => isTerminal(entry.run));
}

export const automationRunAuditAdapter: ExtractionSourceAdapter = {
  type: SOURCE_TYPE,

  captureBoundary(request: SourceWindowRequest): SourceBoundaryToken {
    const entries = listTerminalRows(request.habitatId);
    const highWaterMark = entries.reduce((max, entry) => {
      const ts = occurredAt(entry.run);
      return ts > max ? ts : max;
    }, EPOCH_ISO);
    return makeBoundaryToken(SOURCE_TYPE, highWaterMark);
  },
  collect(request: SourceWindowRequest): SourceBatch {
    let boundaryToken = request.boundaryToken;
    try {
      boundaryToken = boundaryToken ?? this.captureBoundary(request);
      const entries = listTerminalRows(request.habitatId).filter((entry) =>
        isWithinWindow(occurredAt(entry.run), request, boundaryToken!.highWaterMark),
      );
      return {
        sourceType: SOURCE_TYPE,
        observations: entries.map((entry) => rowToObservation(entry.row)),
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
        warnings: ["automation_run_source_unavailable"],
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
      const run = getRuleRunById(underlyingId);
      if (!run) return { ref, state: "dangling" };

      if (run.habitatId !== viewer.habitatId) {
        return { ref, state: "unauthorized" };
      }
      if (!isTerminal(run)) {
        // No longer terminal (mutated back, or was cited before terminalizing).
        // A non-terminal row cannot satisfy a terminal citation.
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
        entityRefs: [{ type: "automation_run", id: run.id }],
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
