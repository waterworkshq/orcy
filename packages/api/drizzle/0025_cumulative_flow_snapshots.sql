CREATE TABLE IF NOT EXISTS `cumulative_flow_snapshots` (
  `id` text PRIMARY KEY NOT NULL,
  `habitat_id` text NOT NULL,
  `snapshot_date` text NOT NULL,
  `counts_by_column` text NOT NULL DEFAULT '{}',
  `counts_by_status` text NOT NULL DEFAULT '{}',
  `source` text DEFAULT 'generated' NOT NULL,
  `completeness` text DEFAULT 'complete' NOT NULL,
  `warnings` text NOT NULL DEFAULT '[]',
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `idx_cumulative_flow_snapshot_unique` ON `cumulative_flow_snapshots` (`habitat_id`,`snapshot_date`);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `idx_cumulative_flow_snapshots_habitat_date` ON `cumulative_flow_snapshots` (`habitat_id`,`snapshot_date`);
