CREATE TABLE `effort_entries` (
  `id` text PRIMARY KEY NOT NULL,
  `task_id` text NOT NULL,
  `actor_type` text NOT NULL,
  `actor_id` text,
  `minutes` integer NOT NULL,
  `source` text NOT NULL,
  `note` text,
  `started_at` text,
  `ended_at` text,
  `recorded_at` text NOT NULL DEFAULT (datetime('now')),
  `corrects_entry_id` text,
  `correction_reason` text,
  `metadata` text,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_effort_entries_task` ON `effort_entries` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_effort_entries_actor` ON `effort_entries` (`actor_type`,`actor_id`);
--> statement-breakpoint
CREATE INDEX `idx_effort_entries_source` ON `effort_entries` (`source`);
--> statement-breakpoint
CREATE INDEX `idx_effort_entries_corrects` ON `effort_entries` (`corrects_entry_id`);
