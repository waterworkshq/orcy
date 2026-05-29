CREATE TABLE habitat_skills (
  `id` text PRIMARY KEY NOT NULL,
  `habitat_id` text NOT NULL,
  `content` text DEFAULT '' NOT NULL,
  `signal_count` integer DEFAULT 0 NOT NULL,
  `avg_strength` real DEFAULT 0 NOT NULL,
  `last_generated_at` text DEFAULT (datetime('now')) NOT NULL,
  `generation_count` integer DEFAULT 1 NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX idx_habitat_skills_habitat ON habitat_skills (`habitat_id`);
--> statement-breakpoint
CREATE TABLE habitat_skill_signals (
  `id` text PRIMARY KEY NOT NULL,
  `habitat_id` text NOT NULL,
  `cluster_key` text NOT NULL,
  `skill_category` text NOT NULL,
  `source_signal_type` text NOT NULL,
  `source_type` text DEFAULT 'pulse' NOT NULL,
  `subject` text NOT NULL,
  `summary` text,
  `strength` real DEFAULT 0.1 NOT NULL,
  `frequency` integer DEFAULT 1 NOT NULL,
  `corroborating_agents` integer DEFAULT 1 NOT NULL,
  `cross_mission_count` integer DEFAULT 0 NOT NULL,
  `successful_tasks` integer DEFAULT 0 NOT NULL,
  `failed_tasks` integer DEFAULT 0 NOT NULL,
  `last_seen_at` text NOT NULL,
  `first_seen_at` text NOT NULL,
  `source_pulse_ids` text,
  `source_task_ids` text,
  `source_comment_ids` text,
  `corroborating_agent_ids` text,
  `promoted_to_skill` integer DEFAULT 0 NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX idx_hskill_signals_habitat ON habitat_skill_signals (`habitat_id`);
--> statement-breakpoint
CREATE INDEX idx_hskill_signals_cluster ON habitat_skill_signals (`cluster_key`);
--> statement-breakpoint
CREATE INDEX idx_hskill_signals_category ON habitat_skill_signals (`skill_category`);
--> statement-breakpoint
CREATE INDEX idx_hskill_signals_strength ON habitat_skill_signals (`strength`);
--> statement-breakpoint
CREATE INDEX idx_hskill_signals_promoted ON habitat_skill_signals (`promoted_to_skill`);
--> statement-breakpoint
CREATE INDEX idx_hskill_signals_habitat_cluster ON habitat_skill_signals (`habitat_id`,`cluster_key`);
--> statement-breakpoint
CREATE INDEX idx_hskill_signals_habitat_cat_promoted ON habitat_skill_signals (`habitat_id`,`skill_category`,`promoted_to_skill`);
