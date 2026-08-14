-- Immutable executable Automation rule revisions + release.shipped event inbox,
-- per-rule-generation deliveries, ordered action checkpoints, and operator
-- disposition ledger.
--
-- Every rule mutation creates an immutable revision containing the complete
-- executable intent (trigger/condition/actions/enabled/limits). Revisions are
-- deliberately NOT foreign-keyed to automation_rules: deleting the live rule
-- must not delete revisions referenced by delivery history (the existing
-- automation_rule_runs.rule_id FK stays untouched — cascade behavior for the
-- live-rule run log is unchanged; the delivery/checkpoint tables below are the
-- durable history for the release path).
--
-- Additive only — no behavior changes to existing tables, no restrictive
-- enforcement on pre-existing data.

-- automation_rule_revisions: immutable executable snapshots of a rule
CREATE TABLE IF NOT EXISTS automation_rule_revisions (
  id TEXT PRIMARY KEY,
  rule_id TEXT NOT NULL,
  habitat_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  enabled INTEGER NOT NULL,
  priority INTEGER NOT NULL DEFAULT 0,
  trigger TEXT NOT NULL,
  condition TEXT NOT NULL,
  actions TEXT NOT NULL,
  cooldown_seconds INTEGER NOT NULL DEFAULT 300,
  max_runs_per_hour INTEGER NOT NULL DEFAULT 30,
  digest TEXT NOT NULL,
  author_type TEXT NOT NULL,
  author_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rule_id, revision_number)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_rule_revisions_rule
  ON automation_rule_revisions(rule_id, revision_number);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_rule_revisions_habitat
  ON automation_rule_revisions(habitat_id);
--> statement-breakpoint

-- automation_event_inbox: unique (event_type, event_id) identity + immutable payload
CREATE TABLE IF NOT EXISTS automation_event_inbox (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_id TEXT NOT NULL,
  habitat_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'terminal')),
  admitted_at TEXT NOT NULL DEFAULT (datetime('now')),
  terminal_at TEXT,
  UNIQUE (event_type, event_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_event_inbox_habitat
  ON automation_event_inbox(habitat_id, state);
--> statement-breakpoint

-- automation_rule_deliveries: per (event, revision, generation) delivery rows.
-- Replaces the release path's reliance on (event_dedupe_key, rule_id) with
-- generation-aware identity while retaining stable event/rule lineage.
CREATE TABLE IF NOT EXISTS automation_rule_deliveries (
  id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL REFERENCES automation_event_inbox(id) ON DELETE CASCADE,
  rule_revision_id TEXT NOT NULL REFERENCES automation_rule_revisions(id),
  rule_id TEXT NOT NULL,
  habitat_id TEXT NOT NULL,
  event_dedupe_key TEXT NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  predecessor_delivery_id TEXT,
  retry_reason TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'leased', 'terminal', 'attention_required', 'waived')),
  lease_owner TEXT,
  lease_fence TEXT,
  lease_expires_at TEXT,
  automation_run_id TEXT,
  proof_classification TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  terminal_disposition TEXT,
  terminal_detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  terminal_at TEXT,
  UNIQUE (event_dedupe_key, rule_revision_id, generation)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_rule_deliveries_inbox
  ON automation_rule_deliveries(inbox_id, state);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_rule_deliveries_drain
  ON automation_rule_deliveries(state, lease_expires_at);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_rule_deliveries_rule
  ON automation_rule_deliveries(rule_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_rule_deliveries_predecessor
  ON automation_rule_deliveries(predecessor_delivery_id);
--> statement-breakpoint

-- automation_delivery_action_checkpoints: ordered per-action authoritative
-- checkpoints. `proved` rows carry a durable receipt and are never re-executed
-- (in this generation or any successor via predecessor carry-forward).
CREATE TABLE IF NOT EXISTS automation_delivery_action_checkpoints (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL REFERENCES automation_rule_deliveries(id) ON DELETE CASCADE,
  action_index INTEGER NOT NULL,
  action_key TEXT NOT NULL,
  action_type TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending', 'proved', 'failed')),
  receipt TEXT,
  terminal_disposition TEXT,
  predecessor_checkpoint_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  proved_at TEXT,
  UNIQUE (delivery_id, action_index)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_delivery_checkpoints_delivery
  ON automation_delivery_action_checkpoints(delivery_id, action_index);
--> statement-breakpoint

-- automation_delivery_dispositions: append-only operator audit ledger for
-- waive / risk-acknowledged successor-generation actions.
CREATE TABLE IF NOT EXISTS automation_delivery_dispositions (
  id TEXT PRIMARY KEY,
  delivery_id TEXT NOT NULL,
  inbox_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('waive', 'successor_generation')),
  actor_type TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_delivery_dispositions_delivery
  ON automation_delivery_dispositions(delivery_id);
