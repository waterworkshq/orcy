-- v0.23 "Triage": finding_triage lifecycle table (ADR-0027).
-- Parallel-table design: triage lifecycle outlives the source pulse.
-- cluster_key + finding_kind denormalised from the pulse at creation to avoid
-- a join on every dedup lookup.
CREATE TABLE IF NOT EXISTS finding_triage (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  pulse_id TEXT NOT NULL REFERENCES pulses(id) ON DELETE CASCADE,
  cluster_key TEXT NOT NULL,
  finding_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  bucket TEXT,
  target_release TEXT,
  triage_mission_id TEXT REFERENCES missions(id) ON DELETE SET NULL,
  corroborating_pulse_ids TEXT,
  triaged_by_type TEXT,
  triaged_by_id TEXT,
  triaged_at TEXT,
  resolved_by_type TEXT,
  resolved_by_id TEXT,
  resolved_at TEXT,
  resolution_note TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_habitat_status ON finding_triage(habitat_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_habitat_bucket ON finding_triage(habitat_id, bucket);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_pulse ON finding_triage(pulse_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_dedup ON finding_triage(habitat_id, cluster_key, finding_kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_mission ON finding_triage(triage_mission_id);
