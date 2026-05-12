CREATE TABLE `project_insights` (
  `id` text PRIMARY KEY NOT NULL,
  `board_id` text NOT NULL,
  `source_pulse_id` text,
  `source_mission` text,
  `signal_type` text NOT NULL,
  `subject` text NOT NULL,
  `body` text DEFAULT '' NOT NULL,
  `relevance_tags` text NOT NULL DEFAULT '[]',
  `promoted_by` text NOT NULL,
  `promoted_at` text NOT NULL,
  `is_active` integer DEFAULT 1 NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`source_pulse_id`) REFERENCES `pulses`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `idx_insights_board` ON `project_insights` (`board_id`);
--> statement-breakpoint
CREATE INDEX `idx_insights_active` ON `project_insights` (`is_active`);
--> statement-breakpoint
CREATE INDEX `idx_insights_type` ON `project_insights` (`signal_type`);
