-- v0.23 "Triage": triage_cluster_missions junction (ADR-0024).
-- Links cluster triage missions to their cluster_key for active-triage
-- suppression (AC-REACTIVE-8). No unique index: the same cluster_key may have
-- multiple records over time (original resolves -> cluster re-emerges -> new
-- triage). The scan queries WHERE habitat_id AND cluster_key AND status='open'.
CREATE TABLE IF NOT EXISTS triage_cluster_missions (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  cluster_key TEXT NOT NULL,
  mission_id TEXT NOT NULL REFERENCES missions(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_triage_cluster_missions_habitat_cluster ON triage_cluster_missions(habitat_id, cluster_key, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_triage_cluster_missions_mission ON triage_cluster_missions(mission_id);
