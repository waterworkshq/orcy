-- Durable Release projection deliveries + immutable activation epochs
-- (restored lifecycle T7). Additive only: no behavior change for existing
-- rows; pre-cutover releases simply never gain epoch/projection rows.

-- release_projection_deliveries: ONE durable delivery row per
-- (release, projection_kind). `pending` means retry on the next replay;
-- `completed` is final for that projection. `output_identity` records the
-- projection-specific output (epoch summary / notification event id / pulse
-- id / inbox id) so replay distinguishes already-delivered from reserved.
CREATE TABLE IF NOT EXISTS release_projection_deliveries (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  projection_kind TEXT NOT NULL CHECK (projection_kind IN (
    'activation_reconciliation',
    'deadline_notification',
    'activation_notification',
    'retrospective_pulse',
    'release_shipped'
  )),
  state TEXT NOT NULL CHECK (state IN ('pending', 'completed')),
  idempotency_key TEXT NOT NULL,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  output_identity TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (release_id, projection_kind)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_release_projection_state
  ON release_projection_deliveries(state);
--> statement-breakpoint

-- release_activation_epochs: exactly ONE immutable epoch per Release, created
-- atomically with the Release + projection rows. Freezes the configured
-- Finding-count cap (NULL = unlimited) and the epoch-wide eligibility digest.
-- `completed_at` means the frozen epoch is FINAL and never reopens.
CREATE TABLE IF NOT EXISTS release_activation_epochs (
  id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL UNIQUE REFERENCES releases(id) ON DELETE CASCADE,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  frozen_cap INTEGER,
  auto_promote_enabled INTEGER NOT NULL DEFAULT 1,
  eligibility_digest TEXT NOT NULL,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_release_epochs_habitat
  ON release_activation_epochs(habitat_id);
--> statement-breakpoint

-- release_activation_epoch_groups: immutable frozen Mission groups. Ordered
-- deterministically (position; ordered by mission createdAt then id at
-- freeze). `finding_ids` is the exact frozen Finding membership (JSON array).
-- `disposition` is the per-group reconciliation outcome; it only ever moves
-- pending -> terminal (activated / deferred_*); terminal dispositions and
-- `activated_finding_count` attribution are immutable.
CREATE TABLE IF NOT EXISTS release_activation_epoch_groups (
  id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL REFERENCES release_activation_epochs(id) ON DELETE CASCADE,
  release_id TEXT NOT NULL REFERENCES releases(id) ON DELETE CASCADE,
  habitat_id TEXT NOT NULL,
  mission_id TEXT NOT NULL,
  mission_created_at TEXT NOT NULL,
  position INTEGER NOT NULL,
  finding_ids TEXT NOT NULL,
  gate_type TEXT,
  gate_version TEXT,
  membership_digest TEXT NOT NULL,
  disposition TEXT NOT NULL DEFAULT 'pending'
    CHECK (disposition IN ('pending', 'activated', 'deferred_changed', 'deferred_oversized', 'deferred_budget')),
  disposition_at TEXT,
  disposition_detail TEXT,
  activated_finding_count INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (epoch_id, mission_id)
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_release_epoch_groups_epoch
  ON release_activation_epoch_groups(epoch_id, position);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_release_epoch_groups_disposition
  ON release_activation_epoch_groups(disposition);
