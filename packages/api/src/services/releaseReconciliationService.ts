/**
 * Release reconciliation service (restored lifecycle T7).
 *
 * Replaces the one-shot Release processing chain with durable per-projection
 * reconciliation over ONE immutable activation epoch per Release:
 *
 * # Bootstrap (the single orchestration seam)
 * `bootstrapReleaseWithEpoch` atomically create-or-loads the Release row, its
 * activation epoch (frozen cap + deterministic eligible Mission groups +
 * exact Finding membership + eligibility digest), and the five pending
 * projection rows. Pre-cutover Releases (created before this ticket, already
 * processed by the retired one-shot chain) carry no epoch and are reported
 * `legacy` — the caller returns without re-emitting effects.
 *
 * # Activation reconciliation
 * Per frozen Mission group, ONE `BEGIN IMMEDIATE` transaction rereads the
 * live homogeneous group, the frozen membership/digest, the epoch cap, and
 * the count of Findings already carrying `activation_release_id` under the
 * writer lock, then either activates the WHOLE group through the shared
 * kernel (`runReleaseActivationOnReservedClient` — no nested transaction;
 * gate retained; Release attribution) or records an explicit deferral
 * (`deferred_changed` / `deferred_oversized` / `deferred_budget`). A FINAL
 * immediate transaction rechecks every still-pending group against the same
 * frozen snapshot + budget before the activation projection and the epoch
 * are marked complete. Two reconcilers can therefore never oversubscribe
 * the cap, partially activate a shared Mission, or complete while a frozen
 * group is unclassified. Epoch completion is final and never reopens.
 *
 * # Notification + retrospective Pulse projections
 * Deterministic Release-scoped identities (`(eventType, sourceId=release)` /
 * the pulse created atomically with completion); target + delivery
 * completion commit on ONE supplied client, so replay never duplicates
 * targets.
 *
 * # `release.shipped`
 * The projection completes exactly when the durable Automation inbox handoff
 * (`admitReleaseShippedEventToInbox`, same client, idempotent on event
 * identity) commits. The fenced inbox owns rule processing and recovery;
 * the eager best-effort drain + the boot/interval scheduler (`initAutomation
 * InboxDrain`) only advance it. Inbox `attention_required` does NOT make the
 * Release falsely incomplete.
 *
 * Projection order is explicit: activation reconciliation → deadline
 * notification → activation notification → retrospective Pulse →
 * `release.shipped`. A failure leaves the failed projection and all later
 * projections pending; a replay resumes from durable state.
 */
import { createHash } from "crypto";
import { eq, and, or, isNotNull, ne } from "drizzle-orm";
import { sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { habitats, missions, notificationEvents } from "../db/schema/index.js";
import * as projRepo from "../repositories/releaseProjection.js";
import type {
  ReleaseProjectionDbClient,
  ReleaseActivationEpoch,
  EpochGroupRow,
} from "../repositories/releaseProjection.js";
import type { Release } from "../repositories/release.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import { getMissionByIdWithClient } from "../repositories/mission.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as pulseRepo from "../repositories/pulse.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { badRequest } from "../errors.js";
import {
  withImmediateLifecycleTransaction,
  runReleaseActivationOnReservedClient,
} from "./findingTriageLifecycle.js";
import { admitReleaseShippedEventToInbox, drainAutomationInbox } from "./automationInboxService.js";
import { enqueueNotificationForRecipients } from "./notificationCommandService.js";
import {
  DEFAULT_RELEASE_SETTINGS,
  isReleaseGateSatisfied,
  classifyReleaseType,
  parseVersion,
  type ReleaseType,
  type DetectorSource,
} from "@orcy/shared";

type DbClient = ReleaseProjectionDbClient;

// ---------------------------------------------------------------------------
// Public result types
// ---------------------------------------------------------------------------

/** Outcome of the create-or-load bootstrap seam. */
export type ReleaseBootstrap =
  | { status: "created"; release: Release; epoch: ReleaseActivationEpoch }
  | { status: "loaded"; release: Release; epoch: ReleaseActivationEpoch }
  /** Pre-cutover Release without an epoch — the retired one-shot chain already processed it. */
  | { status: "legacy"; release: Release };

/** Cumulative epoch summary derived from durable group dispositions. */
export interface EpochCounts {
  groupCount: number;
  activatedFindingCount: number;
  cappedFindingCount: number;
  deferredChangedCount: number;
  activatedGroups: number;
  deferredGroups: number;
}

/** Result of running the full ordered projection pass. */
export interface ReleaseReconciliationSummary {
  promotedCount: number;
  createdMissionCount: number;
  skippedCount: number;
  erroredCount: number;
  missedDeadlineCount: number;
  cappedCount: number;
  /** Legacy naming retained for the retrospective/notification payloads. */
  activatedMissionCount: number;
  incompleteProjections: projRepo.ReleaseProjectionKind[];
}

/** Per-group reconciliation outcome (also the worker-race report shape). */
export interface GroupReconciliationOutcome {
  groupId: string;
  missionId: string;
  disposition: string;
  detail: string | null;
}

// ---------------------------------------------------------------------------
// Freeze inputs (cap + kill switch) — read on the transaction client so the
// worker-process reconciler freezes from ITS OWN connection.
// ---------------------------------------------------------------------------

function resolveFreezeInputs(
  client: DbClient,
  habitatId: string,
): { frozenCap: number | null; autoPromote: boolean } {
  const envFlag = process.env.ORCY_RELEASE_AUTO_PROMOTE?.toLowerCase();
  const envEnabled = !(
    envFlag === "false" ||
    envFlag === "0" ||
    envFlag === "off" ||
    envFlag === "no"
  );
  const habitat = client.select().from(habitats).where(eq(habitats.id, habitatId)).get() as
    | { releaseSettings?: Record<string, unknown> | null }
    | undefined;
  const settings = habitat?.releaseSettings ?? null;
  const autoPromoteHabitat =
    (settings?.autoPromote as boolean | undefined) ?? DEFAULT_RELEASE_SETTINGS.autoPromote;
  return {
    frozenCap:
      (settings?.maxPromotionsPerRelease as number | null | undefined) ??
      DEFAULT_RELEASE_SETTINGS.maxPromotionsPerRelease,
    autoPromote: envEnabled && autoPromoteHabitat,
  };
}

// ---------------------------------------------------------------------------
// Eligible-group snapshot helpers
// ---------------------------------------------------------------------------

/** Gate/deadline match test shared with the retired one-shot semantics. */
function gateSatisfied(
  mission: { releaseGateType: string | null; releaseGateVersion: string | null },
  shippedType: ReleaseType,
  shippedVersion: string,
): boolean {
  return isReleaseGateSatisfied(
    {
      releaseGateType: mission.releaseGateType as "patch" | "minor" | "major" | null,
      releaseGateVersion: mission.releaseGateVersion,
    },
    new Set([shippedType]),
    [shippedVersion],
  );
}

function computeMembershipDigest(input: {
  missionId: string;
  gateType: string | null;
  gateVersion: string | null;
  findingIds: string[];
}): string {
  const canonical = JSON.stringify({
    missionId: input.missionId,
    gate: { type: input.gateType, version: input.gateVersion },
    findings: input.findingIds.map((id) => ({ id, status: "triaged" })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

interface FrozenGroup {
  missionId: string;
  missionCreatedAt: string;
  findingIds: string[];
  gateType: string | null;
  gateVersion: string | null;
  membershipDigest: string;
}

/**
 * Derives the deterministic eligible corrective-Mission groups for a Release
 * snapshot: gated `not_started` missions whose gate is satisfied by the
 * shipped release AND whose linked non-terminal Findings form ONE homogeneous
 * `triaged` group (≥1 member; no mixed states — mixed groups are excluded,
 * never partially activated). Order: mission `createdAt`, then id.
 */
function deriveEligibleGroups(
  client: DbClient,
  habitatId: string,
  shippedType: ReleaseType,
  shippedVersion: string,
): FrozenGroup[] {
  const gated = client
    .select()
    .from(missions)
    .where(
      and(
        eq(missions.habitatId, habitatId),
        eq(missions.status, "not_started"),
        or(isNotNull(missions.releaseGateType), isNotNull(missions.releaseGateVersion)),
      ),
    )
    .all()
    .filter((m) => gateSatisfied(m, shippedType, shippedVersion));

  const groups: FrozenGroup[] = [];
  for (const mission of gated) {
    const linked = findingTriageRepo.listNonTerminalByCorrectiveMissionIdWithClient(
      client,
      mission.id,
    );
    if (linked.length === 0) continue;
    const homogeneous = linked.every(
      (f) => f.status === "triaged" && !f.legacyLineageRepairRequired,
    );
    if (!homogeneous) continue;

    const findingIds = linked.map((f) => f.id).sort();
    const gateType = mission.releaseGateType;
    const gateVersion = mission.releaseGateVersion;
    groups.push({
      missionId: mission.id,
      missionCreatedAt: mission.createdAt,
      findingIds,
      gateType,
      gateVersion,
      membershipDigest: computeMembershipDigest({
        missionId: mission.id,
        gateType,
        gateVersion,
        findingIds,
      }),
    });
  }

  groups.sort((a, b) =>
    a.missionCreatedAt === b.missionCreatedAt
      ? a.missionId < b.missionId
        ? -1
        : 1
      : a.missionCreatedAt < b.missionCreatedAt
        ? -1
        : 1,
  );
  return groups;
}

// ---------------------------------------------------------------------------
// Bootstrap — the single orchestration seam
// ---------------------------------------------------------------------------

/**
 * Atomically create-or-load the Release + epoch + pending projections.
 *
 * The immediate transaction insert-or-reads the `(habitatId, version)` row
 * FIRST (a replay never re-classifies), then classifies a NEW release
 * (caller-override or semver-diff against the most recent prior row, read on
 * the same client), freezes the epoch on first creation, and ensures the
 * five projection rows exist.
 */
export function bootstrapReleaseWithEpoch(
  habitatId: string,
  normalizedVersion: string,
  opts: { releaseType?: ReleaseType; detectedBy: DetectorSource; releaseNotes?: string },
  db?: DbClient,
): ReleaseBootstrap {
  const outcome = withImmediateLifecycleTransaction<ReleaseBootstrap>((client) => {
    // Existing-first: a replay NEVER re-classifies — the stored release type
    // is authoritative and a duplicate webhook carries no type override.
    const existing = projRepo.findReleaseByHabitatAndVersionWithClient(
      client,
      habitatId,
      normalizedVersion,
    );
    if (existing) {
      const epoch = projRepo.getEpochByReleaseIdWithClient(client, existing.id);
      if (!epoch) {
        // Pre-cutover row: the retired one-shot chain already processed it.
        return {
          outcome: "applied" as const,
          value: { status: "legacy" as const, release: existing },
        };
      }
      projRepo.ensureProjectionsWithClient(client, existing);
      return {
        outcome: "applied" as const,
        value: { status: "loaded" as const, release: existing, epoch },
      };
    }

    // Classification for a NEW release only (caller-override or semver-diff
    // against the most recent prior row, read on the same client).
    let releaseType: ReleaseType;
    let classificationMethod: "caller" | "self";
    if (opts.releaseType) {
      releaseType = opts.releaseType;
      classificationMethod = "caller";
    } else {
      const prior = projRepo.findMostRecentPriorWithClient(client, habitatId, normalizedVersion);
      if (!prior) {
        throw badRequest("First detected release requires an explicit type");
      }
      releaseType = classifyReleaseType(
        parseVersion(prior.version),
        parseVersion(normalizedVersion),
      );
      classificationMethod = "self";
    }

    const release = projRepo.createReleaseWithClient(client, {
      habitatId,
      version: normalizedVersion,
      releaseType,
      detectedBy: opts.detectedBy,
      releaseNotes: opts.releaseNotes,
      metadata: { classificationMethod },
    });

    // --- Freeze the immutable activation epoch ONCE, with the Release ---
    const { frozenCap, autoPromote } = resolveFreezeInputs(client, habitatId);
    const groups = autoPromote
      ? deriveEligibleGroups(client, habitatId, releaseType, release.version)
      : [];
    const epochDigest = createHash("sha256")
      .update(groups.map((g) => g.membershipDigest).join("\n"))
      .digest("hex");
    const epoch = projRepo.createEpochWithClient(client, {
      releaseId: release.id,
      habitatId,
      frozenCap,
      autoPromoteEnabled: autoPromote,
      eligibilityDigest: epochDigest,
    });
    groups.forEach((group, index) => {
      projRepo.createEpochGroupWithClient(client, {
        epochId: epoch.id,
        releaseId: release.id,
        habitatId,
        missionId: group.missionId,
        missionCreatedAt: group.missionCreatedAt,
        position: index,
        findingIds: group.findingIds,
        gateType: group.gateType,
        gateVersion: group.gateVersion,
        membershipDigest: group.membershipDigest,
      });
    });

    projRepo.ensureProjectionsWithClient(client, release);
    return {
      outcome: "applied" as const,
      value: { status: "created" as const, release, epoch },
    };
  }, db);

  if (outcome.outcome === "applied" || outcome.outcome === "replayed") return outcome.value;
  // busy — surface as a typed busy-shaped throw-free retry signal
  if (outcome.outcome === "busy") {
    const err = new Error(`release bootstrap contention; retry after ${outcome.retryAfterMs}ms`);
    (err as { retryAfterMs?: number }).retryAfterMs = outcome.retryAfterMs;
    throw err;
  }
  throw new Error(`release bootstrap conflict: ${outcome.reason}`);
}

// ---------------------------------------------------------------------------
// Activation reconciliation — per-group locked transactions
// ---------------------------------------------------------------------------

type GroupClassification =
  | { activate: true }
  | { activate: false; disposition: "activated"; detail?: string; activatedFindingCount: number }
  | {
      activate: false;
      disposition: "deferred_changed" | "deferred_oversized" | "deferred_budget";
      detail: string;
    };

/**
 * Classifies ONE frozen group against live state under the caller's writer
 * reservation. Reads (never guesses) the attribution of already-activated
 * groups — the kernel's `replayed` is attribution-agnostic, so the
 * reconciler owns the current-Release vs earlier-Release vs manual split.
 */
function classifyGroupUnderLock(
  client: DbClient,
  release: Release,
  epoch: ReleaseActivationEpoch,
  group: EpochGroupRow,
): GroupClassification {
  const mission = getMissionByIdWithClient(client, group.missionId);
  if (!mission) {
    return { activate: false, disposition: "deferred_changed", detail: "mission_missing" };
  }
  if (mission.isArchived || mission.status === "done" || mission.status === "failed") {
    return {
      activate: false,
      disposition: "deferred_changed",
      detail: `mission_not_activatable:${mission.status}${mission.isArchived ? ":archived" : ""}`,
    };
  }

  const live = findingTriageRepo.listNonTerminalByCorrectiveMissionIdWithClient(
    client,
    group.missionId,
  );
  const liveById = new Map(live.map((f) => [f.id, f]));
  const frozenIds = group.findingIds;

  // Exact membership: the live non-terminal group must equal the frozen set.
  const liveIds = new Set(live.map((f) => f.id));
  if (liveIds.size !== frozenIds.length || frozenIds.some((id) => !liveIds.has(id))) {
    return { activate: false, disposition: "deferred_changed", detail: "membership_drift" };
  }

  // Already-activated attribution classification (kernel replay is agnostic).
  const allInProgress = frozenIds.every((id) => liveById.get(id)?.status === "in_progress");
  if (allInProgress) {
    const allOurs = frozenIds.every((id) => liveById.get(id)?.activationReleaseId === release.id);
    if (allOurs) {
      // Idempotent re-classification: this Release already activated the
      // group (e.g. activation committed by a reconciler whose disposition
      // write was lost, or the reserved-client kernel ran standalone).
      return {
        activate: false,
        disposition: "activated",
        activatedFindingCount: frozenIds.length,
        detail: "already_attributed_to_this_release",
      };
    }
    return {
      activate: false,
      disposition: "deferred_changed",
      detail: "activated_by_other_attribution",
    };
  }

  // Eligibility snapshot: every member still one homogeneous triaged group.
  const ineligible = frozenIds.filter((id) => {
    const f = liveById.get(id);
    return !f || f.status !== "triaged" || f.legacyLineageRepairRequired;
  });
  if (ineligible.length > 0) {
    return {
      activate: false,
      disposition: "deferred_changed",
      detail: `eligibility_drift:${ineligible.length}`,
    };
  }

  // Gate drift: the frozen gate must still be the Mission's live gate.
  if (
    mission.releaseGateType !== group.gateType ||
    mission.releaseGateVersion !== group.gateVersion
  ) {
    return { activate: false, disposition: "deferred_changed", detail: "gate_drift" };
  }

  // Digest recheck (defense in depth over the explicit checks above).
  const recomputed = computeMembershipDigest({
    missionId: group.missionId,
    gateType: group.gateType,
    gateVersion: group.gateVersion,
    findingIds: [...frozenIds].sort(),
  });
  if (recomputed !== group.membershipDigest) {
    return { activate: false, disposition: "deferred_changed", detail: "digest_mismatch" };
  }

  // Capacity reservation under the writer lock.
  const cap = epoch.frozenCap;
  const size = frozenIds.length;
  if (cap !== null) {
    if (size > cap) {
      return {
        activate: false,
        disposition: "deferred_oversized",
        detail: "oversized_for_release_cap",
      };
    }
    const used = projRepo.countReleaseAttributedFindingsWithClient(client, release.id);
    if (used + size > cap) {
      return {
        activate: false,
        disposition: "deferred_budget",
        detail: `budget_exhausted:used=${used},cap=${cap},size=${size}`,
      };
    }
  }

  return { activate: true };
}

/**
 * One group's locked reconciliation step: classify under the reservation and
 * either activate the WHOLE group through the reserved-client kernel or
 * record the explicit deferral — one transaction, one disposition.
 */
function classifyAndApplyGroupInTx(
  client: DbClient,
  release: Release,
  groupId: string,
): { disposition: string; detail: string | null; activatedFindings: projRepoFindingSnapshot[] } {
  const epoch = projRepo.getEpochByReleaseIdWithClient(client, release.id);
  if (!epoch) throw new Error(`activation epoch missing for release ${release.id}`);
  const group = projRepo.getEpochGroupByIdWithClient(client, groupId);
  if (!group) throw new Error(`epoch group ${groupId} missing`);
  const now = new Date().toISOString();

  if (group.disposition !== "pending") {
    return {
      disposition: group.disposition,
      detail: group.dispositionDetail,
      activatedFindings: [],
    };
  }

  const classification = classifyGroupUnderLock(client, release, epoch, group);

  if (classification.activate) {
    const kernel = runReleaseActivationOnReservedClient(client, {
      findingId: group.findingIds[0]!,
      releaseId: release.id,
      gateProof: {
        releaseGateType: group.gateType,
        releaseGateVersion: group.gateVersion,
      },
    });
    if (kernel.outcome === "applied") {
      projRepo.setGroupDispositionWithClient(
        client,
        group.id,
        "activated",
        now,
        `release:${release.id}`,
        group.findingIds.length,
      );
      return {
        disposition: "activated",
        detail: null,
        activatedFindings: kernel.value.findings,
      };
    }
    if (kernel.outcome === "replayed") {
      // Attribution-agnostic replay — classify it ourselves from live state.
      const reread = classifyGroupUnderLock(client, release, epoch, group);
      if (reread.activate) {
        // Should be unreachable (replay implies non-triaged live state), but
        // fail closed to a deferral rather than partially activating.
        projRepo.setGroupDispositionWithClient(
          client,
          group.id,
          "deferred_changed",
          now,
          "kernel_replay_with_eligible_snapshot",
        );
        return {
          disposition: "deferred_changed",
          detail: "kernel_replay_with_eligible_snapshot",
          activatedFindings: [],
        };
      }
      return applyNonActivatingClassification(client, group, reread, now);
    }
    // Kernel conflict (e.g. gate_proof_mismatch on a gate that changed
    // between our read and the kernel's in-tx verification) — drift.
    projRepo.setGroupDispositionWithClient(
      client,
      group.id,
      "deferred_changed",
      now,
      `kernel_conflict:${kernel.reason}`,
    );
    return {
      disposition: "deferred_changed",
      detail: `kernel_conflict:${kernel.reason}`,
      activatedFindings: [],
    };
  }

  return applyNonActivatingClassification(client, group, classification, now);
}

function applyNonActivatingClassification(
  client: DbClient,
  group: EpochGroupRow,
  classification: GroupClassification,
  now: string,
): { disposition: string; detail: string | null; activatedFindings: projRepoFindingSnapshot[] } {
  if (classification.activate) throw new Error("unreachable: activating classification");
  if (classification.disposition === "activated") {
    projRepo.setGroupDispositionWithClient(
      client,
      group.id,
      "activated",
      now,
      classification.detail,
      classification.activatedFindingCount,
    );
    return {
      disposition: "activated",
      detail: classification.detail ?? null,
      activatedFindings: [],
    };
  }
  projRepo.setGroupDispositionWithClient(
    client,
    group.id,
    classification.disposition,
    now,
    classification.detail,
  );
  return {
    disposition: classification.disposition,
    detail: classification.detail,
    activatedFindings: [],
  };
}

/** Minimal activated-finding snapshot for post-commit SSE publication. */
type projRepoFindingSnapshot = {
  id: string;
  habitatId: string;
  status: string;
  bucket: string | null;
};

/**
 * Reconciles the frozen groups (deterministic order). `onlyMissionIds`
 * forces a subset — used by the worker-race discriminator to make two
 * processes select different groups; production passes nothing.
 */
export function reconcileActivationGroups(
  releaseId: string,
  options?: { onlyMissionIds?: string[] },
  db?: DbClient,
): GroupReconciliationOutcome[] {
  const client0 = db ?? getDb();
  const release = projRepo.findReleaseByIdWithClient(client0, releaseId);
  if (!release) throw new Error(`release ${releaseId} not found`);
  const epoch = projRepo.getEpochByReleaseIdWithClient(client0, releaseId);
  if (!epoch) throw new Error(`activation epoch missing for release ${releaseId}`);

  const groups = options?.onlyMissionIds
    ? projRepo.listEpochGroupsForMissionsWithClient(client0, epoch.id, options.onlyMissionIds)
    : projRepo.listEpochGroupsOrderedWithClient(client0, epoch.id);

  const results: GroupReconciliationOutcome[] = [];
  for (const group of groups) {
    const tx = withImmediateLifecycleTransaction(
      (client) => ({
        outcome: "applied" as const,
        value: classifyAndApplyGroupInTx(client, release, group.id),
      }),
      db,
    );
    if (tx.outcome !== "applied" && tx.outcome !== "replayed") {
      throw new Error(
        `group reconciliation conflict for ${group.missionId}: ${"reason" in tx ? tx.reason : "unknown"}`,
      );
    }
    // After-commit projection: SSE per activated finding (never authority).
    for (const finding of tx.value.activatedFindings) {
      if (finding.status !== "in_progress") continue;
      sseBroadcaster.publish(finding.habitatId, {
        type: "triage.finding_updated",
        data: {
          habitatId: finding.habitatId,
          findingId: finding.id,
          status: "in_progress",
          bucket: finding.bucket,
        },
      });
    }
    results.push({
      groupId: group.id,
      missionId: group.missionId,
      disposition: tx.value.disposition,
      detail: tx.value.detail,
    });
  }
  return results;
}

/**
 * FINAL locked completeness pass: rechecks every still-pending frozen group
 * against the same epoch snapshot + budget, then (only when no group remains
 * unclassified) marks the activation projection complete and closes the
 * epoch. Completion is final — the guarded update never reopens it.
 */
export function finalizeActivationEpoch(releaseId: string, db?: DbClient): EpochCounts {
  const client0 = db ?? getDb();
  const release = projRepo.findReleaseByIdWithClient(client0, releaseId);
  if (!release) throw new Error(`release ${releaseId} not found`);

  const tx = withImmediateLifecycleTransaction((client) => {
    const epoch = projRepo.getEpochByReleaseIdWithClient(client, releaseId);
    if (!epoch) throw new Error(`activation epoch missing for release ${releaseId}`);
    if (epoch.completedAt) {
      return { outcome: "replayed" as const, value: epoch };
    }

    const pending = projRepo
      .listEpochGroupsOrderedWithClient(client, epoch.id)
      .filter((g) => g.disposition === "pending");
    for (const group of pending) {
      classifyAndApplyGroupInTx(client, release, group.id);
    }

    const groups = projRepo.listEpochGroupsOrderedWithClient(client, epoch.id);
    const stillPending = groups.filter((g) => g.disposition === "pending");
    if (stillPending.length > 0) {
      throw new Error(
        `epoch ${epoch.id} has ${stillPending.length} unclassified groups; refusing completion`,
      );
    }

    const now = new Date().toISOString();
    projRepo.completeEpochWithClient(client, epoch.id, now);
    const projection = projRepo.getProjectionWithClient(
      client,
      releaseId,
      "activation_reconciliation",
    );
    if (projection && projection.state === "pending") {
      const counts = computeEpochCounts(groups);
      projRepo.completeProjectionWithClient(
        client,
        projection.id,
        {
          epochCompletedAt: now,
          ...counts,
        },
        now,
      );
    }
    return { outcome: "applied" as const, value: epoch };
  }, db);

  if (tx.outcome !== "applied" && tx.outcome !== "replayed") {
    throw new Error(`epoch finalization conflict: ${"reason" in tx ? tx.reason : "unknown"}`);
  }
  return readEpochCounts(releaseId, db);
}

/** Cumulative durable counts for an epoch (derived from group dispositions). */
function computeEpochCounts(groups: EpochGroupRow[]): EpochCounts {
  let activatedFindingCount = 0;
  let cappedFindingCount = 0;
  let deferredChangedCount = 0;
  let activatedGroups = 0;
  let deferredGroups = 0;
  for (const g of groups) {
    if (g.disposition === "activated") {
      activatedGroups++;
      activatedFindingCount += g.activatedFindingCount ?? g.findingIds.length;
    } else {
      deferredGroups++;
      if (g.disposition === "deferred_changed") deferredChangedCount += g.findingIds.length;
      if (g.disposition === "deferred_oversized" || g.disposition === "deferred_budget") {
        cappedFindingCount += g.findingIds.length;
      }
    }
  }
  return {
    groupCount: groups.length,
    activatedFindingCount,
    cappedFindingCount,
    deferredChangedCount,
    activatedGroups,
    deferredGroups,
  };
}

export function readEpochCounts(releaseId: string, db?: DbClient): EpochCounts {
  const client = db ?? getDb();
  const epoch = projRepo.getEpochByReleaseIdWithClient(client, releaseId);
  if (!epoch) throw new Error(`activation epoch missing for release ${releaseId}`);
  return computeEpochCounts(projRepo.listEpochGroupsOrderedWithClient(client, epoch.id));
}

// ---------------------------------------------------------------------------
// Deadline / notification / pulse helpers (deterministic Release-scoped ids)
// ---------------------------------------------------------------------------

/** Resolves the human recipients for a habitat's release notification. */
function getHabitatHumanRecipients(
  habitatId: string,
): Array<{ recipientType: "human"; recipientId: string }> {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat?.teamId) return [];
  return teamMemberRepo.listMembers(habitat.teamId).map((m) => ({
    recipientType: "human" as const,
    recipientId: m.userId,
  }));
}

/** Deadline-missed missions for the shipped release (live read on the client). */
function findDeadlineMissedMissionsOnClient(
  client: DbClient,
  habitatId: string,
  shippedType: ReleaseType,
  shippedVersion: string,
): Array<{ id: string }> {
  const withDeadline = client
    .select({
      id: missions.id,
      deadlineType: missions.releaseDeadlineType,
      deadlineVersion: missions.releaseDeadlineVersion,
    })
    .from(missions)
    .where(
      and(
        eq(missions.habitatId, habitatId),
        ne(missions.status, "done"),
        or(isNotNull(missions.releaseDeadlineType), isNotNull(missions.releaseDeadlineVersion)),
      ),
    )
    .all();
  return withDeadline.filter((m) =>
    gateSatisfied(
      { releaseGateType: m.deadlineType, releaseGateVersion: m.deadlineVersion },
      shippedType,
      shippedVersion,
    ),
  );
}

/** Existing notification event for a deterministic Release-scoped identity. */
function findReleaseNotificationEvent(
  client: DbClient,
  habitatId: string,
  eventType: string,
  releaseId: string,
): { id: string } | null {
  const row = client
    .select({ id: notificationEvents.id })
    .from(notificationEvents)
    .where(
      and(
        eq(notificationEvents.habitatId, habitatId),
        eq(notificationEvents.eventType, eventType),
        eq(notificationEvents.sourceId, releaseId),
      ),
    )
    .get();
  return row ?? null;
}

// ---------------------------------------------------------------------------
// Ordered projection pass
// ---------------------------------------------------------------------------

function runDeadlineNotificationProjection(release: Release): number {
  const tx = withImmediateLifecycleTransaction((client) => {
    const proj = projRepo.getProjectionWithClient(client, release.id, "deadline_notification");
    if (!proj) throw new Error(`deadline_notification projection missing for ${release.id}`);
    if (proj.state === "completed") {
      const missed = (proj.outputIdentity?.missedMissionIds as string[] | undefined) ?? [];
      return { outcome: "replayed" as const, value: missed.length };
    }
    const missed = findDeadlineMissedMissionsOnClient(
      client,
      release.habitatId,
      release.releaseType,
      release.version,
    );
    const now = new Date().toISOString();
    let eventId: string | null = null;
    if (missed.length > 0) {
      const existing = findReleaseNotificationEvent(
        client,
        release.habitatId,
        "release.deadline_missed",
        release.id,
      );
      if (!existing) {
        const recipients = getHabitatHumanRecipients(release.habitatId);
        const result = enqueueNotificationForRecipients(
          release.habitatId,
          "release.deadline_missed",
          "system",
          "warning",
          recipients,
          {
            sourceId: release.id,
            payload: {
              releaseId: release.id,
              version: release.version,
              releaseType: release.releaseType,
              missedDeadlineCount: missed.length,
              missionIds: missed.map((m) => m.id),
            },
            createdByType: "system",
            createdById: "release",
          },
        );
        eventId = result.event.id;
      } else {
        eventId = existing.id;
      }
    }
    projRepo.completeProjectionWithClient(
      client,
      proj.id,
      {
        notificationEventId: eventId,
        missedDeadlineCount: missed.length,
        missedMissionIds: missed.map((m) => m.id),
      },
      now,
    );
    return { outcome: "applied" as const, value: missed.length };
  });
  if (tx.outcome !== "applied" && tx.outcome !== "replayed") {
    throw new Error(`deadline notification conflict: ${"reason" in tx ? tx.reason : "unknown"}`);
  }
  return tx.value;
}

function runActivationNotificationProjection(
  release: Release,
  activatedFindingCount: number,
): void {
  const tx = withImmediateLifecycleTransaction((client) => {
    const proj = projRepo.getProjectionWithClient(client, release.id, "activation_notification");
    if (!proj) throw new Error(`activation_notification projection missing for ${release.id}`);
    if (proj.state === "completed") return { outcome: "replayed" as const, value: null };
    const now = new Date().toISOString();
    let eventId: string | null = null;
    if (activatedFindingCount > 0) {
      const existing = findReleaseNotificationEvent(
        client,
        release.habitatId,
        "release.activated",
        release.id,
      );
      if (!existing) {
        const recipients = getHabitatHumanRecipients(release.habitatId);
        const result = enqueueNotificationForRecipients(
          release.habitatId,
          "release.activated",
          "system",
          "info",
          recipients,
          {
            sourceId: release.id,
            payload: {
              releaseId: release.id,
              version: release.version,
              releaseType: release.releaseType,
              promotedCount: 0,
              activatedMissionCount: activatedFindingCount,
            },
            createdByType: "system",
            createdById: "release",
          },
        );
        eventId = result.event.id;
      } else {
        eventId = existing.id;
      }
    }
    projRepo.completeProjectionWithClient(
      client,
      proj.id,
      { notificationEventId: eventId, activatedFindingCount },
      now,
    );
    return { outcome: "applied" as const, value: null };
  });
  if (tx.outcome !== "applied" && tx.outcome !== "replayed") {
    throw new Error(`activation notification conflict: ${"reason" in tx ? tx.reason : "unknown"}`);
  }
}

function runRetrospectivePulseProjection(
  release: Release,
  counts: EpochCounts,
  missedDeadlineCount: number,
): void {
  const tx = withImmediateLifecycleTransaction((client) => {
    const proj = projRepo.getProjectionWithClient(client, release.id, "retrospective_pulse");
    if (!proj) throw new Error(`retrospective_pulse projection missing for ${release.id}`);
    if (proj.state === "completed") return { outcome: "replayed" as const, value: null };

    const retrospectiveBody = [
      `Release ${release.version} (${release.releaseType}) shipped via ${release.detectedBy}.`,
      `- Promoted findings: 0`,
      `- Gates resolved (missions activated): ${counts.activatedFindingCount}`,
      `- Corrective missions created: 0`,
      `- Skipped (already in progress): 0`,
      `- Errored (promoted but mission failed): 0`,
      `- Deadlines missed (mission not done when its deadline release shipped): ${missedDeadlineCount}`,
      `- Capped (not promoted — per-release promotion cap reached): ${counts.cappedFindingCount}`,
    ].join("\n");
    const pulse = pulseRepo.createPulseWithClient(client, {
      habitatId: release.habitatId,
      scope: "habitat",
      signalType: "context",
      fromType: "system",
      fromId: "release",
      subject: `Release ${release.version} (${release.releaseType}) shipped`,
      body: retrospectiveBody,
      metadata: {
        releaseRetrospective: true,
        releaseId: release.id,
        version: release.version,
        releaseType: release.releaseType,
        detectedBy: release.detectedBy,
        promotedCount: 0,
        activatedMissionCount: counts.activatedFindingCount,
        createdMissionCount: 0,
        skippedCount: 0,
        erroredCount: 0,
        missedDeadlineCount,
      },
    });
    projRepo.completeProjectionWithClient(
      client,
      proj.id,
      { pulseId: pulse.id },
      new Date().toISOString(),
    );
    return { outcome: "applied" as const, value: null };
  });
  if (tx.outcome !== "applied" && tx.outcome !== "replayed") {
    throw new Error(`retrospective pulse conflict: ${"reason" in tx ? tx.reason : "unknown"}`);
  }
}

async function runReleaseShippedProjection(
  release: Release,
  counts: EpochCounts,
  missedDeadlineCount: number,
): Promise<void> {
  const tx = withImmediateLifecycleTransaction((client) => {
    const proj = projRepo.getProjectionWithClient(client, release.id, "release_shipped");
    if (!proj) throw new Error(`release_shipped projection missing for ${release.id}`);
    if (proj.state === "completed") {
      return { outcome: "replayed" as const, value: proj.outputIdentity?.inboxId as string | null };
    }
    const payload = {
      eventId: release.id,
      releaseId: release.id,
      version: release.version,
      releaseType: release.releaseType,
      detectedBy: release.detectedBy,
      promotedCount: 0,
      activatedMissionCount: counts.activatedFindingCount,
      createdMissionCount: 0,
      skippedCount: 0,
      erroredCount: 0,
      missedDeadlineCount,
    };
    const admitted = admitReleaseShippedEventToInbox(
      {
        habitatId: release.habitatId,
        eventId: release.id,
        payload,
      },
      client,
    );
    projRepo.completeProjectionWithClient(
      client,
      proj.id,
      { inboxId: admitted.inboxId, deliveries: admitted.deliveries },
      new Date().toISOString(),
    );
    return { outcome: "applied" as const, value: admitted.inboxId };
  });
  if (tx.outcome !== "applied" && tx.outcome !== "replayed") {
    throw new Error(`release.shipped handoff conflict: ${"reason" in tx ? tx.reason : "unknown"}`);
  }

  // Best-effort eager drain — the fenced inbox owns rule processing and
  // recovery; boot + interval scheduling (`initAutomationInboxDrain`) cover
  // the crash window. A drain failure NEVER un-completes the projection.
  try {
    await drainAutomationInbox();
  } catch (err) {
    console.warn(
      `[release] eager inbox drain failed for ${release.version}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * Runs the explicit ordered projection pass over durable state:
 * activation reconciliation → deadline notification → activation
 * notification → retrospective Pulse → release.shipped. Completed
 * projections replay without duplicate targets; a failure leaves the failed
 * projection and all later projections pending, and the summary exposes the
 * incomplete kinds rather than claiming a fully processed Release.
 */
export async function reconcileReleaseProjections(
  release: Release,
): Promise<ReleaseReconciliationSummary> {
  const order: projRepo.ReleaseProjectionKind[] = [
    "activation_reconciliation",
    "deadline_notification",
    "activation_notification",
    "retrospective_pulse",
    "release_shipped",
  ];
  const projections = new Map(
    projRepo.listProjectionsWithClient(getDb(), release.id).map((p) => [p.projectionKind, p]),
  );

  let counts: EpochCounts | null = null;
  let missedDeadlineCount = 0;

  for (const kind of order) {
    const projection = projections.get(kind);
    if (projection?.state === "completed") {
      if (kind === "activation_reconciliation") counts = readEpochCounts(release.id);
      if (kind === "deadline_notification") {
        missedDeadlineCount =
          (projection.outputIdentity?.missedDeadlineCount as number | undefined) ?? 0;
      }
      continue;
    }
    try {
      if (kind === "activation_reconciliation") {
        reconcileActivationGroups(release.id);
        counts = finalizeActivationEpoch(release.id);
      } else if (kind === "deadline_notification") {
        missedDeadlineCount = runDeadlineNotificationProjection(release);
      } else if (kind === "activation_notification") {
        runActivationNotificationProjection(release, counts!.activatedFindingCount);
      } else if (kind === "retrospective_pulse") {
        runRetrospectivePulseProjection(release, counts!, missedDeadlineCount);
      } else {
        await runReleaseShippedProjection(release, counts!, missedDeadlineCount);
      }
    } catch (err) {
      projRepo.recordProjectionAttemptError(
        release.id,
        kind,
        err instanceof Error ? err.message : String(err),
      );
      break;
    }
  }

  if (!counts) counts = readEpochCounts(release.id);
  const finalProjections = projRepo.listProjectionsWithClient(getDb(), release.id);
  const incompleteProjections = finalProjections
    .filter((p) => p.state === "pending")
    .map((p) => p.projectionKind);

  return {
    promotedCount: 0,
    createdMissionCount: 0,
    skippedCount: 0,
    erroredCount: 0,
    missedDeadlineCount,
    cappedCount: counts.cappedFindingCount,
    activatedMissionCount: counts.activatedFindingCount,
    incompleteProjections,
  };
}

// ---------------------------------------------------------------------------
// Inbox drain scheduling (boot + interval)
// ---------------------------------------------------------------------------

let drainSchedulerStarted = false;
let drainTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Boots the Automation inbox consumer: one immediate drain pass (recovery
 * for anything admitted before a crash) plus a bounded interval pass.
 * Idempotent — repeated calls are no-ops.
 */
export function initAutomationInboxDrain(intervalMs = 30_000): void {
  if (drainSchedulerStarted) return;
  drainSchedulerStarted = true;
  void drainAutomationInbox().catch((err) => {
    console.warn("[automation-inbox] boot drain failed:", err instanceof Error ? err.message : err);
  });
  drainTimer = setInterval(() => {
    void drainAutomationInbox().catch((err) => {
      console.warn(
        "[automation-inbox] interval drain failed:",
        err instanceof Error ? err.message : err,
      );
    });
  }, intervalMs);
  drainTimer.unref?.();
}

/** Test helper — stops the interval scheduler and resets the guard. */
export function stopAutomationInboxDrainForTests(): void {
  if (drainTimer) {
    clearInterval(drainTimer);
    drainTimer = null;
  }
  drainSchedulerStarted = false;
}
