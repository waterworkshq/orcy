CREATE TABLE `notification_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`recipient_type` text NOT NULL,
	`recipient_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`channels` text NOT NULL,
	`delivered_at` text,
	`acknowledged_at` text,
	`snoozed_until` text,
	`muted_at` text,
	`cleared_at` text,
	`clear_after` text,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_recipient_active` ON `notification_deliveries` (`habitat_id`,`recipient_type`,`recipient_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_event` ON `notification_deliveries` (`event_id`);--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_clearance` ON `notification_deliveries` (`habitat_id`,`clear_after`,`status`);--> statement-breakpoint
CREATE TABLE `notification_delivery_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`channel` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`status_code` integer,
	`error` text,
	`response_body` text,
	`next_retry_at` text,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`finished_at` text,
	FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notification_attempts_delivery` ON `notification_delivery_attempts` (`delivery_id`);--> statement-breakpoint
CREATE INDEX `idx_notification_attempts_retry` ON `notification_delivery_attempts` (`channel`,`status`,`next_retry_at`);--> statement-breakpoint
CREATE TABLE `notification_digest_items` (
	`id` text PRIMARY KEY NOT NULL,
	`digest_event_id` text NOT NULL,
	`included_event_id` text NOT NULL,
	`included_delivery_id` text,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`digest_event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`included_event_id`) REFERENCES `notification_events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`included_delivery_id`) REFERENCES `notification_deliveries`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `notification_events` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`event_type` text NOT NULL,
	`source_type` text NOT NULL,
	`source_id` text,
	`target_type` text,
	`target_id` text,
	`severity` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`payload` text NOT NULL,
	`created_by_type` text NOT NULL,
	`created_by_id` text,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`history_summary` text,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notification_events_habitat_created` ON `notification_events` (`habitat_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_notification_events_type` ON `notification_events` (`habitat_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `idx_notification_events_source` ON `notification_events` (`source_type`,`source_id`);--> statement-breakpoint
CREATE TABLE `notification_retention_policies` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`acknowledged_clear_after_days` integer DEFAULT 30 NOT NULL,
	`resolved_clear_after_days` integer DEFAULT 30 NOT NULL,
	`failed_clear_after_days` integer DEFAULT 90 NOT NULL,
	`history_summary_retention_days` integer,
	`updated_by` text,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notification_retention_habitat` ON `notification_retention_policies` (`habitat_id`);--> statement-breakpoint
CREATE TABLE `notification_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`scope` text NOT NULL,
	`recipient_type` text,
	`recipient_id` text,
	`event_type` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`required` integer DEFAULT false NOT NULL,
	`channels` text NOT NULL,
	`cadence` text DEFAULT 'immediate' NOT NULL,
	`timezone` text,
	`local_send_time` text,
	`mute_until` text,
	`created_by` text,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_notification_subscriptions_habitat` ON `notification_subscriptions` (`habitat_id`,`event_type`);--> statement-breakpoint
CREATE INDEX `idx_notification_subscriptions_recipient` ON `notification_subscriptions` (`habitat_id`,`recipient_type`,`recipient_id`);