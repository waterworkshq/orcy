import { sqliteTable, text, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { habitats } from "./habitat.js";
import type { ReleaseType, DetectorSource } from "@orcy/shared";

/**
 * releases — durable record of every detected release per habitat (ADR-0030).
 *
 * Single source of truth for (a) release-type classification (the most recent
 * prior row is the semver-diff baseline), (b) idempotency (a row already
 * existing for `(habitatId, version)` means a duplicate trigger and is a
 * no-op), and (c) retrospective history (the release-log pulse cites real
 * rows, not ephemeral events). `version` is normalised at ingestion to strict
 * `MAJOR.MINOR.PATCH` (leading `v` stripped) so it is always strict semver.
 */
export const releases = sqliteTable(
  "releases",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    version: text("version").notNull(),
    releaseType: text("release_type").$type<ReleaseType>().notNull(),
    detectedBy: text("detected_by").$type<DetectorSource>().notNull(),
    releaseNotes: text("release_notes"),
    detectedAt: text("detected_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
  },
  (table) => [
    uniqueIndex("idx_releases_habitat_version").on(table.habitatId, table.version),
    index("idx_releases_habitat_detected").on(table.habitatId, table.detectedAt),
  ],
);
