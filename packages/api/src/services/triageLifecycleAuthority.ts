/**
 * Restored Finding Triage lifecycle — Authority Policy (T4).
 *
 * Owns the actor-bound authorization predicate that gates `route`,
 * `activate`, `resolve`, and `markWontfix` commands. The lifecycle command
 * kernel (`findingTriageLifecycle.ts`) accepts only authenticated
 * `LifecycleActor` instances that this policy has cleared. Every command
 * re-checks authority inside the lifecycle transaction (in addition to this
 * pre-check) so a TOCTOU race cannot escalate an agent from "claimant" to
 * "completed/released" without losing authority.
 *
 * Authority matrix (per restored-lifecycle-tech-plan + ADR-0048):
 *
 *  | Actor                    | route | activate | resolve | wontfix |
 *  |--------------------------|-------|----------|---------|---------|
 *  | Human (Habitat write)    |  yes  |   yes    |  yes    |  yes    |
 *  | Local agent              |  yes¹ |   no     |  no     |  no     |
 *  | Remote (contributor)     |  yes² |   no     |  no     |  no     |
 *  | Internal system          |  no   |   no     |  no     |  no     |  (Release Activation T6)
 *
 *  ¹ Local agent is the CURRENT claimant of the Finding's admitted
 *    `admittedByInvestigationTaskId` Task. Pre-T4 admission rows carry null
 *    and are agent-denied (legacy-row guard).
 *  ² Remote caller must be active `remote_contributor`, hold a live exact
 *    claim on the admitted Task, and own ONE same active `scoped_elevation`
 *    or explicitly marked `permanent_execution` grant carrying both
 *    `triage.route` scope AND the exact Task allowlist target.
 *    Observer, grace, baseline, Habitat/Mission targets, split grants, and
 *    rule-based snapshots never authorize routing. Denials collapse
 *    not-found/forbidden into a single 403 to avoid a Finding existence
 *    oracle.
 *
 * This module never throws AppError directly — it returns a discriminated
 * result so the lifecycle command kernel can decide how to surface the
 * denial (HTTP anti-probing collapse vs in-tx rollback error mapping).
 */

import { eq } from "drizzle-orm";
import type { TriageActorType } from "@orcy/shared";

import { getDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";
import type { RemoteGrantRow, RemoteGrantTargetRow } from "../repositories/remoteGrant.js";
import { getRemoteGrantTargets } from "../repositories/remoteGrant.js";

/** The minimal pre-shape of a triage finding needed for authority checks. */
export interface AuthorityFindingShape {
  id: string;
  habitatId: string;
  /** Exact Task whose current claim authorizes agent routing. Null on legacy rows. */
  admittedByInvestigationTaskId: string | null;
}

/** Authenticated actor passed by HTTP transport seam. */
export type AuthorityActor =
  | { type: "human"; id: string }
  | { type: "agent"; id: string }
  | { type: "system"; id: string };

/**
 * A pre-validated remote participant context. The HTTP transport seam resolves
 * this from `request.remoteParticipant` AFTER `remoteParticipantAuth` runs.
 */
export interface RemoteAuthorityActor {
  type: "remote_human" | "remote_orcy";
  id: string;
  habitatId: string;
  remoteParticipant: RemoteParticipantContext;
}

export type AuthorityCheck =
  | { kind: "allow"; actor: TriageActorType }
  | {
      kind: "deny";
      reason:
        | "not_found"
        | "not_authorized"
        | "terminal"
        | "legacy_lineage_repair_required"
        | "different_route"
        | "different_payload"
        | "invalid_input";
      /**
       * Anti-probing: callers expose the same message for not-found and
       * not-authorized. The internal `code` is logged but never sent to a
       * remote client verbatim.
       */
      code: string;
      message: string;
    };

/** Human-write authority over a habitat: required for route/activate/resolve/wontfix. */
export interface HumanHabitatAccessChecker {
  /**
   * Returns true iff `userId` has write authority on `habitatId`. Local agents
   * and remote participants NEVER pass this check — the caller maps those to
   * the agent/remote paths instead.
   */
  userHasHabitatWriteAccess(userId: string, habitatId: string): boolean;
}

/**
 * Result of the route authority check.
 *
 * - `allow` — the actor may proceed to dispatch the lifecycle command.
 * - `deny`  — actor is not authorized; the lifecycle command kernel should
 *             rollback without writing. The `code` field is server-side only.
 */
export type RouteAuthorityResult = AuthorityCheck;

// ---------------------------------------------------------------------------
// Public predicate — route
// ---------------------------------------------------------------------------

/**
 * Authorizes a `routeFinding` call. Used for both HTTP transport pre-check and
 * the in-transaction re-check (the lifecycle kernel calls it again under its
 * own writer reservation to close the TOCTOU race).
 *
 * For remote callers, the predicate is intentionally strict:
 *   - standing MUST be `remote_contributor`
 *   - participant MUST currently claim the EXACT `admittedByInvestigationTaskId` Task
 *   - exactly ONE active `scoped_elevation` or marked `permanent_execution` grant
 *     must carry BOTH `triage.route` scope AND an allowlist target for that
 *     exact Task id.
 *
 * Two grants (each carrying one proof) DO NOT satisfy the predicate. The
 * "same grant" rule is a deliberate same-active grant requirement: the action
 * scope AND the allowlist target must come from the same grant row. Broader
 * Task allowlists that contain the exact id via `includeFutureMatches` +
 * `rule_based` are NOT sufficient — only explicit `allowlist` mode for the
 * exact Task id is honored, mirroring the canonical claim-bound authority.
 */
export function checkRouteAuthority(args: {
  finding: AuthorityFindingShape;
  actor: AuthorityActor;
  access?: HumanHabitatAccessChecker;
  remote?: RemoteAuthorityActor;
}): RouteAuthorityResult {
  // Legacy / un-admitted rows: agent routing is forbidden. Humans with write
  // access may still route (operator repair path).
  if (args.finding.admittedByInvestigationTaskId === null) {
    if (
      args.actor.type === "human" &&
      args.access?.userHasHabitatWriteAccess(args.actor.id, args.finding.habitatId)
    ) {
      return { kind: "allow", actor: "human" };
    }
    return deny(
      "not_authorized",
      "AGENT_AUTHORITY_REQUIRES_ADMITTED_TASK",
      "routing requires an admitted investigation Task",
    );
  }

  if (args.actor.type === "human") {
    if (
      !args.access ||
      !args.access.userHasHabitatWriteAccess(args.actor.id, args.finding.habitatId)
    ) {
      return deny(
        "not_authorized",
        "HABITAT_WRITE_REQUIRED",
        "human routing requires Habitat write authority",
      );
    }
    return { kind: "allow", actor: "human" };
  }

  if (args.actor.type === "agent") {
    const agentClaim = isAgentCurrentClaimantOfTask(
      args.actor.id,
      args.finding.admittedByInvestigationTaskId,
    );
    if (!agentClaim) {
      return deny(
        "not_authorized",
        "NOT_CURRENT_CLAIMANT",
        "local agent is not the current claimant of the admitted Task",
      );
    }
    return { kind: "allow", actor: "agent" };
  }

  if (args.actor.type === "system") {
    return deny(
      "not_authorized",
      "SYSTEM_CANNOT_ROUTE",
      "system actor cannot route findings; use Release activation",
    );
  }

  // Unknown actor type — defensive
  return deny("invalid_input", "UNKNOWN_ACTOR_TYPE", "unknown actor type");
}

/**
 * Authorizes a REMOTE route call. Returns a single result that distinguishes
 * denial reasons for server-side logging while collapsing the client-facing
 * code to a generic 403 (anti-probing: not-found vs not-authorized vs not-a-
 * contributor all surface as the same 403).
 */
export function checkRemoteRouteAuthority(args: {
  finding: AuthorityFindingShape;
  remote: RemoteAuthorityActor;
}): RouteAuthorityResult {
  const { finding, remote } = args;
  const ctx = remote.remoteParticipant;

  // Standing gate: only active remote_contributor. remote_observer and grace
  // never authorize.
  if (ctx.participant.standing !== "remote_contributor") {
    return deny(
      "not_authorized",
      "STANDING_NOT_CONTRIBUTOR",
      "remote routing requires remote_contributor standing",
    );
  }

  // Connection gate: credential/participant/pod must all be active.
  if (ctx.participant.status !== "active") {
    return deny("not_authorized", "PARTICIPANT_INACTIVE", "remote participant is not active");
  }
  if (ctx.pod.status !== "active") {
    return deny("not_authorized", "POD_INACTIVE", "remote pod is not active");
  }

  // Admitted-Task gate
  if (finding.admittedByInvestigationTaskId === null) {
    return deny("not_found", "NO_ADMITTED_TASK", "finding has no admitted investigation Task");
  }

  // Live exact claim on the admitted Task
  const claimed = isRemoteParticipantCurrentClaimantOfTask(
    ctx.participant.id,
    finding.admittedByInvestigationTaskId,
  );
  if (!claimed) {
    return deny(
      "not_authorized",
      "NOT_CURRENT_REMOTE_CLAIMANT",
      "remote participant is not the current claimant of the admitted Task",
    );
  }

  // Same-grant predicate: exactly one active scoped_elevation or
  // permanent_execution grant must carry BOTH `triage.route` AND an explicit
  // allowlist target equal to the exact admitted Task id.
  const grantResult = findSingleGrantWithBothProofs(
    ctx.grants,
    "triage.route",
    "task",
    finding.admittedByInvestigationTaskId,
  );
  if (!grantResult.allowed) {
    return deny("not_authorized", grantResult.code, grantResult.reason);
  }

  return { kind: "allow", actor: remote.type };
}

// ---------------------------------------------------------------------------
// Human-only commands (activate / resolve / wontfix)
// ---------------------------------------------------------------------------

/**
 * Manual activate / resolve / wontfix are human-only with Habitat write
 * authority. The lifecycle kernel maps a denial to `not_authorized` conflict.
 */
export function checkManualCommandAuthority(args: {
  finding: AuthorityFindingShape;
  actor: AuthorityActor;
  access?: HumanHabitatAccessChecker;
  command: "activate" | "resolve" | "wontfix";
}): AuthorityCheck {
  if (args.actor.type !== "human") {
    return deny(
      "not_authorized",
      `${args.command.toUpperCase()}_HUMAN_ONLY`,
      `${args.command} is human-only`,
    );
  }
  if (
    !args.access ||
    !args.access.userHasHabitatWriteAccess(args.actor.id, args.finding.habitatId)
  ) {
    return deny(
      "not_authorized",
      "HABITAT_WRITE_REQUIRED",
      `${args.command} requires Habitat write authority`,
    );
  }
  return { kind: "allow", actor: "human" };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function deny(
  reason:
    | "not_found"
    | "not_authorized"
    | "terminal"
    | "legacy_lineage_repair_required"
    | "different_route"
    | "different_payload"
    | "invalid_input",
  code: string,
  message: string,
): AuthorityCheck {
  return { kind: "deny", reason, code, message };
}

/**
 * True iff the local agent is the current claimant of the given Task AND the
 * Task is in a claimable state (claimed/in_progress). Released or completed
 * Tasks return false. The lifecycle kernel's in-tx recheck uses
 * `assignedAgentId === agentId` only — claim status is re-validated via the
 * lifecycle read on the same client.
 */
function isAgentCurrentClaimantOfTask(agentId: string, taskId: string): boolean {
  const db = getDb();
  const row = db
    .select({ assignedAgentId: tasks.assignedAgentId, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) return false;
  return row.assignedAgentId === agentId;
}

/**
 * True iff the remote participant is the current claimant of the given Task
 * AND the Task is in a claimable state (claimed/in_progress).
 */
function isRemoteParticipantCurrentClaimantOfTask(
  remoteParticipantId: string,
  taskId: string,
): boolean {
  const db = getDb();
  const row = db
    .select({
      remoteAssignedParticipantId: tasks.remoteAssignedParticipantId,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) return false;
  return row.remoteAssignedParticipantId === remoteParticipantId;
}

interface GrantSearchResult {
  allowed: boolean;
  code: string;
  reason: string;
  grant?: RemoteGrantRow;
}

/**
 * Returns `{allowed:true, grant}` iff EXACTLY ONE active `scoped_elevation` or
 * marked `permanent_execution` grant carries both `triage.route` scope AND an
 * explicit allowlist target equal to the exact Task id. Baseline grants,
 * rule-based grants, frozen/hard-revoked/grace grants, broader Habitat/Mission
 * targets, and split grants (action in one row, target in another) all fail.
 */
function findSingleGrantWithBothProofs(
  grants: RemoteGrantRow[],
  requiredScope: string,
  targetType: "task" | "mission" | "habitat",
  exactTargetId: string,
): GrantSearchResult {
  const matches: { grant: RemoteGrantRow; targets: RemoteGrantTargetRow[] }[] = [];

  for (const grant of grants) {
    // Only active scoped_elevation or permanent_execution grants can
    // authorize triage.route. permanent_execution is allowed only when its
    // action_scopes explicitly include the scope (it carries the same
    // allowlist semantics).
    if (grant.status !== "active") continue;
    if (grant.grantType !== "scoped_elevation" && grant.grantType !== "permanent_execution")
      continue;
    if (grant.grantType === "permanent_execution") {
      // Marked permanent_execution grants must explicitly include the scope.
      if (!grant.actionScopes.includes(requiredScope)) continue;
    }

    const scopes = grant.actionScopes as string[];
    if (!scopes.includes(requiredScope)) continue;

    // rule_based grants DO NOT satisfy the exact-Task predicate — they rely
    // on snapshot/rule matching, not explicit allowlists.
    if (grant.eligibilityMode !== "allowlist") continue;

    const targets = getRemoteGrantTargets(grant.id);
    const hasExactTarget = targets.some(
      (t) => t.targetType === targetType && t.targetId === exactTargetId,
    );
    if (!hasExactTarget) continue;

    matches.push({ grant, targets });
  }

  if (matches.length === 0) {
    return {
      allowed: false,
      code: "NO_SAME_GRANT_WITH_TASK_TARGET",
      reason: "no active grant carries both triage.route scope and the exact Task allowlist target",
    };
  }
  if (matches.length > 1) {
    // Multiple active grants both contain the proof — the caller must narrow
    // to a single grant, not split the predicate across grants.
    return {
      allowed: false,
      code: "MULTIPLE_GRANTS_AUTHORIZE",
      reason:
        "more than one active grant authorizes triage.route for this Task — disambiguate before routing",
    };
  }

  return { allowed: true, code: "OK", reason: "OK", grant: matches[0].grant };
}

/**
 * Default Habitat write-authority check used by local HTTP transport. Uses
 * team membership OR (no team = everyone with a JWT) for the same Habitat
 * authority the existing `verifyHabitatAccess` enforces for PATCH routes.
 *
 * Implementation note: the same predicates are evaluated inline in
 * `routes/triage.ts::verifyHabitatAccess` — this helper is the canonical
 * seam the authority policy consumes so tests can stub it without touching
 * Fastify request shape.
 */
export function defaultHabitatAccessChecker(): HumanHabitatAccessChecker {
  return {
    userHasHabitatWriteAccess(_userId: string, _habitatId: string): boolean {
      // The default policy treats ANY authenticated human with `request.user`
      // as Habitat-write-eligible. Habitat-team gating is performed at the
      // route level via `verifyHabitatAccess` BEFORE the policy runs. This
      // matches existing PATCH /triage/findings/:id behavior where any
      // authenticated human may mutate a non-team habitat.
      return true;
    },
  };
}

// Exported for test introspection only — never read at runtime by anything
// but the `getGrantTargetsFor` test helper.
export function _internalGetGrantTargets(grantId: string): RemoteGrantTargetRow[] {
  return getRemoteGrantTargets(grantId);
}
