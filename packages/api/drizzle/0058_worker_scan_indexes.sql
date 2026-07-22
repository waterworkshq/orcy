-- Worker scan composite indexes (release-review D5-3 + D5-4).
-- The dispatch worker filters state + orders by reserved_at; the recovery
-- worker filters state + lease_expires_at. Single-column state indexes force
-- a full-state-partition scan + temp B-tree sort every polling tick.

CREATE INDEX IF NOT EXISTS idx_task_creation_attempts_state_reserved
  ON task_creation_attempts (state, reserved_at);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_scheduled_occurrences_state_lease
  ON scheduled_occurrences (state, lease_expires_at);
