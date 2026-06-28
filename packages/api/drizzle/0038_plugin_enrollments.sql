CREATE TABLE plugin_enrollments (
  `id` text PRIMARY KEY NOT NULL,
  `habitat_id` text NOT NULL,
  `plugin_id` text NOT NULL,
  `contribution_id` text NOT NULL,
  `contribution_kind` text NOT NULL,
  `enabled` integer DEFAULT 0 NOT NULL,
  `config` text,
  `enrolled_by` text NOT NULL,
  `enrolled_at` text NOT NULL,
  `updated_at` text NOT NULL,
  `disabled_at` text,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_plugin_enrollments_unique ON plugin_enrollments (`habitat_id`, `plugin_id`, `contribution_id`);
--> statement-breakpoint
CREATE INDEX idx_plugin_enrollments_habitat ON plugin_enrollments (`habitat_id`, `enabled`);
--> statement-breakpoint
CREATE INDEX idx_plugin_enrollments_plugin ON plugin_enrollments (`plugin_id`);
