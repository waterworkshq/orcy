-- Migration: 0007_column_renames
-- Step 1: Rename tables
PRAGMA foreign_keys=OFF;

--> statement-breakpoint
ALTER TABLE `boards` RENAME TO `habitats`;

--> statement-breakpoint
ALTER TABLE `features` RENAME TO `missions`;

--> statement-breakpoint
ALTER TABLE `feature_dependencies` RENAME TO `mission_dependencies`;

--> statement-breakpoint
ALTER TABLE `feature_events` RENAME TO `mission_events`;

--> statement-breakpoint
ALTER TABLE `feature_watchers` RENAME TO `mission_watchers`;

--> statement-breakpoint
ALTER TABLE `feature_comments` RENAME TO `mission_comments`;

--> statement-breakpoint
ALTER TABLE `feature_comment_mentions` RENAME TO `mission_comment_mentions`;

--> statement-breakpoint
ALTER TABLE `feature_templates` RENAME TO `mission_templates`;

--> statement-breakpoint
ALTER TABLE `board_health_snapshots` RENAME TO `habitat_health_snapshots`;

--> statement-breakpoint
-- Step 2: Rename columns

--> statement-breakpoint
ALTER TABLE `missions` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `mission_dependencies` RENAME COLUMN `feature_id` TO `mission_id`;

--> statement-breakpoint
ALTER TABLE `mission_events` RENAME COLUMN `feature_id` TO `mission_id`;

--> statement-breakpoint
ALTER TABLE `mission_watchers` RENAME COLUMN `feature_id` TO `mission_id`;

--> statement-breakpoint
ALTER TABLE `mission_comments` RENAME COLUMN `feature_id` TO `mission_id`;

--> statement-breakpoint
ALTER TABLE `columns` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `mission_templates` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `saved_filters` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `chat_integrations` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `audit_export_schedules` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `scheduled_tasks` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `scheduled_tasks` RENAME COLUMN `last_created_feature_id` TO `last_created_mission_id`;

--> statement-breakpoint
ALTER TABLE `habitat_health_snapshots` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `tasks` RENAME COLUMN `feature_id` TO `mission_id`;

--> statement-breakpoint
ALTER TABLE `agent_messages` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `webhook_subscriptions` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `pulses` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `project_insights` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
ALTER TABLE `notification_preferences` RENAME COLUMN `board_id` TO `habitat_id`;

--> statement-breakpoint
-- Step 3: Rename indexes

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_features_board_column`;

--> statement-breakpoint
CREATE INDEX `idx_features_habitat_column` ON `missions` (`habitat_id`, `column_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_audit_schedules_board`;

--> statement-breakpoint
CREATE INDEX `idx_audit_schedules_habitat` ON `audit_export_schedules` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_columns_board_order`;

--> statement-breakpoint
CREATE INDEX `idx_columns_habitat_order` ON `columns` (`habitat_id`, `order`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_columns_board_id`;

--> statement-breakpoint
CREATE INDEX `idx_columns_habitat_id` ON `columns` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_templates_board`;

--> statement-breakpoint
CREATE INDEX `idx_templates_habitat` ON `mission_templates` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_health_snapshots_board`;

--> statement-breakpoint
CREATE INDEX `idx_health_snapshots_habitat` ON `habitat_health_snapshots` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_health_snapshots_time`;

--> statement-breakpoint
CREATE INDEX `idx_health_snapshots_time` ON `habitat_health_snapshots` (`habitat_id`, `snapshot_at`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_scheduled_tasks_board`;

--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_habitat` ON `scheduled_tasks` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_insights_board`;

--> statement-breakpoint
CREATE INDEX `idx_insights_habitat` ON `project_insights` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_chat_integrations_board`;

--> statement-breakpoint
CREATE INDEX `idx_chat_integrations_habitat` ON `chat_integrations` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_agent_messages_board`;

--> statement-breakpoint
CREATE INDEX `idx_agent_messages_habitat` ON `agent_messages` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_pulses_board`;

--> statement-breakpoint
CREATE INDEX `idx_pulses_habitat` ON `pulses` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_pulses_board_scope`;

--> statement-breakpoint
CREATE INDEX `idx_pulses_habitat_scope` ON `pulses` (`habitat_id`, `scope`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_webhook_subscriptions_board`;

--> statement-breakpoint
CREATE INDEX `idx_webhook_subscriptions_habitat` ON `webhook_subscriptions` (`habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_notif_prefs_user_board`;

--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notif_prefs_user_habitat` ON `notification_preferences` (`user_id`, `habitat_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_feature_events_feature`;

--> statement-breakpoint
CREATE INDEX `idx_feature_events_mission` ON `mission_events` (`mission_id`);

--> statement-breakpoint
DROP INDEX IF EXISTS `idx_feature_comments_feature_id`;

--> statement-breakpoint
CREATE INDEX `idx_feature_comments_mission_id` ON `mission_comments` (`mission_id`, `created_at`);

--> statement-breakpoint
PRAGMA foreign_keys=ON;