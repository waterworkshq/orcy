CREATE INDEX IF NOT EXISTS `idx_task_events_from_column_time` ON `task_events` (`from_column_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_events_to_column_time` ON `task_events` (`to_column_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_task_events_transition_time` ON `task_events` (`from_column_id`,`to_column_id`,`timestamp`);
