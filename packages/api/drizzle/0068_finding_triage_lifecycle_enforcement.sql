-- Enforcement for the restored Finding Triage lifecycle (staged delivery, final stage).
--
-- Applied by the staged production migration runner ONLY after the additive
-- watermark (0064-0067) is committed AND a clean versioned preflight
-- attestation (preflight_version '002') has been written to
-- migration_preflight_attestations for THIS migration id.
--
-- Guard pattern: anomaly counts are inserted into a TEMPORARY table whose
-- CHECK (anomaly_count = 0) constraint aborts THIS migration transaction
-- BEFORE any table rebuild/replacement. No RAISE() in a bare SELECT — that is
-- illegal in SQLite; the temp-table CHECK guard is the legal equivalent and
-- rolls back atomically with the transaction.
--
-- What this migration enforces:
--   1. Active lifecycle identity: partial UNIQUE (habitat_id, cluster_key,
--      finding_kind) on finding_triage WHERE status NOT IN terminal states.
--   2. Finding-scoped Resolution uniqueness: partial UNIQUE (source,
--      source_id) on triage_resolutions WHERE source = 'finding_triage'.
--      Cluster Resolution (source='cluster_triage') is deliberately unchanged.
--   3. Restrictive FKs: finding_triage.pulse_id and finding_triage.
--      triage_mission_id, both finding_triage_evidence FKs, AND the
--      investigation-provenance columns (admitted_by_triage_mission_id →
--      missions, admitted_by_investigation_task_id → tasks on BOTH rebuilt
--      tables) convert from CASCADE/SET NULL/unreferenced TEXT to RESTRICT
--      so referenced Pulse/Mission/Task deletion can no longer erase
--      terminal evidence or provenance. Service-level guards
--      (findingTriageHistoryGuards.ts) remain the first line; these FKs
--      catch direct-SQL mistakes.
--
-- Table rebuilds use transaction-local backup tables: any failure rolls the
-- whole migration back and leaves the additive schema intact, so an
-- interrupted or aborted enforcement restarts safely under the normal ledger.

CREATE TEMP TABLE IF NOT EXISTS __triage_enforcement_guard (
  check_name TEXT NOT NULL PRIMARY KEY,
  anomaly_count INTEGER NOT NULL CHECK (anomaly_count = 0)
);
--> statement-breakpoint
-- Guard 1: a clean versioned attestation for THIS enforcement migration must
-- exist. 0 when present, 1 when missing/stale. Beyond migration id +
-- preflight version + clean, the guard PINS the attested contract:
--   - schema_version must equal the additive watermark's schema ('0067');
--   - anomaly_query_digest must equal the deterministic SHA-256 digest of the
--     CURRENT preflight's anomaly-query construction (emitted by the staged
--     runner via computeAnomalyQueryDigest() in findingTriagePreflight.ts).
-- A stale preflight (different schema or different anomaly queries) writing
-- a clean attestation therefore aborts enforcement instead of passing. The
-- pinned literals below are asserted against the live constants by the
-- stagedEnforcementMigration parity test — regenerate them together.
INSERT INTO __triage_enforcement_guard (check_name, anomaly_count)
SELECT 'clean_attestation', CASE WHEN EXISTS (
  SELECT 1 FROM migration_preflight_attestations
  WHERE enforcement_migration_id = '0068_finding_triage_lifecycle_enforcement'
    AND preflight_version = '003'
    AND schema_version = '0067'
    AND anomaly_query_digest = '9d1492e92d766e2d45db782502ce734fc34e09c0fb90eb047359fc8b013735b9'
    AND clean = 1
) THEN 0 ELSE 1 END;
--> statement-breakpoint
-- Guard 2: active identity duplicates (must match the preflight query).
INSERT INTO __triage_enforcement_guard (check_name, anomaly_count)
SELECT 'active_identity_duplicate', COUNT(*) FROM (
  SELECT 1 FROM finding_triage
  WHERE status NOT IN ('resolved', 'wontfix')
  GROUP BY habitat_id, cluster_key, finding_kind
  HAVING COUNT(*) > 1
);
--> statement-breakpoint
-- Guard 3: Finding-source Resolution duplicates (must match the preflight query).
INSERT INTO __triage_enforcement_guard (check_name, anomaly_count)
SELECT 'finding_resolution_duplicate', COUNT(*) FROM (
  SELECT 1 FROM triage_resolutions
  WHERE source = 'finding_triage'
  GROUP BY source_id
  HAVING COUNT(*) > 1
);
--> statement-breakpoint
-- Transaction-local backups of both rebuilt tables.
CREATE TABLE finding_triage_enforcement_backup AS SELECT * FROM finding_triage;
--> statement-breakpoint
CREATE TABLE finding_triage_evidence_enforcement_backup AS SELECT * FROM finding_triage_evidence;
--> statement-breakpoint
-- Drop child first, then parent: after these drops no table references
-- finding_triage, so the parent DROP cannot fire child FK actions.
DROP TABLE finding_triage_evidence;
--> statement-breakpoint
DROP TABLE finding_triage;
--> statement-breakpoint
-- finding_triage rebuilt with RESTRICT on pulse_id (source evidence) and
-- triage_mission_id (corrective link). habitat_id keeps the app-wide habitat
-- CASCADE convention. Column set is identical to post-0067 shape.
CREATE TABLE finding_triage (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  pulse_id TEXT NOT NULL REFERENCES pulses(id) ON DELETE RESTRICT,
  cluster_key TEXT NOT NULL,
  finding_kind TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  bucket TEXT,
  target_release TEXT,
  target_release_type TEXT,
  triage_mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  corroborating_pulse_ids TEXT,
  admitted_by_triage_mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  admitted_by_investigation_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  recurrence_of_id TEXT,
  legacy_lineage_repair_required INTEGER NOT NULL DEFAULT 0,
  route_fingerprint TEXT,
  activated_at TEXT,
  activated_by_type TEXT,
  activated_by_id TEXT,
  activation_cause TEXT,
  activation_release_id TEXT,
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
INSERT INTO finding_triage (
  id, habitat_id, pulse_id, cluster_key, finding_kind, status, bucket,
  target_release, target_release_type, triage_mission_id, corroborating_pulse_ids,
  admitted_by_triage_mission_id, admitted_by_investigation_task_id, recurrence_of_id,
  legacy_lineage_repair_required, route_fingerprint, activated_at, activated_by_type,
  activated_by_id, activation_cause, activation_release_id, triaged_by_type,
  triaged_by_id, triaged_at, resolved_by_type, resolved_by_id, resolved_at,
  resolution_note, metadata, created_at, updated_at
)
SELECT
  id, habitat_id, pulse_id, cluster_key, finding_kind, status, bucket,
  target_release, target_release_type, triage_mission_id, corroborating_pulse_ids,
  admitted_by_triage_mission_id, admitted_by_investigation_task_id, recurrence_of_id,
  legacy_lineage_repair_required, route_fingerprint, activated_at, activated_by_type,
  activated_by_id, activation_cause, activation_release_id, triaged_by_type,
  triaged_by_id, triaged_at, resolved_by_type, resolved_by_id, resolved_at,
  resolution_note, metadata, created_at, updated_at
FROM finding_triage_enforcement_backup;
--> statement-breakpoint
DROP TABLE finding_triage_enforcement_backup;
--> statement-breakpoint
-- finding_triage_evidence rebuilt with RESTRICT on both FKs: referenced
-- Pulse or Finding deletion can no longer cascade away terminal evidence.
-- The investigation-provenance columns are RESTRICT-referenced as well:
-- deleting the admitting Mission/Task would leave unprovable admission
-- history (advisory anomaly unprovable_investigation_provenance).
CREATE TABLE finding_triage_evidence (
  finding_triage_id TEXT NOT NULL REFERENCES finding_triage(id) ON DELETE RESTRICT,
  pulse_id TEXT NOT NULL REFERENCES pulses(id) ON DELETE RESTRICT,
  role TEXT NOT NULL CHECK (role IN ('source', 'corroborating', 'legacy_observed')),
  admitted_by_triage_mission_id TEXT REFERENCES missions(id) ON DELETE RESTRICT,
  admitted_by_investigation_task_id TEXT REFERENCES tasks(id) ON DELETE RESTRICT,
  admitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (finding_triage_id, pulse_id)
);
--> statement-breakpoint
INSERT INTO finding_triage_evidence (
  finding_triage_id, pulse_id, role, admitted_by_triage_mission_id,
  admitted_by_investigation_task_id, admitted_at, created_at
)
SELECT
  finding_triage_id, pulse_id, role, admitted_by_triage_mission_id,
  admitted_by_investigation_task_id, admitted_at, created_at
FROM finding_triage_evidence_enforcement_backup;
--> statement-breakpoint
DROP TABLE finding_triage_evidence_enforcement_backup;
--> statement-breakpoint
-- Recreate every finding_triage index dropped with the old table.
CREATE INDEX IF NOT EXISTS idx_finding_triage_habitat_status ON finding_triage(habitat_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_habitat_bucket ON finding_triage(habitat_id, bucket);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_pulse ON finding_triage(pulse_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_dedup ON finding_triage(habitat_id, cluster_key, finding_kind);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_mission ON finding_triage(triage_mission_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_admitted_triage_mission ON finding_triage(admitted_by_triage_mission_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_admitted_investigation_task ON finding_triage(admitted_by_investigation_task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_recurrence ON finding_triage(recurrence_of_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_lineage_repair ON finding_triage(legacy_lineage_repair_required);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_finding ON finding_triage_evidence(finding_triage_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_pulse ON finding_triage_evidence(pulse_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_finding_triage_evidence_role ON finding_triage_evidence(role);
--> statement-breakpoint
-- The enforcement constraints.
CREATE UNIQUE INDEX IF NOT EXISTS idx_finding_triage_active_identity
  ON finding_triage(habitat_id, cluster_key, finding_kind)
  WHERE status NOT IN ('resolved', 'wontfix');
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_triage_resolutions_finding_source
  ON triage_resolutions(source, source_id)
  WHERE source = 'finding_triage';
--> statement-breakpoint
DROP TABLE __triage_enforcement_guard;
