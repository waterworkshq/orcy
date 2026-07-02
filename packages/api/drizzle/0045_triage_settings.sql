-- 0045: Add triage_settings JSON column to habitats for per-habitat scan thresholds.
ALTER TABLE habitats ADD COLUMN triage_settings TEXT;
