-- Cover the bounded chronological prefix and its exact delivery scope lookups.
-- Existing delivery, retry and recipient indexes remain available to fallback reads.
CREATE INDEX `idx_notification_attempts_created_order`
  ON `notification_delivery_attempts` (`created_at`, `id`, `delivery_id`);
--> statement-breakpoint
CREATE INDEX `idx_notification_attempts_channel_created_order`
  ON `notification_delivery_attempts` (`channel`, `created_at`, `id`, `delivery_id`);
--> statement-breakpoint
CREATE INDEX `idx_notification_deliveries_scope_lookup`
  ON `notification_deliveries` (`id`, `habitat_id`);
