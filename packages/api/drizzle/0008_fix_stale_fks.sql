-- Migration: 0008_fix_stale_fks
-- Fixes stale FK references in `pulses` table.
--
-- After v0.10.0 naming unification, the `pulses` table still has FK definitions
-- referencing `boards` and `features` (from migrations 0001/0003). In production,
-- ALTER TABLE RENAME cascaded the FK updates for upgraded databases, but fresh
-- installs never got the cascade (0007 was not in drizzle journal).
--
-- This migration recreates `pulses` with correct FK references to `habitats` and
-- `missions`. It works in both column-name states:
--   - State A: column 3 is still `board_id` (fresh install, 0007 not applied)
--   - State B: column 3 is already `habitat_id` (0007 applied or test DB)
--
-- Uses positional INSERT/SELECT (column 3 maps board_id → habitat_id in new table).
-- `project_insights` was already fixed by migration 0006.
-- `pulse_cursors` has no FK references (redesigned in 0003 to use scope_key only).

PRAGMA foreign_keys=OFF;

--> statement-breakpoint

CREATE TABLE `__new_pulses` (
  `id` text PRIMARY KEY NOT NULL,
  `mission_id` text,
  `habitat_id` text NOT NULL,
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
  FOREIGN KEY (`mission_id`) REFERENCES `missions`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE CASCADE,
  FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL,
  FOREIGN KEY (`linked_task_id`) REFERENCES `tasks`(`id`) ON DELETE SET NULL
);

--> statement-breakpoint

INSERT INTO `__new_pulses` SELECT * FROM `pulses`;

--> statement-breakpoint

DROP TABLE `pulses`;

--> statement-breakpoint

ALTER TABLE `__new_pulses` RENAME TO `pulses`;

--> statement-breakpoint

CREATE INDEX `idx_pulses_mission` ON `pulses` (`mission_id`);

--> statement-breakpoint

CREATE INDEX `idx_pulses_habitat` ON `pulses` (`habitat_id`);

--> statement-breakpoint

CREATE INDEX `idx_pulses_scope` ON `pulses` (`scope`);

--> statement-breakpoint

CREATE INDEX `idx_pulses_habitat_scope` ON `pulses` (`habitat_id`, `scope`);

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

CREATE INDEX `idx_pulses_thread` ON `pulses` (`reply_to_id`, `created_at`);

--> statement-breakpoint

PRAGMA foreign_keys=ON;
