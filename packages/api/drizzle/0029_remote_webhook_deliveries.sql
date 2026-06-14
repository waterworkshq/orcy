-- v0.19 Phase E — Remote webhook delivery tracking.
-- Each enabled remote endpoint that subscribes to an event gets a delivery
-- row per dispatch attempt. The signature is computed at dispatch time
-- using the endpoint's stored secretHash. Plaintext secrets are never
-- stored.

CREATE TABLE `remote_webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`habitat_id` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`signature` text NOT NULL,
	`status` text NOT NULL DEFAULT 'pending',
	`status_code` integer,
	`response_body` text,
	`attempts` integer NOT NULL DEFAULT 0,
	`last_attempt_at` text,
	`next_retry_at` text,
	`created_at` text NOT NULL DEFAULT (datetime('now')),
	FOREIGN KEY (`endpoint_id`) REFERENCES `remote_webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint

CREATE INDEX `idx_remote_webhook_deliveries_endpoint` ON `remote_webhook_deliveries` (`endpoint_id`, `created_at`);
--> statement-breakpoint

CREATE INDEX `idx_remote_webhook_deliveries_status` ON `remote_webhook_deliveries` (`status`, `next_retry_at`);
