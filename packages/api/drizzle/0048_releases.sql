-- v0.24.0 "Cadence": releases table for release detection + classification (ADR-0030).
CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY NOT NULL,
  habitat_id TEXT NOT NULL REFERENCES habitats(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  release_type TEXT NOT NULL,
  detected_by TEXT NOT NULL,
  release_notes TEXT,
  detected_at TEXT NOT NULL DEFAULT (datetime('now')),
  metadata TEXT NOT NULL DEFAULT '{}'
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_releases_habitat_version ON releases(habitat_id, version);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_releases_habitat_detected ON releases(habitat_id, detected_at);
