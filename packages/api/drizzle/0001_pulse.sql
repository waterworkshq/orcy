CREATE TABLE `pulses` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text NOT NULL,
  `board_id` text NOT NULL,
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
  `metadata` text NOT NULL DEFAULT '{}',
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `pinned` integer DEFAULT 0 NOT NULL,
  `is_auto` integer DEFAULT 0 NOT NULL,
  FOREIGN KEY (`mission_id`) REFERENCES `features`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`board_id`) REFERENCES `boards`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`linked_task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE INDEX `idx_pulses_mission` ON `pulses` (`mission_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_board` ON `pulses` (`board_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_signal_type` ON `pulses` (`signal_type`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_from` ON `pulses` (`from_type`, `from_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_to` ON `pulses` (`to_type`, `to_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_task` ON `pulses` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_created` ON `pulses` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_reply_to` ON `pulses` (`reply_to_id`);
--> statement-breakpoint
CREATE TABLE `pulse_cursors` (
  `mission_id` text NOT NULL,
  `reader_type` text NOT NULL,
  `reader_id` text NOT NULL,
  `last_checked_at` text DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY (`mission_id`, `reader_type`, `reader_id`),
  FOREIGN KEY (`mission_id`) REFERENCES `features`(`id`) ON DELETE CASCADE
);
