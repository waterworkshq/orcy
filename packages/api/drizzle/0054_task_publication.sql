-- 0054: Task publication persistence foundations (T1 Phase 1).
--
-- Forward-compatible DORMANT storage for the publication model. Every table
-- ships empty and unused; no production write path routes through them yet.
-- All tables are additive CREATE IF NOT EXISTS; the only ALTER is a nullable-
-- defaulted integrity column on tasks. See db/schema/taskPublication.ts.
--
-- Non-cascade design: cross-chain references (committed_task_id, mission_id,
-- scheduled_task_id, etc.) are plain TEXT columns — NO FK to habitats /
-- missions / tasks. A replacement Habitat import deletes and recreates the
-- Habitat row (cascading to missions/tasks), but attempt, envelope, dispatch,
-- reservation, occurrence, and marker records MUST survive as audit history.
-- Within-family FKs (attempt → governance decision / envelope / reservation)
-- DO exist because they are never reached by a Habitat cascade.

-- 1. Durable Task Creation Attempts
CREATE TABLE IF NOT EXISTS task_creation_attempts (
  id TEXT PRIMARY KEY NOT NULL,
  source TEXT NOT NULL,
  source_scope_kind TEXT NOT NULL,
  source_scope_id TEXT NOT NULL,
  attempt_key TEXT NOT NULL,
  request_fingerprint TEXT NOT NULL,
  publication_kind TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  causal_context TEXT,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT,
  lease_expires_at TEXT,
  prospective_task_id TEXT,
  committed_task_id TEXT,
  committed_mission_id TEXT,
  envelope_event_id TEXT,
  reservation_id TEXT,
  terminal_outcome TEXT,
  terminal_result TEXT,
  details TEXT,
  reserved_at TEXT NOT NULL DEFAULT (datetime('now')),
  published_at TEXT,
  completed_at TEXT
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_creation_attempts_scope_key
  ON task_creation_attempts (source, source_scope_kind, source_scope_id, attempt_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_attempts_state
  ON task_creation_attempts (state);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_attempts_lease
  ON task_creation_attempts (lease_owner, lease_expires_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_attempts_committed_task
  ON task_creation_attempts (committed_task_id);
--> statement-breakpoint

-- 2. Governance-decision ledger
CREATE TABLE IF NOT EXISTS task_creation_governance_decisions (
  id TEXT PRIMARY KEY NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES task_creation_attempts(id) ON DELETE CASCADE,
  prospective_task_id TEXT NOT NULL,
  interceptor_key TEXT NOT NULL,
  governance_fingerprint TEXT NOT NULL,
  decision TEXT NOT NULL,
  plugin_run_id TEXT,
  diagnostics TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_creation_gov_decisions_key
  ON task_creation_governance_decisions (attempt_id, prospective_task_id, interceptor_key, governance_fingerprint);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_gov_decisions_attempt
  ON task_creation_governance_decisions (attempt_id);
--> statement-breakpoint

-- 3. Committed creation envelopes
CREATE TABLE IF NOT EXISTS task_creation_envelopes (
  event_id TEXT PRIMARY KEY NOT NULL,
  lifecycle_action TEXT NOT NULL,
  task_id TEXT NOT NULL,
  habitat_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES task_creation_attempts(id) ON DELETE CASCADE,
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  source TEXT NOT NULL,
  causal_context TEXT NOT NULL DEFAULT '{}',
  clone_source_task_id TEXT
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_envelopes_task
  ON task_creation_envelopes (task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_envelopes_attempt
  ON task_creation_envelopes (attempt_id);
--> statement-breakpoint

-- 4. Dispatch targets
CREATE TABLE IF NOT EXISTS task_creation_dispatch_targets (
  id TEXT PRIMARY KEY NOT NULL,
  event_id TEXT NOT NULL REFERENCES task_creation_envelopes(event_id) ON DELETE CASCADE,
  target_kind TEXT NOT NULL,
  target_key TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_error TEXT,
  accepted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_task_creation_dispatch_targets
  ON task_creation_dispatch_targets (event_id, target_kind, target_key);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_dispatch_targets_state
  ON task_creation_dispatch_targets (state);
--> statement-breakpoint

-- 5. Targeted-assignment reservations
CREATE TABLE IF NOT EXISTS task_creation_assignment_reservations (
  id TEXT PRIMARY KEY NOT NULL,
  task_id TEXT NOT NULL,
  attempt_id TEXT NOT NULL REFERENCES task_creation_attempts(id) ON DELETE CASCADE,
  requested_agent_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  deadline TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active',
  failure_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_reservations_task
  ON task_creation_assignment_reservations (task_id);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_creation_reservations_state
  ON task_creation_assignment_reservations (state);
--> statement-breakpoint

-- 6. Mission recalculation markers
CREATE TABLE IF NOT EXISTS mission_recalculation_markers (
  id TEXT PRIMARY KEY NOT NULL,
  mission_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_mission_recalc_markers_mission
  ON mission_recalculation_markers (mission_id);
--> statement-breakpoint
-- Partial unique index: at most one pending marker per Mission (coalescing).
CREATE UNIQUE INDEX IF NOT EXISTS uq_mission_recalc_markers_pending
  ON mission_recalculation_markers (mission_id)
  WHERE state = 'pending';
--> statement-breakpoint

-- 7. Scheduled occurrences (Story-3 consumer; forward-compatible storage now)
CREATE TABLE IF NOT EXISTS scheduled_occurrences (
  id TEXT PRIMARY KEY NOT NULL,
  scheduled_task_id TEXT NOT NULL,
  scheduled_for TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  schedule_revision TEXT,
  state TEXT NOT NULL DEFAULT 'reserved',
  attempt_id TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_mission_id TEXT,
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS uq_scheduled_occurrences_schedule_due
  ON scheduled_occurrences (scheduled_task_id, scheduled_for);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scheduled_occurrences_state
  ON scheduled_occurrences (state);
--> statement-breakpoint

-- 8. Task creation-integrity versioning (Legacy Partial History)
-- 0 = pre-cutover Task (observation-gate-open). Additive: existing rows
-- default to 0; no write path changes. No backfill of synthetic events.
ALTER TABLE tasks ADD COLUMN creation_integrity INTEGER NOT NULL DEFAULT 0;
