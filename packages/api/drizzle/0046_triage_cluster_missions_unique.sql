-- 0046: Partial unique index on triage_cluster_missions to prevent duplicate open junctions.
-- Only one open junction per (habitat_id, cluster_key) — resolved/wontfix records coexist.
CREATE UNIQUE INDEX IF NOT EXISTS uq_triage_cluster_missions_active
  ON triage_cluster_missions (habitat_id, cluster_key)
  WHERE status = 'open';
