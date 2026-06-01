-- Add self-referencing FK constraint on effort_entries.corrects_entry_id
-- SQLite doesn't support ALTER TABLE ADD CONSTRAINT, so we use the
-- table-rebuild pattern: create new table with FK, copy data, swap.
PRAGMA defer_foreign_keys = ON;
--> statement-breakpoint

CREATE TABLE `effort_entries_new` (
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
  `corrects_entry_id` text REFERENCES `effort_entries`(`id`) ON UPDATE no action ON DELETE set null,
  `correction_reason` text,
  `metadata` text,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

INSERT INTO `effort_entries_new` (
  `id`, `task_id`, `actor_type`, `actor_id`, `minutes`, `source`,
  `note`, `started_at`, `ended_at`, `recorded_at`,
  `corrects_entry_id`, `correction_reason`, `metadata`
)
SELECT
  `id`, `task_id`, `actor_type`, `actor_id`, `minutes`, `source`,
  `note`, `started_at`, `ended_at`, `recorded_at`,
  `corrects_entry_id`, `correction_reason`, `metadata`
FROM `effort_entries`;
--> statement-breakpoint

DROP TABLE `effort_entries`;
--> statement-breakpoint

ALTER TABLE `effort_entries_new` RENAME TO `effort_entries`;
--> statement-breakpoint

CREATE INDEX `idx_effort_entries_task` ON `effort_entries` (`task_id`);
--> statement-breakpoint

CREATE INDEX `idx_effort_entries_actor` ON `effort_entries` (`actor_type`,`actor_id`);
--> statement-breakpoint

CREATE INDEX `idx_effort_entries_source` ON `effort_entries` (`source`);
--> statement-breakpoint

CREATE INDEX `idx_effort_entries_corrects` ON `effort_entries` (`corrects_entry_id`);

-- Indexes on FK columns in pull_requests and pipeline_events
-- These were added in 0018 without indexes; now backfilling the missing indexes
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_pull_requests_task_id` ON `pull_requests` (`task_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_pull_requests_repository_id` ON `pull_requests` (`repository_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_pull_requests_branch_id` ON `pull_requests` (`branch_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_pipeline_events_task_id` ON `pipeline_events` (`task_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_pipeline_events_repository_id` ON `pipeline_events` (`repository_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_pipeline_events_commit_id` ON `pipeline_events` (`commit_id`);

-- Indexes for code_evidence_links audit/filtering by who linked
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_code_evidence_links_linked_by` ON `code_evidence_links` (`linked_by_type`, `linked_by_id`);

-- Indexes for code_evidence_gaps filtering by reporter
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_code_evidence_gaps_reported_by` ON `code_evidence_gaps` (`reported_by_type`, `reported_by_id`);
