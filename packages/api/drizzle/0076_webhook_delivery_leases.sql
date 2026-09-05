-- Webhook retry restoration: exclusive lease/fence ownership columns on
-- webhook_deliveries, plus the defensive backfill that makes every
-- pre-existing pending row due (NULL next_retry_at was the stranded legacy
-- shape the old NULL-hostile eligibility predicate could never select).
-- After this migration, the first worker ticks re-fire ALL pre-existing
-- pending deliveries — bounded by the 3-reservation budget per row.
ALTER TABLE `webhook_deliveries` ADD COLUMN `lease_owner` TEXT;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD COLUMN `lease_fence` TEXT;--> statement-breakpoint
ALTER TABLE `webhook_deliveries` ADD COLUMN `lease_expires_at` TEXT;--> statement-breakpoint
UPDATE `webhook_deliveries` SET `next_retry_at` = `created_at` WHERE `status` = 'pending' AND `next_retry_at` IS NULL;
