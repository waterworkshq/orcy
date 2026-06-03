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
CREATE UNIQUE INDEX `users_username_unique` ON `users` (`username`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_users_username` ON `users` (`username`);--> statement-breakpoint

CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_organizations_slug` ON `organizations` (`slug`);--> statement-breakpoint

CREATE TABLE `teams` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `teams_slug_unique` ON `teams` (`slug`);--> statement-breakpoint
CREATE INDEX `idx_teams_organization_id` ON `teams` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_teams_slug` ON `teams` (`slug`);--> statement-breakpoint

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
CREATE UNIQUE INDEX `idx_team_members_unique` ON `team_members` (`team_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `idx_team_members_team_id` ON `team_members` (`team_id`);--> statement-breakpoint
CREATE INDEX `idx_team_members_user_id` ON `team_members` (`user_id`);--> statement-breakpoint

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
	`team_id` text,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_habitats_name` ON `habitats` (`name`);--> statement-breakpoint
CREATE INDEX `idx_habitats_team_id` ON `habitats` (`team_id`);--> statement-breakpoint

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
CREATE UNIQUE INDEX `idx_columns_board_order` ON `columns` (`habitat_id`,`order`);--> statement-breakpoint
CREATE INDEX `idx_columns_habitat_id` ON `columns` (`habitat_id`);--> statement-breakpoint
CREATE INDEX `idx_columns_next` ON `columns` (`next_column_id`);--> statement-breakpoint

CREATE TABLE `missions` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text NOT NULL,
	`column_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`acceptance_criteria` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`labels` text NOT NULL DEFAULT '[]',
	`status` text DEFAULT 'not_started' NOT NULL,
	`display_order` integer DEFAULT 0 NOT NULL,
	`depends_on` text NOT NULL DEFAULT '[]',
	`blocks` text NOT NULL DEFAULT '[]',
	`due_at` text,
	`sla_minutes` integer,
	`sla_deadline_at` text,
	`actual_minutes` integer,
	`planned_minutes` integer,
	`planning_accuracy` real,
	`completed_at` text,
	`is_archived` integer DEFAULT false NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`column_id`) REFERENCES `columns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_missions_board_column` ON `missions` (`habitat_id`,`column_id`);--> statement-breakpoint
CREATE INDEX `idx_missions_status` ON `missions` (`status`);--> statement-breakpoint
CREATE INDEX `idx_missions_priority` ON `missions` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_missions_column_order` ON `missions` (`column_id`,`display_order`);--> statement-breakpoint
CREATE INDEX `idx_missions_due_at` ON `missions` (`due_at`);--> statement-breakpoint

CREATE TABLE `mission_dependencies` (
	`mission_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`mission_id`, `depends_on_id`),
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mission_deps_depends_on` ON `mission_dependencies` (`depends_on_id`);--> statement-breakpoint

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
	`metadata` text NOT NULL DEFAULT '{}',
	`timestamp` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mission_events_feature` ON `mission_events` (`mission_id`);--> statement-breakpoint
CREATE INDEX `idx_mission_events_timestamp` ON `mission_events` (`timestamp`);--> statement-breakpoint

CREATE TABLE `mission_watchers` (
	`mission_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	PRIMARY KEY(`mission_id`, `user_id`),
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_mission_watchers_user` ON `mission_watchers` (`user_id`);--> statement-breakpoint

CREATE TABLE `mission_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`habitat_id` text,
	`name` text NOT NULL,
	`title_pattern` text DEFAULT '' NOT NULL,
	`description_pattern` text DEFAULT '' NOT NULL,
	`tasks_template` text NOT NULL DEFAULT '[]',
	`priority` text DEFAULT 'medium',
	`labels` text NOT NULL,
	`required_domain` text,
	`required_capabilities` text NOT NULL,
	`is_default` integer DEFAULT false NOT NULL,
	`usage_count` integer DEFAULT 0 NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_templates_board` ON `mission_templates` (`habitat_id`);--> statement-breakpoint
CREATE INDEX `idx_templates_default` ON `mission_templates` (`is_default`);--> statement-breakpoint

CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`priority` text DEFAULT 'medium' NOT NULL,
	`assigned_agent_id` text,
	`required_domain` text,
	`required_capabilities` text NOT NULL DEFAULT '[]',
	`status` text DEFAULT 'pending' NOT NULL,
	`claimed_at` text,
	`started_at` text,
	`submitted_at` text,
	`completed_at` text,
	`rejected_count` integer DEFAULT 0 NOT NULL,
	`rejection_reason` text,
	`result` text,
	`artifacts` text NOT NULL DEFAULT '[]',
	`actual_minutes` integer,
	`cycle_time_minutes` integer,
	`lead_time_minutes` integer,
	`estimation_accuracy` real,
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
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`assigned_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`delegated_to_agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `idx_tasks_feature` ON `tasks` (`mission_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_feature_order` ON `tasks` (`mission_id`,`order`);--> statement-breakpoint
CREATE INDEX `idx_tasks_status` ON `tasks` (`status`);--> statement-breakpoint
CREATE INDEX `idx_tasks_assigned_agent` ON `tasks` (`assigned_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_tasks_required_domain` ON `tasks` (`required_domain`);--> statement-breakpoint
CREATE INDEX `idx_tasks_priority` ON `tasks` (`priority`);--> statement-breakpoint
CREATE INDEX `idx_tasks_delegated` ON `tasks` (`delegated_to_agent_id`);--> statement-breakpoint

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
CREATE INDEX `idx_attachments_task_id` ON `task_attachments` (`task_id`);--> statement-breakpoint

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
CREATE INDEX `idx_comments_task_id` ON `task_comments` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_comments_parent` ON `task_comments` (`parent_id`);--> statement-breakpoint

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
CREATE INDEX `idx_comment_mentions_comment_id` ON `task_comment_mentions` (`comment_id`);--> statement-breakpoint
CREATE INDEX `idx_comment_mentions_target` ON `task_comment_mentions` (`mentioned_type`,`mentioned_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_comment_mentions_unique` ON `task_comment_mentions` (`comment_id`,`mentioned_type`,`mentioned_id`,`mention_text`);--> statement-breakpoint

CREATE TABLE `task_dependencies` (
	`task_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_dependencies_depends_on` ON `task_dependencies` (`depends_on_id`);--> statement-breakpoint
CREATE INDEX `idx_task_dependencies_task_id` ON `task_dependencies` (`task_id`);--> statement-breakpoint

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
CREATE INDEX `idx_task_events_task_id` ON `task_events` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_task_events_timestamp` ON `task_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_task_events_actor` ON `task_events` (`actor_type`,`actor_id`);--> statement-breakpoint
CREATE INDEX `idx_task_events_from_column_time` ON `task_events` (`from_column_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_task_events_to_column_time` ON `task_events` (`to_column_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_task_events_transition_time` ON `task_events` (`from_column_id`,`to_column_id`,`timestamp`);--> statement-breakpoint

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
CREATE INDEX `idx_subtasks_task_id` ON `task_subtasks` (`task_id`,`order`);--> statement-breakpoint
CREATE INDEX `idx_subtasks_assignee` ON `task_subtasks` (`assignee_id`);--> statement-breakpoint

CREATE TABLE `task_watchers` (
	`task_id` text NOT NULL,
	`user_id` text NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	PRIMARY KEY(`task_id`, `user_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_task_watchers_user_id` ON `task_watchers` (`user_id`);--> statement-breakpoint

CREATE TABLE `task_time_records` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`agent_id` text,
	`minutes_spent` integer NOT NULL,
	`recorded_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`status_during_work` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_time_records_task` ON `task_time_records` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_time_records_agent` ON `task_time_records` (`agent_id`);--> statement-breakpoint

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
CREATE UNIQUE INDEX `agents_name_unique` ON `agents` (`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `agents_api_key_unique` ON `agents` (`api_key`);--> statement-breakpoint
CREATE INDEX `idx_agents_domain` ON `agents` (`domain`);--> statement-breakpoint
CREATE INDEX `idx_agents_status` ON `agents` (`status`);--> statement-breakpoint
CREATE INDEX `idx_agents_current_task` ON `agents` (`current_task_id`);--> statement-breakpoint

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
CREATE INDEX `idx_agent_messages_to_agent` ON `agent_messages` (`to_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_from_agent` ON `agent_messages` (`from_agent_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_board` ON `agent_messages` (`habitat_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_task` ON `agent_messages` (`task_id`);--> statement-breakpoint
CREATE INDEX `idx_agent_messages_read` ON `agent_messages` (`read_at`);--> statement-breakpoint

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

CREATE TABLE `pipeline_events` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`provider` text NOT NULL,
	`repo` text NOT NULL,
	`run_id` text NOT NULL,
	`status` text NOT NULL,
	`branch` text NOT NULL,
	`commit_sha` text,
	`created_at` text DEFAULT '(datetime(''now''))',
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
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
	`created_at` text DEFAULT '(datetime(''now''))',
	`updated_at` text DEFAULT '(datetime(''now''))',
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade
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
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_notif_prefs_user_board` ON `notification_preferences` (`user_id`,`habitat_id`);--> statement-breakpoint

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
CREATE INDEX `idx_chat_integrations_board` ON `chat_integrations` (`habitat_id`);--> statement-breakpoint
CREATE INDEX `idx_chat_integrations_provider` ON `chat_integrations` (`provider`);--> statement-breakpoint
CREATE INDEX `idx_chat_integrations_enabled` ON `chat_integrations` (`enabled`);--> statement-breakpoint

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
CREATE INDEX `idx_webhook_subscriptions_board` ON `webhook_subscriptions` (`habitat_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_subscriptions_enabled` ON `webhook_subscriptions` (`enabled`);--> statement-breakpoint

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
CREATE INDEX `idx_webhook_deliveries_subscription` ON `webhook_deliveries` (`subscription_id`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_status` ON `webhook_deliveries` (`status`);--> statement-breakpoint
CREATE INDEX `idx_webhook_deliveries_retry` ON `webhook_deliveries` (`next_retry_at`);--> statement-breakpoint

CREATE TABLE `quality_checklist_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '',
	`category` text NOT NULL,
	`is_required` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	`updated_at` text DEFAULT '(datetime(''now''))' NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_quality_templates_category` ON `quality_checklist_templates` (`category`);--> statement-breakpoint

CREATE TABLE `quality_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`template_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text DEFAULT '',
	`required` integer DEFAULT 1 NOT NULL,
	`order_index` integer NOT NULL,
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`template_id`) REFERENCES `quality_checklist_templates`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_quality_items_template` ON `quality_checklist_items` (`template_id`);--> statement-breakpoint

CREATE TABLE `task_quality_checklists` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`template_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`completed_at` text,
	`completed_by` text,
	`notes` text DEFAULT '',
	`created_at` text DEFAULT '(datetime(''now''))' NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`template_id`) REFERENCES `quality_checklist_templates`(`id`) ON UPDATE no action ON DELETE set null,
	UNIQUE(`task_id`, `template_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_task_quality_checklists_task` ON `task_quality_checklists` (`task_id`);--> statement-breakpoint

CREATE TABLE `task_quality_checklist_items` (
	`id` text PRIMARY KEY NOT NULL,
	`checklist_id` text NOT NULL,
	`item_id` text NOT NULL,
	`is_completed` integer DEFAULT 0 NOT NULL,
	`completed_by` text,
	`completed_at` text,
	`evidence_url` text,
	`notes` text DEFAULT '',
	FOREIGN KEY (`checklist_id`) REFERENCES `task_quality_checklists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `quality_checklist_items`(`id`) ON UPDATE no action ON DELETE cascade,
	UNIQUE(`checklist_id`, `item_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_task_quality_items_checklist` ON `task_quality_checklist_items` (`checklist_id`);
