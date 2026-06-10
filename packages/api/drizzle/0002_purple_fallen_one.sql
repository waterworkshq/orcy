CREATE TABLE `automation_rule_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`rule_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`trigger_type` text NOT NULL,
	`trigger_event_id` text,
	`target_type` text,
	`target_id` text,
	`fingerprint` text NOT NULL,
	`status` text NOT NULL,
	`skip_reason` text,
	`condition_result` text,
	`action_results` text,
	`metadata` text,
	`started_at` text NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`rule_id`) REFERENCES `automation_rules`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_automation_runs_rule` ON `automation_rule_runs` (`rule_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_automation_runs_habitat` ON `automation_rule_runs` (`habitat_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_automation_runs_fingerprint` ON `automation_rule_runs` (`fingerprint`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_automation_runs_status` ON `automation_rule_runs` (`habitat_id`,`status`);--> statement-breakpoint
CREATE TABLE `automation_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`trigger` text NOT NULL,
	`condition` text NOT NULL,
	`actions` text NOT NULL,
	`cooldown_seconds` integer DEFAULT 300 NOT NULL,
	`max_runs_per_hour` integer DEFAULT 30 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`last_run_at` text,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_automation_rules_habitat` ON `automation_rules` (`habitat_id`);--> statement-breakpoint
CREATE INDEX `idx_automation_rules_enabled` ON `automation_rules` (`habitat_id`,`enabled`);--> statement-breakpoint
CREATE INDEX `idx_automation_rules_priority` ON `automation_rules` (`habitat_id`,`priority`);