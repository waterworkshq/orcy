/**
 * Independent human review-requirement recovery (review-safety cutover).
 *
 * The ONLY legacy-unknown→known resolution and the ONLY reduction of a
 * positive baseline, before any role foundation: a task-scoped, human-auth
 * command under one BEGIN IMMEDIATE reservation. Authorization reads
 * PERSISTED rows on the same transaction (JWT role is an identity hint,
 * never authority):
 *
 *   persisted users.role !== 'viewer'
 *   && (users.role === 'admin'
 *       || (habitat has a team AND persisted team_members.role IN
 *           ('owner','admin') for that team))
 *
 * Personal habitats (no team) are global-admin-only by the same predicate.
 * The current typed claimant/executor and any actor who decided review in
 * the current generation are refused. A resolution never approves or
 * completes; a relaxation stays `required` (override-to-zero is never a
 * genuine known-zero for the merge webhook) and expires at the next
 * ownership end/reset/claimant change with immediate baseline restore.
 */
import { getDb } from "../db/index.js";
import { tasks, missions, habitats, users, teamMembers } from "../db/schema/index.js";
import { and, eq } from "drizzle-orm";
import {
  getRequirementWithClient,
  resolveRequirementWithClient,
  type ReviewRequirementRow,
} from "../repositories/reviewSafety.js";
import { createEventWithClient } from "../repositories/events/event-crud.js";

export type RecoveryOutcome =
  | { ok: true; requirement: ReviewRequirementRow; overrideId: string }
  | { ok: false; reason: string };

/** Persisted-role authorization, evaluated on the caller's transaction. */
export function authorizeRecoveryWithClient(
  tx: ReturnType<typeof getDb>,
  actorUserId: string,
  taskId: string,
): boolean {
  const taskRow = tx
    .select({ missionId: tasks.missionId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!taskRow) return false;
  const habitatRow = tx
    .select({ teamId: habitats.teamId })
    .from(missions)
    .innerJoin(habitats, eq(missions.habitatId, habitats.id))
    .where(eq(missions.id, taskRow.missionId))
    .get();
  if (!habitatRow) return false;

  const userRow = tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, actorUserId))
    .get();
  if (!userRow) return false;

  // Global viewer ceiling precedes either governor branch.
  if (userRow.role === "viewer") return false;
  if (userRow.role === "admin") return true;

  const teamId = habitatRow.teamId;
  if (!teamId) return false; // personal habitat: global-admin-only
  const member = tx
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, actorUserId)))
    .get();
  return member?.role === "owner" || member?.role === "admin";
}

export function resolveTaskReviewRequirement(input: {
  taskId: string;
  actorUserId: string;
  expectedTaskVersion: number;
  expectedRequirementVersion: number;
  effectiveCount: number;
  reason: string;
}): RecoveryOutcome {
  const db = getDb();
  return db.transaction(
    (tx) => {
      const authorized = authorizeRecoveryWithClient(tx, input.actorUserId, input.taskId);
      const result = resolveRequirementWithClient(tx, {
        taskId: input.taskId,
        actorId: input.actorUserId,
        expectedTaskVersion: input.expectedTaskVersion,
        expectedRequirementVersion: input.expectedRequirementVersion,
        effectiveCount: input.effectiveCount,
        reason: input.reason,
        authorized,
      });
      if (!result.ok) return { ok: false as const, reason: result.reason };

      // Audit marker (event row only — same reservation, no emitter postlude).
      createEventWithClient(tx, {
        taskId: input.taskId,
        actorType: "human",
        actorId: input.actorUserId,
        action: "updated",
        metadata: {
          reviewRequirementResolution: {
            overrideId: result.overrideId,
            newState: result.requirement.state,
            newEffectiveCount: result.requirement.effectiveCount,
            reason: input.reason,
          },
        },
      });
      return result;
    },
    { behavior: "immediate" },
  );
}

/** Read-side projection for the recovery UI/route. */
export function getTaskReviewRequirement(taskId: string): ReviewRequirementRow | null {
  return getRequirementWithClient(getDb(), taskId);
}
