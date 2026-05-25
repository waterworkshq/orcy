CREATE TABLE integration_connections (
  `id` text PRIMARY KEY NOT NULL,
  `habitat_id` text NOT NULL,
  `provider` text NOT NULL,
  `name` text NOT NULL,
  `auth_method` text NOT NULL,
  `access_token` text,
  `refresh_token` text,
  `token_expires_at` text,
  `external_account_id` text,
  `external_account_name` text,
  `external_tenant_id` text,
  `external_tenant_name` text,
  `external_base_url` text,
  `repository_owner` text,
  `repository_name` text,
  `project_key` text,
  `team_id` text,
  `provider_config` text DEFAULT '{}',
  `enabled` integer DEFAULT 1 NOT NULL,
  `pull_enabled` integer DEFAULT 1 NOT NULL,
  `auto_import` integer DEFAULT 0 NOT NULL,
  `webhook_secret` text,
  `webhook_external_id` text,
  `last_sync_at` text,
  `last_sync_status` text DEFAULT 'never' NOT NULL,
  `last_sync_error` text,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX idx_integration_connections_habitat ON integration_connections (`habitat_id`);
--> statement-breakpoint
CREATE INDEX idx_integration_connections_provider ON integration_connections (`provider`);
--> statement-breakpoint
CREATE INDEX idx_integration_connections_enabled ON integration_connections (`enabled`);
--> statement-breakpoint
CREATE TABLE external_intake_candidates (
  `id` text PRIMARY KEY NOT NULL,
  `connection_id` text NOT NULL,
  `habitat_id` text NOT NULL,
  `provider` text NOT NULL,
  `external_id` text NOT NULL,
  `external_key` text NOT NULL,
  `external_url` text NOT NULL,
  `source_kind` text,
  `source_status` text,
  `source_priority` text,
  `source_assignees` text DEFAULT '[]',
  `source_reporter` text,
  `source_labels` text DEFAULT '[]',
  `source_title` text NOT NULL,
  `source_body` text,
  `normalized_summary` text,
  `recommended_mission_title` text,
  `recommended_mission_description` text,
  `review_status` text DEFAULT 'new' NOT NULL,
  `promoted_mission_id` text,
  `raw_provider_payload` text,
  `external_updated_at` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`promoted_mission_id`) REFERENCES `missions`(`id`) ON DELETE set null ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX idx_external_intake_candidates_connection ON external_intake_candidates (`connection_id`);
--> statement-breakpoint
CREATE INDEX idx_external_intake_candidates_habitat ON external_intake_candidates (`habitat_id`);
--> statement-breakpoint
CREATE INDEX idx_external_intake_candidates_review_status ON external_intake_candidates (`review_status`);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_external_intake_candidates_connection_external ON external_intake_candidates (`connection_id`,`external_id`);
--> statement-breakpoint
CREATE TABLE external_issue_links (
  `id` text PRIMARY KEY NOT NULL,
  `connection_id` text NOT NULL,
  `habitat_id` text NOT NULL,
  `mission_id` text NOT NULL,
  `provider` text NOT NULL,
  `external_id` text NOT NULL,
  `external_key` text NOT NULL,
  `external_url` text NOT NULL,
  `external_status` text NOT NULL,
  `external_updated_at` text,
  `provider_labels` text DEFAULT '[]',
  `last_synced_at` text,
  `sync_status` text DEFAULT 'synced' NOT NULL,
  `sync_warning` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX idx_external_issue_links_connection ON external_issue_links (`connection_id`);
--> statement-breakpoint
CREATE INDEX idx_external_issue_links_habitat ON external_issue_links (`habitat_id`);
--> statement-breakpoint
CREATE INDEX idx_external_issue_links_mission ON external_issue_links (`mission_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_external_issue_links_provider_external ON external_issue_links (`provider`,`external_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_external_issue_links_connection_external ON external_issue_links (`connection_id`,`external_id`);
--> statement-breakpoint
CREATE TABLE integration_sync_runs (
  `id` text PRIMARY KEY NOT NULL,
  `connection_id` text NOT NULL,
  `habitat_id` text NOT NULL,
  `trigger` text NOT NULL,
  `status` text NOT NULL,
  `started_at` text NOT NULL,
  `finished_at` text,
  `created_count` integer DEFAULT 0 NOT NULL,
  `updated_count` integer DEFAULT 0 NOT NULL,
  `skipped_count` integer DEFAULT 0 NOT NULL,
  `failed_count` integer DEFAULT 0 NOT NULL,
  `error` text,
  FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX idx_integration_sync_runs_connection ON integration_sync_runs (`connection_id`);
--> statement-breakpoint
CREATE INDEX idx_integration_sync_runs_habitat ON integration_sync_runs (`habitat_id`);
--> statement-breakpoint
CREATE INDEX idx_integration_sync_runs_started ON integration_sync_runs (`started_at`);
