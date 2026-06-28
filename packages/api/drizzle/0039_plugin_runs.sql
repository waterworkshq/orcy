CREATE TABLE plugin_runs (
  `id` text PRIMARY KEY NOT NULL,
  `habitat_id` text NOT NULL,
  `plugin_id` text NOT NULL,
  `contribution_id` text NOT NULL,
  `contribution_kind` text NOT NULL,
  `trigger_event_id` text,
  `trigger_type` text NOT NULL,
  `status` text NOT NULL,
  `fingerprint` text NOT NULL,
  `signals_emitted` integer,
  `error` text,
  `started_at` text NOT NULL,
  `finished_at` text,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX idx_plugin_runs_habitat_plugin ON plugin_runs (`habitat_id`, `plugin_id`, `started_at`);
--> statement-breakpoint
CREATE INDEX idx_plugin_runs_habitat_status ON plugin_runs (`habitat_id`, `status`, `started_at`);
