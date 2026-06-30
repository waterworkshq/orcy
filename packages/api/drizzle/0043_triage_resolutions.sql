-- v0.23 "Triage": triage_resolutions unified resolution store (ADR-0027).
-- Keyed by cluster_key for proactive matching (PRD AC-PROACTIVE). Sources:
-- cluster_triage (source_id = triage_mission_id) and finding_triage
-- (source_id = finding_triage_id).
CREATE TABLE IF NOT EXISTS triage_resolutions (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  cluster_key TEXT NOT NULL,
  skill_category TEXT NOT NULL,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  root_cause TEXT,
  resolution TEXT,
  resolution_kind TEXT,
  resolved_by_type TEXT,
  resolved_by_id TEXT,
  resolved_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_triage_resolutions_habitat_cluster ON triage_resolutions(habitat_id, cluster_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_triage_resolutions_source ON triage_resolutions(source, source_id);
