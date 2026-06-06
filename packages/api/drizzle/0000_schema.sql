CREATE TABLE `agent_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`from_agent_id` text NOT NULL,
	`to_agent_id` text NOT NULL,
	`task_id` text,
	`subject` text NOT NULL,
	`body` text NOT NULL,
	`message_type` text DEFAULT 'info' NOT NULL,
	`priority` text DEFAULT 'normal' NOT NULL,
	`read_at` text,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `agents` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`domain` text NOT NULL,
	`capabilities` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`current_task_id` text,
	`api_key` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`last_heartbeat` text DEFAULT '(datetime(''now''))' NOT NULL,
	`metadata` text NOT NULL,
	`rate_limit_per_minute` integer
);
--> statement-breakpoint
CREATE TABLE `audit_export_schedules` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`name` text NOT NULL,
	`format` text NOT NULL,
	`filters` text NOT NULL,
	`schedule` text NOT NULL,
	`destination` text DEFAULT 'local' NOT NULL,
	`destination_config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`next_run_at` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `chat_integrations` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`provider` text NOT NULL,
	`webhook_url` text NOT NULL,
	`channel_id` text,
	`bot_token` text,
	`enabled` integer DEFAULT 1 NOT NULL,
	`events` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `code_branches` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`provider` text NOT NULL,
	`repo_slug` text,
	`name` text NOT NULL,
	`base_branch` text,
	`head_sha` text,
	`url` text,
	`created_from_task_id` text,
	`verification_state` text DEFAULT 'unverified' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `habitat_code_repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_from_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `code_changed_files` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`commit_id` text,
	`pull_request_id` text,
	`provider` text NOT NULL,
	`repo_slug` text,
	`path` text NOT NULL,
	`previous_path` text,
	`change_type` text NOT NULL,
	`additions` integer,
	`deletions` integer,
	`source` text NOT NULL,
	`captured_at` text DEFAULT (datetime('now')) NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `habitat_code_repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`commit_id`) REFERENCES `code_commits`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `code_commits` (
	`id` text PRIMARY KEY NOT NULL,
	`repository_id` text,
	`provider` text NOT NULL,
	`repo_slug` text,
	`sha` text NOT NULL,
	`branch_id` text,
	`message` text,
	`author_name` text,
	`author_email` text,
	`authored_at` text,
	`url` text,
	`verification_state` text DEFAULT 'unverified' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`repository_id`) REFERENCES `habitat_code_repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`branch_id`) REFERENCES `code_branches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `code_evidence_completeness` (
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`status` text NOT NULL,
	`reason_code` text,
	`reason_note` text,
	`marked_by_type` text NOT NULL,
	`marked_by_id` text NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `code_evidence_gaps` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`reason_code` text NOT NULL,
	`reason_note` text,
	`status` text DEFAULT 'active' NOT NULL,
	`reported_by_type` text NOT NULL,
	`reported_by_id` text NOT NULL,
	`reported_at` text DEFAULT (datetime('now')) NOT NULL,
	`resolved_by_type` text,
	`resolved_by_id` text,
	`resolved_at` text,
	`resolution_reason` text,
	`metadata` text DEFAULT '{}' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `code_evidence_links` (
	`id` text PRIMARY KEY NOT NULL,
	`target_type` text NOT NULL,
	`target_id` text NOT NULL,
	`evidence_type` text NOT NULL,
	`evidence_id` text,
	`external_url` text,
	`normalized_external_url` text,
	`title` text,
	`description` text,
	`link_source` text NOT NULL,
	`link_sources` text DEFAULT '[]' NOT NULL,
	`linked_by_type` text NOT NULL,
	`linked_by_id` text NOT NULL,
	`linked_at` text DEFAULT (datetime('now')) NOT NULL,
	`verification_state` text DEFAULT 'unverified' NOT NULL,
	`confidence` real,
	`status` text DEFAULT 'active' NOT NULL,
	`corrected_by_type` text,
	`corrected_by_id` text,
	`corrected_at` text,
	`correction_reason` text,
	`replacement_link_id` text,
	`allow_external_repository` integer DEFAULT false NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	FOREIGN KEY (`replacement_link_id`) REFERENCES `code_evidence_links`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `code_reviews` (
	`id` text PRIMARY KEY NOT NULL,
	`pull_request_id` text,
	`repository_id` text,
	`provider` text NOT NULL,
	`repo_slug` text,
	`review_url` text,
	`review_status` text DEFAULT 'pending' NOT NULL,
	`reviewer_name` text,
	`reviewer_id` text,
	`submitted_at` text,
	`verification_state` text DEFAULT 'unverified' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`pull_request_id`) REFERENCES `pull_requests`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`repository_id`) REFERENCES `habitat_code_repositories`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `columns` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`name` text NOT NULL,
	`order` integer NOT NULL,
	`wip_limit` integer,
	`auto_advance` integer DEFAULT false NOT NULL,
	`requires_claim` integer DEFAULT true NOT NULL,
	`next_column_id` text,
	`is_terminal` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`next_column_id`) REFERENCES `columns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `cumulative_flow_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`snapshot_date` text NOT NULL,
	`counts_by_column` text NOT NULL,
	`counts_by_status` text NOT NULL,
	`source` text DEFAULT 'generated' NOT NULL,
	`completeness` text DEFAULT 'complete' NOT NULL,
	`warnings` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `daemon_agents` (
	`id` text PRIMARY KEY NOT NULL,
	`daemon_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`cli_type` text NOT NULL,
	`cli_version` text,
	`cli_path` text NOT NULL,
	`status` text DEFAULT 'idle' NOT NULL,
	`last_seen_at` text,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`daemon_id`) REFERENCES `daemon_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `daemon_instances` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hostname` text NOT NULL,
	`token_hash` text NOT NULL,
	`max_concurrent` integer DEFAULT 4 NOT NULL,
	`daemon_version` text NOT NULL,
	`last_heartbeat_at` text,
	`status` text DEFAULT 'online' NOT NULL,
	`metadata` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daemon_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`daemon_id` text NOT NULL,
	`agent_id` text NOT NULL,
	`task_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`pid` integer,
	`cli_session_id` text,
	`workdir` text NOT NULL,
	`status` text DEFAULT 'starting' NOT NULL,
	`last_progress` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`daemon_id`) REFERENCES `daemon_instances`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
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
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL,
	`corrects_entry_id` text,
	`correction_reason` text,
	`metadata` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`corrects_entry_id`) REFERENCES `effort_entries`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `external_intake_candidates` (
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
	`source_assignees` text NOT NULL,
	`source_reporter` text,
	`source_labels` text NOT NULL,
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
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`promoted_mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `external_issue_links` (
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
	`provider_labels` text NOT NULL,
	`last_synced_at` text,
	`sync_status` text DEFAULT 'synced' NOT NULL,
	`sync_warning` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `habitat_code_repositories` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_base_url` text,
	`external_id` text,
	`repo_slug` text,
	`display_name` text,
	`local_path` text,
	`verification_state` text DEFAULT 'unverified' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `habitat_health_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`score` integer NOT NULL,
	`grade` text NOT NULL,
	`dimensions` text NOT NULL,
	`metrics` text NOT NULL,
	`recommendations` text DEFAULT '[]' NOT NULL,
	`snapshot_at` text DEFAULT (datetime('now')) NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `habitat_skill_signals` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`cluster_key` text NOT NULL,
	`skill_category` text NOT NULL,
	`source_signal_type` text NOT NULL,
	`source_type` text DEFAULT 'pulse' NOT NULL,
	`subject` text NOT NULL,
	`summary` text,
	`strength` real DEFAULT 0.1 NOT NULL,
	`frequency` integer DEFAULT 1 NOT NULL,
	`corroborating_agents` integer DEFAULT 1 NOT NULL,
	`cross_mission_count` integer DEFAULT 0 NOT NULL,
	`successful_tasks` integer DEFAULT 0 NOT NULL,
	`failed_tasks` integer DEFAULT 0 NOT NULL,
	`last_seen_at` text NOT NULL,
	`first_seen_at` text NOT NULL,
	`source_pulse_ids` text,
	`source_task_ids` text,
	`source_comment_ids` text,
	`corroborating_agent_ids` text,
	`promoted_to_skill` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `habitat_skills` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`signal_count` integer DEFAULT 0 NOT NULL,
	`avg_strength` real DEFAULT 0 NOT NULL,
	`last_generated_at` text DEFAULT (datetime('now')) NOT NULL,
	`generation_count` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `habitats` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`retry_settings` text,
	`anomaly_settings` text,
	`auto_assign_settings` text,
	`code_review_settings` text,
	`event_retention_days` integer DEFAULT 90,
	`ci_cd_settings` text,
	`git_worktree_settings` text,
	`prioritization_settings` text,
	`team_id` text,
	`carry_over_policy` text DEFAULT 'backlog' NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `integration_connections` (
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
	`provider_config` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`pull_enabled` integer DEFAULT true NOT NULL,
	`auto_import` integer DEFAULT false NOT NULL,
	`webhook_secret` text,
	`webhook_external_id` text,
	`last_sync_at` text,
	`last_sync_status` text DEFAULT 'never' NOT NULL,
	`last_sync_error` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `integration_sync_runs` (
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
	FOREIGN KEY (`connection_id`) REFERENCES `integration_connections`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mission_comment_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`mentioned_type` text NOT NULL,
	`mentioned_id` text NOT NULL,
	`mention_text` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `mission_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mission_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`parent_id` text,
	`author_type` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`parent_id`) REFERENCES `mission_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mission_dependencies` (
	`mission_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`mission_id`, `depends_on_id`),
	FOREIGN KEY (`depends_on_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mission_events` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`from_column_id` text,
	`to_column_id` text,
	`from_status` text,
	`to_status` text,
	`metadata` text NOT NULL,
	`timestamp` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mission_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text,
	`name` text NOT NULL,
	`title_pattern` text DEFAULT '' NOT NULL,
	`description_pattern` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'medium',
	`labels` text NOT NULL,
	`required_domain` text,
	`required_capabilities` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`tasks_template` text NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `mission_watchers` (
	`mission_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`mission_id`, `user_id`),
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`column_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`acceptance_criteria` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`labels` text NOT NULL,
	`status` text DEFAULT 'not_started' NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`depends_on` text NOT NULL,
	`blocks` text NOT NULL,
	`due_at` text,
	`sla_minutes` integer,
	`sla_deadline_at` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`actual_minutes` integer,
	`planned_minutes` integer,
	`planning_accuracy` real,
	`completed_at` text,
	`is_archived` integer DEFAULT false NOT NULL,
	`sprint_id` text,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `columns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `notification_preferences` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`habitat_id` text,
	`task_assigned` integer DEFAULT 1 NOT NULL,
	`task_submitted` integer DEFAULT 1 NOT NULL,
	`task_approved` integer DEFAULT 0 NOT NULL,
	`task_rejected` integer DEFAULT 1 NOT NULL,
	`task_overdue` integer DEFAULT 1 NOT NULL,
	`task_mentioned` integer DEFAULT 1 NOT NULL,
	`task_watching` integer DEFAULT 1 NOT NULL,
	`task_review_assigned` integer DEFAULT 1 NOT NULL,
	`task_priority_changed` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `pipeline_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`provider` text NOT NULL,
	`repo` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`branch` text NOT NULL,
	`commit_sha` text,
	`repository_id` text,
	`commit_id` text,
	`branch_evidence_id` text,
	`verification_state` text,
	`metadata` text,
	`created_at` text DEFAULT '(datetime(''now''))',
	`updated_at` text DEFAULT '(datetime(''now''))',
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `habitat_code_repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`commit_id`) REFERENCES `code_commits`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`branch_evidence_id`) REFERENCES `code_branches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `project_insights` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`source_pulse_id` text,
	`source_mission` text,
	`signal_type` text NOT NULL,
	`subject` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`relevance_tags` text NOT NULL,
	`promoted_by` text NOT NULL,
	`promoted_at` text NOT NULL,
	`is_active` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_pulse_id`) REFERENCES `pulses`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `pull_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`provider` text NOT NULL,
	`repo` text NOT NULL,
	`pr_number` integer NOT NULL,
	`pr_title` text,
	`pr_url` text NOT NULL,
	`branch_name` text,
	`state` text DEFAULT 'open',
	`review_status` text DEFAULT 'pending',
	`repository_id` text,
	`branch_id` text,
	`verification_state` text,
	`metadata` text,
	`created_at` text DEFAULT '(datetime(''now''))',
	`updated_at` text DEFAULT '(datetime(''now''))',
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`repository_id`) REFERENCES `habitat_code_repositories`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`branch_id`) REFERENCES `code_branches`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `pulse_cursors` (
	`scope_key` text NOT NULL,
	`scope` text DEFAULT 'mission' NOT NULL,
	`reader_type` text NOT NULL,
	`reader_id` text NOT NULL,
	`last_checked_at` text DEFAULT (datetime('now')) NOT NULL,
	PRIMARY KEY(`scope_key`, `reader_type`, `reader_id`)
);
--> statement-breakpoint
CREATE TABLE `pulse_reactions` (
	`id` text PRIMARY KEY NOT NULL,
	`pulse_id` text NOT NULL,
	`reactor_type` text NOT NULL,
	`reactor_id` text NOT NULL,
	`reaction` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`pulse_id`) REFERENCES `pulses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `pulses` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text,
	`habitat_id` text NOT NULL,
	`scope` text DEFAULT 'mission' NOT NULL,
	`from_type` text NOT NULL,
	`from_id` text NOT NULL,
	`to_type` text,
	`to_id` text,
	`signal_type` text NOT NULL,
	`subject` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`task_id` text,
	`reply_to_id` text,
	`linked_task_id` text,
	`metadata` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`pinned` integer DEFAULT 0 NOT NULL,
	`is_auto` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`linked_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `quality_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`required` integer DEFAULT true NOT NULL,
	`order_index` integer NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `quality_checklist_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `quality_checklist_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`category` text NOT NULL,
	`is_required` integer DEFAULT true NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`name` text NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`match_domain` text,
	`match_labels` text NOT NULL,
	`match_priority` text,
	`assignment_strategy` text DEFAULT 'domain_expert' NOT NULL,
	`required_reviews` integer DEFAULT 1 NOT NULL,
	`anti_self_review` integer DEFAULT 1 NOT NULL,
	`fixed_reviewer_ids` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `saved_filters` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`filter_config` text NOT NULL,
	`is_builtin` integer DEFAULT false,
	`created_at` text DEFAULT '(datetime(''now''))',
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `scheduled_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`template_id` text,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`schedule_type` text NOT NULL,
	`cron_expression` text,
	`interval_minutes` integer,
	`scheduled_at` text,
	`timezone` text DEFAULT 'UTC' NOT NULL,
	`mission_title` text NOT NULL,
	`mission_description` text DEFAULT '' NOT NULL,
	`mission_priority` text DEFAULT 'medium' NOT NULL,
	`mission_labels` text NOT NULL,
	`mission_domain` text,
	`tasks_template` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` text,
	`next_run_at` text NOT NULL,
	`run_count` integer DEFAULT 0 NOT NULL,
	`last_created_mission_id` text,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `mission_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `sprints` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text DEFAULT '' NOT NULL,
	`start_date` text NOT NULL,
	`end_date` text NOT NULL,
	`status` text DEFAULT 'planning' NOT NULL,
	`committed_mission_ids` text NOT NULL,
	`completed_mission_ids` text NOT NULL,
	`capacity_minutes` integer,
	`notes` text DEFAULT '' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`filename` text NOT NULL,
	`original_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`uploaded_by` text,
	`created_at` text DEFAULT '(datetime(''now''))',
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_comment_mentions` (
	`id` text PRIMARY KEY NOT NULL,
	`comment_id` text NOT NULL,
	`mentioned_type` text NOT NULL,
	`mentioned_id` text NOT NULL,
	`mention_text` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`comment_id`) REFERENCES `task_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`parent_id` text,
	`author_type` text NOT NULL,
	`author_id` text NOT NULL,
	`content` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`parent_id`) REFERENCES `task_comments`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`action` text NOT NULL,
	`from_column_id` text,
	`to_column_id` text,
	`from_status` text,
	`to_status` text,
	`metadata` text NOT NULL,
	`timestamp` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_quality_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`checklist_id` text NOT NULL,
	`item_id` text NOT NULL,
	`is_completed` integer DEFAULT false NOT NULL,
	`completed_by` text,
	`completed_at` text,
	`evidence_url` text,
	`notes` text DEFAULT '' NOT NULL,
	FOREIGN KEY (`checklist_id`) REFERENCES `task_quality_checklists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `quality_checklist_items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_quality_checklists` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`template_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` text,
	`completed_by` text,
	`notes` text DEFAULT '' NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `quality_checklist_templates`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `task_reviewers` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`reviewer_type` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`assigned_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`reviewed_at` text,
	`review_note` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `task_subtasks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`title` text NOT NULL,
	`completed` integer DEFAULT false NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`assignee_id` text,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assignee_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_time_records` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text,
	`minutes_spent` integer NOT NULL,
	`recorded_at` text DEFAULT (datetime('now')) NOT NULL,
	`status_during_work` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE `task_watchers` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`labels` text NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`assigned_agent_id` text,
	`required_domain` text,
	`required_capabilities` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`claimed_at` text,
	`started_at` text,
	`submitted_at` text,
	`completed_at` text,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`rejection_reason` text,
	`result` text,
	`artifacts` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`order` integer DEFAULT 0 NOT NULL,
	`delegated_to_agent_id` text,
	`estimated_minutes` integer,
	`retry_policy` text,
	`retry_count` integer DEFAULT 0 NOT NULL,
	`next_retry_at` text,
	`actual_minutes` integer,
	`cycle_time_minutes` integer,
	`lead_time_minutes` integer,
	`estimation_accuracy` real,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delegated_to_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role` text DEFAULT 'member' NOT NULL,
	`joined_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`username` text NOT NULL,
	`password_hash` text NOT NULL,
	`display_name` text DEFAULT '' NOT NULL,
	`role` text DEFAULT 'admin' NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`last_login_at` text,
	`email` text
);
--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`status_code` integer,
	`response_body` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`last_attempt_at` text,
	`next_retry_at` text,
	FOREIGN KEY (`subscription_id`) REFERENCES `webhook_subscriptions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `webhook_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`secret` text,
	`events` text NOT NULL,
	`headers` text NOT NULL,
	`format` text DEFAULT 'standard' NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_to_agent` ON `agent_messages` (`to_agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_from_agent` ON `agent_messages` (`from_agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_habitat` ON `agent_messages` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_task` ON `agent_messages` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_agent_messages_read` ON `agent_messages` (`read_at`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);
--> statement-breakpoint
CREATE UNIQUE INDEX `agents_api_key_unique` ON `agents` (`api_key`);
--> statement-breakpoint
CREATE INDEX `idx_agents_domain` ON `agents` (`domain`);
--> statement-breakpoint
CREATE INDEX `idx_agents_status` ON `agents` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_agents_current_task` ON `agents` (`current_task_id`);
--> statement-breakpoint
CREATE INDEX `idx_audit_schedules_habitat` ON `audit_export_schedules` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_audit_schedules_next` ON `audit_export_schedules` (`next_run_at`);
--> statement-breakpoint
CREATE INDEX `idx_chat_integrations_habitat` ON `chat_integrations` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_chat_integrations_provider` ON `chat_integrations` (`provider`);
--> statement-breakpoint
CREATE INDEX `idx_chat_integrations_enabled` ON `chat_integrations` (`enabled`);
--> statement-breakpoint
CREATE INDEX `idx_code_branches_repo_name` ON `code_branches` (`repository_id`,`name`);
--> statement-breakpoint
CREATE INDEX `idx_code_branches_task` ON `code_branches` (`created_from_task_id`);
--> statement-breakpoint
CREATE INDEX `idx_code_changed_files_repo_path` ON `code_changed_files` (`repository_id`,`path`);
--> statement-breakpoint
CREATE INDEX `idx_code_changed_files_commit` ON `code_changed_files` (`commit_id`);
--> statement-breakpoint
CREATE INDEX `idx_code_changed_files_pr` ON `code_changed_files` (`pull_request_id`);
--> statement-breakpoint
CREATE INDEX `idx_code_commits_repo_sha` ON `code_commits` (`repository_id`,`sha`);
--> statement-breakpoint
CREATE INDEX `idx_code_commits_sha` ON `code_commits` (`sha`);
--> statement-breakpoint
CREATE INDEX `idx_code_commits_branch` ON `code_commits` (`branch_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_evidence_completeness_target` ON `code_evidence_completeness` (`target_type`,`target_id`);
--> statement-breakpoint
CREATE INDEX `idx_evidence_gaps_target_status` ON `code_evidence_gaps` (`target_type`,`target_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_evidence_gaps_reason_status` ON `code_evidence_gaps` (`reason_code`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_code_evidence_gaps_reported_by` ON `code_evidence_gaps` (`reported_by_type`,`reported_by_id`);
--> statement-breakpoint
CREATE INDEX `idx_evidence_links_target_status` ON `code_evidence_links` (`target_type`,`target_id`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_evidence_links_evidence` ON `code_evidence_links` (`evidence_type`,`evidence_id`);
--> statement-breakpoint
CREATE INDEX `idx_code_evidence_links_linked_by` ON `code_evidence_links` (`linked_by_type`,`linked_by_id`);
--> statement-breakpoint
CREATE INDEX `idx_code_reviews_pr` ON `code_reviews` (`pull_request_id`);
--> statement-breakpoint
CREATE INDEX `idx_code_reviews_repo_status` ON `code_reviews` (`repository_id`,`review_status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_columns_habitat_order` ON `columns` (`habitat_id`,`order`);
--> statement-breakpoint
CREATE INDEX `idx_columns_habitat_id` ON `columns` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_columns_next` ON `columns` (`next_column_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cumulative_flow_snapshot_unique` ON `cumulative_flow_snapshots` (`habitat_id`,`snapshot_date`);
--> statement-breakpoint
CREATE INDEX `idx_daemon_agents_daemon` ON `daemon_agents` (`daemon_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_daemon_agents_agent` ON `daemon_agents` (`agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_daemon_instances_status` ON `daemon_instances` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_daemon_sessions_daemon` ON `daemon_sessions` (`daemon_id`);
--> statement-breakpoint
CREATE INDEX `idx_daemon_sessions_task` ON `daemon_sessions` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_daemon_sessions_status` ON `daemon_sessions` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_effort_entries_task` ON `effort_entries` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_effort_entries_actor` ON `effort_entries` (`actor_type`,`actor_id`);
--> statement-breakpoint
CREATE INDEX `idx_effort_entries_source` ON `effort_entries` (`source`);
--> statement-breakpoint
CREATE INDEX `idx_effort_entries_corrects` ON `effort_entries` (`corrects_entry_id`);
--> statement-breakpoint
CREATE INDEX `idx_external_intake_candidates_connection` ON `external_intake_candidates` (`connection_id`);
--> statement-breakpoint
CREATE INDEX `idx_external_intake_candidates_habitat` ON `external_intake_candidates` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_external_intake_candidates_review_status` ON `external_intake_candidates` (`review_status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_intake_candidates_connection_external` ON `external_intake_candidates` (`connection_id`,`external_id`);
--> statement-breakpoint
CREATE INDEX `idx_external_issue_links_connection` ON `external_issue_links` (`connection_id`);
--> statement-breakpoint
CREATE INDEX `idx_external_issue_links_habitat` ON `external_issue_links` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_external_issue_links_mission` ON `external_issue_links` (`mission_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_issue_links_provider_external` ON `external_issue_links` (`provider`,`external_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_external_issue_links_connection_external` ON `external_issue_links` (`connection_id`,`external_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_habitat_code_repo_habitat` ON `habitat_code_repositories` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_habitat_code_repo_provider_slug` ON `habitat_code_repositories` (`provider`,`repo_slug`);
--> statement-breakpoint
CREATE INDEX `idx_health_snapshots_habitat` ON `habitat_health_snapshots` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_health_snapshots_time` ON `habitat_health_snapshots` (`habitat_id`,`snapshot_at`);
--> statement-breakpoint
CREATE INDEX `idx_hskill_signals_habitat` ON `habitat_skill_signals` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_hskill_signals_cluster` ON `habitat_skill_signals` (`cluster_key`);
--> statement-breakpoint
CREATE INDEX `idx_hskill_signals_category` ON `habitat_skill_signals` (`skill_category`);
--> statement-breakpoint
CREATE INDEX `idx_hskill_signals_strength` ON `habitat_skill_signals` (`strength`);
--> statement-breakpoint
CREATE INDEX `idx_hskill_signals_promoted` ON `habitat_skill_signals` (`promoted_to_skill`);
--> statement-breakpoint
CREATE INDEX `idx_hskill_signals_habitat_cluster` ON `habitat_skill_signals` (`habitat_id`,`cluster_key`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_hskill_signals_habitat_cluster_unique` ON `habitat_skill_signals` (`habitat_id`,`cluster_key`);
--> statement-breakpoint
CREATE INDEX `idx_hskill_signals_habitat_cat_promoted` ON `habitat_skill_signals` (`habitat_id`,`skill_category`,`promoted_to_skill`);
--> statement-breakpoint
CREATE UNIQUE INDEX `habitat_skills_habitat_id_unique` ON `habitat_skills` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_habitat_skills_habitat` ON `habitat_skills` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_habitats_name` ON `habitats` (`name`);
--> statement-breakpoint
CREATE INDEX `idx_habitats_team_id` ON `habitats` (`team_id`);
--> statement-breakpoint
CREATE INDEX `idx_integration_connections_habitat` ON `integration_connections` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_integration_connections_provider` ON `integration_connections` (`provider`);
--> statement-breakpoint
CREATE INDEX `idx_integration_connections_enabled` ON `integration_connections` (`enabled`);
--> statement-breakpoint
CREATE INDEX `idx_integration_sync_runs_connection` ON `integration_sync_runs` (`connection_id`);
--> statement-breakpoint
CREATE INDEX `idx_integration_sync_runs_habitat` ON `integration_sync_runs` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_integration_sync_runs_started` ON `integration_sync_runs` (`started_at`);
--> statement-breakpoint
CREATE INDEX `idx_mission_mentions_comment_id` ON `mission_comment_mentions` (`comment_id`);
--> statement-breakpoint
CREATE INDEX `idx_mission_mentions_target` ON `mission_comment_mentions` (`mentioned_type`,`mentioned_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_mission_mentions_unique` ON `mission_comment_mentions` (`comment_id`,`mentioned_type`,`mentioned_id`,`mention_text`);
--> statement-breakpoint
CREATE INDEX `idx_mission_comments_mission_id` ON `mission_comments` (`mission_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_mission_comments_parent` ON `mission_comments` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `idx_mission_deps_depends_on` ON `mission_dependencies` (`depends_on_id`);
--> statement-breakpoint
CREATE INDEX `idx_mission_events_mission` ON `mission_events` (`mission_id`);
--> statement-breakpoint
CREATE INDEX `idx_mission_events_timestamp` ON `mission_events` (`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_templates_habitat` ON `mission_templates` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_templates_default` ON `mission_templates` (`is_default`);
--> statement-breakpoint
CREATE INDEX `idx_mission_watchers_user` ON `mission_watchers` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_missions_habitat_column` ON `missions` (`habitat_id`,`column_id`);
--> statement-breakpoint
CREATE INDEX `idx_missions_status` ON `missions` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_missions_priority` ON `missions` (`priority`);
--> statement-breakpoint
CREATE INDEX `idx_missions_column_order` ON `missions` (`column_id`,`display_order`);
--> statement-breakpoint
CREATE INDEX `idx_missions_due_at` ON `missions` (`due_at`);
--> statement-breakpoint
CREATE INDEX `idx_missions_sla_deadline_at` ON `missions` (`sla_deadline_at`);
--> statement-breakpoint
CREATE INDEX `idx_missions_sprint` ON `missions` (`sprint_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notif_prefs_user_habitat` ON `notification_preferences` (`user_id`,`habitat_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_task_id` ON `pipeline_events` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_repository_id` ON `pipeline_events` (`repository_id`);
--> statement-breakpoint
CREATE INDEX `idx_pipeline_events_commit_id` ON `pipeline_events` (`commit_id`);
--> statement-breakpoint
CREATE INDEX `idx_insights_habitat` ON `project_insights` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_insights_active` ON `project_insights` (`is_active`);
--> statement-breakpoint
CREATE INDEX `idx_insights_type` ON `project_insights` (`signal_type`);
--> statement-breakpoint
CREATE INDEX `idx_pull_requests_task_id` ON `pull_requests` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_pull_requests_repository_id` ON `pull_requests` (`repository_id`);
--> statement-breakpoint
CREATE INDEX `idx_pull_requests_branch_id` ON `pull_requests` (`branch_id`);
--> statement-breakpoint
CREATE INDEX `idx_reactions_pulse` ON `pulse_reactions` (`pulse_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reactions_unique` ON `pulse_reactions` (`pulse_id`,`reactor_type`,`reactor_id`,`reaction`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_mission` ON `pulses` (`mission_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_habitat` ON `pulses` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_scope` ON `pulses` (`scope`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_habitat_scope` ON `pulses` (`habitat_id`,`scope`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_signal_type` ON `pulses` (`signal_type`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_from` ON `pulses` (`from_type`,`from_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_to` ON `pulses` (`to_type`,`to_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_task` ON `pulses` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_created` ON `pulses` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_reply_to` ON `pulses` (`reply_to_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_thread` ON `pulses` (`reply_to_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_quality_items_template` ON `quality_checklist_items` (`template_id`);
--> statement-breakpoint
CREATE INDEX `idx_quality_templates_category` ON `quality_checklist_templates` (`category`);
--> statement-breakpoint
CREATE INDEX `idx_review_rules_habitat` ON `review_rules` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_habitat` ON `scheduled_tasks` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_next` ON `scheduled_tasks` (`next_run_at`);
--> statement-breakpoint
CREATE INDEX `idx_scheduled_tasks_enabled` ON `scheduled_tasks` (`enabled`);
--> statement-breakpoint
CREATE INDEX `idx_sprints_habitat` ON `sprints` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_sprints_status` ON `sprints` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_sprints_dates` ON `sprints` (`start_date`,`end_date`);
--> statement-breakpoint
CREATE INDEX `idx_attachments_task_id` ON `task_attachments` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_mentions_comment_id` ON `task_comment_mentions` (`comment_id`);
--> statement-breakpoint
CREATE INDEX `idx_comment_mentions_target` ON `task_comment_mentions` (`mentioned_type`,`mentioned_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comment_mentions_unique` ON `task_comment_mentions` (`comment_id`,`mentioned_type`,`mentioned_id`,`mention_text`);
--> statement-breakpoint
CREATE INDEX `idx_comments_task_id` ON `task_comments` (`task_id`,`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_comments_parent` ON `task_comments` (`parent_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_dependencies_depends_on` ON `task_dependencies` (`depends_on_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_dependencies_task_id` ON `task_dependencies` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_task_id` ON `task_events` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_timestamp` ON `task_events` (`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_actor` ON `task_events` (`actor_type`,`actor_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_from_column_time` ON `task_events` (`from_column_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_to_column_time` ON `task_events` (`to_column_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_task_events_transition_time` ON `task_events` (`from_column_id`,`to_column_id`,`timestamp`);
--> statement-breakpoint
CREATE INDEX `idx_task_quality_items_checklist` ON `task_quality_checklist_items` (`checklist_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_quality_checklists_task` ON `task_quality_checklists` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_reviewers_task` ON `task_reviewers` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_reviewers_reviewer` ON `task_reviewers` (`reviewer_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_reviewers_task_status` ON `task_reviewers` (`task_id`,`status`);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_task_reviewers_task_reviewer` ON `task_reviewers` (`task_id`,`reviewer_id`);
--> statement-breakpoint
CREATE INDEX `idx_subtasks_task_id` ON `task_subtasks` (`task_id`,`order`);
--> statement-breakpoint
CREATE INDEX `idx_subtasks_assignee` ON `task_subtasks` (`assignee_id`);
--> statement-breakpoint
CREATE INDEX `idx_time_records_task` ON `task_time_records` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_time_records_agent` ON `task_time_records` (`agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_task_watchers_user_id` ON `task_watchers` (`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_mission` ON `tasks` (`mission_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_mission_order` ON `tasks` (`mission_id`,`order`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_assigned_agent` ON `tasks` (`assigned_agent_id`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_required_domain` ON `tasks` (`required_domain`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);
--> statement-breakpoint
CREATE INDEX `idx_tasks_delegated` ON `tasks` (`delegated_to_agent_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_team_members_unique` ON `team_members` (`team_id`,`user_id`);
--> statement-breakpoint
CREATE INDEX `idx_team_members_team_id` ON `team_members` (`team_id`);
--> statement-breakpoint
CREATE INDEX `idx_team_members_user_id` ON `team_members` (`user_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_unique` ON `teams` (`slug`);
--> statement-breakpoint
CREATE INDEX `idx_teams_organization_id` ON `teams` (`organization_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_subscription` ON `webhook_deliveries` (`subscription_id`);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_status` ON `webhook_deliveries` (`status`);
--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_retry` ON `webhook_deliveries` (`next_retry_at`);
--> statement-breakpoint
CREATE INDEX `idx_webhook_subscriptions_habitat` ON `webhook_subscriptions` (`habitat_id`);
--> statement-breakpoint
CREATE INDEX `idx_webhook_subscriptions_enabled` ON `webhook_subscriptions` (`enabled`);
--> statement-breakpoint
