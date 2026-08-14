-- Triage publication occurrences — first-writer-frozen canonical occurrence store
-- for structured Finding cluster intake.
--
-- One row per canonical (version, candidate-snapshot) identity. The FIRST writer
-- freezes the rendered payload and the COMPLETE prepared Mission/Task/workflow
-- aggregate; every later replay (same scan, competing worker, or template edit)
-- publishes ONLY the persisted snapshot and never rereads the mutable template.
-- The unique snapshot_digest is the lifecycle/pulse snapshot identity used by
-- task-creation attempts (sourceScopeKind='triage_occurrence') and junction
-- publication. Additive only — no behavior changes, no restrictive enforcement.

CREATE TABLE IF NOT EXISTS triage_publication_occurrences (
  id TEXT PRIMARY KEY,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  cluster_key TEXT NOT NULL,
  occurrence_version INTEGER NOT NULL,
  candidate_snapshot TEXT NOT NULL,
  snapshot_digest TEXT NOT NULL UNIQUE,
  rendered_payload TEXT NOT NULL,
  prepared_aggregate TEXT NOT NULL,
  prepared_digest TEXT NOT NULL,
  template_id TEXT NOT NULL,
  template_digest TEXT NOT NULL,
  winner_nonce TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_triage_publication_occurrences_cluster
  ON triage_publication_occurrences(habitat_id, cluster_key);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_triage_publication_occurrences_template
  ON triage_publication_occurrences(template_id);
