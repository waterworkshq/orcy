import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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

/**
 * release_projection_deliveries — ONE durable delivery row per
 * (release, projection_kind) (restored lifecycle T7). `pending` means the
 * projection is retryable on the next Release replay; `completed` is final.
 * `outputIdentity` records the projection-specific output identity (epoch
 * summary / notification event id / pulse id / inbox id) so replay
 * distinguishes already-delivered from merely reserved.
 */
export const RELEASE_PROJECTION_KINDS = [
  "activation_reconciliation",
  "deadline_notification",
  "activation_notification",
  "retrospective_pulse",
  "release_shipped",
] as const;

export type ReleaseProjectionKind = (typeof RELEASE_PROJECTION_KINDS)[number];

export const releaseProjectionDeliveries = sqliteTable(
  "release_projection_deliveries",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    projectionKind: text("projection_kind").$type<ReleaseProjectionKind>().notNull(),
    state: text("state", { enum: ["pending", "completed"] }).notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    outputIdentity: text("output_identity", { mode: "json" }).$type<Record<
      string,
      unknown
    > | null>(),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_release_projection_release_kind").on(table.releaseId, table.projectionKind),
    index("idx_release_projection_state").on(table.state),
  ],
);

/**
 * release_activation_epochs — exactly ONE immutable activation epoch per
 * Release, created atomically with the Release and its projection rows. The
 * epoch freezes the configured Finding-count cap (null = unlimited) and the
 * epoch-wide eligibility digest. `completedAt` means the frozen epoch is
 * final and never reopens.
 */
export const releaseActivationEpochs = sqliteTable(
  "release_activation_epochs",
  {
    id: text("id").primaryKey(),
    releaseId: text("release_id")
      .notNull()
      .unique()
      .references(() => releases.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    frozenCap: integer("frozen_cap"),
    autoPromoteEnabled: integer("auto_promote_enabled").notNull().default(1),
    eligibilityDigest: text("eligibility_digest").notNull(),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_release_epochs_habitat").on(table.habitatId)],
);

/**
 * release_activation_epoch_groups — immutable frozen corrective-Mission
 * groups. `position` is the deterministic eligible order (mission createdAt,
 * then id, captured at freeze). `findingIds` is the exact frozen Finding
 * membership. `disposition` only ever moves `pending` → terminal; terminal
 * dispositions and the activated-finding attribution are immutable.
 */
export const EPOCH_GROUP_DISPOSITIONS = [
  "pending",
  "activated",
  "deferred_changed",
  "deferred_oversized",
  "deferred_budget",
] as const;

export type EpochGroupDisposition = (typeof EPOCH_GROUP_DISPOSITIONS)[number];

export const releaseActivationEpochGroups = sqliteTable(
  "release_activation_epoch_groups",
  {
    id: text("id").primaryKey(),
    epochId: text("epoch_id")
      .notNull()
      .references(() => releaseActivationEpochs.id, { onDelete: "cascade" }),
    releaseId: text("release_id")
      .notNull()
      .references(() => releases.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id").notNull(),
    missionId: text("mission_id").notNull(),
    missionCreatedAt: text("mission_created_at").notNull(),
    position: integer("position").notNull(),
    findingIds: text("finding_ids", { mode: "json" }).$type<string[]>().notNull(),
    gateType: text("gate_type"),
    gateVersion: text("gate_version"),
    membershipDigest: text("membership_digest").notNull(),
    disposition: text("disposition").$type<EpochGroupDisposition>().notNull().default("pending"),
    dispositionAt: text("disposition_at"),
    dispositionDetail: text("disposition_detail"),
    activatedFindingCount: integer("activated_finding_count"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_release_epoch_groups_epoch_mission").on(table.epochId, table.missionId),
    index("idx_release_epoch_groups_epoch").on(table.epochId, table.position),
    index("idx_release_epoch_groups_disposition").on(table.disposition),
  ],
);
