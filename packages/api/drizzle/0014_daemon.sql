CREATE TABLE daemon_instances (
  `id` text PRIMARY KEY NOT NULL,
  `name` text NOT NULL,
  `hostname` text NOT NULL,
  `token_hash` text NOT NULL,
  `max_concurrent` integer DEFAULT 4 NOT NULL,
  `daemon_version` text NOT NULL,
  `last_heartbeat_at` text,
  `status` text DEFAULT 'online' NOT NULL,
  `metadata` text DEFAULT '{}',
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_daemon_instances_status ON daemon_instances (`status`);
--> statement-breakpoint
CREATE TABLE daemon_agents (
  `id` text PRIMARY KEY NOT NULL,
  `daemon_id` text NOT NULL,
  `agent_id` text NOT NULL,
  `cli_type` text NOT NULL,
  `cli_version` text,
  `cli_path` text NOT NULL,
  `status` text DEFAULT 'idle' NOT NULL,
  `last_seen_at` text,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`daemon_id`) REFERENCES `daemon_instances`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX idx_daemon_agents_daemon ON daemon_agents (`daemon_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_daemon_agents_agent ON daemon_agents (`agent_id`);
--> statement-breakpoint
CREATE TABLE daemon_sessions (
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
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`daemon_id`) REFERENCES `daemon_instances`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`agent_id`) REFERENCES `agents`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE cascade ON UPDATE no action,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade ON UPDATE no action
);
--> statement-breakpoint
CREATE INDEX idx_daemon_sessions_daemon ON daemon_sessions (`daemon_id`);
--> statement-breakpoint
CREATE INDEX idx_daemon_sessions_task ON daemon_sessions (`task_id`);
--> statement-breakpoint
CREATE INDEX idx_daemon_sessions_status ON daemon_sessions (`status`);
