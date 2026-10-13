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
import { eq, inArray } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { habitats, missions, tasks } from "../db/schema/index.js";
import type { LocalAuthorizationDbClient } from "./localAuthorization.js";
import {
  appendGovernanceAuditWithClient,
  materializeScopeWithClient,
  reenrollScopeWithClient,
  retireDefinitionsForNamespaceWithClient,
  retireScopeWithClient,
  revokeAssignmentsForScopeWithClient,
} from "../repositories/roleFoundation.js";

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

export function taskIdsForHabitat(tx: LocalAuthorizationDbClient, habitatId: string): string[] {
  return taskIdsForMissions(tx, missionIdsForHabitat(tx, habitatId));
}

function retireOne(
  tx: LocalAuthorizationDbClient,
  scopeKind: "team" | "habitat" | "mission" | "task",
  scopeId: string,
  reason: string,
): void {
  // Revoke first (retained rows), then retire the ledger incarnation. A
  // never-materialized (virtual) scope is materialized first so the retired
  // incarnation is retained as history — a bare retire is a no-op on virtual
  // scopes and would leave no trace.
  revokeAssignmentsForScopeWithClient(tx, scopeKind, scopeId, reason);
  materializeScopeWithClient(tx, scopeKind, scopeId);
  retireScopeWithClient(tx, scopeKind, scopeId);
  audit(tx, {
    actorType: "human",
    actorId: "system",
    operation: `${scopeKind}.custody_retired`,
    scopeKind,
    scopeId,
    scopeIncarnation: 1,
    objectKind: scopeKind,
    objectId: scopeId,
    details: { reason },
  });
}

/** Retire a Task scope + its grants (Task delete seam). */
export function retireTaskCustodyWithClient(
  tx: LocalAuthorizationDbClient,
  taskId: string,
  reason: string,
): void {
  retireOne(tx, "task", taskId, reason);
}

/** Retire a Mission + its child Tasks (Mission delete seam). */
export function retireMissionCustodyWithClient(
  tx: LocalAuthorizationDbClient,
  missionId: string,
  reason: string,
): void {
  const childTaskIds = tx
    .select({ id: tasks.id })
    .from(tasks)
    .where(eq(tasks.missionId, missionId))
    .all()
    .map((r) => r.id);
  for (const taskId of childTaskIds) retireTaskCustodyWithClient(tx, taskId, reason);
  retireOne(tx, "mission", missionId, reason);
}

/** Retire v3-import domain replacement targets inside the publication tx. */
export function retireImportDomainWithClient(
  tx: LocalAuthorizationDbClient,
  domain: "tasks" | "missions",
  targetHabitatId: string,
): void {
  if (domain === "tasks") {
    for (const taskId of taskIdsForHabitat(tx, targetHabitatId)) {
      retireTaskCustodyWithClient(tx, taskId, "import replacement");
    }
    return;
  }
  for (const missionId of missionIdsForHabitat(tx, targetHabitatId)) {
    retireMissionCustodyWithClient(tx, missionId, "import replacement");
  }
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
): void {
  const missionIds = missionIdsForHabitat(tx, habitatId);
  for (const taskId of taskIdsForMissions(tx, missionIds)) {
    retireTaskCustodyWithClient(tx, taskId, reason);
  }
  for (const missionId of missionIds) {
    retireOne(tx, "mission", missionId, reason);
  }
  retireDefinitionsForNamespaceWithClient(tx, "habitat", habitatId);
  retireOne(tx, "habitat", habitatId, reason);
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
): { habitatIds: string[] } {
  const habitatIds = tx
    .select({ id: habitats.id })
    .from(habitats)
    .where(eq(habitats.teamId, teamId))
    .all()
    .map((r) => r.id);
  for (const habitatId of habitatIds) {
    retireHabitatCustodyWithClient(tx, habitatId, reason);
  }
  retireDefinitionsForNamespaceWithClient(tx, "team", teamId);
  retireOne(tx, "team", teamId, reason);
  return { habitatIds };
}

/** Post-delete half of the Team custody bundle (same reservation). */
export function reenrollTeamDescendantsWithClient(
  tx: LocalAuthorizationDbClient,
  habitatIds: string[],
  reason: string,
): void {
  for (const habitatId of habitatIds) {
    // Skip habitats the delete actually removed (defensive; SET NULL keeps them).
    const still = tx
      .select({ id: habitats.id })
      .from(habitats)
      .where(eq(habitats.id, habitatId))
      .get();
    if (!still) continue;
    reenrollScopeWithClient(tx, "habitat", habitatId);
    const missionIds = missionIdsForHabitat(tx, habitatId);
    for (const taskId of taskIdsForMissions(tx, missionIds)) {
      reenrollScopeWithClient(tx, "task", taskId);
    }
    for (const missionId of missionIds) {
      reenrollScopeWithClient(tx, "mission", missionId);
    }
    audit(tx, {
      actorType: "human",
      actorId: "system",
      operation: "habitat.custody_reenrolled",
      scopeKind: "habitat",
      scopeId: habitatId,
      scopeIncarnation: 1,
      objectKind: "habitat",
      objectId: habitatId,
      details: { reason },
    });
  }
}
