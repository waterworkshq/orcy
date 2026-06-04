PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `mission_events_new` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL,
  `actor_type` text NOT NULL,
  `actor_id` text NOT NULL,
  `action` text NOT NULL,
  `from_column_id` text,
  `to_column_id` text,
  `from_status` text,
  `to_status` text,
  `metadata` text NOT NULL DEFAULT '{}',
  `timestamp` text DEFAULT '(datetime(''now''))' NOT NULL
);--> statement-breakpoint
INSERT INTO `mission_events_new` (`id`, `mission_id`, `actor_type`, `actor_id`, `action`, `from_column_id`, `to_column_id`, `from_status`, `to_status`, `metadata`, `timestamp`)
SELECT `id`, `mission_id`, `actor_type`, `actor_id`, `action`, `from_column_id`, `to_column_id`, `from_status`, `to_status`, `metadata`, `timestamp`
FROM `mission_events`;--> statement-breakpoint
DROP TABLE `mission_events`;--> statement-breakpoint
ALTER TABLE `mission_events_new` RENAME TO `mission_events`;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mission_events_feature` ON `mission_events` (`mission_id`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_mission_events_timestamp` ON `mission_events` (`timestamp`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
