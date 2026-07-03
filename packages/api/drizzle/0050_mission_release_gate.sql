-- v0.25.0 "Roadmap Activation": release-gate columns on missions (ADR-0032).
-- A mission with a release-gate is blocked from claiming until a matching release ships.
ALTER TABLE missions ADD COLUMN release_gate_type TEXT;
ALTER TABLE missions ADD COLUMN release_gate_version TEXT;
