/**
 * Local role administration commands (administration ticket).
 *
 * Every mutating command runs under ONE BEGIN IMMEDIATE reservation that
 * performs, in order: target existence check → persisted human-governor
 * authorization → scope-ledger CAS → mutation → scope-version bump →
 * governance audit. Any failure rolls the whole command back — an audit
 * fault rolls the mutation back with it.
 *
 * Authority is the persisted governor adapter (never JWT role alone, never a
 * past issuer): a global admin governs everywhere; a non-viewer persisted
 * team owner/admin governs that team's descendants; the explicit personal
 * owner governs a still-personal Habitat. A global viewer is an absolute
 * ceiling. Target-missing 404 comes BEFORE governor denial 403, so an
 * unauthorized caller never learns whether a target exists.
 */
import { and, eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { agents, habitats, roleAssignments, teamMembers, teams, users } from "../db/schema/index.js";
import { AppError } from "../errors.js";
import {
  ASSIGNABLE_SCOPES,
  LOCAL_PERMISSION_CATALOGUE,
  LOCAL_PERMISSION_CATALOGUE_VERSION,
  resolveScopeChainWithClient,
  type GovernanceScopeKind,
  type LocalAuthorizationDbClient,
  type LocalPermission,
} from "./localAuthorization.js";
import {
  appendGovernanceAuditWithClient,
  bumpScopeVersionWithClient,
  createDefinitionWithClient,
  findActiveGrantTupleWithClient,
  getAssignmentWithClient,
  getDefinitionWithClient,
  getRevisionWithClient,
  insertAssignmentWithClient,
  insertRevisionWithClient,
  listAssignmentsForScopeWithClient,
  listBuiltinDefinitionsWithClient,
  listDefinitionsForNamespaceWithClient,
  listRevisionsForDefinitionWithClient,
  materializeScopeWithClient,
  readScopeForWriterWithClient,
  repinAssignmentRevisionWithClient,
  retireDefinitionWithClient,
  revokeAssignmentWithClient,
  type GovernanceAuditInsert,
  type RoleAssignmentRow,
  type RoleDefinitionRow,
  type RoleRevisionRow,
  type ScopeKindLiteral,
} from "../repositories/roleFoundation.js";

// ---------------------------------------------------------------------------
// Errors — exact wire codes from the binding command matrix
// ---------------------------------------------------------------------------

const notFoundError = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
const deniedError = () => new AppError(403, "AUTHORIZATION_DENIED", "Authorization denied");
const governanceConflict = (message: string) =>
  new AppError(409, "GOVERNANCE_VERSION_CONFLICT", message);
const revisionConflict = (message: string) => new AppError(409, "ROLE_REVISION_CONFLICT", message);
const assignmentConflict = (message: string) =>
  new AppError(409, "ROLE_ASSIGNMENT_VERSION_CONFLICT", message);

// ---------------------------------------------------------------------------
// Governor predicate (persisted adapters on the command's transaction)
// ---------------------------------------------------------------------------

/**
 * Persisted human-governor check for a team or habitat governance scope, read
 * on the caller's transaction. Global admin passes; global viewer denies
 * (ceiling before any grant); a persisted team owner/admin governs a team and
 * its team-habitats; the explicit personal owner governs a still-personal
 * Habitat. Legacy unowned personal Habitats are global-admin-only.
 */
export function isGovernorWithClient(
  tx: LocalAuthorizationDbClient,
  actorUserId: string,
  scopeKind: "team" | "habitat",
  scopeId: string,
): boolean {
  const userRow = tx
    .select({ role: users.role })
    .from(users)
    .where(eq(users.id, actorUserId))
    .get();
  if (!userRow) return false;
  if (userRow.role === "viewer") return false;
  if (userRow.role === "admin") return true;

  if (scopeKind === "team") {
    return isTeamOwnerOrAdmin(tx, scopeId, actorUserId);
  }

  const habitatRow = tx
    .select({ teamId: habitats.teamId, ownerUserId: habitats.ownerUserId })
    .from(habitats)
    .where(eq(habitats.id, scopeId))
    .get();
  if (!habitatRow) return false;
  if (habitatRow.teamId === null) {
    return habitatRow.ownerUserId === actorUserId;
  }
  return isTeamOwnerOrAdmin(tx, habitatRow.teamId, actorUserId);
}

function isTeamOwnerOrAdmin(
  tx: LocalAuthorizationDbClient,
  teamId: string,
  userId: string,
): boolean {
  const member = tx
    .select({ role: teamMembers.role })
    .from(teamMembers)
    .where(and(eq(teamMembers.teamId, teamId), eq(teamMembers.userId, userId)))
    .get();
  return member?.role === "owner" || member?.role === "admin";
}

function isGlobalAdminWithClient(tx: LocalAuthorizationDbClient, userId: string): boolean {
  return (
    tx.select({ role: users.role }).from(users).where(eq(users.id, userId)).get()?.role === "admin"
  );
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function audit(tx: LocalAuthorizationDbClient, input: Omit<GovernanceAuditInsert, "id">): void {
  appendGovernanceAuditWithClient(tx, { ...input, id: uuid() });
}

/**
 * Expiry input contract at the COMMAND boundary (public commands validate and
 * NORMALIZE valid ISO instant inputs before storage; the storage layer and the
 * fail-closed evaluator both require canonical UTC on STORED strings and are
 * deliberately not relaxed).
 *
 * Accepts a valid ISO 8601 date-time carrying an explicit timezone (Z or a
 * numeric offset) and canonicalizes it to UTC via epoch → `toISOString`, so
 * `2020-01-01T00:00:00+02:00` stores as `2019-12-31T22:00:00.000Z` — the same
 * instant, canonically. Anything that is not a real instant is refused 400:
 * date-only strings (no instant/offset), malformed text, prose, and
 * impossible calendar instants (`2020-02-31T00:00:00Z`, `...T25:00:00Z`).
 * Deliberately NOT `Date.parse`, which accepts prose and rolls impossible
 * dates over into the next month. `null`/omission keep "no expiry".
 */
export function normalizeExpiry(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw !== "string") {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid expiresAt");
  }
  // Shape gate before any parsing: an ISO date-time with a MANDATORY timezone
  // designator (Z or ±HH:MM). This rejects date-only values, plain prose, and
  // offset-less local times, so the only thing left to verify is whether the
  // components name a real instant.
  const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
  if (!ISO_INSTANT.test(raw)) {
    throw new AppError(400, "VALIDATION_ERROR", "expiresAt must be an ISO instant with a timezone");
  }
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid expiresAt");
  }
  // Round-trip guard against impossible instants: `2020-02-31T00:00:00Z` and
  // `2020-01-01T25:00:00Z` parse to a valid timestamp that is a DIFFERENT
  // instant than written (JS rolls the day/hour over). Comparing the written
  // calendar components against the parsed instant's own components rejects
  // exactly those, without depending on parse leniency either way.
  const written = raw.slice(0, 19).split(/[-T:]/).map(Number);
  const [y, mo, d, h, mi, sec] = written;
  if (y === undefined || mo === undefined || d === undefined || h === undefined || mi === undefined || sec === undefined) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid expiresAt");
  }
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59 || sec > 59) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid expiresAt");
  }
  const asUtc = new Date(Date.UTC(y, mo - 1, d, h, mi, sec));
  if (asUtc.getUTCMonth() !== mo - 1 || asUtc.getUTCDate() !== d || asUtc.getUTCHours() !== h) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid expiresAt");
  }
  return new Date(t).toISOString();
}

function validatePermissions(perms: readonly string[]): void {
  if (perms.length === 0) {
    throw new AppError(400, "VALIDATION_ERROR", "permissions must be a nonempty array");
  }
  for (const p of perms) {
    if (!(LOCAL_PERMISSION_CATALOGUE as readonly string[]).includes(p)) {
      throw new AppError(400, "VALIDATION_ERROR", `Unknown permission "${p}"`);
    }
  }
}

/**
 * Existence-gated namespace read. Missing resource → 404 (before any
 * authority check). Retired ledger → governance conflict. Returns the active
 * (incarnation, version) — virtual 1/1 for a live never-materialized scope.
 */
function readNamespaceScope(
  tx: LocalAuthorizationDbClient,
  scopeKind: "team" | "habitat",
  scopeId: string,
): { incarnation: number; version: number } {
  const exists =
    scopeKind === "team"
      ? tx.select({ id: teams.id }).from(teams).where(eq(teams.id, scopeId)).get()
      : tx.select({ id: habitats.id }).from(habitats).where(eq(habitats.id, scopeId)).get();
  if (!exists) throw notFoundError(scopeKind === "team" ? "Team" : "Habitat");
  const state = readScopeForWriterWithClient(tx, scopeKind, scopeId);
  if (state.kind === "missing") throw notFoundError(scopeKind === "team" ? "Team" : "Habitat");
  if (state.kind === "retired") {
    throw governanceConflict(`${scopeKind} governance scope is retired`);
  }
  return { incarnation: state.incarnation, version: state.version };
}

/**
 * Scope-ledger CAS + version bump, materializing a never-materialized live
 * scope at its virtual initial state first. false = stale expectation
 * (including an incarnation captured under a previous, now-retired ledger).
 */
export function casAndBumpScope(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
  expected: { incarnation: number; version: number },
): boolean {
  const read = readScopeForWriterWithClient(tx, scopeKind, scopeId);
  if (read.kind !== "active") return false;
  if (!read.materialized && !materializeScopeWithClient(tx, scopeKind, scopeId)) return false;
  return bumpScopeVersionWithClient(tx, scopeKind, scopeId, expected.incarnation, expected.version);
}

/**
 * The governable (team|habitat) scope for an assignment target. Mission/Task
 * targets are governed through their Habitat ancestor; a missing/broken chain
 * is null (callers treat it as missing).
 */
function governorScopeForScope(
  tx: LocalAuthorizationDbClient,
  scopeKind: GovernanceScopeKind,
  scopeId: string,
): { kind: "team" | "habitat"; id: string } | null {
  if (scopeKind === "team" || scopeKind === "habitat") {
    return { kind: scopeKind, id: scopeId };
  }
  const chain = resolveScopeChainWithClient(tx, scopeKind, scopeId);
  const habitat = chain?.find((s) => s.scopeKind === "habitat");
  return habitat ? { kind: "habitat", id: habitat.scopeId } : null;
}

/**
 * Whole-revision scope compatibility: every permission in the revision must be
 * assignable at the given scope kind (the fixed catalogue). Throws 400 on the
 * first incompatible pair. Callers invoke this AFTER the governor/authority
 * gate (so revision-validation detail never leaks to a forbidden actor) and
 * BEFORE the scope CAS / mutation / audit (so a refused command writes
 * nothing). `permissions` is the committed text column; the CHECK constraint
 * guarantees a nonempty JSON array, so this parse cannot fail.
 */
function assertRevisionAssignableAtScope(permissionsJson: string, scopeKind: GovernanceScopeKind): void {
  const perms = JSON.parse(permissionsJson) as string[];
  for (const perm of perms) {
    if (!ASSIGNABLE_SCOPES[perm as LocalPermission]?.includes(scopeKind)) {
      throw new AppError(
        400,
        "VALIDATION_ERROR",
        `Permission "${perm}" is not assignable at a ${scopeKind} scope`,
      );
    }
  }
}

/** Resolve the habitat ancestor id of a mission/task scope, or null. */
function habitatAncestorOf(
  tx: LocalAuthorizationDbClient,
  scopeKind: GovernanceScopeKind,
  scopeId: string,
): string | null {
  return governorScopeForScope(tx, scopeKind, scopeId)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Read views (GET commands)
// ---------------------------------------------------------------------------

export type PermissionsView = {
  catalogueVersion: number;
  permissions: readonly string[];
};

export function getPermissionsCatalogue(): PermissionsView {
  return {
    catalogueVersion: LOCAL_PERMISSION_CATALOGUE_VERSION,
    permissions: LOCAL_PERMISSION_CATALOGUE,
  };
}

export type DefinitionSummary = {
  id: string;
  name: string;
  isBuiltin: boolean;
  retiredAt: string | null;
  latestRevision: number;
  namespaceKind: string;
  namespaceScopeId: string | null;
  namespaceIncarnation: number;
  createdAt: string;
  updatedAt: string;
};

function definitionSummary(d: RoleDefinitionRow): DefinitionSummary {
  return {
    id: d.id,
    name: d.name,
    isBuiltin: d.isBuiltin,
    retiredAt: d.retiredAt,
    latestRevision: d.latestRevision,
    namespaceKind: d.namespaceKind,
    namespaceScopeId: d.namespaceScopeId,
    namespaceIncarnation: d.namespaceIncarnation,
    createdAt: d.createdAt,
    updatedAt: d.updatedAt,
  };
}

export type NamespaceView = {
  scopeKind: "team" | "habitat";
  scopeId: string;
  incarnation: number;
  version: number;
  definitions: DefinitionSummary[];
};

/** GET /roles — namespace definitions (built-ins + custom) + ledger state. */
export function listRoles(
  actorUserId: string,
  scopeKind: "team" | "habitat",
  scopeId: string,
): NamespaceView {
  const db = getDb();
  const scope = readNamespaceScope(db, scopeKind, scopeId);
  if (!isGovernorWithClient(db, actorUserId, scopeKind, scopeId)) throw deniedError();
  const custom = listDefinitionsForNamespaceWithClient(db, scopeKind, scopeId);
  const builtins = listBuiltinDefinitionsWithClient(db);
  return {
    scopeKind,
    scopeId,
    incarnation: scope.incarnation,
    version: scope.version,
    definitions: [...builtins, ...custom].map(definitionSummary),
  };
}

export type RevisionView = {
  id: string;
  ordinal: number;
  permissions: string[];
  catalogueVersion: number;
  createdAt: string;
};

function revisionView(r: RoleRevisionRow): RevisionView {
  return {
    id: r.id,
    ordinal: r.ordinal,
    permissions: JSON.parse(r.permissions) as string[],
    catalogueVersion: r.catalogueVersion,
    createdAt: r.createdAt,
  };
}

export type DefinitionDetailView = {
  definition: DefinitionSummary;
  revisions: RevisionView[];
  namespace: { scopeKind: "team" | "habitat"; scopeId: string; incarnation: number; version: number } | null;
};

/** GET /role-definitions/:id — definition + revisions + namespace ledger state. */
export function getRoleDefinition(actorUserId: string, definitionId: string): DefinitionDetailView {
  const db = getDb();
  const def = getDefinitionWithClient(db, definitionId);
  if (!def) throw notFoundError("Role definition");
  const revisions = listRevisionsForDefinitionWithClient(db, definitionId).map(revisionView);

  if (def.namespaceKind === "builtin" || def.namespaceScopeId === null) {
    // Built-in catalogue detail: static vocabulary, any authenticated human.
    return { definition: definitionSummary(def), revisions, namespace: null };
  }
  const nsKind = def.namespaceKind as "team" | "habitat";
  const scope = readNamespaceScope(db, nsKind, def.namespaceScopeId);
  if (!isGovernorWithClient(db, actorUserId, nsKind, def.namespaceScopeId)) throw deniedError();
  return {
    definition: definitionSummary(def),
    revisions,
    namespace: {
      scopeKind: nsKind,
      scopeId: def.namespaceScopeId,
      incarnation: scope.incarnation,
      version: scope.version,
    },
  };
}

export type AssignmentView = {
  id: string;
  principalType: string;
  principalId: string;
  definitionId: string;
  revisionId: string;
  scopeKind: string;
  scopeId: string;
  scopeIncarnation: number;
  state: string;
  version: number;
  issuerUserId: string;
  issuedAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  revokeReason: string | null;
};

function assignmentView(a: RoleAssignmentRow): AssignmentView {
  return {
    id: a.id,
    principalType: a.principalType,
    principalId: a.principalId,
    definitionId: a.definitionId,
    revisionId: a.revisionId,
    scopeKind: a.scopeKind,
    scopeId: a.scopeId,
    scopeIncarnation: a.scopeIncarnation,
    state: a.state,
    version: a.version,
    issuerUserId: a.issuerUserId,
    issuedAt: a.issuedAt,
    expiresAt: a.expiresAt,
    revokedAt: a.revokedAt,
    revokeReason: a.revokeReason,
  };
}

export type AssignmentsView = {
  scopeKind: ScopeKindLiteral;
  scopeId: string;
  incarnation: number;
  version: number;
  assignments: AssignmentView[];
};

/** GET /role-assignments — exact-scope assignments (retained rows included). */
export function listRoleAssignments(
  actorUserId: string,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
): AssignmentsView {
  const db = getDb();
  // Existence gate on the real resource (404 before 403).
  const chain = resolveScopeChainWithClient(db, scopeKind, scopeId);
  if (!chain) throw notFoundError("Scope resource");
  const govScope = governorScopeForScope(db, scopeKind, scopeId);
  if (!govScope) throw notFoundError("Scope resource");
  if (!isGovernorWithClient(db, actorUserId, govScope.kind, govScope.id)) throw deniedError();

  const state = readScopeForWriterWithClient(db, scopeKind, scopeId);
  if (state.kind !== "active") {
    throw governanceConflict("Scope governance ledger is retired");
  }
  const rows = listAssignmentsForScopeWithClient(db, scopeKind, scopeId);
  return {
    scopeKind,
    scopeId,
    incarnation: state.incarnation,
    version: state.version,
    assignments: rows.map(assignmentView),
  };
}

// ---------------------------------------------------------------------------
// Definition commands
// ---------------------------------------------------------------------------

export type CreateDefinitionInput = {
  actorUserId: string;
  scopeKind: "team" | "habitat";
  scopeId: string;
  scopeIncarnation: number;
  expectedScopeVersion: number;
  name: string;
  permissions: string[];
};

export function createCustomDefinition(input: CreateDefinitionInput): {
  definition: DefinitionSummary;
  revision: RevisionView;
  scope: { incarnation: number; version: number };
} {
  validatePermissions(input.permissions);
  return getDb().transaction(
    (tx) => {
      const scope = readNamespaceScope(tx, input.scopeKind, input.scopeId);
      if (!isGovernorWithClient(tx, input.actorUserId, input.scopeKind, input.scopeId)) {
        throw deniedError();
      }
      if (
        !casAndBumpScope(tx, input.scopeKind, input.scopeId, {
          incarnation: input.scopeIncarnation,
          version: input.expectedScopeVersion,
        })
      ) {
        throw governanceConflict("Scope version expectation failed");
      }
      const { definition, revision } = createDefinitionWithClient(tx, {
        name: input.name,
        namespaceKind: input.scopeKind,
        namespaceScopeId: input.scopeId,
        namespaceIncarnation: scope.incarnation,
        permissions: input.permissions,
        catalogueVersion: LOCAL_PERMISSION_CATALOGUE_VERSION,
      });
      audit(tx, {
        actorType: "human",
        actorId: input.actorUserId,
        operation: "role_definition.created",
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        scopeIncarnation: scope.incarnation,
        objectKind: "role_definition",
        objectId: definition.id,
        versionBefore: input.expectedScopeVersion,
        versionAfter: input.expectedScopeVersion + 1,
        details: { name: input.name, permissions: input.permissions },
      });
      return {
        definition: definitionSummary(definition),
        revision: revisionView(revision),
        scope: { incarnation: scope.incarnation, version: input.expectedScopeVersion + 1 },
      };
    },
    { behavior: "immediate" },
  );
}

export type MintRevisionInput = {
  actorUserId: string;
  definitionId: string;
  permissions: string[];
  scopeIncarnation: number;
  expectedScopeVersion: number;
  expectedLatestRevision: number;
};

export function mintRevision(input: MintRevisionInput): {
  definition: DefinitionSummary;
  revision: RevisionView;
} {
  validatePermissions(input.permissions);
  return getDb().transaction(
    (tx) => {
      const def = getDefinitionWithClient(tx, input.definitionId);
      if (!def) throw notFoundError("Role definition");
      if (def.isBuiltin || def.retiredAt !== null) {
        throw revisionConflict("Built-in and retired definitions are immutable");
      }
      if (def.namespaceKind === "builtin" || def.namespaceScopeId === null) {
        throw notFoundError("Role definition");
      }
      const nsKind = def.namespaceKind as "team" | "habitat";
      const scope = readNamespaceScope(tx, nsKind, def.namespaceScopeId);
      if (!isGovernorWithClient(tx, input.actorUserId, nsKind, def.namespaceScopeId)) {
        throw deniedError();
      }
      if (def.latestRevision !== input.expectedLatestRevision) {
        throw revisionConflict("Stale latestRevision expectation");
      }
      if (
        !casAndBumpScope(tx, nsKind, def.namespaceScopeId, {
          incarnation: input.scopeIncarnation,
          version: input.expectedScopeVersion,
        })
      ) {
        throw governanceConflict("Scope version expectation failed");
      }
      const revision = insertRevisionWithClient(tx, {
        definitionId: input.definitionId,
        permissions: input.permissions,
        catalogueVersion: LOCAL_PERMISSION_CATALOGUE_VERSION,
      });
      audit(tx, {
        actorType: "human",
        actorId: input.actorUserId,
        operation: "role_revision.minted",
        scopeKind: nsKind,
        scopeId: def.namespaceScopeId,
        scopeIncarnation: scope.incarnation,
        objectKind: "role_revision",
        objectId: revision.id,
        versionBefore: input.expectedScopeVersion,
        versionAfter: input.expectedScopeVersion + 1,
        details: {
          definitionId: input.definitionId,
          ordinal: revision.ordinal,
          permissions: input.permissions,
        },
      });
      return {
        definition: definitionSummary(getDefinitionWithClient(tx, input.definitionId)!),
        revision: revisionView(revision),
      };
    },
    { behavior: "immediate" },
  );
}

export type RetireDefinitionInput = {
  actorUserId: string;
  definitionId: string;
  reason: string;
  scopeIncarnation: number;
  expectedScopeVersion: number;
  expectedLatestRevision: number;
};

export function retireDefinition(input: RetireDefinitionInput): {
  definition: DefinitionSummary;
  revokedAssignments: number;
} {
  return getDb().transaction(
    (tx) => {
      const def = getDefinitionWithClient(tx, input.definitionId);
      if (!def) throw notFoundError("Role definition");
      if (def.isBuiltin || def.retiredAt !== null) {
        throw revisionConflict("Built-in and retired definitions are immutable");
      }
      if (def.namespaceKind === "builtin" || def.namespaceScopeId === null) {
        throw notFoundError("Role definition");
      }
      const nsKind = def.namespaceKind as "team" | "habitat";
      const scope = readNamespaceScope(tx, nsKind, def.namespaceScopeId);
      if (!isGovernorWithClient(tx, input.actorUserId, nsKind, def.namespaceScopeId)) {
        throw deniedError();
      }
      if (def.latestRevision !== input.expectedLatestRevision) {
        throw revisionConflict("Stale latestRevision expectation");
      }
      if (
        !casAndBumpScope(tx, nsKind, def.namespaceScopeId, {
          incarnation: input.scopeIncarnation,
          version: input.expectedScopeVersion,
        })
      ) {
        throw governanceConflict("Scope version expectation failed");
      }
      const retired = retireDefinitionWithClient(tx, input.definitionId);
      if (!retired) throw revisionConflict("Definition was concurrently retired");
      const revoked = revokeAssignmentsForDefinition(tx, input.definitionId, input.reason);
      audit(tx, {
        actorType: "human",
        actorId: input.actorUserId,
        operation: "role_definition.retired",
        scopeKind: nsKind,
        scopeId: def.namespaceScopeId,
        scopeIncarnation: scope.incarnation,
        objectKind: "role_definition",
        objectId: retired.id,
        versionBefore: input.expectedScopeVersion,
        versionAfter: input.expectedScopeVersion + 1,
        details: { revokedAssignments: revoked, reason: input.reason },
        reason: input.reason,
      });
      return { definition: definitionSummary(retired), revokedAssignments: revoked };
    },
    { behavior: "immediate" },
  );
}

function revokeAssignmentsForDefinition(
  tx: LocalAuthorizationDbClient,
  definitionId: string,
  reason: string,
): number {
  const rows = tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(and(eq(roleAssignments.definitionId, definitionId), eq(roleAssignments.state, "active")))
    .all();
  for (const r of rows) revokeAssignmentWithClient(tx, r.id, reason);
  return rows.length;
}

// ---------------------------------------------------------------------------
// Assignment commands
// ---------------------------------------------------------------------------

export type CreateAssignmentInput = {
  actorUserId: string;
  principalType: "human" | "agent";
  principalId: string;
  revisionId: string;
  scopeKind: GovernanceScopeKind;
  scopeId: string;
  scopeIncarnation: number;
  expectedScopeVersion: number;
  expiresAt?: string | null;
};

export function createAssignment(input: CreateAssignmentInput): AssignmentView {
  const expiresAt = normalizeExpiry(input.expiresAt);
  return getDb().transaction(
    (tx) => {
      // Typed principal existence (registry rows, 404 before 403).
      if (input.principalType === "human") {
        const u = tx.select({ id: users.id }).from(users).where(eq(users.id, input.principalId)).get();
        if (!u) throw notFoundError("Principal user");
      } else {
        const a = tx.select({ id: agents.id }).from(agents).where(eq(agents.id, input.principalId)).get();
        if (!a) throw notFoundError("Principal agent");
      }

      const rev = getRevisionWithClient(tx, input.revisionId);
      if (!rev) throw notFoundError("Role revision");
      const def = getDefinitionWithClient(tx, rev.definitionId);
      if (!def || def.retiredAt !== null) throw notFoundError("Role definition");

      // Scope resource existence (404 before 403).
      const chain = resolveScopeChainWithClient(tx, input.scopeKind, input.scopeId);
      if (!chain) throw notFoundError("Scope resource");

      // Governor of the assignment scope's governable ancestor.
      const govScope = governorScopeForScope(tx, input.scopeKind, input.scopeId);
      if (!govScope) throw deniedError();
      if (!isGovernorWithClient(tx, input.actorUserId, govScope.kind, govScope.id)) {
        throw deniedError();
      }

      // Namespace compatibility: a custom definition's namespace must sit in
      // the assignment scope's ancestry.
      if (def.namespaceKind !== "builtin" && def.namespaceScopeId !== null) {
        const inChain = chain.some(
          (s) => s.scopeKind === def.namespaceKind && s.scopeId === def.namespaceScopeId,
        );
        if (!inChain) {
          throw new AppError(
            400,
            "VALIDATION_ERROR",
            "Definition namespace is incompatible with the assignment scope",
          );
        }
      }

      // Fixed catalogue: the definition's permissions must all be assignable
      // at this scope kind. Refusal lands AFTER the authority gate so a
      // forbidden actor never sees revision-validation detail, and BEFORE any
      // scope CAS / insert / audit — the evaluator later filtering the row out
      // is not an alternative interpretation of the issuance contract.
      assertRevisionAssignableAtScope(rev.permissions, input.scopeKind);

      if (
        !casAndBumpScope(tx, input.scopeKind, input.scopeId, {
          incarnation: input.scopeIncarnation,
          version: input.expectedScopeVersion,
        })
      ) {
        throw governanceConflict("Scope version expectation failed");
      }

      // Regrant disposition: an exact active grant tuple already exists →
      // revoke + audit the old row, then insert a fresh-ID row in this same
      // reservation (covers expiry regrant and revision regrant alike).
      const prior = findActiveGrantTupleWithClient(tx, {
        principalType: input.principalType,
        principalId: input.principalId,
        definitionId: def.id,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        scopeIncarnation: input.scopeIncarnation,
      });
      if (prior) {
        revokeAssignmentWithClient(tx, prior.id, "regranted");
        audit(tx, {
          actorType: "human",
          actorId: input.actorUserId,
          operation: "role_assignment.revoked",
          scopeKind: input.scopeKind,
          scopeId: input.scopeId,
          scopeIncarnation: input.scopeIncarnation,
          objectKind: "role_assignment",
          objectId: prior.id,
          versionBefore: prior.version,
          versionAfter: prior.version + 1,
          reason: "regranted",
          details: { regrant: true },
        });
      }

      const row = insertAssignmentWithClient(tx, {
        principalType: input.principalType,
        principalId: input.principalId,
        definitionId: def.id,
        revisionId: rev.id,
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        scopeIncarnation: input.scopeIncarnation,
        issuerUserId: input.actorUserId,
        expiresAt,
      });
      audit(tx, {
        actorType: "human",
        actorId: input.actorUserId,
        operation: "role_assignment.created",
        scopeKind: input.scopeKind,
        scopeId: input.scopeId,
        scopeIncarnation: input.scopeIncarnation,
        objectKind: "role_assignment",
        objectId: row.id,
        versionBefore: input.expectedScopeVersion,
        versionAfter: input.expectedScopeVersion + 1,
        details: {
          principalType: input.principalType,
          principalId: input.principalId,
          definitionId: def.id,
          revisionId: rev.id,
          expiresAt,
        },
      });
      return assignmentView(row);
    },
    { behavior: "immediate" },
  );
}

export type RepinInput = {
  actorUserId: string;
  assignmentId: string;
  revisionId: string;
  scopeIncarnation: number;
  expectedScopeVersion: number;
  expectedAssignmentVersion: number;
};

/** Explicit re-pin of an active assignment to another revision of its definition. */
export function repinAssignment(input: RepinInput): AssignmentView {
  return getDb().transaction(
    (tx) => {
      const assignment = getAssignmentWithClient(tx, input.assignmentId);
      if (!assignment) throw notFoundError("Role assignment");
      const rev = getRevisionWithClient(tx, input.revisionId);
      if (!rev) throw notFoundError("Role revision");
      if (rev.definitionId !== assignment.definitionId) {
        throw new AppError(
          400,
          "VALIDATION_ERROR",
          "Revision does not belong to the assignment's definition",
        );
      }
      const def = getDefinitionWithClient(tx, assignment.definitionId);
      if (!def || def.retiredAt !== null) throw notFoundError("Role definition");

      const govScope = governorScopeForScope(tx, assignment.scopeKind, assignment.scopeId);
      if (!govScope) throw deniedError();
      if (!isGovernorWithClient(tx, input.actorUserId, govScope.kind, govScope.id)) {
        throw deniedError();
      }
      // Whole-revision scope compatibility at ADOPTION: the newly selected
      // revision's permissions must all be assignable at the assignment's
      // scope kind, under the same reservation, before the CAS / repin / audit.
      // An assign-only Task/Mission assignment adopting a revision that also
      // carries review.configure is refused here — adoption is issuance-
      // equivalent and cannot widen a grant past the fixed catalogue.
      assertRevisionAssignableAtScope(rev.permissions, assignment.scopeKind);

      if (
        !casAndBumpScope(tx, assignment.scopeKind, assignment.scopeId, {
          incarnation: input.scopeIncarnation,
          version: input.expectedScopeVersion,
        })
      ) {
        throw governanceConflict("Scope version expectation failed");
      }
      const updated = repinAssignmentRevisionWithClient(tx, {
        id: input.assignmentId,
        revisionId: input.revisionId,
        expectedVersion: input.expectedAssignmentVersion,
      });
      if (!updated) throw assignmentConflict("Stale assignment version");
      audit(tx, {
        actorType: "human",
        actorId: input.actorUserId,
        operation: "role_assignment.revised",
        scopeKind: assignment.scopeKind,
        scopeId: assignment.scopeId,
        scopeIncarnation: input.scopeIncarnation,
        objectKind: "role_assignment",
        objectId: updated.id,
        versionBefore: input.expectedAssignmentVersion,
        versionAfter: updated.version,
        details: { revisionId: input.revisionId },
      });
      return assignmentView(updated);
    },
    { behavior: "immediate" },
  );
}

export type RevokeAssignmentInput = {
  actorUserId: string;
  assignmentId: string;
  reason: string;
  scopeIncarnation: number;
  expectedScopeVersion: number;
  expectedAssignmentVersion: number;
};

export function revokeAssignment(input: RevokeAssignmentInput): AssignmentView {
  return getDb().transaction(
    (tx) => {
      const assignment = getAssignmentWithClient(tx, input.assignmentId);
      if (!assignment) throw notFoundError("Role assignment");
      if (assignment.state !== "active") throw assignmentConflict("Assignment is not active");

      const govScope = governorScopeForScope(tx, assignment.scopeKind, assignment.scopeId);
      if (!govScope) throw deniedError();
      if (!isGovernorWithClient(tx, input.actorUserId, govScope.kind, govScope.id)) {
        throw deniedError();
      }
      // Assignment-object CAS under the same reservation: a stale
      // expectedAssignmentVersion refuses before the scope version is bumped
      // or any row is touched — the object expectation is not optional on
      // this mandatory-CAS command even when the scope CAS alone would pass.
      if (assignment.version !== input.expectedAssignmentVersion) {
        throw assignmentConflict("Stale assignment version");
      }
      if (
        !casAndBumpScope(tx, assignment.scopeKind, assignment.scopeId, {
          incarnation: input.scopeIncarnation,
          version: input.expectedScopeVersion,
        })
      ) {
        throw governanceConflict("Scope version expectation failed");
      }
      const revoked = revokeAssignmentWithClient(tx, input.assignmentId, input.reason);
      if (!revoked) throw notFoundError("Role assignment");
      audit(tx, {
        actorType: "human",
        actorId: input.actorUserId,
        operation: "role_assignment.revoked",
        scopeKind: assignment.scopeKind,
        scopeId: assignment.scopeId,
        scopeIncarnation: input.scopeIncarnation,
        objectKind: "role_assignment",
        objectId: revoked.id,
        versionBefore: input.expectedAssignmentVersion,
        versionAfter: revoked.version,
        reason: input.reason,
        details: { reason: input.reason },
      });
      return assignmentView(revoked);
    },
    { behavior: "immediate" },
  );
}

// ---------------------------------------------------------------------------
// Personal owner commands (current persisted global admin only)
// ---------------------------------------------------------------------------

export type SetOwnerInput = {
  actorUserId: string;
  habitatId: string;
  ownerUserId: string;
  reason: string;
  scopeIncarnation: number;
  expectedScopeVersion: number;
};

/** Read a still-personal Habitat (teamId null) or 404/409. */
function readPersonalHabitat(
  tx: LocalAuthorizationDbClient,
  habitatId: string,
): { ownerUserId: string | null } {
  const row = tx
    .select({ teamId: habitats.teamId, ownerUserId: habitats.ownerUserId })
    .from(habitats)
    .where(eq(habitats.id, habitatId))
    .get();
  if (!row) throw notFoundError("Habitat");
  if (row.teamId !== null) {
    throw new AppError(
      409,
      "CONFLICT",
      "Habitat is team-bound; personal owner commands apply only to personal habitats",
    );
  }
  return { ownerUserId: row.ownerUserId };
}

export function setHabitatOwner(input: SetOwnerInput): { habitatId: string; ownerUserId: string } {
  if (!input.reason.trim()) {
    throw new AppError(400, "VALIDATION_ERROR", "reason must be nonempty");
  }
  return getDb().transaction(
    (tx) => {
      const habitat = readPersonalHabitat(tx, input.habitatId);
      if (!isGlobalAdminWithClient(tx, input.actorUserId)) throw deniedError();
      const target = tx
        .select({ id: users.id, role: users.role })
        .from(users)
        .where(eq(users.id, input.ownerUserId))
        .get();
      if (!target) throw notFoundError("Owner user");
      if (target.role === "viewer") {
        throw new AppError(400, "VALIDATION_ERROR", "Owner target must not be a viewer");
      }
      if (
        !casAndBumpScope(tx, "habitat", input.habitatId, {
          incarnation: input.scopeIncarnation,
          version: input.expectedScopeVersion,
        })
      ) {
        throw governanceConflict("Scope version expectation failed");
      }
      tx.update(habitats)
        .set({ ownerUserId: input.ownerUserId, updatedAt: new Date().toISOString() })
        .where(eq(habitats.id, input.habitatId))
        .run();
      audit(tx, {
        actorType: "human",
        actorId: input.actorUserId,
        operation: "habitat.owner.set",
        scopeKind: "habitat",
        scopeId: input.habitatId,
        scopeIncarnation: input.scopeIncarnation,
        objectKind: "habitat",
        objectId: input.habitatId,
        versionBefore: input.expectedScopeVersion,
        versionAfter: input.expectedScopeVersion + 1,
        details: {
          ownerBefore: habitat.ownerUserId,
          ownerAfter: input.ownerUserId,
          reason: input.reason,
        },
        reason: input.reason,
      });
      return { habitatId: input.habitatId, ownerUserId: input.ownerUserId };
    },
    { behavior: "immediate" },
  );
}

export type ClearOwnerInput = {
  actorUserId: string;
  habitatId: string;
  reason: string;
  scopeIncarnation: number;
  expectedScopeVersion: number;
};

export function clearHabitatOwner(input: ClearOwnerInput): { habitatId: string; ownerUserId: null } {
  if (!input.reason.trim()) {
    throw new AppError(400, "VALIDATION_ERROR", "reason must be nonempty");
  }
  return getDb().transaction(
    (tx) => {
      const habitat = readPersonalHabitat(tx, input.habitatId);
      if (!isGlobalAdminWithClient(tx, input.actorUserId)) throw deniedError();
      if (
        !casAndBumpScope(tx, "habitat", input.habitatId, {
          incarnation: input.scopeIncarnation,
          version: input.expectedScopeVersion,
        })
      ) {
        throw governanceConflict("Scope version expectation failed");
      }
      tx.update(habitats)
        .set({ ownerUserId: null, updatedAt: new Date().toISOString() })
        .where(eq(habitats.id, input.habitatId))
        .run();
      audit(tx, {
        actorType: "human",
        actorId: input.actorUserId,
        operation: "habitat.owner.cleared",
        scopeKind: "habitat",
        scopeId: input.habitatId,
        scopeIncarnation: input.scopeIncarnation,
        objectKind: "habitat",
        objectId: input.habitatId,
        versionBefore: input.expectedScopeVersion,
        versionAfter: input.expectedScopeVersion + 1,
        details: { ownerBefore: habitat.ownerUserId, reason: input.reason },
        reason: input.reason,
      });
      return { habitatId: input.habitatId, ownerUserId: null };
    },
    { behavior: "immediate" },
  );
}

export { habitatAncestorOf };
