-- v0.24.0 "Cadence": per-habitat release activation settings (ADR-0031 kill switch).
ALTER TABLE habitats ADD COLUMN release_settings TEXT;
