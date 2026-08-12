-- 0063: Learning Loop ledger — extraction policies, work items, attempts,
-- immutable cited findings, scope refs, reviews, and promotions.
--
-- DORMANT foundation: no production write path routes through these tables
-- yet. Every table ships empty. See ADR-0044 for the architectural record.
--
-- Cascade design:
--   habitat_id  → habitats CASCADE          (no cross-Habitat orphans)
--   policy_id   → learning_loop_policies SET NULL  (work history survives policy deletion)
--   work_item_id → extraction_work_items CASCADE    (attempts belong to work)
--   finding_id  → extracted_findings CASCADE         (subordinate rows belong to finding)
-- Cross-chain provenance pointers (first_attempt_id, last_seen_attempt_id,
-- completed_by_attempt_id, parent_attempt_id, supersedes_*, lineage_root_id,
-- derived_from_source_id) are plain TEXT columns — NO FK. This mirrors the
-- 0054 task-publication design: the habitat_id CASCADE chain handles cleanup;
-- provenance references are application-layer invariants.

-- 1. learning_loop_policies — Habitat-scoped enrollment and schedule per extractor
CREATE TABLE IF NOT EXISTS learning_loop_policies (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  extractor_key TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  source_types TEXT NOT NULL DEFAULT '[]',
  schedule TEXT NOT NULL,
  window_seconds INTEGER NOT NULL,
  lookback_seconds INTEGER NOT NULL,
  min_confidence REAL,
  min_sample_size INTEGER,
  config TEXT NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1,
  created_by_type TEXT NOT NULL DEFAULT 'human',
  created_by_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_learning_loop_policies_habitat_extractor
  ON learning_loop_policies(habitat_id, extractor_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_learning_loop_policies_habitat
  ON learning_loop_policies(habitat_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_learning_loop_policies_habitat_enabled
  ON learning_loop_policies(habitat_id, enabled);
--> statement-breakpoint

-- 2. extraction_work_items — one logical, replay-safe unit of extraction
CREATE TABLE IF NOT EXISTS extraction_work_items (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  policy_id TEXT REFERENCES learning_loop_policies(id) ON DELETE SET NULL,
  extractor_key TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  policy_version INTEGER NOT NULL,
  window_from TEXT NOT NULL,
  window_to TEXT NOT NULL,
  source_boundary_tokens TEXT NOT NULL DEFAULT '{}',
  logical_work_key TEXT NOT NULL,
  delivery_mode TEXT NOT NULL,
  rerun_generation INTEGER NOT NULL DEFAULT 0,
  supersedes_work_id TEXT,
  fresh_reason TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  completed_by_attempt_id TEXT,
  policy_snapshot TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_extraction_work_items_logical_key
  ON extraction_work_items(logical_work_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extraction_work_items_habitat_status
  ON extraction_work_items(habitat_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extraction_work_items_policy
  ON extraction_work_items(policy_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extraction_work_items_habitat_extractor
  ON extraction_work_items(habitat_id, extractor_key);
--> statement-breakpoint

-- 3. extraction_attempts — one physical attempt to complete a work item
CREATE TABLE IF NOT EXISTS extraction_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  work_item_id TEXT NOT NULL REFERENCES extraction_work_items(id) ON DELETE CASCADE,
  attempt_no INTEGER NOT NULL,
  parent_attempt_id TEXT,
  delivery_mode TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  lease_expires_at TEXT NOT NULL,
  source_snapshot TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running',
  candidate_count INTEGER NOT NULL DEFAULT 0,
  persisted_count INTEGER NOT NULL DEFAULT 0,
  deduplicated_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  started_at TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_extraction_attempts_work_no
  ON extraction_attempts(work_item_id, attempt_no);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_work_status
  ON extraction_attempts(work_item_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_lease_recovery
  ON extraction_attempts(status, lease_expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extraction_attempts_owner
  ON extraction_attempts(lease_owner, status);
--> statement-breakpoint

-- 4. extracted_findings — immutable content/evidence revision with mutable CAS decision envelope
CREATE TABLE IF NOT EXISTS extracted_findings (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  first_attempt_id TEXT NOT NULL,
  last_seen_attempt_id TEXT NOT NULL,
  lineage_root_id TEXT NOT NULL,
  supersedes_finding_id TEXT,
  revision INTEGER NOT NULL,
  extractor_key TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  finding_type TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  structured_payload TEXT,
  confidence REAL NOT NULL,
  sample_size INTEGER NOT NULL,
  completeness TEXT NOT NULL,
  visibility_ceiling TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  evidence_digest TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'proposed',
  decision_version INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  occurrence_count INTEGER NOT NULL DEFAULT 1,
  caveats TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_extracted_findings_recurrence
  ON extracted_findings(habitat_id, extractor_key, extractor_version, fingerprint, evidence_digest);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_extracted_findings_lineage
  ON extracted_findings(lineage_root_id, revision);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_findings_habitat_status
  ON extracted_findings(habitat_id, status);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_findings_habitat_type
  ON extracted_findings(habitat_id, finding_type);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_findings_fingerprint
  ON extracted_findings(fingerprint, evidence_digest);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_findings_attempt
  ON extracted_findings(first_attempt_id);
--> statement-breakpoint

-- 5. extracted_finding_sources — polymorphic citations
CREATE TABLE IF NOT EXISTS extracted_finding_sources (
  id TEXT PRIMARY KEY NOT NULL,
  finding_id TEXT NOT NULL REFERENCES extracted_findings(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  source_version TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL,
  source_digest TEXT,
  occurred_at TEXT,
  entity_refs TEXT NOT NULL DEFAULT '[]',
  completeness TEXT NOT NULL DEFAULT 'complete',
  visibility_class TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_extracted_finding_sources_citation
  ON extracted_finding_sources(finding_id, source_type, source_id, source_version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_finding_sources_finding
  ON extracted_finding_sources(finding_id);
--> statement-breakpoint

-- 6. extracted_finding_scope_refs — server-derived authorization/query scope
CREATE TABLE IF NOT EXISTS extracted_finding_scope_refs (
  id TEXT PRIMARY KEY NOT NULL,
  finding_id TEXT NOT NULL REFERENCES extracted_findings(id) ON DELETE CASCADE,
  scope_type TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  derived_from_source_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_extracted_finding_scope_refs_finding_scope
  ON extracted_finding_scope_refs(finding_id, scope_type, scope_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_finding_scope_refs_scope
  ON extracted_finding_scope_refs(scope_type, scope_id);
--> statement-breakpoint

-- 7. extracted_finding_reviews — append-only human review decisions
CREATE TABLE IF NOT EXISTS extracted_finding_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  finding_id TEXT NOT NULL REFERENCES extracted_findings(id) ON DELETE CASCADE,
  decision TEXT NOT NULL,
  reason TEXT,
  reviewer_type TEXT NOT NULL,
  reviewer_id TEXT NOT NULL,
  expected_decision_version INTEGER NOT NULL,
  resulting_decision_version INTEGER NOT NULL,
  resolved_citation_states TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_finding_reviews_finding
  ON extracted_finding_reviews(finding_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_finding_reviews_finding_created
  ON extracted_finding_reviews(finding_id, created_at);
--> statement-breakpoint

-- 8. extracted_finding_promotions — one row per finding/destination, fenced terminalization
CREATE TABLE IF NOT EXISTS extracted_finding_promotions (
  id TEXT PRIMARY KEY NOT NULL,
  finding_id TEXT NOT NULL REFERENCES extracted_findings(id) ON DELETE CASCADE,
  destination_type TEXT NOT NULL,
  destination_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  idempotency_key TEXT NOT NULL,
  lease_owner TEXT NOT NULL,
  lease_generation INTEGER NOT NULL,
  target_type TEXT,
  target_id TEXT,
  target_version TEXT,
  consumed_finding_revision INTEGER NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_extracted_finding_promotions_finding_dest
  ON extracted_finding_promotions(finding_id, destination_type, destination_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_extracted_finding_promotions_status
  ON extracted_finding_promotions(status);
