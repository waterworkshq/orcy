-- v0.25.0 "Roadmap Activation": release-gate columns on missions (ADR-0032).
-- A mission with a release-gate is blocked from claiming until a matching release ships.
ALTER TABLE missions ADD COLUMN release_gate_type TEXT;
ALTER TABLE missions ADD COLUMN release_gate_version TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_missions_habitat_gate ON missions(habitat_id, release_gate_type);
