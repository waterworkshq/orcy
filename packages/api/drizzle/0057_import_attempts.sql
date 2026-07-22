-- 0057: Import-side persistence foundations (T10A Milestone 1).
--
-- Forward-compatible DORMANT storage for the Habitat Import Manifest v3 +
-- the per-import attempt lifecycle. The `import_attempts` table is the import
-- analog of `scheduled_occurrences` (T9A Phase 1): it tracks the import-level
-- state machine (`reserved → publishing → published | rejected`) across the
-- post-commit observation window, the worker lease, the coordination attempt
-- link, and the terminal result.
--
-- DORMANT: no production caller routes through this table yet (M4 ships the
-- `reserveImportAttempt` wrapper + the preflight pipeline that fills it; the
-- T11 cutover wires the new manifest path behind `ORCY_CREATION_PUBLICATION_ENABLED`).
-- Like the T1 publication tables, this migration ships the schema + indexes +
-- a dormant helper module (`repositories/importAttempts.ts`) so later milestones
-- can compose primitives without a further migration.
--
-- Non-cascade design (load-bearing, mirrors `scheduled_occurrences` precedent):
--   `habitat_id` and `created_habitat_id` are plain TEXT with NO foreign key —
--   NON-cascading by design, for the same reason `scheduled_task_id` and
--   `created_mission_id` are plain text on `scheduled_occurrences`. A replacement
--   Habitat import deletes and recreates the Habitat row (cascading to missions /
--   tasks / comments), but the import attempt is operational / audit history
--   that MUST survive. Authorization (for read paths that care about caller
--   habitat access) is resolved against the habitats table at read time (a
--   since-deleted habitat is treated as not-found → access refused), never
--   derived from a Mission / Task FK that disappears on replacement.
--   `attempt_id` (the publication-kind:habitat_import coordination attempt) is
--   also plain TEXT with NO foreign key — NON-cascading by design, mirroring
--   `scheduled_occurrences.attempt_id` (T9A Phase 1 precedent — same plain-
--   TEXT-without-FK discipline for the same reason: the import attempt is the
--   durable operational/audit record; the coordination attempt may be aged out
--   or cleaned up while the import attempt remains authoritative state).
--
-- See: db/schema/importManifest.ts (the drizzle export mirroring this DDL)
-- See: repositories/importAttempts.ts (the *WithClient primitives + state machine)
-- See: docs/plans/MEMORY.md § Migration Plumbing (hand-written SQL is the source
--      of truth; the drizzle export mirrors it; 0000_schema.sql is FROZEN).

-- 1. Import Attempts (the import analog of `scheduled_occurrences`)
CREATE TABLE IF NOT EXISTS import_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  -- The target habitat (plain text, non-cascading — outlives replacement).
  habitat_id TEXT NOT NULL,
  -- 'new' | 'replacement'
  mode TEXT NOT NULL,
  -- 'remap' | 'restore'
  identity_policy TEXT NOT NULL,
  -- JSON: source manifest id, source habitat id (for restore), source exportedAt.
  -- Nullable: callers that don't carry lineage (legacy v1 inputs) leave it NULL.
  source_lineage TEXT,
  -- SHA-256 of the canonical-stable-stringified manifest (the prepared basis).
  manifest_digest TEXT NOT NULL,
  -- 'reserved' | 'publishing' | 'published' | 'rejected'
  state TEXT NOT NULL DEFAULT 'reserved',
  -- The coordination attempt (publicationKind:'habitat_import'); NULL before the
  -- reservation tx stamps it (T10A M4 parallel to T9A-03's setOccurrenceAttemptId).
  -- Plain TEXT (NO FK) — the import attempt is operational / audit history
  -- that outlives the coordination attempt (a `task_creation_attempts` row
  -- may be aged out / cleaned up while the import attempt remains as the
  -- durable record). Mirrors `scheduled_occurrences.attempt_id` (T9A Phase 1
  -- precedent — same plain-TEXT-without-FK discipline for the same reason).
  attempt_id TEXT,
  -- The worker that drove publication (NULL when state != 'publishing').
  lease_owner TEXT,
  lease_expires_at TEXT,
  -- The committed habitat id (NULL until complete success — for mode:'new' the
  -- habitat is allocated in-tx at publish time; for mode:'replacement' it
  -- equals `habitat_id`).
  created_habitat_id TEXT,
  -- JSON: terminal detail (kind:import_published | reason:rejected_*) + retry
  -- history. Nullable until terminalization.
  result TEXT,
  -- JSON: per-domain counts (portable/preserve/reset declared) + authority
  -- context. Stamped at reservation (the prepared-basis audit snapshot).
  manifest_summary TEXT NOT NULL,
  -- When state = 'rejected': preflight or governance failure detail.
  rejection_reason TEXT,
  -- 'human' (default) | 'agent' | 'system'
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_import_attempts_habitat
  ON import_attempts(habitat_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_import_attempts_state
  ON import_attempts(state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_import_attempts_lease
  ON import_attempts(lease_owner, lease_expires_at);
