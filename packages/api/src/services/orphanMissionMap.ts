/**
 * Triage orphan-mission map command (RM-7 bounded restoration, ADR-0048
 * scope; see `triage-registration-restoration` implementation contract).
 *
 * Positions ONE existing orphan Mission in the roadmap DAG on behalf of the
 * local agent that currently claims the orphan's admitted investigation
 * Task. This is the bounded replacement for routing `map_orphan_mission`
 * through the generic `PATCH /missions/:id` (which any local agent could
 * call on any Habitat's Mission).
 *
 * Server-owned transaction invariant — every check runs INSIDE the SQLite
 * writer reservation (`BEGIN IMMEDIATE` via
 * `withImmediateLifecycleTransaction`), before any write, on the same
 * client that performs the mutation (no TOCTOU between a precheck GET and
 * the write):
 *
 *   1. Target Mission exists, is NOT archived, its status is mappable (the
 *      orphan scan's own eligibility predicate — done/failed targets deny
 *      even with an open junction), and its ACTUAL Habitat equals the path
 *      Habitat (mismatch collapses into not_found — the route is not a
 *      cross-Habitat Mission existence oracle).
 *   2. Target is an ACTIVE orphan: zero incident dependency edges (incoming
 *      AND outgoing, `missionDependencies` table plus the mission's own
 *      dependsOn/blocks projections). Already-mapped targets refuse.
 *   3. Exactly ONE open `triage_cluster_missions` junction exists for
 *      `(habitatId, orphan-mission:{missionId})` (partial unique index).
 *      Its `missionId` is the INVESTIGATION Mission (ADR-0048 investigation
 *      identity), distinct from the orphan target.
 *   4. The GENUINE published investigate Task of that investigation Mission
 *      is resolved ONLY from the publication ledger (`task_creation_attempts`
 *      scoped to this orphan with `committed_task_id`/`committed_mission_id`
 *      stamped atomically by the publication coordinator). Exactly ONE
 *      committed candidate, still present on the Mission, is the investigate
 *      Task; THAT Task must be in an active claim state (`claimed` |
 *      `in_progress`) with `assignedAgentId === agentId`. Absent ledger
 *      (legacy junctions), dangling/deleted/replaced committed Tasks, and
 *      multiple candidates deny with the typed
 *      `no_provable_investigation_task` outcome — identity is never inferred
 *      from Task count, title, createdAt, or the caller's current claim
 *      (delete-and-replace attacks fail closed). Investigations whose
 *      identity cannot be proven are a KNOWN LIMITATION, not a recoverable
 *      state: there is no supported automatic re-admit while the
 *      unresolvable open junction remains (the scan skips open junctions and
 *      no production command resolves one for this case) — a human handles
 *      the mission through the existing Mission editing UI/API, and that
 *      manual edit does not close or repair the junction.
 *   5. Every `dependsOn` id is an existing same-Habitat Mission and adding
 *      the edge creates no cycle (missing / cross-Habitat / cycle produce
 *      ONE indistinguishable `invalid_dependency` naming the index).
 *   6. Generic Mission gate guards (`guardMissionGateEdit`) apply unchanged.
 *   7. The Mission update itself reuses `updateMissionWithClient` (version
 *      CAS rides in the UPDATE WHERE clause).
 *
 * Attribution: ONE same-transaction Mission `updated` audit event with
 * `actorType: "agent"` (the generic PATCH path hardcodes `human`; this
 * agent-owned path attributes honestly) carrying the verified
 * investigation identity in metadata. SSE `mission.updated` is an
 * after-commit projection only — never authority, never in-transaction.
 */

import { and, eq, isNotNull, sql } from "drizzle-orm";

import { getDb } from "../db/index.js";
import { missionDependencies, taskCreationAttempts, tasks } from "../db/schema/index.js";
import { getMissionByIdWithClient, updateMissionWithClient } from "../repositories/mission.js";
import { createMissionEventWithClient } from "../repositories/events/event-feature.js";
import { findActiveByClusterKeyWithClient } from "../repositories/triageClusterMissions.js";
import { wouldCreateMissionCycleWithClient } from "../repositories/dependency.js";
import { guardMissionGateEdit } from "./findingTriageHistoryGuards.js";
import { ORPHAN_ELIGIBLE_MISSION_STATUSES } from "./orphanScanService.js";
import {
  withImmediateLifecycleTransaction,
  type LifecycleOutcome,
} from "./findingTriageLifecycle.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import type { Mission } from "../models/index.js";

/** Cluster-key prefix the orphan scan uses for orphan investigations. */
export const ORPHAN_CLUSTER_KEY_PREFIX = "orphan-mission:";

/** Reasons an orphan-map command cannot proceed; every one leaves ZERO writes. */
export type OrphanMapConflictReason =
  /** Missing target, wrong-Habitat target (collapsed), archived target, or vanished investigation Mission. */
  | "not_found"
  /** Target already has incident dependency edges (not an orphan / already mapped). */
  | "not_orphan"
  /** No open junction for (habitatId, orphan-mission:{missionId}) — never investigated or already resolved. */
  | "no_open_investigation"
  /** Claim predicate failed in-tx: proven investigate Task is unclaimed, stale, or held by another assignee. */
  | "not_current_claimant"
  /** The published investigate Task's identity cannot be PROVEN from persisted publication evidence (absent ledger, dangling/deleted/replaced committed Task, or multiple candidates). Automatic mapping is refused; a human handles the mission via existing Mission editing (which does not repair the junction) — no supported automatic re-admit exists while the unresolvable open junction remains. */
  | "no_provable_investigation_task"
  /** Missing / cross-Habitat / cyclic dependency (one indistinguishable message, index only). */
  | "invalid_dependency"
  /** Generic Mission gate guard rejected the gate edit (linked Findings). */
  | "gate_clear_blocked"
  | "gate_change_blocked"
  /** expectedVersion CAS failed; current version is carried in `current.currentVersion`. */
  | "stale_mission_version"
  | "invalid_input";

/** Successful (committed) orphan-map result — carries the VERIFIED identities. */
export interface OrphanMapSuccess {
  /** The positioned orphan Mission, post-write. */
  mission: Mission;
  /** The target's verified ACTUAL Habitat (=== the path Habitat). */
  habitatId: string;
  /** The junction clusterKey (`orphan-mission:{missionId}`). */
  clusterKey: string;
  /** The open investigation Mission the junction points at (ADR-0048 identity). */
  investigationMissionId: string;
  /** The exact investigation Task whose live claim authorized the write. */
  investigationTaskId: string;
}

/**
 * Envelope of {@link mapOrphanMission}: the lifecycle transaction envelope
 * specialized to the orphan-map reasons. `replayed` never occurs for this
 * command (mapping is not idempotent-replayable; a second map of the same
 * Mission is `not_orphan` because the first map created edges).
 */
export type OrphanMapOutcome = LifecycleOutcome<OrphanMapSuccess, OrphanMapConflictReason>;

/** Input accepted by {@link mapOrphanMission}. `agentId` is ALWAYS the authenticated local agent. */
export interface MapOrphanMissionInput {
  habitatId: string;
  missionId: string;
  agentId: string;
  /** At least one positioning edge is required (a gate-only edit leaves the Mission unmapped). */
  dependsOn: string[];
  releaseGateType?: "patch" | "minor" | "major" | null;
  releaseGateVersion?: string | null;
  /** Optional caller-observed Mission version; CASed against the live row. */
  expectedVersion?: number;
}

/** Incident (incoming or outgoing) dependency-edge count for the mission, on the supplied client. */
function countIncidentEdges(
  client: Pick<ReturnType<typeof getDb>, "select" | "get">,
  missionId: string,
): number {
  const row = client
    .select({ n: sql<number>`count(*) as n` })
    .from(missionDependencies)
    .where(
      sql`${missionDependencies.missionId} = ${missionId} or ${missionDependencies.dependsOnId} = ${missionId}`,
    )
    .get();
  return row?.n ?? 0;
}

/**
 * Maps (positions) an orphan Mission. See the module header for the full
 * in-transaction invariant; every conflict leaves zero writes.
 */
export function mapOrphanMission(input: MapOrphanMissionInput): OrphanMapOutcome {
  const outcome = withImmediateLifecycleTransaction<OrphanMapSuccess, OrphanMapConflictReason>(
    (client) => {
      // 1. Target Mission — exists, not archived, ACTUAL Habitat === path
      //    Habitat, and its status is mappable (the SAME eligibility predicate
      //    the orphan scan uses — a target that went done/failed after the scan
      //    opened the junction is no longer positionable; archived and other
      //    ineligible statuses deny identically).
      const mission = getMissionByIdWithClient(client, input.missionId);
      if (
        !mission ||
        mission.isArchived ||
        mission.habitatId !== input.habitatId ||
        !ORPHAN_ELIGIBLE_MISSION_STATUSES.has(mission.status)
      ) {
        // Anti-probing collapse: wrong-Habitat, archived, and ineligible-status
        // targets are indistinguishable from missing — the route must not be a
        // cross-Habitat existence oracle.
        return { outcome: "conflict" as const, reason: "not_found" as OrphanMapConflictReason };
      }

      // 2. Active orphan: zero incident edges (table + the row's own projections).
      const hasProjectedEdges =
        (mission.dependsOn?.length ?? 0) > 0 || (mission.blocks?.length ?? 0) > 0;
      if (hasProjectedEdges || countIncidentEdges(client, input.missionId) > 0) {
        return {
          outcome: "conflict" as const,
          reason: "not_orphan" as OrphanMapConflictReason,
          current: { missionId: input.missionId },
        };
      }

      // 3. Exactly one OPEN junction for (habitatId, orphan-mission:{id}).
      const clusterKey = `${ORPHAN_CLUSTER_KEY_PREFIX}${input.missionId}`;
      const junction = findActiveByClusterKeyWithClient(client, input.habitatId, clusterKey);
      if (!junction) {
        return {
          outcome: "conflict" as const,
          reason: "no_open_investigation" as OrphanMapConflictReason,
          current: { clusterKey },
        };
      }

      // The junction's missionId is the INVESTIGATION Mission (ADR-0048), not
      // the orphan target.
      const investigationMissionId = junction.missionId;
      const investigationMission = getMissionByIdWithClient(client, investigationMissionId);
      if (!investigationMission) {
        // Defensive: the junction FK cascades on delete; a missing row here is
        // corrupt state — fail closed.
        return { outcome: "conflict" as const, reason: "not_found" as OrphanMapConflictReason };
      }

      // 4. Resolve the GENUINE published investigate Task identity, then verify THAT
      //    Task's live claim (final authority check, in-tx on this client).
      //    A merely-claimed Task of the investigation Mission is NOT
      //    sufficient — the mission can carry additional, unrelated Tasks.
      //
      //    The ONLY trustworthy persisted identity is the triage publication's
      //    `task_creation_attempts` ledger: one row per published Task, scoped
      //    `(source_scope_kind='orphan_mission', source_scope_id=<orphan id>)`
      //    with `committed_task_id`/`committed_mission_id` stamped atomically
      //    by the publication coordinator (its sole production writer). The
      //    chain proves the committed Task belongs to the EXACT open
      //    investigation Mission of THIS habitat's junction for THIS orphan.
      //    Anything else — no ledger row (pre-ledger legacy junction), the
      //    committed Task deleted and replaced by a look-alike, multiple
      //    committed candidates — cannot prove identity and DENIES with the
      //    typed `no_provable_investigation_task` outcome. No inference from
      //    task count, title, createdAt, or the caller's current claim is
      //    accepted (delete-and-replace attack: the ledger still points at the
      //    deleted genuine Task, the replacement carries no proof). Known
      //    limitation: no supported automatic re-admit exists while the
      //    unresolvable open junction remains; humans use existing Mission
      //    editing, which does not repair the junction.
      const missionTasks = client
        .select({ id: tasks.id, assignedAgentId: tasks.assignedAgentId, status: tasks.status })
        .from(tasks)
        .where(eq(tasks.missionId, investigationMissionId))
        .all();

      const publishedTaskIds = client
        .select({ committedTaskId: taskCreationAttempts.committedTaskId })
        .from(taskCreationAttempts)
        .where(
          and(
            eq(taskCreationAttempts.sourceScopeKind, "orphan_mission"),
            eq(taskCreationAttempts.sourceScopeId, input.missionId),
            eq(taskCreationAttempts.committedMissionId, investigationMissionId),
            isNotNull(taskCreationAttempts.committedTaskId),
          ),
        )
        .all()
        .map((r) => r.committedTaskId as string);

      const unprovable = {
        outcome: "conflict" as const,
        reason: "no_provable_investigation_task" as OrphanMapConflictReason,
        current: { investigationMissionId },
      };
      if (publishedTaskIds.length !== 1) {
        // Zero ledger rows (legacy) or multiple committed candidates: identity
        // cannot be proven — deny.
        return unprovable;
      }
      const investigateTask = missionTasks.find((t) => t.id === publishedTaskIds[0]);
      if (!investigateTask) {
        // The ledger's committed Task is no longer on the investigation Mission
        // (deleted, possibly replaced by a claimed look-alike): dangling
        // identity — deny. The replacement carries no publication proof.
        return unprovable;
      }
      if (
        !["claimed", "in_progress"].includes(investigateTask.status) ||
        investigateTask.assignedAgentId !== input.agentId
      ) {
        return {
          outcome: "conflict" as const,
          reason: "not_current_claimant" as OrphanMapConflictReason,
          current: { investigationMissionId },
        };
      }
      const investigationTaskId = investigateTask.id;

      // 5. Dependencies: >=1, existing, same-Habitat, acyclic. Missing /
      //    cross-Habitat / cycle produce ONE indistinguishable conflict naming
      //    only the position.
      if (input.dependsOn.length === 0) {
        return {
          outcome: "conflict" as const,
          reason: "invalid_input" as OrphanMapConflictReason,
          current: "dependsOn must carry at least one positioning dependency",
        };
      }
      for (let i = 0; i < input.dependsOn.length; i++) {
        const depId = input.dependsOn[i];
        const dep = getMissionByIdWithClient(client, depId);
        if (!dep || dep.habitatId !== input.habitatId) {
          return {
            outcome: "conflict" as const,
            reason: "invalid_dependency" as OrphanMapConflictReason,
            current: { index: i },
          };
        }
        if (wouldCreateMissionCycleWithClient(client, input.missionId, depId)) {
          return {
            outcome: "conflict" as const,
            reason: "invalid_dependency" as OrphanMapConflictReason,
            current: { index: i },
          };
        }
      }

      // 6. Generic Mission gate guards (unchanged semantics).
      const gateGuard = guardMissionGateEdit(
        input.missionId,
        {
          releaseGateType: mission.releaseGateType ?? null,
          releaseGateVersion: mission.releaseGateVersion ?? null,
        },
        {
          releaseGateType: input.releaseGateType === undefined ? undefined : input.releaseGateType,
          releaseGateVersion:
            input.releaseGateVersion === undefined ? undefined : input.releaseGateVersion,
        },
      );
      if (!gateGuard.allowed) {
        return {
          outcome: "conflict" as const,
          reason: gateGuard.reason as OrphanMapConflictReason,
          current: { findingIds: gateGuard.findingIds },
        };
      }

      // 7. Write. The observed in-tx version is the default CAS value (the
      //    writer reservation makes the read-then-write race-free); an
      //    explicit expectedVersion CASes against the caller's observation.
      const changedFields: string[] = ["dependsOn"];
      const update: Parameters<typeof updateMissionWithClient>[2] = {
        dependsOn: input.dependsOn,
      };
      if (input.releaseGateType !== undefined) {
        update.releaseGateType = input.releaseGateType;
        changedFields.push("releaseGateType");
      }
      if (input.releaseGateVersion !== undefined) {
        update.releaseGateVersion = input.releaseGateVersion;
        changedFields.push("releaseGateVersion");
      }
      const written = updateMissionWithClient(
        client,
        input.missionId,
        update,
        input.expectedVersion ?? mission.version,
      );
      if (!written.success) {
        if ("notFound" in written) {
          return { outcome: "conflict" as const, reason: "not_found" as OrphanMapConflictReason };
        }
        return {
          outcome: "conflict" as const,
          reason: "stale_mission_version" as OrphanMapConflictReason,
          current: { currentVersion: written.currentVersion },
        };
      }

      // 8. Audit — ONE same-transaction Mission `updated` event, agent-attributed
      //    (the generic PATCH hardcodes `human`; this agent path does not),
      //    carrying the verified investigation identity.
      createMissionEventWithClient(client, {
        missionId: input.missionId,
        actorType: "agent",
        actorId: input.agentId,
        action: "updated",
        metadata: {
          reason: "triage_orphan_map",
          source: "triage_orphan_map",
          habitatId: input.habitatId,
          clusterKey,
          investigationMissionId,
          investigationTaskId,
          changedFields,
          dependsOn: input.dependsOn,
        },
      });

      return {
        outcome: "applied" as const,
        value: {
          mission: written.mission,
          habitatId: input.habitatId,
          clusterKey,
          investigationMissionId,
          investigationTaskId,
        },
      };
    },
  );

  // After-commit SSE projection — honest, outside the transaction, never
  // authority (mirrors missionService.updateMission's post-commit publish).
  if (outcome.outcome === "applied") {
    sseBroadcaster.publish(outcome.value.habitatId, {
      type: "mission.updated",
      data: outcome.value.mission,
    });
  }

  return outcome;
}
