-- Additive lifecycle storage for restored Finding Triage lifecycle.
-- Adds nullable provenance, lineage, route-fingerprint, activation, and
-- legacy-repair columns to finding_triage; creates normalized evidence,
-- lineage repair, baseline evidence, and preflight attestation tables.
-- NO behavior changes, NO restrictive indexes/FKs, NO enforcement.

-- finding_triage: additive provenance/lineage/activation columns
ALTER TABLE finding_triage ADD COLUMN admitted_by_triage_mission_id TEXT;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN admitted_by_investigation_task_id TEXT;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN recurrence_of_id TEXT;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN legacy_lineage_repair_required INTEGER NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN route_fingerprint TEXT;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN activated_at TEXT;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN activated_by_type TEXT;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN activated_by_id TEXT;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN activation_cause TEXT;
--> statement-breakpoint
ALTER TABLE finding_triage ADD COLUMN activation_release_id TEXT;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_finding_triage_admitted_triage_mission
  ON finding_triage(admitted_by_triage_mission_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_admitted_investigation_task
  ON finding_triage(admitted_by_investigation_task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_recurrence
  ON finding_triage(recurrence_of_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_lineage_repair
  ON finding_triage(legacy_lineage_repair_required);
--> statement-breakpoint

-- finding_triage_evidence: normalized Finding-Pulse evidence membership.
-- habitat_id anchors the app-wide habitat-cascade convention: it is derived
-- from the referenced finding's habitat and lets habitat deletion cascade
-- evidence rows away alongside their findings.
CREATE TABLE IF NOT EXISTS finding_triage_evidence (
  finding_triage_id TEXT NOT NULL REFERENCES finding_triage(id) ON DELETE CASCADE,
  pulse_id TEXT NOT NULL REFERENCES pulses(id) ON DELETE CASCADE,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('source', 'corroborating', 'legacy_observed')),
  admitted_by_triage_mission_id TEXT,
  admitted_by_investigation_task_id TEXT,
  admitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (finding_triage_id, pulse_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_finding
  ON finding_triage_evidence(finding_triage_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_pulse
  ON finding_triage_evidence(pulse_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_role
  ON finding_triage_evidence(role);
--> statement-breakpoint

-- finding_triage_lineage_repairs: append-only repair audit ledger
CREATE TABLE IF NOT EXISTS finding_triage_lineage_repairs (
  id TEXT PRIMARY KEY,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  cluster_key TEXT NOT NULL,
  finding_kind TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('predecessor_mapping', 'evidence_baselined_root')),
  affected_identity TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  repair_time TEXT NOT NULL DEFAULT (datetime('now')),
  before_mapping TEXT NOT NULL DEFAULT '{}',
  after_mapping TEXT NOT NULL DEFAULT '{}',
  input_snapshot_digest TEXT NOT NULL,
  cutoff_timestamp TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_finding_triage_lineage_repairs_habitat
  ON finding_triage_lineage_repairs(habitat_id, cluster_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_lineage_repairs_identity
  ON finding_triage_lineage_repairs(habitat_id, cluster_key, finding_kind);
--> statement-breakpoint

-- finding_triage_lineage_baseline_evidence: normalized (repair_id, pulse_id) evidence baseline
CREATE TABLE IF NOT EXISTS finding_triage_lineage_baseline_evidence (
  repair_id TEXT NOT NULL REFERENCES finding_triage_lineage_repairs(id) ON DELETE CASCADE,
  pulse_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (repair_id, pulse_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_finding_triage_baseline_repair
  ON finding_triage_lineage_baseline_evidence(repair_id);
--> statement-breakpoint

-- migration_preflight_attestations: DB-local clean-result attestation
-- keyed by enforcement migration id + schema/preflight version.
-- NOT a fleet assertion — records this database's local preflight result.
CREATE TABLE IF NOT EXISTS migration_preflight_attestations (
  enforcement_migration_id TEXT NOT NULL,
  schema_version TEXT NOT NULL,
  preflight_version TEXT NOT NULL,
  anomaly_query_digest TEXT NOT NULL,
  clean INTEGER NOT NULL,
  anomaly_report TEXT,
  attested_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (enforcement_migration_id, schema_version)
);
