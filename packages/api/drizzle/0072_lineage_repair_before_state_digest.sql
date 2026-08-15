-- Additive column on finding_triage_lineage_repairs: the derived
-- before-state digest recorded when the repair was applied. Exact replay
-- verification previously RECONSTRUCTED the before-state from live rows,
-- so any post-repair mutation of a finding's status or evidence made an
-- otherwise-exact replay file conflict; replay now trusts the recorded
-- digest instead of mutable current state. Legacy rows (pre-0072) carry
-- NULL and keep the reconstruction path.
--
-- Do not edit 0064; this is its additive successor.

ALTER TABLE finding_triage_lineage_repairs
  ADD COLUMN before_state_digest TEXT;
