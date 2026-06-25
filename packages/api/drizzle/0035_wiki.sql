CREATE TABLE wiki_pages (
  `id` text PRIMARY KEY NOT NULL,
  `habitat_id` text NOT NULL,
  `parent_id` text,
  `slug` text NOT NULL,
  `title` text NOT NULL,
  `content` text DEFAULT '' NOT NULL,
  `status` text DEFAULT 'draft' NOT NULL,
  `tags` text NOT NULL,
  `current_version_number` integer DEFAULT 1 NOT NULL,
  `created_by` text NOT NULL,
  `last_updated_by` text NOT NULL,
  `last_updated_at` text DEFAULT (datetime('now')) NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  `updated_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade,
  FOREIGN KEY (`parent_id`) REFERENCES `wiki_pages`(`id`) ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX idx_wiki_pages_habitat ON wiki_pages (`habitat_id`);
--> statement-breakpoint
CREATE INDEX idx_wiki_pages_parent ON wiki_pages (`parent_id`);
--> statement-breakpoint
CREATE INDEX idx_wiki_pages_habitat_status ON wiki_pages (`habitat_id`, `status`);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wiki_pages_slug_root ON wiki_pages (`habitat_id`, `slug`) WHERE `parent_id` IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wiki_pages_slug_child ON wiki_pages (`habitat_id`, `parent_id`, `slug`) WHERE `parent_id` IS NOT NULL;
--> statement-breakpoint
CREATE TABLE wiki_page_versions (
  `id` text PRIMARY KEY NOT NULL,
  `page_id` text NOT NULL,
  `version_number` integer NOT NULL,
  `title` text NOT NULL,
  `content` text NOT NULL,
  `edit_summary` text,
  `edited_by` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`page_id`) REFERENCES `wiki_pages`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_wiki_versions_page_num ON wiki_page_versions (`page_id`, `version_number`);
--> statement-breakpoint
CREATE INDEX idx_wiki_versions_page ON wiki_page_versions (`page_id`);
--> statement-breakpoint
CREATE TABLE wiki_page_links (
  `id` text PRIMARY KEY NOT NULL,
  `page_id` text NOT NULL,
  `target_type` text NOT NULL,
  `target_id` text NOT NULL,
  `link_note` text,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`page_id`) REFERENCES `wiki_pages`(`id`) ON DELETE cascade,
  UNIQUE(`page_id`, `target_type`, `target_id`)
);
--> statement-breakpoint
CREATE INDEX idx_wiki_links_page ON wiki_page_links (`page_id`);
--> statement-breakpoint
CREATE INDEX idx_wiki_links_target ON wiki_page_links (`target_type`, `target_id`);
--> statement-breakpoint
CREATE TABLE wiki_coverage_markers (
  `id` text PRIMARY KEY NOT NULL,
  `habitat_id` text NOT NULL,
  `coverage_from` text NOT NULL,
  `coverage_to` text NOT NULL,
  `marker_type` text NOT NULL,
  `page_id` text,
  `reason` text,
  `created_by` text NOT NULL,
  `created_at` text DEFAULT (datetime('now')) NOT NULL,
  FOREIGN KEY (`habitat_id`) REFERENCES `habitats`(`id`) ON DELETE cascade,
  FOREIGN KEY (`page_id`) REFERENCES `wiki_pages`(`id`) ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX idx_wiki_coverage_habitat ON wiki_coverage_markers (`habitat_id`);
--> statement-breakpoint
CREATE INDEX idx_wiki_coverage_page ON wiki_coverage_markers (`page_id`);
--> statement-breakpoint
CREATE INDEX idx_wiki_coverage_type ON wiki_coverage_markers (`habitat_id`, `marker_type`);
--> statement-breakpoint
CREATE VIRTUAL TABLE wiki_pages_fts USING fts5(title, content, CONTENT='wiki_pages', CONTENT_ROWID='rowid');
--> statement-breakpoint
CREATE TRIGGER wiki_pages_ai AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
--> statement-breakpoint
CREATE TRIGGER wiki_pages_ad AFTER DELETE ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
END;
--> statement-breakpoint
CREATE TRIGGER wiki_pages_au AFTER UPDATE ON wiki_pages BEGIN
  INSERT INTO wiki_pages_fts(wiki_pages_fts, rowid, title, content) VALUES ('delete', old.rowid, old.title, old.content);
  INSERT INTO wiki_pages_fts(rowid, title, content) VALUES (new.rowid, new.title, new.content);
END;
