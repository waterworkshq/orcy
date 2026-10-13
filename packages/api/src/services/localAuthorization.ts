/**
 * Local authorization evaluator (role-foundation storage ticket).
 *
 * Transaction-client permission evaluation for the fixed operational
 * catalogue. Runs on the CALLER's client — usually a BEGIN IMMEDIATE writer
 * reservation — and never opens its own transaction for writes. Reads are
 * pure: authorized reads of a live, never-materialized governance scope
 * report virtual (incarnation 1, version 1) WITHOUT materializing anything.
 *
 * Contract anchors (binding addendum + role-foundation contract):
 *   - Deny unknown/malformed permissions, invalid principal/scope
 *     combinations, expired grants (decision time), retired incarnations.
 *   - Typed (principalType, id) equality only — never bare registry IDs.
 *   - Human adapters: persisted global admin (all scopes) / non-viewer team
 *     owner/admin (current team descendants) / explicit personal owner
 *     (still-personal Habitat). Global viewer is a ceiling that denies even
 *     over a matching grant.
 *   - Downward inheritance only, resolved from database ancestry; a
 *     caller-supplied scope id is resolved against real rows, never trusted
 *     as a substitute ancestry.
 *   - The current typed executor of a target Task cannot hold review.assign
 *     authority on it (own-Task denial). assigned_agent_id is the executor;
 *     delegated_to_agent_id is an offer, not execution.
 *   - review.configure's served consumer target is a Habitat;
 *     review.assign's is a Task. Team/Mission are assignment scopes, not
 *     authorization targets for these permissions.
 *
 * This module is storage/evaluator only: the administration commands that
 * mint definitions/assignments and the review-governance consumers that call
 * authorizeWithClient at their final writes land in their own tickets.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  agents,
  governanceScopes,
  roleAssignments,
  roleDefinitions,
  roleRevisions,
  habitats,
  missions,
  tasks,
  teams,
  teamMembers,
  users,
} from "../db/schema/index.js";

/** Any Drizzle client — the root database or a transaction client. */
export type LocalAuthorizationDbClient = ReturnType<typeof getDb>;

/** Fixed operational permission catalogue (catalogue version 1). */
export const LOCAL_PERMISSION_CATALOGUE = ["review.configure", "review.assign"] as const;
export type LocalPermission = (typeof LOCAL_PERMISSION_CATALOGUE)[number];
export const LOCAL_PERMISSION_CATALOGUE_VERSION = 1;

/** Typed local principal — persisted local human or local agent identity. */
export type LocalPrincipal = { type: "human"; id: string } | { type: "agent"; id: string };

export type GovernanceScopeKind = "team" | "habitat" | "mission" | "task";

/** Authorization target: the object the operation acts on. */
export type AuthorizationTarget = {
  scopeKind: GovernanceScopeKind;
  scopeId: string;
};

/** Assignment scope kinds valid for each permission (binding addendum). */
export const ASSIGNABLE_SCOPES: Record<LocalPermission, readonly GovernanceScopeKind[]> = {
  "review.configure": ["team", "habitat"],
  "review.assign": ["team", "habitat", "mission", "task"],
};

/** Served consumer target kinds for each permission. */
const SERVED_TARGETS: Record<LocalPermission, readonly GovernanceScopeKind[]> = {
  "review.configure": ["habitat"],
  "review.assign": ["task"],
};

/** Internal, machine-readable denial reasons (public errors stay generic). */
export type AuthorizationDenialReason =
  | "UNKNOWN_PERMISSION"
  | "MALFORMED_PERMISSION"
  | "PRINCIPAL_NOT_FOUND"
  | "VIEWER_CEILING"
  | "NO_ACTIVE_GRANT"
  | "EXPIRED_GRANT"
  | "OWN_TASK_DENIAL"
  | "SCOPE_NOT_FOUND"
  | "RETIRED_SCOPE"
  | "INVALID_SCOPE_CHAIN";

export type AuthorizationDecision =
  | {
      allowed: true;
      via: "human_adapter" | "assignment";
      matchedAssignmentId?: string;
    }
  | { allowed: false; reason: AuthorizationDenialReason };

/** Live scope state as seen by authorized readers. */
export type GovernanceScopeState =
  | {
      status: "active";
      incarnation: number;
      version: number;
      /** false = live resource with no ledger history (virtual 1/1 read). */
      materialized: boolean;
    }
  | {
      status: "retired";
      incarnation: number;
      version: number;
      materialized: true;
      retiredAt: string;
    };

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/**
 * Resolves the chain of scope ids a target participates in, from the target
 * itself up to its Team, using persisted rows only: Task→Mission→Habitat→Team
 * (Habitat chain stops at Team; personal Habitats have no Team). Returns null
 * when the resource does not exist or the ancestry is broken. Order is
 * [target, ..., outermost].
 */
export function resolveScopeChainWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: GovernanceScopeKind,
  scopeId: string,
): { scopeKind: GovernanceScopeKind; scopeId: string }[] | null {
  if (scopeKind === "team") {
    const row = tx.select({ id: teams.id }).from(teams).where(eq(teams.id, scopeId)).get();
    return row ? [{ scopeKind: "team", scopeId }] : null;
  }

  if (scopeKind === "habitat") {
    const row = tx
      .select({ id: habitats.id, teamId: habitats.teamId })
      .from(habitats)
      .where(eq(habitats.id, scopeId))
      .get();
    if (!row) return null;
    const chain: { scopeKind: GovernanceScopeKind; scopeId: string }[] = [
      { scopeKind: "habitat", scopeId },
    ];
    // Nonnull teamId is an EXPLICIT team ancestry claim: resolve the Team
    // row and fail closed (null chain) when it is missing — never silently
    // degrade to a personal-habitat partial chain. Empty-string ids are
    // invalid nonnull values and fail the same way. Explicit null
    // comparison keeps undefined/null teamId meaning genuinely personal.
    if (row.teamId !== null && row.teamId !== undefined) {
      if (row.teamId === "" || !resolveScopeChainWithClient(tx, "team", row.teamId)) {
        return null;
      }
      chain.push({ scopeKind: "team", scopeId: row.teamId });
    }
    return chain;
  }

  if (scopeKind === "mission") {
    const row = tx
      .select({ id: missions.id, habitatId: missions.habitatId })
      .from(missions)
      .where(eq(missions.id, scopeId))
      .get();
    if (!row) return null;
    const habitatChain = resolveScopeChainWithClient(tx, "habitat", row.habitatId);
    if (!habitatChain) return null;
    return [{ scopeKind: "mission", scopeId }, ...habitatChain];
  }

  // task
  const row = tx
    .select({ id: tasks.id, missionId: tasks.missionId })
    .from(tasks)
    .where(eq(tasks.id, scopeId))
    .get();
  if (!row) return null;
  const missionChain = resolveScopeChainWithClient(tx, "mission", row.missionId);
  if (!missionChain) return null;
  return [{ scopeKind: "task", scopeId }, ...missionChain];
}

/**
 * Authoritative scope state for governance readers. NEVER writes: a live
 * resource with no ledger history reports the virtual initial state
 * (incarnation 1, version 1, materialized false); a retired/history-bearing
 * key uses its recorded disposition; a missing resource is null.
 */
export function getScopeStateWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: GovernanceScopeKind,
  scopeId: string,
): GovernanceScopeState | null {
  const chain = resolveScopeChainWithClient(tx, scopeKind, scopeId);
  if (!chain) return null;

  const active = tx
    .select()
    .from(governanceScopes)
    .where(
      and(
        eq(governanceScopes.scopeKind, scopeKind),
        eq(governanceScopes.scopeId, scopeId),
        sql`${governanceScopes.retiredAt} IS NULL`,
      ),
    )
    .get();
  if (active) {
    return {
      status: "active",
      incarnation: active.incarnation,
      version: active.version,
      materialized: true,
    };
  }

  const any = tx
    .select()
    .from(governanceScopes)
    .where(and(eq(governanceScopes.scopeKind, scopeKind), eq(governanceScopes.scopeId, scopeId)))
    .get();
  if (any) {
    // History exists and none is active: retired, never virtually revived.
    return {
      status: "retired",
      incarnation: any.incarnation,
      version: any.version,
      materialized: true,
      retiredAt: any.retiredAt ?? "",
    };
  }

  // Live resource (chain resolved) with no ledger history: virtual 1/1.
  return { status: "active", incarnation: 1, version: 1, materialized: false };
}

// ---------------------------------------------------------------------------
// Principal + permission validation
// ---------------------------------------------------------------------------

function isLocalPermission(value: string): value is LocalPermission {
  return (LOCAL_PERMISSION_CATALOGUE as readonly string[]).includes(value);
}

/** Strict stored-set validation: every element must be a known permission. */
function isLocalPermissionArray(values: readonly string[]): boolean {
  return values.every((p) => isLocalPermission(p));
}

/**
 * Canonical-instant check for stored expiry strings: parseable AND its
 * canonical UTC round-trip must equal the input, so offset representations
 * are refused as malformed storage rather than compared lexically. Evaluator
 * contract: canonical form or refusal — normalization before storage is the
 * command layer's concern, deliberately not done here.
 */
function isValidCanonicalIsoInstant(value: string): boolean {
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) return false;
  return new Date(parsed).toISOString() === value;
}

/**
 * Validates that the target kind is a served consumer target for the
 * permission. Called BEFORE inheritance/executor logic so a mis-targeted
 * call can never evade the Task-executor denial via a Team/Mission target.
 */
function targetCompatible(permission: LocalPermission, target: AuthorizationTarget): boolean {
  return SERVED_TARGETS[permission].includes(target.scopeKind);
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

/**
 * Full-decision permission evaluation on the caller's client. Pure read —
 * see module doc. Denial reasons are internal codes; public HTTP surfaces
 * stay generic AUTHORIZATION_DENIED with no grant/scope echo.
 */
export function evaluatePermissionsWithClient(
  tx: LocalAuthorizationDbClient,
  principal: LocalPrincipal,
  permission: LocalPermission,
  target: AuthorizationTarget,
): AuthorizationDecision {
  if (!isLocalPermission(permission)) {
    return { allowed: false, reason: "UNKNOWN_PERMISSION" };
  }
  if (!targetCompatible(permission, target)) {
    return { allowed: false, reason: "MALFORMED_PERMISSION" };
  }

  const chain = resolveScopeChainWithClient(tx, target.scopeKind, target.scopeId);
  if (!chain) return { allowed: false, reason: "SCOPE_NOT_FOUND" };

  // Retired target scope: its incarnation no longer authorizes.
  const targetState = getScopeStateWithClient(tx, target.scopeKind, target.scopeId);
  if (!targetState) return { allowed: false, reason: "SCOPE_NOT_FOUND" };
  if (targetState.status === "retired") {
    return { allowed: false, reason: "RETIRED_SCOPE" };
  }

  if (principal.type === "human") {
    return evaluateHuman(tx, principal, permission, target, chain);
  }
  return evaluateAgent(tx, principal, permission, target, chain);
}

/** Boolean convenience wrapper over evaluatePermissionsWithClient. */
export function authorizeWithClient(
  tx: LocalAuthorizationDbClient,
  principal: LocalPrincipal,
  permission: LocalPermission,
  target: AuthorizationTarget,
): boolean {
  return evaluatePermissionsWithClient(tx, principal, permission, target).allowed;
}

/**
 * Human branch: persisted global admin (all scopes) / non-viewer team
 * owner|admin of the Habitat's current team / explicit personal owner of the
 * still-personal Habitat — the human governance adapters. The global viewer
 * ceiling denies before any grant is even considered.
 */
function evaluateHuman(
  tx: LocalAuthorizationDbClient,
  principal: { type: "human"; id: string },
  permission: LocalPermission,
  target: AuthorizationTarget,
  chain: { scopeKind: GovernanceScopeKind; scopeId: string }[],
): AuthorizationDecision {
  const userRow = tx
    .select({ id: users.id, role: users.role })
    .from(users)
    .where(eq(users.id, principal.id))
    .get();
  if (!userRow) return { allowed: false, reason: "PRINCIPAL_NOT_FOUND" };

  // Viewer ceiling: an invariant denial no grant or adapter can bypass.
  if (userRow.role === "viewer") {
    return { allowed: false, reason: "VIEWER_CEILING" };
  }

  if (userRow.role === "admin") {
    return { allowed: true, via: "human_adapter" };
  }

  // Human governance adapters resolve through the target's ancestor chain,
  // so they govern BOTH served target kinds (Habitat and descendant Task):
  // a non-viewer team owner/admin or explicit personal owner manages review
  // on a descendant Task without an extra operational assignment.
  const habitatScope = chain.find((s) => s.scopeKind === "habitat");
  if (habitatScope) {
    const habitatRow = tx
      .select({ teamId: habitats.teamId, ownerUserId: habitats.ownerUserId })
      .from(habitats)
      .where(eq(habitats.id, habitatScope.scopeId))
      .get();
    if (habitatRow) {
      // Explicit personal owner of the still-personal Habitat (teamId must
      // be null — a team Habitat never carries a personal owner).
      if (habitatRow.ownerUserId === principal.id && habitatRow.teamId === null) {
        return { allowed: true, via: "human_adapter" };
      }
      // Non-viewer current team owner/admin of the Habitat's team.
      if (habitatRow.teamId) {
        const member = tx
          .select({ role: teamMembers.role })
          .from(teamMembers)
          .where(
            and(eq(teamMembers.teamId, habitatRow.teamId), eq(teamMembers.userId, principal.id)),
          )
          .get();
        if (member?.role === "owner" || member?.role === "admin") {
          return { allowed: true, via: "human_adapter" };
        }
      }
    }
  }

  // Human without a governance adapter needs an explicit operational grant.
  return findActiveGrant(tx, principal, permission, chain);
}

/**
 * Agent branch: explicit operational grants only (no adapters). Own-Task
 * denial: the typed agent that is the target Task's current persisted
 * executor (assigned_agent_id) cannot hold review.assign on it.
 */
function evaluateAgent(
  tx: LocalAuthorizationDbClient,
  principal: { type: "agent"; id: string },
  permission: LocalPermission,
  target: AuthorizationTarget,
  chain: { scopeKind: GovernanceScopeKind; scopeId: string }[],
): AuthorizationDecision {
  const agentRow = tx
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.id, principal.id))
    .get();
  if (!agentRow) return { allowed: false, reason: "PRINCIPAL_NOT_FOUND" };

  if (permission === "review.assign" && target.scopeKind === "task") {
    const taskRow = tx
      .select({ assignedAgentId: tasks.assignedAgentId })
      .from(tasks)
      .where(eq(tasks.id, target.scopeId))
      .get();
    if (taskRow?.assignedAgentId === principal.id) {
      return { allowed: false, reason: "OWN_TASK_DENIAL" };
    }
  }

  return findActiveGrant(tx, principal, permission, chain);
}

/**
 * Union of qualifying current assignments for the principal whose pinned
 * revision's permissions contain the requested permission, whose assignment
 * scope is an ancestor-or-self of the target chain (downward inheritance
 * only), whose scope kind is assignable for the permission, whose state is
 * active, not expired at decision time, and whose captured incarnation is
 * still the scope's active incarnation. Invariant denials were already
 * applied by the callers; this is the positive grant lookup.
 */
function findActiveGrant(
  tx: LocalAuthorizationDbClient,
  principal: LocalPrincipal,
  permission: LocalPermission,
  chain: { scopeKind: GovernanceScopeKind; scopeId: string }[],
): AuthorizationDecision {
  const assignable = ASSIGNABLE_SCOPES[permission];
  const chainKeys = chain
    .filter((s) => assignable.includes(s.scopeKind))
    .map((s) => ({ kind: s.scopeKind, id: s.scopeId }));
  if (chainKeys.length === 0) return { allowed: false, reason: "NO_ACTIVE_GRANT" };

  const scopeKinds = chainKeys.map((k) => k.kind);
  const scopeIds = chainKeys.map((k) => k.id);

  const rows = tx
    .select({
      assignmentId: roleAssignments.id,
      scopeKind: roleAssignments.scopeKind,
      scopeId: roleAssignments.scopeId,
      scopeIncarnation: roleAssignments.scopeIncarnation,
      expiresAt: roleAssignments.expiresAt,
      permissions: roleRevisions.permissions,
      catalogueVersion: roleRevisions.catalogueVersion,
      namespaceKind: roleDefinitions.namespaceKind,
      namespaceScopeId: roleDefinitions.namespaceScopeId,
      namespaceIncarnation: roleDefinitions.namespaceIncarnation,
    })
    .from(roleAssignments)
    .innerJoin(roleRevisions, eq(roleAssignments.revisionId, roleRevisions.id))
    .innerJoin(roleDefinitions, eq(roleAssignments.definitionId, roleDefinitions.id))
    .where(
      and(
        eq(roleAssignments.principalType, principal.type),
        eq(roleAssignments.principalId, principal.id),
        eq(roleAssignments.state, "active"),
        inArray(roleAssignments.scopeKind, scopeKinds),
        inArray(roleAssignments.scopeId, scopeIds),
        sql`${roleDefinitions.retiredAt} IS NULL`,
      ),
    )
    .all();

  const nowEpochMs = Date.now();
  let sawExpiredMatch = false;
  for (const row of rows) {
    // Malformed storage first, expiry comparison second: a noncanonical or
    // unparseable expiry string is malformed storage that authorizes
    // nothing — never mislabeled as a valid expired grant. Only canonical
    // strings reach the epoch comparison.
    if (row.expiresAt !== null) {
      if (!isValidCanonicalIsoInstant(row.expiresAt)) continue;
    }
    // Pinned revision must contain the permission with a supported catalogue
    // version and a fully known permission set — a revision carrying unknown
    // permissions or an unsupported catalogue version is malformed storage
    // and authorizes nothing.
    let permissions: unknown;
    try {
      permissions = JSON.parse(row.permissions);
    } catch {
      continue;
    }
    if (
      !Array.isArray(permissions) ||
      !permissions.every((p): p is string => typeof p === "string") ||
      !isLocalPermissionArray(permissions)
    ) {
      continue;
    }
    if (row.catalogueVersion !== LOCAL_PERMISSION_CATALOGUE_VERSION) continue;
    if (!permissions.includes(permission)) continue;
    // Ancestor-or-self match against the target chain.
    const chainMatch = chainKeys.some((k) => k.kind === row.scopeKind && k.id === row.scopeId);
    if (!chainMatch) continue;

    // History-aware assignment-scope state: the grant's captured incarnation
    // must equal the CURRENT ACTIVE incarnation of its scope. A retired-only
    // history (no active row) refuses outright — never virtually 1.
    const assignmentScopeState = getScopeStateWithClient(tx, row.scopeKind, row.scopeId);
    if (!assignmentScopeState || assignmentScopeState.status !== "active") {
      continue;
    }
    if (row.scopeIncarnation !== assignmentScopeState.incarnation) {
      continue;
    }

    // Namespace containment: a custom Team definition authorizes only when
    // its namespace is in BOTH the qualifying assignment scope's resolved
    // ancestry AND the target's ancestry, at the current captured namespace
    // incarnation; a Habitat definition only within its own Habitat or
    // current descendants (an assignment at the PARENT Team is upward-
    // incompatible and denies even for a Task inside that Habitat).
    // Built-ins have no tenant namespace and are exempt from this check
    // only — their assignment scope checks above still apply.
    if (row.namespaceKind !== "builtin") {
      const inTargetChain = chainKeys.some(
        (k) => k.kind === row.namespaceKind && k.id === row.namespaceScopeId,
      );
      if (!inTargetChain) continue;
      // The assignment scope's own ancestry must contain the namespace too.
      const assignmentAncestry = resolveScopeChainWithClient(tx, row.scopeKind, row.scopeId);
      if (!assignmentAncestry) continue;
      const inAssignmentAncestry = assignmentAncestry.some(
        (k) => k.scopeKind === row.namespaceKind && k.scopeId === row.namespaceScopeId,
      );
      if (!inAssignmentAncestry) continue;
      const namespaceState = getScopeStateWithClient(tx, row.namespaceKind, row.namespaceScopeId!);
      if (!namespaceState || namespaceState.status !== "active") continue;
      if (row.namespaceIncarnation !== namespaceState.incarnation) continue;
    }

    // Only an otherwise qualifying grant can explain an expired denial.
    if (row.expiresAt !== null && Date.parse(row.expiresAt) <= nowEpochMs) {
      sawExpiredMatch = true;
      continue;
    }
    return { allowed: true, via: "assignment", matchedAssignmentId: row.assignmentId };
  }

  if (sawExpiredMatch) return { allowed: false, reason: "EXPIRED_GRANT" };
  return { allowed: false, reason: "NO_ACTIVE_GRANT" };
}
