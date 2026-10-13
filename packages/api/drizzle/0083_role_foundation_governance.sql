/*
    Role foundation — scoped local authorization storage (role-foundation
    contract + binding technical addendum).

    Additive only — five new tables, two column additions, seeded immutable
    built-in roles; no owner/role/grant backfill from history:

      - governance_scopes: four-kind (team/habitat/mission/task) scope ledger
        with incarnations. PK (scope_kind, scope_id, incarnation); partial
        unique keeps at most ONE materialized active incarnation per
        (kind, id) — a live, never-materialized scope has no stored active
        row and reads as virtual until first mutation. A retired
        incarnation is never reactivated; history is retained. Authorized
        reads of a live, never-materialized scope report virtual
        (incarnation 1, version 1) WITHOUT writing; the first mutation
        materializes that exact initial state and CASes the supplied
        expectation inside its writer reservation.

      - role_definitions: built-in (migration-seeded, server-owned, fixed IDs)
        and custom Team/Habitat-namespaced definitions. Custom active names
        unique per namespace incarnation; built-ins under a separate
        is_builtin = 1 unique index (no SQLite NULL-uniqueness assumption).
        Retired name reuse creates a new definition id; nothing un-retires.

      - role_revisions: insert-only immutable permission revisions. BEFORE
        UPDATE/DELETE triggers RAISE(ABORT) on any mutation. Assignments
        reference the composite (definition_id, revision_id) ->
        role_revisions(definition_id, id) — an assignment can never point at
        another definition's revision.

      - role_assignments: typed (human|agent) principal, pinned
        definition/revision, exact scope kind/id/incarnation, active|revoked
        state with object version, human issuer (FK users RESTRICT — the
        human-only issuance rule is enforced at the command layer), optional
        decision-time expiry. Partial unique on the active grant tuple;
        revocation retains the row as history.

      - governance_audit: append-only governance evidence with plain retained
        citations (no FKs to live resource tables — evidence survives every
        scope/principal retirement; no credential values).

    Column additions:
      - habitats.owner_user_id TEXT NULL FK users RESTRICT, with a CHECK that
        a team Habitat never carries a dormant personal owner. No backfill:
        legacy personal Habitats start explicitly unowned (global-admin
        governed).
      - review_rules.version INTEGER NOT NULL DEFAULT 1 — initialized to 1 for
        existing rows; every repository update increments (optional legacy
        CAS lands with the review-governance ticket).

    Seeded fixed IDs: builtin-role-coordinator ('Coordinator',
    ["review.configure","review.assign"]) and
    builtin-role-review-coordinator ('Review Coordinator', ["review.assign"]),
    each with revision 1 rows builtin-role-coordinator-rev-1 /
    builtin-role-review-coordinator-rev-1 at catalogue version 1. INSERT ...
    SELECT WHERE NOT EXISTS keeps re-application idempotent.
*/
CREATE TABLE `governance_scopes` (
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`incarnation` integer NOT NULL,
	`version` integer NOT NULL,
	`retired_at` text,
	CONSTRAINT `gs_pk` PRIMARY KEY (`scope_kind`, `scope_id`, `incarnation`),
	CONSTRAINT `gs_scope_kind_chk` CHECK (scope_kind IN ('team', 'habitat', 'mission', 'task')),
	CONSTRAINT `gs_incarnation_positive` CHECK (incarnation >= 1),
	CONSTRAINT `gs_version_positive` CHECK (version >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_governance_scopes_active`
	ON `governance_scopes` (`scope_kind`, `scope_id`)
	WHERE `retired_at` IS NULL;
--> statement-breakpoint
CREATE INDEX `idx_governance_scopes_scope` ON `governance_scopes` (`scope_kind`, `scope_id`);
--> statement-breakpoint
CREATE TABLE `role_definitions` (
	`id` text PRIMARY KEY NOT NULL,
	`namespace_kind` text NOT NULL,
	`namespace_scope_id` text,
	`namespace_incarnation` integer NOT NULL,
	`name` text NOT NULL,
	`is_builtin` integer NOT NULL DEFAULT 0,
	`latest_revision` integer NOT NULL,
	`retired_at` text,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	`updated_at` text NOT NULL DEFAULT (datetime('now')),
	CONSTRAINT `rd_namespace_kind_chk` CHECK (namespace_kind IN ('builtin', 'team', 'habitat')),
	CONSTRAINT `rd_namespace_pair_chk` CHECK ((namespace_kind = 'builtin' AND namespace_scope_id IS NULL) OR (namespace_kind IN ('team', 'habitat') AND namespace_scope_id IS NOT NULL)),
	CONSTRAINT `rd_namespace_incarnation_positive` CHECK (namespace_incarnation >= 1),
	CONSTRAINT `rd_latest_revision_positive` CHECK (latest_revision >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_role_definitions_active_name`
	ON `role_definitions` (`namespace_kind`, `namespace_scope_id`, `namespace_incarnation`, `name`)
	WHERE `retired_at` IS NULL AND `namespace_kind` IN ('team', 'habitat');
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_role_definitions_builtin_name`
	ON `role_definitions` (`name`)
	WHERE `is_builtin` = 1;
--> statement-breakpoint
CREATE INDEX `idx_role_definitions_namespace` ON `role_definitions` (`namespace_kind`, `namespace_scope_id`);
--> statement-breakpoint
CREATE TABLE `role_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`definition_id` text NOT NULL,
	`ordinal` integer NOT NULL,
	`permissions` text NOT NULL,
	`catalogue_version` integer NOT NULL,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	CONSTRAINT `rr_ordinal_positive` CHECK (ordinal >= 1),
	CONSTRAINT `rr_permissions_nonempty` CHECK (length(permissions) > 2),
	CONSTRAINT `rr_catalogue_version_positive` CHECK (catalogue_version >= 1),
	CONSTRAINT `rr_definition_fk` FOREIGN KEY (`definition_id`) REFERENCES `role_definitions`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_role_revisions_definition_ordinal` ON `role_revisions` (`definition_id`, `ordinal`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_role_revisions_definition_id` ON `role_revisions` (`definition_id`, `id`);
--> statement-breakpoint
CREATE TABLE `role_assignments` (
	`id` text PRIMARY KEY NOT NULL,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`scope_incarnation` integer NOT NULL,
	`state` text NOT NULL,
	`version` integer NOT NULL,
	`issuer_user_id` text NOT NULL,
	`issued_at` text NOT NULL DEFAULT (datetime('now')),
	`expires_at` text,
	`revoked_at` text,
	`revoke_reason` text,
	CONSTRAINT `ra_principal_type_chk` CHECK (principal_type IN ('human', 'agent')),
	CONSTRAINT `ra_scope_kind_chk` CHECK (scope_kind IN ('team', 'habitat', 'mission', 'task')),
	CONSTRAINT `ra_state_chk` CHECK (state IN ('active', 'revoked')),
	CONSTRAINT `ra_scope_incarnation_positive` CHECK (scope_incarnation >= 1),
	CONSTRAINT `ra_version_positive` CHECK (version >= 1),
	CONSTRAINT `ra_revision_composite_fk` FOREIGN KEY (`definition_id`, `revision_id`) REFERENCES `role_revisions`(`definition_id`, `id`),
	CONSTRAINT `ra_issuer_fk` FOREIGN KEY (`issuer_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_role_assignments_active_grant`
	ON `role_assignments` (`principal_type`, `principal_id`, `definition_id`, `scope_kind`, `scope_id`, `scope_incarnation`)
	WHERE `state` = 'active';
--> statement-breakpoint
CREATE INDEX `idx_role_assignments_principal` ON `role_assignments` (`principal_type`, `principal_id`);
--> statement-breakpoint
CREATE INDEX `idx_role_assignments_scope` ON `role_assignments` (`scope_kind`, `scope_id`, `state`);
--> statement-breakpoint
CREATE INDEX `idx_role_assignments_definition` ON `role_assignments` (`definition_id`);
--> statement-breakpoint
CREATE TABLE `governance_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`operation` text NOT NULL,
	`scope_kind` text NOT NULL,
	`scope_id` text NOT NULL,
	`scope_incarnation` integer NOT NULL,
	`object_kind` text NOT NULL,
	`object_id` text NOT NULL,
	`version_before` integer,
	`version_after` integer,
	`details` text,
	`reason` text,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	CONSTRAINT `ga_actor_type_chk` CHECK (actor_type IN ('human', 'agent')),
	CONSTRAINT `ga_scope_kind_chk` CHECK (scope_kind IN ('team', 'habitat', 'mission', 'task'))
);
--> statement-breakpoint
CREATE INDEX `idx_governance_audit_scope` ON `governance_audit` (`scope_kind`, `scope_id`);
--> statement-breakpoint
CREATE INDEX `idx_governance_audit_actor` ON `governance_audit` (`actor_type`, `actor_id`);
--> statement-breakpoint
CREATE INDEX `idx_governance_audit_object` ON `governance_audit` (`object_kind`, `object_id`);
--> statement-breakpoint
CREATE INDEX `idx_governance_audit_created` ON `governance_audit` (`created_at`);
--> statement-breakpoint
ALTER TABLE `habitats` ADD `owner_user_id` text REFERENCES `users`(`id`) ON DELETE RESTRICT;
--> statement-breakpoint
CREATE INDEX `idx_habitats_owner` ON `habitats` (`owner_user_id`);
--> statement-breakpoint
CREATE TRIGGER `habitats_owner_team_exclusive_chk_insert`
	BEFORE INSERT ON `habitats`
	WHEN NEW.`owner_user_id` IS NOT NULL AND NEW.`team_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'team habitats cannot carry a personal owner');
END;
--> statement-breakpoint
CREATE TRIGGER `habitats_owner_team_exclusive_chk_update`
	BEFORE UPDATE OF `owner_user_id`, `team_id` ON `habitats`
	WHEN NEW.`owner_user_id` IS NOT NULL AND NEW.`team_id` IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'team habitats cannot carry a personal owner');
END;
--> statement-breakpoint
ALTER TABLE `review_rules` ADD `version` integer NOT NULL DEFAULT 1;
--> statement-breakpoint
CREATE TRIGGER `role_revisions_no_update`
	BEFORE UPDATE ON `role_revisions`
BEGIN
	SELECT RAISE(ABORT, 'role revisions are immutable');
END;
--> statement-breakpoint
CREATE TRIGGER `role_revisions_no_delete`
	BEFORE DELETE ON `role_revisions`
BEGIN
	SELECT RAISE(ABORT, 'role revisions are immutable');
END;
--> statement-breakpoint
INSERT INTO `role_definitions` (`id`, `namespace_kind`, `namespace_scope_id`, `namespace_incarnation`, `name`, `is_builtin`, `latest_revision`, `created_at`, `updated_at`)
SELECT 'builtin-role-coordinator', 'builtin', NULL, 1, 'Coordinator', 1, 1, datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM `role_definitions` WHERE `id` = 'builtin-role-coordinator');
--> statement-breakpoint
INSERT INTO `role_revisions` (`id`, `definition_id`, `ordinal`, `permissions`, `catalogue_version`, `created_at`)
SELECT 'builtin-role-coordinator-rev-1', 'builtin-role-coordinator', 1, '["review.configure","review.assign"]', 1, datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM `role_revisions` WHERE `id` = 'builtin-role-coordinator-rev-1');
--> statement-breakpoint
INSERT INTO `role_definitions` (`id`, `namespace_kind`, `namespace_scope_id`, `namespace_incarnation`, `name`, `is_builtin`, `latest_revision`, `created_at`, `updated_at`)
SELECT 'builtin-role-review-coordinator', 'builtin', NULL, 1, 'Review Coordinator', 1, 1, datetime('now'), datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM `role_definitions` WHERE `id` = 'builtin-role-review-coordinator');
--> statement-breakpoint
INSERT INTO `role_revisions` (`id`, `definition_id`, `ordinal`, `permissions`, `catalogue_version`, `created_at`)
SELECT 'builtin-role-review-coordinator-rev-1', 'builtin-role-review-coordinator', 1, '["review.assign"]', 1, datetime('now')
WHERE NOT EXISTS (SELECT 1 FROM `role_revisions` WHERE `id` = 'builtin-role-review-coordinator-rev-1');
--> statement-breakpoint
-- Seed the governance ledger for every EXISTING supported resource at
-- active incarnation/version 1 (binding: existing supported resources are
-- seeded; virtual reads serve only newly created resources without
-- history). No owner/grant backfill. INSERT..SELECT WHERE NOT EXISTS keeps
-- re-application idempotent and skips any key a prior statement already
-- materialized (e.g. a fresh habitat created mid-migration cannot exist —
-- the migration runs inside one boot reservation).
INSERT INTO `governance_scopes` (`scope_kind`, `scope_id`, `incarnation`, `version`)
SELECT 'team', t.`id`, 1, 1 FROM `teams` t
WHERE NOT EXISTS (SELECT 1 FROM `governance_scopes` g WHERE g.`scope_kind` = 'team' AND g.`scope_id` = t.`id`);
--> statement-breakpoint
INSERT INTO `governance_scopes` (`scope_kind`, `scope_id`, `incarnation`, `version`)
SELECT 'habitat', h.`id`, 1, 1 FROM `habitats` h
WHERE NOT EXISTS (SELECT 1 FROM `governance_scopes` g WHERE g.`scope_kind` = 'habitat' AND g.`scope_id` = h.`id`);
--> statement-breakpoint
INSERT INTO `governance_scopes` (`scope_kind`, `scope_id`, `incarnation`, `version`)
SELECT 'mission', m.`id`, 1, 1 FROM `missions` m
WHERE NOT EXISTS (SELECT 1 FROM `governance_scopes` g WHERE g.`scope_kind` = 'mission' AND g.`scope_id` = m.`id`);
--> statement-breakpoint
INSERT INTO `governance_scopes` (`scope_kind`, `scope_id`, `incarnation`, `version`)
SELECT 'task', k.`id`, 1, 1 FROM `tasks` k
WHERE NOT EXISTS (SELECT 1 FROM `governance_scopes` g WHERE g.`scope_kind` = 'task' AND g.`scope_id` = k.`id`);
