-- Durable Automation run-completion outbox (FU2).
--
-- Makes the rule-run completion notification (previously the in-memory
-- `notifyAutomationRunCompleted` subscriber hook on the frozen-revision
-- delivery path) crash-recoverable. A terminal delivery bundle writes ONE
-- outbox row in the SAME immediate transaction that terminalizes the
-- delivery + run + inbox, so a crash can never leave the delivery terminal,
-- the run `running`, and the inbox `pending` with the completion lost.
-- A drain/boot pass reads undelivered rows, invokes the completion hooks,
-- and marks them delivered (retry on next drain/boot).
--
-- Dedup: UNIQUE(run_id) — exactly one completion per rule run. The terminal
-- bundle only writes the row when it owns the run's running->terminal
-- transition; `INSERT OR IGNORE` makes a replay write a no-op.
--
-- FK with ON DELETE CASCADE: when the live rule (and its run rows) are
-- deleted, a pending outbox row self-cleanes — there is nothing left to
-- notify about.
--
-- Additive only. No behavior change to existing tables.

CREATE TABLE IF NOT EXISTS automation_run_completion_outbox (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES automation_rule_runs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  habitat_id TEXT NOT NULL,
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  delivered_at TEXT,
  delivery_attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  UNIQUE (run_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_completion_outbox_undelivered
  ON automation_run_completion_outbox(delivered_at);
