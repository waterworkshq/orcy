-- Recreate pulses with nullable mission_id + scope column (ADR-007)
CREATE TABLE `pulses_new` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text,
  `board_id` text NOT NULL,
  `scope` text DEFAULT 'mission' NOT NULL,
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
INSERT INTO `pulses_new`
  SELECT `id`, `mission_id`, `board_id`, 'mission', `from_type`, `from_id`,
         `to_type`, `to_id`, `signal_type`, `subject`, `body`, `task_id`,
         `reply_to_id`, `linked_task_id`, `metadata`, `created_at`, `pinned`, `is_auto`
  FROM `pulses`;
--> statement-breakpoint
CREATE INDEX `idx_pulses_mission` ON `pulses_new` (`mission_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_board` ON `pulses_new` (`board_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_scope` ON `pulses_new` (`scope`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_board_scope` ON `pulses_new` (`board_id`, `scope`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_signal_type` ON `pulses_new` (`signal_type`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_from` ON `pulses_new` (`from_type`, `from_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_to` ON `pulses_new` (`to_type`, `to_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_task` ON `pulses_new` (`task_id`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_created` ON `pulses_new` (`created_at`);
--> statement-breakpoint
CREATE INDEX `idx_pulses_reply_to` ON `pulses_new` (`reply_to_id`);
--> statement-breakpoint
DROP TABLE `pulses`;
--> statement-breakpoint
ALTER TABLE `pulses_new` RENAME TO `pulses`;
--> statement-breakpoint
-- Recreate pulse_cursors with generic scope_key replacing mission_id
CREATE TABLE `pulse_cursors_new` (
  `scope_key` text NOT NULL,
  `scope` text DEFAULT 'mission' NOT NULL,
  `reader_type` text NOT NULL,
  `reader_id` text NOT NULL,
  `last_checked_at` text DEFAULT (datetime('now')) NOT NULL,
  PRIMARY KEY (`scope_key`, `reader_type`, `reader_id`)
);
--> statement-breakpoint
INSERT INTO `pulse_cursors_new`
  SELECT `mission_id`, 'mission', `reader_type`, `reader_id`, `last_checked_at`
  FROM `pulse_cursors`;
--> statement-breakpoint
DROP TABLE `pulse_cursors`;
--> statement-breakpoint
ALTER TABLE `pulse_cursors_new` RENAME TO `pulse_cursors`;
