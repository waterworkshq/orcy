-- v0.20 workflow orchestration: workflows, task gates, failure contexts
CREATE TABLE `workflows` (
	`id` text PRIMARY KEY NOT NULL,
	`mission_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`resolved_variables` text NOT NULL,
	`failure_handler` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`detached_at` text,
	`detached_by` text,
	`version` integer DEFAULT 1 NOT NULL,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_workflows_mission` ON `workflows` (`mission_id`);--> statement-breakpoint
CREATE INDEX `idx_workflows_habitat` ON `workflows` (`habitat_id`);--> statement-breakpoint
CREATE INDEX `idx_workflows_status` ON `workflows` (`status`);--> statement-breakpoint
CREATE TABLE `task_workflow_gates` (
	`id` text PRIMARY KEY NOT NULL,
	`workflow_id` text NOT NULL,
	`mission_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`upstream_task_id` text NOT NULL,
	`downstream_task_id` text NOT NULL,
	`gate_type` text NOT NULL,
	`match_config` text,
	`condition` text,
	`satisfied` integer DEFAULT false NOT NULL,
	`satisfied_at` text,
	`satisfied_by_event_id` text,
	`recovery_task_id` text,
	`recovery_depth` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`upstream_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`downstream_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recovery_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_workflow_gates_workflow` ON `task_workflow_gates` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_gates_downstream` ON `task_workflow_gates` (`downstream_task_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_gates_upstream` ON `task_workflow_gates` (`upstream_task_id`);--> statement-breakpoint
CREATE INDEX `idx_workflow_gates_satisfied` ON `task_workflow_gates` (`satisfied`);--> statement-breakpoint
CREATE INDEX `idx_workflow_gates_type` ON `task_workflow_gates` (`gate_type`);--> statement-breakpoint
CREATE TABLE `failure_contexts` (
	`id` text PRIMARY KEY NOT NULL,
	`failed_task_id` text NOT NULL,
	`workflow_id` text,
	`habitat_id` text NOT NULL,
	`failure_kind` text NOT NULL,
	`failure_reason` text DEFAULT '' NOT NULL,
	`failed_at` text DEFAULT (datetime('now')) NOT NULL,
	`failed_by_agent_id` text,
	`bundle` text NOT NULL,
	`bundle_schema_version` integer DEFAULT 1 NOT NULL,
	`recovery_task_id` text,
	`recovery_depth` integer DEFAULT 0 NOT NULL,
	`resolved_at` text,
	`resolution_kind` text,
	FOREIGN KEY (`failed_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`workflow_id`) REFERENCES `workflows`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`recovery_task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_failure_contexts_task` ON `failure_contexts` (`failed_task_id`);--> statement-breakpoint
CREATE INDEX `idx_failure_contexts_workflow` ON `failure_contexts` (`workflow_id`);--> statement-breakpoint
CREATE INDEX `idx_failure_contexts_unresolved` ON `failure_contexts` (`resolved_at`);
