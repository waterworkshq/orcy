import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import type { AnySQLiteColumn } from "drizzle-orm/sqlite-core";
import { habitats } from "./board.js";

/** Current page state and denormalized current-version content for habitat Wiki Pages. */
export const wikiPages = sqliteTable(
  "wiki_pages",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    parentId: text("parent_id").references((): AnySQLiteColumn => wikiPages.id, {
      onDelete: "no action",
    }),
    slug: text("slug").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull().default(""),
    status: text("status", { enum: ["draft", "published"] })
      .notNull()
      .default("draft"),
    tags: text("tags", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    currentVersionNumber: integer("current_version_number").notNull().default(1),
    createdBy: text("created_by").notNull(),
    lastUpdatedBy: text("last_updated_by").notNull(),
    lastUpdatedAt: text("last_updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_wiki_pages_habitat").on(table.habitatId),
    index("idx_wiki_pages_parent").on(table.parentId),
    index("idx_wiki_pages_habitat_status").on(table.habitatId, table.status),
  ],
);

/** Append-only version history table for every Wiki Page save and restore operation. */
export const wikiPageVersions = sqliteTable(
  "wiki_page_versions",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    content: text("content").notNull(),
    editSummary: text("edit_summary"),
    editedBy: text("edited_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_wiki_versions_page_num").on(table.pageId, table.versionNumber),
    index("idx_wiki_versions_page").on(table.pageId),
  ],
);

/** Polymorphic citation table linking Wiki Pages to source primitives without target FKs. */
export const wikiPageLinks = sqliteTable(
  "wiki_page_links",
  {
    id: text("id").primaryKey(),
    pageId: text("page_id")
      .notNull()
      .references(() => wikiPages.id, { onDelete: "cascade" }),
    targetType: text("target_type").notNull(),
    targetId: text("target_id").notNull(),
    linkNote: text("link_note"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_wiki_links_page_target").on(table.pageId, table.targetType, table.targetId),
    index("idx_wiki_links_page").on(table.pageId),
    index("idx_wiki_links_target").on(table.targetType, table.targetId),
  ],
);

/** Authored coverage records that advance or hold the per-habitat wiki cadence watermark. */
export const wikiCoverageMarkers = sqliteTable(
  "wiki_coverage_markers",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    coverageFrom: text("coverage_from").notNull(),
    coverageTo: text("coverage_to").notNull(),
    markerType: text("marker_type", { enum: ["page", "no_update_needed"] }).notNull(),
    pageId: text("page_id").references(() => wikiPages.id, { onDelete: "cascade" }),
    reason: text("reason"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_wiki_coverage_habitat").on(table.habitatId),
    index("idx_wiki_coverage_page").on(table.pageId),
    index("idx_wiki_coverage_type").on(table.habitatId, table.markerType),
  ],
);
