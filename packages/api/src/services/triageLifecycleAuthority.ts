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
 * Authority matrix (per restored-lifecycle-tech-plan + ADR-0048; FU6 viewer
 * gate: a human with `role === "viewer"` is a read-only principal and holds
 * NO write authority on any command, teamed or un-teamed habitat):
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

import { eq, and } from "drizzle-orm";
import type { TriageActorType } from "@orcy/shared";

import { getDb } from "../db/index.js";
import {
  tasks,
  habitats,
  teamMembers,
  remoteParticipants,
  remotePods,
  remoteCredentials,
  users,
} from "../db/schema/index.js";
import type { RemoteParticipantContext } from "../middleware/remoteAuth.js";
import type { RemoteGrantRow, RemoteGrantTargetRow } from "../repositories/remoteGrant.js";
import {
  getActiveGrantsByParticipant,
  getRemoteGrantTargets,
  listRemoteGrantTargetsByGrantIds,
} from "../repositories/remoteGrant.js";

/** Supplied-client type for transaction participation (FU1 in-tx re-check). */
export type AuthorityDbClient = ReturnType<typeof getDb>;

/** Task statuses that represent an ACTIVE claim (FU1 — stale-claim defense). */
const ACTIVE_CLAIM_STATUSES = ["claimed", "in_progress"] as const;

/** The minimal pre-shape of a triage finding needed for authority checks. */
export interface AuthorityFindingShape {
  id: string;
  habitatId: string;
  /** Exact Task whose current claim authorizes agent routing. Null on legacy rows. */
  admittedByInvestigationTaskId: string | null;
}

/** Authenticated actor passed by HTTP transport seam. */
export type AuthorityActor =
  /**
   * `role` is the JWT role claim (FU6). The transport populates it so the
   * predicate can deny read-only viewers before the lifecycle kernel runs;
   * the in-transaction re-check independently re-reads the persisted
   * `users.role` under the writer reservation.
   */
  | { type: "human"; id: string; role?: "admin" | "editor" | "viewer" }
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
 * Real Habitat write-access checker used for the in-tx re-check (FU1).
 *
 * The transport precheck (`defaultHabitatAccessChecker`) returns true because
 * the transport layer already enforced `verifyHabitatAccess`. The in-tx
 * re-check needs its OWN real read to be race-safe — a habitat team
 * membership can be revoked between precheck and the in-tx mutation. Mirrors
 * `routes/triage.ts::verifyHabitatAccess` (team membership OR no-team = open)
 * but executes on the supplied client so it observes post-`BEGIN IMMEDIATE`
 * state.
 *
 * FU6 — viewer-role gate: this is the ONE authoritative place a human's write
 * capability is decided in-transaction. A persisted `users.role === "viewer"`
 * NEVER holds Habitat write authority, in teamed AND un-teamed habitats (an
 * un-teamed habitat is open to authenticated humans, but a viewer is a
 * read-only principal by definition — role caps what team membership or its
 * absence could otherwise grant). The role row is re-read on the supplied
 * client so a demotion to viewer between precheck and mutation is caught.
 * A missing users row is NOT treated as viewer — local human identity is
 * carried by the JWT (`middleware/jwt-verification.ts` does not consult the
 * users table), so absence of a row follows the established token-trust model.
 */
export function habitatAccessCheckerWithClient(
  client: AuthorityDbClient,
): HumanHabitatAccessChecker {
  return {
    userHasHabitatWriteAccess(userId: string, habitatId: string): boolean {
      const user = client
        .select({ role: users.role })
        .from(users)
        .where(eq(users.id, userId))
        .get();
      if (user?.role === "viewer") return false; // FU6: read-only principal
      const habitat = client
        .select({ teamId: habitats.teamId })
        .from(habitats)
        .where(eq(habitats.id, habitatId))
        .get();
      if (!habitat) return false;
      if (!habitat.teamId) return true; // un-teamed habitats = open write
      const member = client
        .select({ userId: teamMembers.userId })
        .from(teamMembers)
        .where(and(eq(teamMembers.teamId, habitat.teamId), eq(teamMembers.userId, userId)))
        .get();
      return member !== undefined;
    },
  };
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
  /**
   * Optional supplied client (FU1). When provided, all reads in the predicate
   * use this client so the in-tx re-check observes state under the writer
   * reservation. When omitted (transport precheck), reads use `getDb()`.
   */
  client?: AuthorityDbClient;
}): RouteAuthorityResult {
  // FU6 — viewer-role gate (transport path). The actor's `role` comes from
  // the JWT claim set by the transport; read-only viewers are denied before
  // any other predicate, in teamed AND un-teamed habitats. The in-tx re-check
  // independently re-reads `users.role` via `habitatAccessCheckerWithClient`.
  if (args.actor.type === "human" && args.actor.role === "viewer") {
    return deny(
      "not_authorized",
      "VIEWER_WRITE_DENIED",
      "viewer role is read-only and cannot route findings",
    );
  }

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
      args.client,
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
  /**
   * Optional supplied client (FU1). When provided, all reads in the predicate
   * use this client so the in-tx re-check observes state under the writer
   * reservation. When omitted (transport precheck), reads use `getDb()`.
   */
  client?: AuthorityDbClient;
}): RouteAuthorityResult {
  const { finding, remote, client } = args;
  const ctx = remote.remoteParticipant;

  const live = client
    ? recheckRemoteAuthorityOnClient(client, ctx)
    : {
        active: ctx.participant.status === "active" && ctx.pod.status === "active",
        standing: ctx.participant.standing,
        grants: ctx.grants,
        code: undefined as string | undefined,
      };
  if (!live.active) {
    return deny(
      "not_authorized",
      live.code ?? "PARTICIPANT_INACTIVE",
      "remote participant, pod, or credential is not active",
    );
  }

  // Standing gate: only active remote_contributor. remote_observer and grace
  // never authorize. Live standing is re-read on the supplied client so a
  // demotion between precheck and the in-tx mutation is caught.
  if (live.standing !== "remote_contributor") {
    return deny(
      "not_authorized",
      "STANDING_NOT_CONTRIBUTOR",
      "remote routing requires remote_contributor standing",
    );
  }

  // Admitted-Task gate
  if (finding.admittedByInvestigationTaskId === null) {
    return deny("not_found", "NO_ADMITTED_TASK", "finding has no admitted investigation Task");
  }

  // Live exact claim on the admitted Task (re-reads on the supplied client
  // when provided, so a claim released between precheck and the in-tx
  // mutation is caught). The helper enforces status IN
  // ('claimed','in_progress') — submitted/approved/done/released claims fail.
  const claimed = isRemoteParticipantCurrentClaimantOfTask(
    ctx.participant.id,
    finding.admittedByInvestigationTaskId,
    client,
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
  // allowlist target equal to the exact admitted Task id. When the supplied
  // client is provided, targets are loaded in ONE batched read so the denial
  // path is query-count-invariant — killing the timing/identity oracle.
  const grantResult = findSingleGrantWithBothProofs({
    grants: live.grants,
    requiredScope: "triage.route",
    targetType: "task",
    exactTargetId: finding.admittedByInvestigationTaskId,
    client: client ?? getDb(),
  });
  if (!grantResult.allowed) {
    return deny("not_authorized", grantResult.code, grantResult.reason);
  }

  return { kind: "allow", actor: remote.type };
}

// ---------------------------------------------------------------------------
// Human-only commands (activate / resolve / wontfix)
// ---------------------------------------------------------------------------

/**
 * Manual activate / resolve / wontfix (and the retained legacy first-link
 * adapter, FU6) are human-only with Habitat write authority. The lifecycle
 * kernel maps a denial to `not_authorized` conflict.
 */
export function checkManualCommandAuthority(args: {
  finding: AuthorityFindingShape;
  actor: AuthorityActor;
  access?: HumanHabitatAccessChecker;
  command: "activate" | "resolve" | "wontfix" | "link";
}): AuthorityCheck {
  if (args.actor.type !== "human") {
    return deny(
      "not_authorized",
      `${args.command.toUpperCase()}_HUMAN_ONLY`,
      `${args.command} is human-only`,
    );
  }
  // FU6 — viewer-role gate (transport path); see `checkRouteAuthority`.
  if (args.actor.role === "viewer") {
    return deny(
      "not_authorized",
      "VIEWER_WRITE_DENIED",
      `viewer role is read-only and cannot ${args.command} findings`,
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
 * Tasks return false — submitted/approved/done states RETAIN
 * `assignedAgentId` (see `taskStateMachine.ts:368-397`), so without the status
 * filter the helper would still pass for stale claimants (FU1 stale-claim
 * defense).
 */
function isAgentCurrentClaimantOfTask(
  agentId: string,
  taskId: string,
  client?: AuthorityDbClient,
): boolean {
  const db = client ?? getDb();
  const row = db
    .select({ assignedAgentId: tasks.assignedAgentId, status: tasks.status })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) return false;
  return (
    row.assignedAgentId === agentId &&
    (ACTIVE_CLAIM_STATUSES as readonly string[]).includes(row.status)
  );
}

/**
 * True iff the remote participant is the current claimant of the given Task
 * AND the Task is in a claimable state (claimed/in_progress). Same
 * stale-claim defense as the local helper — `remoteAssignedParticipantId` is
 * preserved across submitted/approved/done/released states in the current
 * `taskStateMachine.ts` implementation.
 */
function isRemoteParticipantCurrentClaimantOfTask(
  remoteParticipantId: string,
  taskId: string,
  client?: AuthorityDbClient,
): boolean {
  const db = client ?? getDb();
  const row = db
    .select({
      remoteAssignedParticipantId: tasks.remoteAssignedParticipantId,
      status: tasks.status,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!row) return false;
  return (
    row.remoteAssignedParticipantId === remoteParticipantId &&
    (ACTIVE_CLAIM_STATUSES as readonly string[]).includes(row.status)
  );
}

/**
 * Re-reads credential, participant standing/status, pod status, and grants on
 * the supplied client so the in-tx re-check catches revocation, expiry, or
 * demotion between the transport precheck and the lifecycle mutation.
 */
function recheckRemoteAuthorityOnClient(
  client: AuthorityDbClient,
  ctx: RemoteParticipantContext,
): { active: boolean; standing: string; grants: RemoteGrantRow[]; code?: string } {
  const credential = client
    .select({
      status: remoteCredentials.status,
      expiresAt: remoteCredentials.expiresAt,
    })
    .from(remoteCredentials)
    .where(eq(remoteCredentials.id, ctx.credentialId))
    .get();
  if (!credential || credential.status !== "active") {
    return { active: false, standing: ctx.participant.standing, grants: [], code: "CREDENTIAL_INACTIVE" };
  }
  if (credential.expiresAt && new Date(credential.expiresAt).getTime() < Date.now()) {
    return { active: false, standing: ctx.participant.standing, grants: [], code: "CREDENTIAL_EXPIRED" };
  }

  const participant = client
    .select({ status: remoteParticipants.status, standing: remoteParticipants.standing })
    .from(remoteParticipants)
    .where(eq(remoteParticipants.id, ctx.participant.id))
    .get();
  if (!participant || participant.status !== "active") {
    return { active: false, standing: ctx.participant.standing, grants: [], code: "PARTICIPANT_INACTIVE" };
  }

  const pod = client
    .select({ status: remotePods.status })
    .from(remotePods)
    .where(eq(remotePods.id, ctx.pod.id))
    .get();
  if (!pod || pod.status !== "active") {
    return { active: false, standing: participant.standing, grants: [], code: "POD_INACTIVE" };
  }

  return {
    active: true,
    standing: participant.standing,
    grants: getActiveGrantsByParticipant(ctx.participant.id, client),
  };
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
 *
 * FU1: when `client` is supplied, the target query is ONE batched read across
 * all matching grant ids (not N per-grant reads). This makes the denial path
 * query-count-invariant — killing the timing/identity oracle that varied by
 * grant count.
 */
function findSingleGrantWithBothProofs(args: {
  grants: RemoteGrantRow[];
  requiredScope: string;
  targetType: "task" | "mission" | "habitat";
  exactTargetId: string;
  client?: AuthorityDbClient;
}): GrantSearchResult {
  const { grants, requiredScope, targetType, exactTargetId, client } = args;
  const matches: { grant: RemoteGrantRow; targets: RemoteGrantTargetRow[] }[] = [];
  const grantIdsToFetch: string[] = [];

  for (const grant of grants) {
    // Only active scoped_elevation or permanent_execution grants can
    // authorize triage.route. permanent_execution is allowed only when its
    // action_scopes explicitly include the scope (it carries the same
    // allowlist semantics).
    if (grant.status !== "active") continue;
    if (grant.expiresAt && new Date(grant.expiresAt).getTime() < Date.now()) continue;
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

    grantIdsToFetch.push(grant.id);
  }

  if (grantIdsToFetch.length === 0) {
    return {
      allowed: false,
      code: "NO_SAME_GRANT_WITH_TASK_TARGET",
      reason: "no active grant carries both triage.route scope and the exact Task allowlist target",
    };
  }

  // FU1: ONE batched read for ALL candidate grants' targets. The denial path
  // for "no qualifying grant" is the same query count as "one qualifying
  // grant" — query-count-invariant. When the supplied client is provided,
  // this is a single SELECT on the in-tx client; when it is not, the
  // repository helper issues ONE query internally.
  const targetsByGrantId = listRemoteGrantTargetsByGrantIds(client ?? getDb(), grantIdsToFetch);

  for (const grant of grants) {
    if (!grantIdsToFetch.includes(grant.id)) continue;
    const targets = targetsByGrantId[grant.id] ?? [];
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
 *
 * FU6: this checker does NOT need a viewer branch — the authority predicate
 * itself denies `role === "viewer"` actors before consulting any checker
 * (`checkRouteAuthority` / `checkManualCommandAuthority`), and the in-tx
 * re-check uses the real `habitatAccessCheckerWithClient`, which re-reads
 * `users.role`.
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
