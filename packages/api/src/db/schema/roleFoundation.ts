import {
  sqliteTable,
  text,
  integer,
  index,
  uniqueIndex,
  primaryKey,
  foreignKey,
  check,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { users } from "./user.js";

/**
 * Role foundation (migration 0083) — scoped local authorization storage.
 *
 * Four-kind governance scope ledger with incarnations: one active row per
 * (scope_kind, scope_id) via partial unique; a retired incarnation is never
 * reactivated and history is retained, never cascaded away. Resource
 * references are retained plain typed IDs — the ledger is governance state,
 * not an FK graph (deletion retirement is composed by the deletion writers).
 *
 * Authorized reads of a live, never-materialized scope report virtual
 * (incarnation 1, version 1) WITHOUT writing; the first mutation
 * materializes exactly that initial state and CASes against the supplied
 * expectation inside its writer reservation (binding addendum, storage).
 */
export const governanceScopes = sqliteTable(
  "governance_scopes",
  {
    scopeKind: text("scope_kind", { enum: ["team", "habitat", "mission", "task"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    incarnation: integer("incarnation").notNull(),
    version: integer("version").notNull(),
    retiredAt: text("retired_at"),
  },
  (table) => [
    primaryKey({ columns: [table.scopeKind, table.scopeId, table.incarnation] }),
    // Exactly one active incarnation per (kind, id).
    uniqueIndex("uq_governance_scopes_active")
      .on(table.scopeKind, table.scopeId)
      .where(sql`retired_at IS NULL`),
    index("idx_governance_scopes_scope").on(table.scopeKind, table.scopeId),
    check("gs_scope_kind_chk", sql`scope_kind IN ('team','habitat','mission','task')`),
    check("gs_incarnation_positive", sql`incarnation >= 1`),
    check("gs_version_positive", sql`version >= 1`),
  ],
);

/**
 * Role definitions. Built-ins are migration-seeded immutable rows with stable
 * fixed IDs (is_builtin = 1, no tenant namespace); custom definitions belong
 * to a Team or Habitat namespace captured at creation. Retired name reuse
 * creates a NEW definition id; a retired definition never un-retires.
 */
export const roleDefinitions = sqliteTable(
  "role_definitions",
  {
    id: text("id").primaryKey(),
    namespaceKind: text("namespace_kind", { enum: ["builtin", "team", "habitat"] }).notNull(),
    namespaceScopeId: text("namespace_scope_id"),
    namespaceIncarnation: integer("namespace_incarnation").notNull(),
    name: text("name").notNull(),
    isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
    latestRevision: integer("latest_revision").notNull(),
    retiredAt: text("retired_at"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
    updatedAt: text("updated_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    // Custom active names unique per namespace incarnation.
    uniqueIndex("uq_role_definitions_active_name")
      .on(
        table.namespaceKind,
        table.namespaceScopeId,
        table.namespaceIncarnation,
        table.name,
      )
      .where(sql`retired_at IS NULL AND namespace_kind IN ('team','habitat')`),
    // Built-ins: separate unique-name index (SQLite NULL-uniqueness avoided).
    uniqueIndex("uq_role_definitions_builtin_name")
      .on(table.name)
      .where(sql`is_builtin = 1`),
    index("idx_role_definitions_namespace").on(table.namespaceKind, table.namespaceScopeId),
    check("rd_namespace_kind_chk", sql`namespace_kind IN ('builtin','team','habitat')`),
    check(
      "rd_namespace_pair_chk",
      sql`(namespace_kind = 'builtin' AND namespace_scope_id IS NULL) OR (namespace_kind IN ('team','habitat') AND namespace_scope_id IS NOT NULL)`,
    ),
    check("rd_namespace_incarnation_positive", sql`namespace_incarnation >= 1`),
    check("rd_latest_revision_positive", sql`latest_revision >= 1`),
  ],
);

/**
 * Immutable permission revisions. Insert-only by trigger
 * (role_revisions_no_update / role_revisions_no_delete) and by repository
 * contract; a revision pins the exact permission JSON and catalogue version.
 * Assignments reference (definition_id, id) — the composite FK target.
 */
export const roleRevisions = sqliteTable(
  "role_revisions",
  {
    id: text("id").primaryKey(),
    definitionId: text("definition_id")
      .notNull()
      .references(() => roleDefinitions.id, { onDelete: "restrict" }),
    ordinal: integer("ordinal").notNull(),
    permissions: text("permissions").notNull(),
    catalogueVersion: integer("catalogue_version").notNull(),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("uq_role_revisions_definition_ordinal").on(table.definitionId, table.ordinal),
    uniqueIndex("uq_role_revisions_definition_id").on(table.definitionId, table.id),
    check("rr_ordinal_positive", sql`ordinal >= 1`),
    // length > 2 excludes '[]' — permissions must be a nonempty JSON array.
    check("rr_permissions_nonempty", sql`length(permissions) > 2`),
    check("rr_catalogue_version_positive", sql`catalogue_version >= 1`),
  ],
);

/**
 * Typed scoped assignments. Pins (definition, revision) via the composite FK
 * to role_revisions(definition_id, id) — an assignment can never point at a
 * revision belonging to another definition. Partial unique on the active
 * grant tuple; expiry is decision-time (no sweep, no grace). Revocation
 * retains the row as history. Issuer is a human user id.
 */
export const roleAssignments = sqliteTable(
  "role_assignments",
  {
    id: text("id").primaryKey(),
    principalType: text("principal_type", { enum: ["human", "agent"] }).notNull(),
    principalId: text("principal_id").notNull(),
    definitionId: text("definition_id").notNull(),
    revisionId: text("revision_id").notNull(),
    scopeKind: text("scope_kind", { enum: ["team", "habitat", "mission", "task"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    scopeIncarnation: integer("scope_incarnation").notNull(),
    state: text("state", { enum: ["active", "revoked"] }).notNull(),
    version: integer("version").notNull(),
    issuerUserId: text("issuer_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "restrict" }),
    issuedAt: text("issued_at").notNull().default(sql`(datetime('now'))`),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
    revokeReason: text("revoke_reason"),
  },
  (table) => [
    uniqueIndex("uq_role_assignments_active_grant")
      .on(
        table.principalType,
        table.principalId,
        table.definitionId,
        table.scopeKind,
        table.scopeId,
        table.scopeIncarnation,
      )
      .where(sql`state = 'active'`),
    foreignKey({
      columns: [table.definitionId, table.revisionId],
      foreignColumns: [roleRevisions.definitionId, roleRevisions.id],
    }),
    index("idx_role_assignments_principal").on(table.principalType, table.principalId),
    index("idx_role_assignments_scope").on(table.scopeKind, table.scopeId, table.state),
    index("idx_role_assignments_definition").on(table.definitionId),
    check("ra_principal_type_chk", sql`principal_type IN ('human','agent')`),
    check("ra_scope_kind_chk", sql`scope_kind IN ('team','habitat','mission','task')`),
    check("ra_state_chk", sql`state IN ('active','revoked')`),
    check("ra_scope_incarnation_positive", sql`scope_incarnation >= 1`),
    check("ra_version_positive", sql`version >= 1`),
  ],
);

/**
 * Append-only governance audit. Plain retained citations (typed actor,
 * operation, authoritative scope/incarnation, object, versions, bounded
 * details, reason) — no FKs to live resource tables so evidence survives
 * every scope/principal retirement. No credential values.
 */
export const governanceAudit = sqliteTable(
  "governance_audit",
  {
    id: text("id").primaryKey(),
    actorType: text("actor_type", { enum: ["human", "agent"] }).notNull(),
    actorId: text("actor_id").notNull(),
    operation: text("operation").notNull(),
    scopeKind: text("scope_kind", { enum: ["team", "habitat", "mission", "task"] }).notNull(),
    scopeId: text("scope_id").notNull(),
    scopeIncarnation: integer("scope_incarnation").notNull(),
    objectKind: text("object_kind").notNull(),
    objectId: text("object_id").notNull(),
    versionBefore: integer("version_before"),
    versionAfter: integer("version_after"),
    details: text("details", { mode: "json" }).$type<Record<string, unknown>>(),
    reason: text("reason"),
    createdAt: text("created_at").notNull().default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_governance_audit_scope").on(table.scopeKind, table.scopeId),
    index("idx_governance_audit_actor").on(table.actorType, table.actorId),
    index("idx_governance_audit_object").on(table.objectKind, table.objectId),
    index("idx_governance_audit_created").on(table.createdAt),
    check("ga_actor_type_chk", sql`actor_type IN ('human','agent')`),
    check("ga_scope_kind_chk", sql`scope_kind IN ('team','habitat','mission','task')`),
  ],
);
