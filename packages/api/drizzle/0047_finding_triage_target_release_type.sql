-- v0.24.0 "Cadence": target_release_type column for semver-type-targeted deferrals (ADR-0029).
ALTER TABLE finding_triage ADD COLUMN target_release_type TEXT;
