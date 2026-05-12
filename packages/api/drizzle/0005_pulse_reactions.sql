CREATE TABLE `pulse_reactions` (
  `id` text PRIMARY KEY NOT NULL,
  `pulse_id` text NOT NULL,
  `reactor_type` text NOT NULL,
  `reactor_id` text NOT NULL,
  `reaction` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`pulse_id`) REFERENCES `pulses`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_reactions_pulse` ON `pulse_reactions` (`pulse_id`);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_reactions_unique` ON `pulse_reactions` (`pulse_id`,`reactor_type`,`reactor_id`,`reaction`);
