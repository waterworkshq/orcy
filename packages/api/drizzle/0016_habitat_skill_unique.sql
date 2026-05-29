CREATE UNIQUE INDEX IF NOT EXISTS idx_habitat_skills_habitat_unique ON habitat_skills (`habitat_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS idx_hskill_signals_habitat_cluster_unique ON habitat_skill_signals (`habitat_id`,`cluster_key`);
