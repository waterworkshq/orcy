CREATE TABLE `audit_export_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`filters` text NOT NULL,
	`schedule` text NOT NULL,
	`destination` text DEFAULT 'local' NOT NULL,
	`destination_config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`next_run_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_audit_schedules_board` ON `audit_export_schedules` (`board_id`);--> statement-breakpoint
CREATE INDEX `idx_audit_schedules_next` ON `audit_export_schedules` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `board_health_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`score` integer NOT NULL,
	`grade` text NOT NULL,
	`dimensions` text NOT NULL,
	`metrics` text NOT NULL,
	`recommendations` text DEFAULT '[]' NOT NULL,
	`snapshot_at` text DEFAULT (datetime('now')) NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_health_snapshots_board` ON `board_health_snapshots` (`board_id`);--> statement-breakpoint
CREATE INDEX `idx_health_snapshots_time` ON `board_health_snapshots` (`board_id`,`snapshot_at`);--> statement-breakpoint
CREATE TABLE `feature_comment_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`mentioned_type` text NOT NULL,
	`mentioned_id` text NOT NULL,
	`mention_text` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `feature_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_feature_mentions_comment_id` ON `feature_comment_mentions` (`comment_id`);--> statement-breakpoint
CREATE INDEX `idx_feature_mentions_target` ON `feature_comment_mentions` (`mentioned_type`,`mentioned_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_feature_mentions_unique` ON `feature_comment_mentions` (`comment_id`,`mentioned_type`,`mentioned_id`,`mention_text`);--> statement-breakpoint
CREATE TABLE `feature_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`feature_id` text NOT NULL,
	`parent_id` text,
	`author_type` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`feature_id`) REFERENCES `features`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `feature_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_feature_comments_feature_id` ON `feature_comments` (`feature_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_feature_comments_parent` ON `feature_comments` (`parent_id`);--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`template_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`schedule_type` text NOT NULL,
	`cron_expression` text,
	`interval_minutes` integer,
	`scheduled_at` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`feature_title` text NOT NULL,
	`feature_description` text DEFAULT '' NOT NULL,
	`feature_priority` text DEFAULT 'medium' NOT NULL,
	`feature_labels` text NOT NULL,
	`feature_domain` text,
	`tasks_template` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`next_run_at` text NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_created_feature_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `feature_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_board` ON `scheduled_tasks` (`board_id`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_next` ON `scheduled_tasks` (`next_run_at`);--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_enabled` ON `scheduled_tasks` (`enabled`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_task_watchers` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_task_watchers`("task_id", "user_id", "created_at") SELECT "task_id", "user_id", "created_at" FROM `task_watchers`;--> statement-breakpoint
DROP TABLE `task_watchers`;--> statement-breakpoint
ALTER TABLE `__new_task_watchers` RENAME TO `task_watchers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_task_watchers_user_id` ON `task_watchers` (`user_id`);--> statement-breakpoint
CREATE TABLE `__new_project_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`board_id` text NOT NULL,
	`source_pulse_id` text,
	`source_mission` text,
	`signal_type` text NOT NULL,
	`subject` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`relevance_tags` text NOT NULL,
	`promoted_by` text NOT NULL,
	`promoted_at` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_pulse_id`) REFERENCES `pulses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
INSERT INTO `__new_project_insights`("id", "board_id", "source_pulse_id", "source_mission", "signal_type", "subject", "body", "relevance_tags", "promoted_by", "promoted_at", "is_active", "created_at") SELECT "id", "board_id", "source_pulse_id", "source_mission", "signal_type", "subject", "body", "relevance_tags", "promoted_by", "promoted_at", "is_active", "created_at" FROM `project_insights`;--> statement-breakpoint
DROP TABLE `project_insights`;--> statement-breakpoint
ALTER TABLE `__new_project_insights` RENAME TO `project_insights`;--> statement-breakpoint
CREATE INDEX `idx_insights_board` ON `project_insights` (`board_id`);--> statement-breakpoint
CREATE INDEX `idx_insights_active` ON `project_insights` (`is_active`);--> statement-breakpoint
CREATE INDEX `idx_insights_type` ON `project_insights` (`signal_type`);--> statement-breakpoint
CREATE TABLE `__new_pulse_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`pulse_id` text NOT NULL,
	`reactor_type` text NOT NULL,
	`reactor_id` text NOT NULL,
	`reaction` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`pulse_id`) REFERENCES `pulses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
INSERT INTO `__new_pulse_reactions`("id", "pulse_id", "reactor_type", "reactor_id", "reaction", "created_at") SELECT "id", "pulse_id", "reactor_type", "reactor_id", "reaction", "created_at" FROM `pulse_reactions`;--> statement-breakpoint
DROP TABLE `pulse_reactions`;--> statement-breakpoint
ALTER TABLE `__new_pulse_reactions` RENAME TO `pulse_reactions`;--> statement-breakpoint
CREATE INDEX `idx_reactions_pulse` ON `pulse_reactions` (`pulse_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reactions_unique` ON `pulse_reactions` (`pulse_id`,`reactor_type`,`reactor_id`,`reaction`);--> statement-breakpoint
ALTER TABLE `boards` ADD `prioritization_settings` text;--> statement-breakpoint
CREATE INDEX `idx_features_sla_deadline_at` ON `features` (`sla_deadline_at`);--> statement-breakpoint
CREATE INDEX `idx_pulses_thread` ON `pulses` (`reply_to_id`,`created_at`);