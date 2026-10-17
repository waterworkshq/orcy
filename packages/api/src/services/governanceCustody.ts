/**
 * Governance custody composition (administration ticket).
 *
 * Caller-transaction helpers that retire governance state BEFORE a resource
 * cascade deletes it, so retired incarnations and revoked grants survive as
 * history and a reused ID can never revive old authority. Every helper runs
 * on the CALLER's writer reservation (BEGIN IMMEDIATE) — none open their own
 * transaction. Writers must collect descendant IDs through these helpers
 * BEFORE the row deletion cascades them away.
 *
 * Dispositions (binding custody register):
 *   - Habitat delete / legacy import swap: retire Habitat + descendant
 *     Mission/Task ledgers, Habitat namespace definitions, revoke assignments.
 *   - Team delete: retire Team + all descendant Habitat/Mission/Task ledgers
 *     and namespaces, revoke grants, delete (SET NULL fires), then reenroll
 *     FRESH incarnations (old+1, version 1) for still-existing descendants.
 *   - Mission delete: retire Mission + child-Task ledgers/grants.
 *   - Task delete: retire the Task ledger/grants.
 */
import { and, eq, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { governanceScopes, habitats, missions, tasks } from "../db/schema/index.js";
import type { LocalAuthorizationDbClient } from "./localAuthorization.js";
import {
  appendGovernanceAuditWithClient,
  materializeScopeWithClient,
  reenrollScopeWithClient,
  retireDefinitionsForNamespaceWithClient,
  retireScopeWithClient,
  revokeAssignmentsForScopeWithClient,
} from "../repositories/roleFoundation.js";

/** Truthful custody actor: only `human`/`agent` exist in the audit enum. */
export interface CustodyActor {
  actorType: "human" | "agent";
  actorId: string;
}

function audit(
  tx: LocalAuthorizationDbClient,
  input: Omit<Parameters<typeof appendGovernanceAuditWithClient>[1], "id">,
): void {
  appendGovernanceAuditWithClient(tx, { ...input, id: uuid() });
}

function missionIdsForHabitat(tx: LocalAuthorizationDbClient, habitatId: string): string[] {
  return tx
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all()
    .map((r) => r.id);
}

function taskIdsForMissions(tx: LocalAuthorizationDbClient, missionIds: string[]): string[] {
  if (missionIds.length === 0) return [];
  return tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(inArray(tasks.missionId, missionIds))
    .all()
    .map((r) => r.id);
}

/**
 * Retire the active incarnation of one scope under a truthful actor.
 *
 * - A live-but-virtual scope is materialized first so the retired incarnation
 *   is retained as history (a bare retire is a no-op on virtual scopes).
 * - No-op when nothing is active AND nothing is live-virtual (already retired
 *   or the resource no longer exists): no audit row, no fabricated state.
 * - The audit row reports the ACTUAL retired incarnation and version span —
 *   never a hardcoded incarnation 1 — and the real caller actor, never a
 *   fabricated `human`/`system` identity.
 */
function retireOne(
  tx: LocalAuthorizationDbClient,
  scopeKind: "team" | "habitat" | "mission" | "task",
  scopeId: string,
  reason: string,
  actor?: CustodyActor,
): void {
  // Revoke first (retained rows), then retire the ledger incarnation.
  revokeAssignmentsForScopeWithClient(tx, scopeKind, scopeId, reason);
  materializeScopeWithClient(tx, scopeKind, scopeId);
  const retired = retireScopeWithClient(tx, scopeKind, scopeId);
  if (retired === null) return; // nothing active: no state change, no audit
  audit(tx, {
    actorType: actor?.actorType ?? "human",
    actorId: actor?.actorId ?? "unknown",
    operation: `${scopeKind}.custody_retired`,
    scopeKind,
    scopeId,
    scopeIncarnation: retired.incarnation,
    objectKind: scopeKind,
    objectId: scopeId,
    versionBefore: retired.version - 1,
    versionAfter: retired.version,
    details: { reason },
  });
}

/** Retire a Task scope + its grants (Task delete seam). */
export function retireTaskCustodyWithClient(
  tx: LocalAuthorizationDbClient,
  taskId: string,
  reason: string,
  actor?: CustodyActor,
): void {
  retireOne(tx, "task", taskId, reason, actor);
}

/** Retire a Mission + its child Tasks (Mission delete seam). */
export function retireMissionCustodyWithClient(
  tx: LocalAuthorizationDbClient,
  missionId: string,
  reason: string,
  actor?: CustodyActor,
): void {
  const childTaskIds = tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.missionId, missionId))
    .all()
    .map((r) => r.id);
  for (const taskId of childTaskIds) retireTaskCustodyWithClient(tx, taskId, reason, actor);
  retireOne(tx, "mission", missionId, reason, actor);
}

/**
 * Retire a Habitat, its descendants and its namespace (Habitat delete +
 * legacy import delete-old swap seam). MUST run before the habitat row
 * deletion cascades the descendants away.
 */
export function retireHabitatCustodyWithClient(
  tx: LocalAuthorizationDbClient,
  habitatId: string,
  reason: string,
  actor?: CustodyActor,
): void {
  const missionIds = missionIdsForHabitat(tx, habitatId);
  for (const taskId of taskIdsForMissions(tx, missionIds)) {
    retireTaskCustodyWithClient(tx, taskId, reason, actor);
  }
  for (const missionId of missionIds) {
    retireOne(tx, "mission", missionId, reason, actor);
  }
  retireDefinitionsForNamespaceWithClient(tx, "habitat", habitatId);
  retireOne(tx, "habitat", habitatId, reason, actor);
}

/**
 * Team deletion custody bundle (binding): retire Team + every descendant
 * Habitat/Mission/Task ledger and namespace and revoke all grants, then —
 * after the caller deletes the Team row (habitats.teamId SET NULL fires) —
 * reenroll FRESH active incarnations (old+1, version 1) for the
 * still-existing descendants so they stay administrable by global admins
 * with no carried-over grants. Run `retireTeamCustodyWithClient` BEFORE the
 * team row delete and `reenrollTeamDescendantsWithClient` AFTER it, in the
 * SAME reservation.
 */
export function retireTeamCustodyWithClient(
  tx: LocalAuthorizationDbClient,
  teamId: string,
  reason: string,
  actor?: CustodyActor,
): { habitatIds: string[] } {
  const habitatIds = tx
    .select({ id: habitats.id })
    .from(habitats)
    .where(eq(habitats.teamId, teamId))
    .all()
    .map((r) => r.id);
  for (const habitatId of habitatIds) {
    retireHabitatCustodyWithClient(tx, habitatId, reason, actor);
  }
  retireDefinitionsForNamespaceWithClient(tx, "team", teamId);
  retireOne(tx, "team", teamId, reason, actor);
  return { habitatIds };
}

/**
 * Same-id restore re-enrollment for one scope the import is about to
 * re-insert under its existing server id. Retires any ACTIVE incarnation
 * (revoking its grants — stale grants never survive a custody transition)
 * and enrolls a FRESH active incarnation so the restored entity's ledger
 * reads active, not retired-only. A scope with NO ledger history (never
 * materialized — the common restore case for pre-governance exports) is
 * left alone: nothing to retire, nothing to revive, no churn. Only call
 * this for ids the prepared manifest actually restores — never as a broad
 * rescan, which would re-enroll preserved/unrelated scopes. Audited with
 * the real import actor.
 */
export function reenrollRestoredScopeWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: "task" | "mission",
  scopeId: string,
  reason: string,
  actor?: CustodyActor,
): void {
  const hasHistory = tx
    .select({ scopeKind: governanceScopes.scopeKind })
    .from(governanceScopes)
    .where(and(eq(governanceScopes.scopeKind, scopeKind), eq(governanceScopes.scopeId, scopeId)))
    .get();
  if (!hasHistory) return; // never materialized — the restore reads virtual 1/1
  retireOne(tx, scopeKind, scopeId, reason, actor);
  const fresh = reenrollScopeWithClient(tx, scopeKind, scopeId);
  audit(tx, {
    actorType: actor?.actorType ?? "human",
    actorId: actor?.actorId ?? "unknown",
    operation: `${scopeKind}.custody_reenrolled`,
    scopeKind,
    scopeId,
    scopeIncarnation: fresh.incarnation,
    objectKind: scopeKind,
    objectId: scopeId,
    details: { reason },
  });
}

/** Post-delete half of the Team custody bundle (same reservation). */
export function reenrollTeamDescendantsWithClient(
  tx: LocalAuthorizationDbClient,
  habitatIds: string[],
  reason: string,
  actor?: CustodyActor,
): void {
  for (const habitatId of habitatIds) {
    // Skip habitats the delete actually removed (defensive; SET NULL keeps them).
    const still = tx
      .select({ id: habitats.id })
      .from(habitats)
      .where(eq(habitats.id, habitatId))
      .get();
    if (!still) continue;
    const fresh = reenrollScopeWithClient(tx, "habitat", habitatId);
    const missionIds = missionIdsForHabitat(tx, habitatId);
    for (const taskId of taskIdsForMissions(tx, missionIds)) {
      reenrollScopeWithClient(tx, "task", taskId);
    }
    for (const missionId of missionIds) {
      reenrollScopeWithClient(tx, "mission", missionId);
    }
    audit(tx, {
      actorType: actor?.actorType ?? "human",
      actorId: actor?.actorId ?? "unknown",
      operation: "habitat.custody_reenrolled",
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: fresh.incarnation,
      objectKind: "habitat",
      objectId: habitatId,
      details: { reason },
    });
  }
}
