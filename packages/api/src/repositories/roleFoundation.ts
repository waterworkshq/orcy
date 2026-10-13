/**
 * Role-foundation repository (migration 0083 storage).
 *
 * Client-scoped primitives for the governance ledger, definitions/revisions,
 * assignments and audit. Every mutation primitive is *WithClient and runs on
 * the CALLER's writer reservation (BEGIN IMMEDIATE) — none of these open
 * their own transaction. Command-level orchestration (expected-version CAS,
 * issuer authorization, namespace compatibility, audit append) belongs to
 * the administration commands ticket; this file is the storage contract the
 * evaluator and later commands share.
 *
 * Deliberate limits (binding addendum):
 *   - No revision update/delete primitive exists — revisions are
 *     insert-only, enforced additionally by DB triggers.
 *   - No built-in definition mutation/retirement primitive exists.
 *   - Scope retirement never deletes ledger history; a retired incarnation
 *     is never reactivated (retireScopeWithClient sets retired_at only).
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  governanceAudit,
  governanceScopes,
  roleAssignments,
  roleDefinitions,
  roleRevisions,
} from "../db/schema/index.js";
import { getDb } from "../db/index.js";
import {
  resolveScopeChainWithClient,
  type LocalAuthorizationDbClient,
} from "../services/localAuthorization.js";

export type GovernanceScopeRow = typeof governanceScopes.$inferSelect;
export type RoleDefinitionRow = typeof roleDefinitions.$inferSelect;
export type RoleRevisionRow = typeof roleRevisions.$inferSelect;
export type RoleAssignmentRow = typeof roleAssignments.$inferSelect;
export type GovernanceAuditInsert = typeof governanceAudit.$inferInsert;

export type ScopeKindLiteral = GovernanceScopeRow["scopeKind"];

// ---------------------------------------------------------------------------
// Scope ledger
// ---------------------------------------------------------------------------

/**
 * Authoritative active-ledger read for a scope. Mirrors the evaluator's
 * virtual semantics for WRITERS: returns the recorded active row or the
 * would-be virtual initial state (incarnation 1, version 1, materialized
 * false) for a LIVE, EXISTING, never-materialized resource. Missing
 * resources return { kind: "missing" }; retired/history-bearing keys with no
 * active row return { kind: "retired" } so callers never treat history as
 * activatable or virtually revive it. Existence is resolved from real
 * resource rows (sharing the evaluator's chain resolver), never assumed.
 */
export function readScopeForWriterWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
):
  | { kind: "active"; incarnation: number; version: number; materialized: boolean }
  | { kind: "retired" }
  | { kind: "missing" } {
  // Existence first: a missing resource is never virtually enrolled.
  const exists = resolveScopeChainWithClient(tx, scopeKind, scopeId);
  if (!exists) return { kind: "missing" };

  const active = tx
    .select()
    .from(governanceScopes)
    .where(
      and(
        eq(governanceScopes.scopeKind, scopeKind),
        eq(governanceScopes.scopeId, scopeId),
        isNull(governanceScopes.retiredAt),
      ),
    )
    .get();
  if (active) {
    return {
      kind: "active",
      incarnation: active.incarnation,
      version: active.version,
      materialized: true,
    };
  }
  const any = tx
    .select({ id: governanceScopes.scopeId })
    .from(governanceScopes)
    .where(and(eq(governanceScopes.scopeKind, scopeKind), eq(governanceScopes.scopeId, scopeId)))
    .get();
  if (any) return { kind: "retired" };
  return { kind: "active", incarnation: 1, version: 1, materialized: false };
}

/**
 * First-mutation materialization: inserts the ledger row at exactly the
 * virtual initial state (incarnation 1, version 1) the reader reported.
 * REFUSES missing resources and retired/history-bearing keys — only a live,
 * existing, never-materialized resource may enroll. Returns false when an
 * active row already exists or the key is not enrollable. Success is
 * detected via RETURNING row match, which behaves identically on the
 * better-sqlite3 and sql.js drivers (`.run()` result shapes differ there).
 */
export function materializeScopeWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
): boolean {
  const read = readScopeForWriterWithClient(tx, scopeKind, scopeId);
  if (read.kind === "missing" || read.kind === "retired") return false;
  if (read.kind === "active" && read.materialized) return false;
  const inserted = tx
    .insert(governanceScopes)
    .values({ scopeKind, scopeId, incarnation: 1, version: 1 })
    .onConflictDoNothing()
    .returning({ scopeKind: governanceScopes.scopeKind })
    .get();
  return inserted !== undefined;
}

/**
 * CAS the scope version against the (incarnation, version) identity pair:
 * false when the expectation did not match, including a stale expectation
 * captured under a PREVIOUS incarnation (version 1 of incarnation 2 must
 * not satisfy a request expecting incarnation 1). Success detected via
 * RETURNING row match — valid on both drivers.
 */
export function bumpScopeVersionWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
  expectedIncarnation: number,
  expectedVersion: number,
): boolean {
  const updated = tx
    .update(governanceScopes)
    .set({ version: expectedVersion + 1 })
    .where(
      and(
        eq(governanceScopes.scopeKind, scopeKind),
        eq(governanceScopes.scopeId, scopeId),
        eq(governanceScopes.incarnation, expectedIncarnation),
        eq(governanceScopes.version, expectedVersion),
        isNull(governanceScopes.retiredAt),
      ),
    )
    .returning({ scopeKind: governanceScopes.scopeKind })
    .get();
  return updated !== undefined;
}

/**
 * Retire the active incarnation: sets retired_at and advances its version.
 * Never reactivates anything; returns the retired row or null when none
 * was active.
 */
export function retireScopeWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
): GovernanceScopeRow | null {
  const active = tx
    .select()
    .from(governanceScopes)
    .where(
      and(
        eq(governanceScopes.scopeKind, scopeKind),
        eq(governanceScopes.scopeId, scopeId),
        isNull(governanceScopes.retiredAt),
      ),
    )
    .get();
  if (!active) return null;
  const retiredAt = new Date().toISOString();
  tx.update(governanceScopes)
    .set({ retiredAt, version: active.version + 1 })
    .where(
      and(
        eq(governanceScopes.scopeKind, scopeKind),
        eq(governanceScopes.scopeId, scopeId),
        eq(governanceScopes.incarnation, active.incarnation),
      ),
    )
    .run();
  return { ...active, retiredAt, version: active.version + 1 };
}

/**
 * Controlled custody re-enrollment (Team deletion or same-lineage restore): retire the active
 * incarnation if any, then insert a FRESH active incarnation (old + 1, or 1
 * when no history) at version 1. Callers constrain this to retained Team
 * descendants or the exact replaced/restored import IDs, never arbitrary
 * ID reuse or a general transfer API.
 */
export function reenrollScopeWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
): GovernanceScopeRow {
  const latest = tx
    .select({ incarnation: governanceScopes.incarnation })
    .from(governanceScopes)
    .where(and(eq(governanceScopes.scopeKind, scopeKind), eq(governanceScopes.scopeId, scopeId)))
    .orderBy(sql`incarnation DESC`)
    .limit(1)
    .get();
  const nextIncarnation = (latest?.incarnation ?? 0) + 1;
  const active = retireScopeWithClient(tx, scopeKind, scopeId); // no-op when none
  void active;
  tx.insert(governanceScopes)
    .values({ scopeKind, scopeId, incarnation: nextIncarnation, version: 1 })
    .run();
  return {
    scopeKind,
    scopeId,
    incarnation: nextIncarnation,
    version: 1,
    retiredAt: null,
  };
}

// ---------------------------------------------------------------------------
// Definitions and revisions
// ---------------------------------------------------------------------------

export function getDefinitionWithClient(
  tx: LocalAuthorizationDbClient,
  id: string,
): RoleDefinitionRow | null {
  return tx.select().from(roleDefinitions).where(eq(roleDefinitions.id, id)).get() ?? null;
}

export function getRevisionWithClient(
  tx: LocalAuthorizationDbClient,
  id: string,
): RoleRevisionRow | null {
  return tx.select().from(roleRevisions).where(eq(roleRevisions.id, id)).get() ?? null;
}

/** Insert a custom definition with its revision 1 in one client scope. */
export function createDefinitionWithClient(
  tx: LocalAuthorizationDbClient,
  input: {
    name: string;
    namespaceKind: "team" | "habitat";
    namespaceScopeId: string;
    namespaceIncarnation: number;
    permissions: string[];
    catalogueVersion: number;
  },
): { definition: RoleDefinitionRow; revision: RoleRevisionRow } {
  const definitionId = uuid();
  const revisionId = uuid();
  const now = new Date().toISOString();
  tx.insert(roleDefinitions)
    .values({
      id: definitionId,
      namespaceKind: input.namespaceKind,
      namespaceScopeId: input.namespaceScopeId,
      namespaceIncarnation: input.namespaceIncarnation,
      name: input.name,
      isBuiltin: false,
      latestRevision: 1,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  tx.insert(roleRevisions)
    .values({
      id: revisionId,
      definitionId,
      ordinal: 1,
      permissions: JSON.stringify(input.permissions),
      catalogueVersion: input.catalogueVersion,
      createdAt: now,
    })
    .run();
  return {
    definition: getDefinitionWithClient(tx, definitionId)!,
    revision: getRevisionWithClient(tx, revisionId)!,
  };
}

/** Mint the next immutable revision; caller CASes latest_revision. */
export function insertRevisionWithClient(
  tx: LocalAuthorizationDbClient,
  input: {
    definitionId: string;
    permissions: string[];
    catalogueVersion: number;
  },
): RoleRevisionRow {
  const current = getDefinitionWithClient(tx, input.definitionId);
  if (!current) throw new Error(`role definition ${input.definitionId} not found`);
  const revisionId = uuid();
  const ordinal = current.latestRevision + 1;
  tx.insert(roleRevisions)
    .values({
      id: revisionId,
      definitionId: input.definitionId,
      ordinal,
      permissions: JSON.stringify(input.permissions),
      catalogueVersion: input.catalogueVersion,
      createdAt: new Date().toISOString(),
    })
    .run();
  // Keep the definition's latestRevision pointer in step with the new head
  // (mint CAS chains off this value).
  tx.update(roleDefinitions)
    .set({ latestRevision: ordinal, updatedAt: new Date().toISOString() })
    .where(eq(roleDefinitions.id, input.definitionId))
    .run();
  return getRevisionWithClient(tx, revisionId)!;
}

// ---------------------------------------------------------------------------
// Assignments
// ---------------------------------------------------------------------------

export function getAssignmentWithClient(
  tx: LocalAuthorizationDbClient,
  id: string,
): RoleAssignmentRow | null {
  return tx.select().from(roleAssignments).where(eq(roleAssignments.id, id)).get() ?? null;
}

export function insertAssignmentWithClient(
  tx: LocalAuthorizationDbClient,
  input: {
    principalType: "human" | "agent";
    principalId: string;
    definitionId: string;
    revisionId: string;
    scopeKind: ScopeKindLiteral;
    scopeId: string;
    scopeIncarnation: number;
    issuerUserId: string;
    expiresAt?: string | null;
  },
): RoleAssignmentRow {
  const id = uuid();
  tx.insert(roleAssignments)
    .values({
      id,
      principalType: input.principalType,
      principalId: input.principalId,
      definitionId: input.definitionId,
      revisionId: input.revisionId,
      scopeKind: input.scopeKind,
      scopeId: input.scopeId,
      scopeIncarnation: input.scopeIncarnation,
      state: "active",
      version: 1,
      issuerUserId: input.issuerUserId,
      expiresAt: input.expiresAt ?? null,
    })
    .run();
  return getAssignmentWithClient(tx, id)!;
}

/** Revoke (retain row as history); returns the updated row or null. */
export function revokeAssignmentWithClient(
  tx: LocalAuthorizationDbClient,
  id: string,
  reason: string,
): RoleAssignmentRow | null {
  const row = getAssignmentWithClient(tx, id);
  if (!row) return null;
  const revokedAt = new Date().toISOString();
  tx.update(roleAssignments)
    .set({ state: "revoked", revokedAt, revokeReason: reason, version: row.version + 1 })
    .where(eq(roleAssignments.id, id))
    .run();
  return getAssignmentWithClient(tx, id);
}

/** Revoke every active assignment of a typed agent (agent deletion bundle). */
export function revokeAssignmentsForAgentWithClient(
  tx: LocalAuthorizationDbClient,
  agentId: string,
  reason: string,
): number {
  const rows = tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.principalType, "agent"),
        eq(roleAssignments.principalId, agentId),
        eq(roleAssignments.state, "active"),
      ),
    )
    .all();
  for (const row of rows) revokeAssignmentWithClient(tx, row.id, reason);
  return rows.length;
}

/**
 * Administration-read/list primitives and the two command-owned CAS updates
 * (administration ticket). Still caller-transaction-scoped; still no command
 * orchestration lives here.
 */

export function listDefinitionsForNamespaceWithClient(
  tx: LocalAuthorizationDbClient,
  namespaceKind: "team" | "habitat",
  namespaceScopeId: string,
): RoleDefinitionRow[] {
  return tx
    .select()
    .from(roleDefinitions)
    .where(
      and(
        eq(roleDefinitions.namespaceKind, namespaceKind),
        eq(roleDefinitions.namespaceScopeId, namespaceScopeId),
      ),
    )
    .orderBy(roleDefinitions.name)
    .all();
}

/** The immutable migration-seeded built-in definitions (fixed vocabulary). */
export function listBuiltinDefinitionsWithClient(
  tx: LocalAuthorizationDbClient,
): RoleDefinitionRow[] {
  return tx
    .select()
    .from(roleDefinitions)
    .where(eq(roleDefinitions.isBuiltin, true))
    .orderBy(roleDefinitions.name)
    .all();
}

export function listRevisionsForDefinitionWithClient(
  tx: LocalAuthorizationDbClient,
  definitionId: string,
): RoleRevisionRow[] {
  return tx
    .select()
    .from(roleRevisions)
    .where(eq(roleRevisions.definitionId, definitionId))
    .orderBy(roleRevisions.ordinal)
    .all();
}

export function listAssignmentsForScopeWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
): RoleAssignmentRow[] {
  return tx
    .select()
    .from(roleAssignments)
    .where(and(eq(roleAssignments.scopeKind, scopeKind), eq(roleAssignments.scopeId, scopeId)))
    .orderBy(roleAssignments.issuedAt)
    .all();
}

export function listActiveAssignmentsForScopeWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
): RoleAssignmentRow[] {
  return tx
    .select()
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.scopeKind, scopeKind),
        eq(roleAssignments.scopeId, scopeId),
        eq(roleAssignments.state, "active"),
      ),
    )
    .all();
}

/** Terminal definition retirement (custom definitions only, caller verifies). */
export function retireDefinitionWithClient(
  tx: LocalAuthorizationDbClient,
  id: string,
): RoleDefinitionRow | null {
  const now = new Date().toISOString();
  const updated = tx
    .update(roleDefinitions)
    .set({ retiredAt: now, updatedAt: now })
    .where(and(eq(roleDefinitions.id, id), isNull(roleDefinitions.retiredAt)))
    .returning({ id: roleDefinitions.id })
    .get();
  return updated ? getDefinitionWithClient(tx, id) : null;
}

/**
 * Re-pin an active assignment to another revision of the SAME definition,
 * CASing the assignment object version. Returns the updated row or null on a
 * stale/missing/inactive CAS miss.
 */
export function repinAssignmentRevisionWithClient(
  tx: LocalAuthorizationDbClient,
  input: { id: string; revisionId: string; expectedVersion: number },
): RoleAssignmentRow | null {
  const updated = tx
    .update(roleAssignments)
    .set({ revisionId: input.revisionId, version: input.expectedVersion + 1 })
    .where(
      and(
        eq(roleAssignments.id, input.id),
        eq(roleAssignments.version, input.expectedVersion),
        eq(roleAssignments.state, "active"),
      ),
    )
    .returning({ id: roleAssignments.id })
    .get();
  return updated ? getAssignmentWithClient(tx, input.id) : null;
}

/**
 * Exact active-grant tuple lookup for duplicate/regrant disposition
 * (administration ticket). State is read as stored; expiry is decision-time
 * and interpreted by the caller.
 */
export function findActiveGrantTupleWithClient(
  tx: LocalAuthorizationDbClient,
  input: {
    principalType: "human" | "agent";
    principalId: string;
    definitionId: string;
    scopeKind: ScopeKindLiteral;
    scopeId: string;
    scopeIncarnation: number;
  },
): RoleAssignmentRow | null {
  return (
    tx
      .select()
      .from(roleAssignments)
      .where(
        and(
          eq(roleAssignments.principalType, input.principalType),
          eq(roleAssignments.principalId, input.principalId),
          eq(roleAssignments.definitionId, input.definitionId),
          eq(roleAssignments.scopeKind, input.scopeKind),
          eq(roleAssignments.scopeId, input.scopeId),
          eq(roleAssignments.scopeIncarnation, input.scopeIncarnation),
          eq(roleAssignments.state, "active"),
        ),
      )
      .get() ?? null
  );
}

/** Revoke every ACTIVE assignment whose scope is exactly (kind, id), any incarnation. */
export function revokeAssignmentsForScopeWithClient(
  tx: LocalAuthorizationDbClient,
  scopeKind: ScopeKindLiteral,
  scopeId: string,
  reason: string,
): number {
  const rows = tx
    .select({ id: roleAssignments.id })
    .from(roleAssignments)
    .where(
      and(
        eq(roleAssignments.scopeKind, scopeKind),
        eq(roleAssignments.scopeId, scopeId),
        eq(roleAssignments.state, "active"),
      ),
    )
    .all();
  for (const row of rows) revokeAssignmentWithClient(tx, row.id, reason);
  return rows.length;
}

/** Retire every non-retired custom definition in a namespace (custody bundles). */
export function retireDefinitionsForNamespaceWithClient(
  tx: LocalAuthorizationDbClient,
  namespaceKind: "team" | "habitat",
  namespaceScopeId: string,
): number {
  let count = 0;
  const rows = tx
    .select({ id: roleDefinitions.id })
    .from(roleDefinitions)
    .where(
      and(
        eq(roleDefinitions.namespaceKind, namespaceKind),
        eq(roleDefinitions.namespaceScopeId, namespaceScopeId),
        isNull(roleDefinitions.retiredAt),
      ),
    )
    .all();
  for (const row of rows) {
    if (retireDefinitionWithClient(tx, row.id)) count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

/** Append-only audit insert; shares the caller's reservation. */
export function appendGovernanceAuditWithClient(
  tx: LocalAuthorizationDbClient,
  input: GovernanceAuditInsert,
): void {
  tx.insert(governanceAudit)
    .values({ ...input, id: input.id ?? uuid() })
    .run();
}

// ---------------------------------------------------------------------------
// Root-db conveniences (read-only shape; mutations stay caller-scoped)
// ---------------------------------------------------------------------------

export function getDefinition(id: string): RoleDefinitionRow | null {
  return getDefinitionWithClient(getDb(), id);
}

export function getAssignment(id: string): RoleAssignmentRow | null {
  return getAssignmentWithClient(getDb(), id);
}
