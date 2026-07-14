-- v0.25.3 "Release Window": release-deadline columns on missions (RM-1).
-- A mission with a release-deadline should complete before a matching release ships;
-- on release ship, missions not yet done trigger escalation (notification + retrospective).
-- The deadline does NOT block claiming — it is enforcement-on-miss, not a hard gate.
ALTER TABLE missions ADD COLUMN release_deadline_type TEXT;
--> statement-breakpoint
ALTER TABLE missions ADD COLUMN release_deadline_version TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_missions_habitat_deadline ON missions(habitat_id, release_deadline_type);
