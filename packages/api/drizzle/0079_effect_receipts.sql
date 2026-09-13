/*
    T2 — durable failure-effect receipts (authority-and-effects contract §B).

    Additive only: every new column is nullable, every new table is fresh, all
    uniqueness rides partial indexes on the new nullable columns. Zero legacy
    row rewrite (rev-6 migration plan).

      - effect_receipts / effect_receipt_targets / effect_receipt_attempts /
        effect_receipt_admin_actions: the receipt outbox family. Receipts are
        retained indefinitely (S-3) — no cleanup or delete path exists.
      - tasks.last_failure_event_id: the failure-provenance pointer written by
        the act-tx, CAS'd by pointer-fenced consumers (§B.0). Never inferred.
      - task_events.execution_token: the epoch token stamped on the failed
        event at creation time (immutable, written once).
      - failure_contexts.source_event_id: per-event exactly-once capture key
        (partial unique — legacy NULL rows stay outside the index).
      - plugin_runs.dispatch_key + lease/marker columns: event-keyed detector
        dispatch units (canonical JSON, collision-safe), lease-token attempt
        generations, and the set-once signals_committed_at marker. Legacy rows
        keep NULL keys and stay outside the partial unique index.
*/
CREATE TABLE `effect_receipts` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`task_id` text,
	`consumer` text NOT NULL,
	`state` text NOT NULL DEFAULT 'pending',
	`attempts` integer NOT NULL DEFAULT 0,
	`last_error_code` text,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`causal_snapshot` text,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_effect_receipts_subject_consumer` ON `effect_receipts` (`subject_type`,`subject_id`,`consumer`);
--> statement-breakpoint
CREATE INDEX `idx_effect_receipts_state_created` ON `effect_receipts` (`state`,`created_at`);
--> statement-breakpoint
CREATE TABLE `effect_receipt_targets` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`target_key` text NOT NULL,
	`plugin_id` text NOT NULL,
	`contribution_id` text NOT NULL,
	`state` text NOT NULL DEFAULT 'pending',
	`attempts` integer NOT NULL DEFAULT 0,
	`last_error_code` text,
	`lease_owner` text,
	`lease_token` text,
	`lease_expires_at` text,
	`created_at` text NOT NULL,
	`delivered_at` text,
	FOREIGN KEY (`receipt_id`) REFERENCES `effect_receipts`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_effect_receipt_targets_unique` ON `effect_receipt_targets` (`receipt_id`,`target_key`);
--> statement-breakpoint
CREATE INDEX `idx_effect_receipt_targets_state_created` ON `effect_receipt_targets` (`state`,`created_at`);
--> statement-breakpoint
CREATE TABLE `effect_receipt_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`target_id` text,
	`attempt` integer NOT NULL,
	`code` text NOT NULL,
	`actor` text NOT NULL DEFAULT 'deliverer',
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `effect_receipts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_effect_receipt_attempts_receipt` ON `effect_receipt_attempts` (`receipt_id`,`occurred_at`);
--> statement-breakpoint
CREATE TABLE `effect_receipt_admin_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`receipt_id` text NOT NULL,
	`target_id` text,
	`action` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`occurred_at` text NOT NULL,
	FOREIGN KEY (`receipt_id`) REFERENCES `effect_receipts`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_effect_receipt_admin_actions_receipt` ON `effect_receipt_admin_actions` (`receipt_id`,`occurred_at`);
--> statement-breakpoint
ALTER TABLE `tasks` ADD `last_failure_event_id` text;
--> statement-breakpoint
CREATE INDEX `idx_tasks_last_failure_event` ON `tasks` (`last_failure_event_id`);
--> statement-breakpoint
ALTER TABLE `task_events` ADD `execution_token` text;
--> statement-breakpoint
ALTER TABLE `failure_contexts` ADD `source_event_id` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_failure_contexts_source_event` ON `failure_contexts` (`source_event_id`) WHERE `source_event_id` IS NOT NULL;
--> statement-breakpoint
ALTER TABLE `plugin_runs` ADD `dispatch_key` text;
--> statement-breakpoint
ALTER TABLE `plugin_runs` ADD `lease_token` text;
--> statement-breakpoint
ALTER TABLE `plugin_runs` ADD `lease_expires_at` text;
--> statement-breakpoint
ALTER TABLE `plugin_runs` ADD `signals_committed_at` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_plugin_runs_dispatch_key` ON `plugin_runs` (`dispatch_key`) WHERE `dispatch_key` IS NOT NULL;
