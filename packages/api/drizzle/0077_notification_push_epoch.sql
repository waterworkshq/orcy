-- Notification V2 push+retry restoration — upgrade epoch boundary.
--
-- Binding user decision 2026-09-05: the upgrade sends ONLY new notifications.
-- This migration is the atomic cutover:
--   1. `notification_delivery_channel_states` lands — the per-(delivery,
--      channel, destination) unit state machine the delivery worker scans
--      (available/cooldown/claimed with lease+fence, 3-reservation claim-time
--      budget, fixed truthful dispositions).
--   2. `notification_deliveries.push_epoch` lands with a column-level DEFAULT
--      'restored' so every future insert path — including direct repository
--      producers — receives the marker automatically; no producer can bypass.
--   3. Every pre-existing row is backfilled to 'legacy' IN THE SAME
--      migration (before the server accepts writes; no time heuristic).
--      Legacy rows are never sent and never relabeled; push_epoch is
--      INSERT-only (no update path ever writes it).
--   4. Non-terminal legacy deliveries (pending/snoozed/muted) get one
--      terminal `backlog_not_attempted` unit recording that push was
--      deliberately not attempted — evidence, not action. Terminal legacy
--      deliveries (delivered/failed/acknowledged/cleared) get no units.
CREATE TABLE `notification_delivery_channel_states` (
	`id` text PRIMARY KEY NOT NULL,
	`delivery_id` text NOT NULL,
	`channel_key` text NOT NULL,
	`base_channel` text,
	`destination_id` text,
	`state` text NOT NULL DEFAULT 'available',
	`reservations_total` integer NOT NULL DEFAULT 3,
	`reservations_used` integer NOT NULL DEFAULT 0,
	`lease_owner` text,
	`lease_fence` text,
	`lease_expires_at` text,
	`next_eligible_at` text,
	`disposition` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`delivery_id`) REFERENCES `notification_deliveries`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_ndcs_delivery_channel` ON `notification_delivery_channel_states` (`delivery_id`,`channel_key`);
--> statement-breakpoint
CREATE INDEX `idx_ndcs_state_eligible` ON `notification_delivery_channel_states` (`state`,`next_eligible_at`,`lease_expires_at`);
--> statement-breakpoint
ALTER TABLE `notification_deliveries` ADD COLUMN `push_epoch` text DEFAULT 'restored' NOT NULL;
--> statement-breakpoint
UPDATE `notification_deliveries` SET `push_epoch` = 'legacy';
--> statement-breakpoint
INSERT INTO `notification_delivery_channel_states` (`id`, `delivery_id`, `channel_key`, `base_channel`, `destination_id`, `state`, `reservations_total`, `reservations_used`, `disposition`, `created_at`, `updated_at`)
SELECT lower(hex(randomblob(16))), `id`, 'backlog', NULL, NULL, 'backlog_not_attempted', 0, 0, 'pre-restoration backlog; push not attempted by user decision 2026-09-05', datetime('now'), datetime('now')
FROM `notification_deliveries`
WHERE `push_epoch` = 'legacy' AND `status` IN ('pending', 'snoozed', 'muted');
--> statement-breakpoint
-- Attempt rows gain an optional destination linkage so the worker can tie the
-- attempt it pre-creates for a reservation to the unit that spent it — needed
-- to terminalize a crashed owner's non-terminal attempt on lease-expiry
-- resume (multi-destination webhook units share base channel 'webhook').
-- Nullable: every pre-existing attempt row (and every non-webhook unit
-- attempt) has no destination. Additive; no attempt row is rewritten.
ALTER TABLE `notification_delivery_attempts` ADD COLUMN `destination_id` text;
