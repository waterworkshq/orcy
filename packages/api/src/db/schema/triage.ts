import { sqliteTable, text, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { habitats, missions } from "./habitat.js";
import { pulses } from "./pulse.js";
import { SUGGESTED_BUCKETS } from "@orcy/shared";

/**
 * finding_triage — lifecycle record for a structured Engineering Finding pulse.
 *
 * Parallel-table design (ADR-0027): the triage lifecycle outlives the source
 * pulse. The pulse retains a write-once `findingTriageId` pointer; all status
 * mutations happen on this table. `clusterKey` and `findingKind` are
 * denormalised from the pulse at creation to avoid a join on every dedup
 * check.
 */
export const findingTriage = sqliteTable(
  "finding_triage",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    pulseId: text("pulse_id")
      .notNull()
      .references(() => pulses.id, { onDelete: "cascade" }),
    clusterKey: text("cluster_key").notNull(),
    findingKind: text("finding_kind").notNull(),

    status: text("status", {
      enum: ["open", "triaged", "in_progress", "resolved", "wontfix"],
    })
      .notNull()
      .default("open"),
    bucket: text("bucket", { enum: SUGGESTED_BUCKETS }),
    targetRelease: text("target_release"),
    targetReleaseType: text("target_release_type"),

    triageMissionId: text("triage_mission_id").references(() => missions.id, {
      onDelete: "set null",
    }),
    corroboratingPulseIds: text("corroborating_pulse_ids"),

    triagedByType: text("triaged_by_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }),
    triagedById: text("triaged_by_id"),
    triagedAt: text("triaged_at"),

    resolvedByType: text("resolved_by_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }),
    resolvedById: text("resolved_by_id"),
    resolvedAt: text("resolved_at"),
    resolutionNote: text("resolution_note"),

    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_finding_triage_habitat_status").on(table.habitatId, table.status),
    index("idx_finding_triage_habitat_bucket").on(table.habitatId, table.bucket),
    index("idx_finding_triage_pulse").on(table.pulseId),
    index("idx_finding_triage_dedup").on(table.habitatId, table.clusterKey, table.findingKind),
    index("idx_finding_triage_mission").on(table.triageMissionId),
  ],
);

/**
 * triage_resolutions — unified resolution store keyed by clusterKey for
 * proactive matching (PRD AC-PROACTIVE). Sources: cluster triage and
 * finding triage. `sourceId` points at the originating mission or finding.
 */
export const triageResolutions = sqliteTable(
  "triage_resolutions",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    clusterKey: text("cluster_key").notNull(),
    skillCategory: text("skill_category").notNull(),

    source: text("source", {
      enum: ["cluster_triage", "finding_triage"],
    }).notNull(),
    sourceId: text("source_id").notNull(),

    rootCause: text("root_cause"),
    resolution: text("resolution"),
    resolutionKind: text("resolution_kind", {
      enum: [
        "config_change",
        "doc_clarification",
        "code_fix",
        "process_change",
        "wontfix",
        "other",
      ],
    }),

    resolvedByType: text("resolved_by_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }),
    resolvedById: text("resolved_by_id"),
    resolvedAt: text("resolved_at")
      .notNull()
      .default(sql`(datetime('now'))`),

    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
  },
  (table) => [
    index("idx_triage_resolutions_habitat_cluster").on(table.habitatId, table.clusterKey),
    index("idx_triage_resolutions_source").on(table.source, table.sourceId),
  ],
);

/**
 * triage_cluster_missions — junction linking cluster triage missions to their
 * clusterKey for active-triage suppression (AC-REACTIVE-8). No unique index:
 * the same clusterKey may have multiple records over time (resolves, cluster
 * re-emerges, new triage). The scan queries WHERE habitatId AND clusterKey
 * AND status='open' — any open record suppresses.
 */
export const triageClusterMissions = sqliteTable(
  "triage_cluster_missions",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    clusterKey: text("cluster_key").notNull(),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    status: text("status", { enum: ["open", "resolved"] })
      .notNull()
      .default("open"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    resolvedAt: text("resolved_at"),
  },
  (table) => [
    index("idx_triage_cluster_missions_habitat_cluster").on(
      table.habitatId,
      table.clusterKey,
      table.status,
    ),
    index("idx_triage_cluster_missions_mission").on(table.missionId),
  ],
);
