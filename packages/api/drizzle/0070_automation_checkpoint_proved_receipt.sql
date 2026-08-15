-- Additive CHECK on automation_delivery_action_checkpoints: a `proved` row
-- must carry both a receipt and proved_at. SQLite cannot ALTER TABLE ADD CHECK,
-- so the table is rebuilt. Dirty rows (proved with a null receipt or proved_at)
-- are coerced to `failed` before copy so the rebuild cannot abort on history.
--
-- Do not edit 0066; this is the post-enforcement additive successor.

UPDATE automation_delivery_action_checkpoints
SET state = 'failed',
    proved_at = NULL,
    terminal_disposition = COALESCE(terminal_disposition, 'failed:missing_receipt')
WHERE state = 'proved' AND (receipt IS NULL OR proved_at IS NULL);
--> statement-breakpoint

CREATE TABLE automation_delivery_action_checkpoints_0070 (
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
  UNIQUE (delivery_id, action_index),
  CHECK ((state != 'proved') OR (receipt IS NOT NULL AND proved_at IS NOT NULL))
);
--> statement-breakpoint

INSERT INTO automation_delivery_action_checkpoints_0070 (
  id, delivery_id, action_index, action_key, action_type, idempotency_key,
  state, receipt, terminal_disposition, predecessor_checkpoint_id,
  created_at, updated_at, proved_at
)
SELECT
  id, delivery_id, action_index, action_key, action_type, idempotency_key,
  state, receipt, terminal_disposition, predecessor_checkpoint_id,
  created_at, updated_at, proved_at
FROM automation_delivery_action_checkpoints;
--> statement-breakpoint

DROP TABLE automation_delivery_action_checkpoints;
--> statement-breakpoint

ALTER TABLE automation_delivery_action_checkpoints_0070
  RENAME TO automation_delivery_action_checkpoints;
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_automation_delivery_checkpoints_delivery
  ON automation_delivery_action_checkpoints(delivery_id, action_index);
