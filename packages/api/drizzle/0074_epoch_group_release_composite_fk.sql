-- Composite foreign key on release_activation_epoch_groups: a group's
-- (epoch_id, release_id) pair must match the epoch's own release. The two
-- foreign keys were independent, so a group could pair an epoch from one
-- Release with another Release's id and reconcile into the wrong release
-- context. Write paths already pass both ids from one bootstrap; this is
-- schema-level defense in depth. The copy re-derives release_id from the
-- epoch, so any mismatched pair is repaired instead of aborting the rebuild.
--
-- Do not edit 0067; this is its additive successor.

-- Parent side: UNIQUE (id, release_id) so the composite FK can reference it.
CREATE UNIQUE INDEX IF NOT EXISTS idx_release_epochs_id_release
  ON release_activation_epochs(id, release_id);
--> statement-breakpoint

CREATE TABLE release_activation_epoch_groups_0074 (
  id TEXT PRIMARY KEY,
  epoch_id TEXT NOT NULL,
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
  FOREIGN KEY (epoch_id, release_id)
    REFERENCES release_activation_epochs(id, release_id) ON DELETE CASCADE
);
--> statement-breakpoint

-- Preserve orphaned group rows instead of silently dropping them: archive
-- every row whose (epoch, release) pair cannot satisfy the replacement
-- foreign keys — a missing epoch, OR an epoch whose own release row is gone
-- (only possible where foreign-key enforcement was off historically). The
-- join below filters them out before the DROP; leaving the release-orphaned
-- shape unarchived would abort the rebuild on the release foreign key.
-- Normally empty; anything it captures needs explicit remediation.
CREATE TABLE IF NOT EXISTS release_activation_epoch_groups_orphans_0074 AS
SELECT g.*
FROM release_activation_epoch_groups g
WHERE NOT EXISTS (
  SELECT 1 FROM release_activation_epochs e
  JOIN releases r ON r.id = e.release_id
  WHERE e.id = g.epoch_id
);
--> statement-breakpoint

INSERT INTO release_activation_epoch_groups_0074 (
  id, epoch_id, release_id, habitat_id, mission_id, mission_created_at, position,
  finding_ids, gate_type, gate_version, membership_digest, disposition,
  disposition_at, disposition_detail, activated_finding_count, created_at
)
SELECT
  g.id, g.epoch_id, e.release_id, g.habitat_id, g.mission_id, g.mission_created_at,
  g.position, g.finding_ids, g.gate_type, g.gate_version, g.membership_digest,
  g.disposition, g.disposition_at, g.disposition_detail, g.activated_finding_count,
  g.created_at
FROM release_activation_epoch_groups g
JOIN release_activation_epochs e ON e.id = g.epoch_id;
--> statement-breakpoint

DROP TABLE release_activation_epoch_groups;
--> statement-breakpoint

ALTER TABLE release_activation_epoch_groups_0074
  RENAME TO release_activation_epoch_groups;
--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS idx_release_epoch_groups_epoch_mission
  ON release_activation_epoch_groups(epoch_id, mission_id);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_release_epoch_groups_epoch
  ON release_activation_epoch_groups(epoch_id, position);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS idx_release_epoch_groups_disposition
  ON release_activation_epoch_groups(disposition);
