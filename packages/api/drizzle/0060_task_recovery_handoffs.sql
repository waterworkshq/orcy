CREATE TABLE task_recovery_handoffs (
  id TEXT PRIMARY KEY,
  gate_id TEXT NOT NULL REFERENCES task_workflow_gates(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  habitat_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  downstream_task_id TEXT NOT NULL,
  recovery_depth INTEGER NOT NULL,
  trigger_event_id TEXT NOT NULL,
  frozen_handler_config TEXT NOT NULL,
  handler_fingerprint TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'expected',
  blocked_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  consumed_at TEXT
);
--> statement-breakpoint
CREATE INDEX idx_task_recovery_handoffs_status
  ON task_recovery_handoffs (status);
--> statement-breakpoint
CREATE INDEX idx_task_recovery_handoffs_gate
  ON task_recovery_handoffs (gate_id);
