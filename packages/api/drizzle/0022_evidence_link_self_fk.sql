-- Add self-referencing FK on code_evidence_links.replacement_link_id
-- SQLite requires a table rebuild to add FK constraints.
PRAGMA foreign_keys = OFF;
--> statement-breakpoint

CREATE TABLE `code_evidence_links_new` (
  `id` text PRIMARY KEY NOT NULL,
  `target_type` text NOT NULL,
  `target_id` text NOT NULL,
  `evidence_type` text NOT NULL,
  `evidence_id` text,
  `external_url` text,
  `normalized_external_url` text,
  `title` text,
  `description` text,
  `link_source` text NOT NULL,
  `link_sources` text NOT NULL DEFAULT '[]',
  `linked_by_type` text NOT NULL,
  `linked_by_id` text NOT NULL,
  `linked_at` text NOT NULL DEFAULT (datetime('now')),
  `verification_state` text NOT NULL DEFAULT 'unverified',
  `confidence` real,
  `status` text NOT NULL DEFAULT 'active',
  `corrected_by_type` text,
  `corrected_by_id` text,
  `corrected_at` text,
  `correction_reason` text,
  `replacement_link_id` text REFERENCES `code_evidence_links`(`id`) ON DELETE SET NULL,
  `allow_external_repository` integer NOT NULL DEFAULT 0,
  `metadata` text NOT NULL DEFAULT '{}'
);
--> statement-breakpoint

INSERT INTO `code_evidence_links_new` (
  `id`, `target_type`, `target_id`, `evidence_type`, `evidence_id`,
  `external_url`, `normalized_external_url`, `title`, `description`,
  `link_source`, `link_sources`, `linked_by_type`, `linked_by_id`,
  `linked_at`, `verification_state`, `confidence`, `status`,
  `corrected_by_type`, `corrected_by_id`, `corrected_at`, `correction_reason`,
  `replacement_link_id`, `allow_external_repository`, `metadata`
)
SELECT
  `id`, `target_type`, `target_id`, `evidence_type`, `evidence_id`,
  `external_url`, `normalized_external_url`, `title`, `description`,
  `link_source`, `link_sources`, `linked_by_type`, `linked_by_id`,
  `linked_at`, `verification_state`, `confidence`, `status`,
  `corrected_by_type`, `corrected_by_id`, `corrected_at`, `correction_reason`,
  `replacement_link_id`, `allow_external_repository`, `metadata`
FROM `code_evidence_links`;
--> statement-breakpoint

DROP TABLE `code_evidence_links`;
--> statement-breakpoint

ALTER TABLE `code_evidence_links_new` RENAME TO `code_evidence_links`;
--> statement-breakpoint

PRAGMA foreign_keys = ON;

-- Recreate indexes that were on the original table
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_evidence_links_target_status` ON `code_evidence_links` (`target_type`, `target_id`, `status`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_evidence_links_evidence` ON `code_evidence_links` (`evidence_type`, `evidence_id`);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS `idx_code_evidence_links_linked_by` ON `code_evidence_links` (`linked_by_type`, `linked_by_id`);
