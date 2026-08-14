import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
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
      // RESTRICT since the 0068 enforcement migration: deleting the source
      // Pulse of a Finding row can no longer cascade away lifecycle history.
      .references(() => pulses.id, { onDelete: "restrict" }),
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

    // Physical column retained; domain mapper exposes it as canonical
    // correctiveMissionId (ADR-0048). RESTRICT since 0068 enforcement.
    triageMissionId: text("triage_mission_id").references(() => missions.id, {
      onDelete: "restrict",
    }),
    corroboratingPulseIds: text("corroborating_pulse_ids"),

    // --- Restored lifecycle additive provenance/lineage/activation fields ---
    /** Bounded Triage Mission identity for the investigation (distinct from corrective work). */
    admittedByTriageMissionId: text("admitted_by_triage_mission_id"),
    /** Exact Task whose live claim authorizes agent routing. */
    admittedByInvestigationTaskId: text("admitted_by_investigation_task_id"),
    /** Nullable predecessor link; traversal defines the complete lineage. */
    recurrenceOfId: text("recurrence_of_id"),
    /** Blocks automatic recurrence/agent mutation for ambiguous migrated lineage. */
    legacyLineageRepairRequired: integer("legacy_lineage_repair_required").notNull().default(0),
    /** Normalized immutable route fingerprint excluding actor/timestamps/Mission version. */
    routeFingerprint: text("route_fingerprint"),
    /** Activation timestamp. */
    activatedAt: text("activated_at"),
    /** Activation actor type. */
    activatedByType: text("activated_by_type"),
    /** Activation actor id. */
    activatedById: text("activated_by_id"),
    /** Activation cause: manual or release. */
    activationCause: text("activation_cause"),
    /** Release identity when activation_cause is 'release'. */
    activationReleaseId: text("activation_release_id"),
    // --- End restored lifecycle additive fields ---

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

/**
 * finding_triage_evidence — normalized Finding–Pulse evidence membership.
 *
 * Authoritative membership store. Each row links a finding triage record to a
 * Pulse with a role classifying the relationship. FKs are RESTRICT since the
 * 0068 enforcement migration — referenced Pulse/Finding deletion cannot
 * cascade away terminal evidence.
 */
export const findingTriageEvidence = sqliteTable(
  "finding_triage_evidence",
  {
    findingTriageId: text("finding_triage_id")
      .notNull()
      // RESTRICT since the 0068 enforcement migration.
      .references(() => findingTriage.id, { onDelete: "restrict" }),
    pulseId: text("pulse_id")
      .notNull()
      // RESTRICT since the 0068 enforcement migration: deleting the source
      // Pulse of a Finding row can no longer cascade away lifecycle history.
      .references(() => pulses.id, { onDelete: "restrict" }),
    role: text("role", {
      enum: ["source", "corroborating", "legacy_observed"],
    }).notNull(),
    admittedByTriageMissionId: text("admitted_by_triage_mission_id"),
    admittedByInvestigationTaskId: text("admitted_by_investigation_task_id"),
    admittedAt: text("admitted_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_finding_triage_evidence_finding").on(table.findingTriageId),
    index("idx_finding_triage_evidence_pulse").on(table.pulseId),
    index("idx_finding_triage_evidence_role").on(table.role),
  ],
);

/**
 * finding_triage_lineage_repairs — append-only audit ledger for offline
 * lineage repair operations. Each row records one repair event with
 * mode, affected identity, operator, reason, before/after mapping, and
 * input snapshot digest for replay verification.
 */
export const findingTriageLineageRepairs = sqliteTable(
  "finding_triage_lineage_repairs",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    clusterKey: text("cluster_key").notNull(),
    findingKind: text("finding_kind").notNull(),
    mode: text("mode", {
      enum: ["predecessor_mapping", "evidence_baselined_root"],
    }).notNull(),
    affectedIdentity: text("affected_identity").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    repairTime: text("repair_time")
      .notNull()
      .default(sql`(datetime('now'))`),
    beforeMapping: text("before_mapping", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
    afterMapping: text("after_mapping", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
    inputSnapshotDigest: text("input_snapshot_digest").notNull(),
    cutoffTimestamp: text("cutoff_timestamp"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_finding_triage_lineage_repairs_habitat").on(table.habitatId, table.clusterKey),
    index("idx_finding_triage_lineage_repairs_identity").on(
      table.habitatId,
      table.clusterKey,
      table.findingKind,
    ),
  ],
);

/**
 * finding_triage_lineage_baseline_evidence — normalized (repair_id, pulse_id)
 * evidence baseline for evidence-baselined-root repairs. Each row carries
 * a digest of the baseline content for replay verification.
 */
export const findingTriageLineageBaselineEvidence = sqliteTable(
  "finding_triage_lineage_baseline_evidence",
  {
    repairId: text("repair_id")
      .notNull()
      .references(() => findingTriageLineageRepairs.id, { onDelete: "cascade" }),
    pulseId: text("pulse_id").notNull(),
    digest: text("digest").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [index("idx_finding_triage_baseline_repair").on(table.repairId)],
);

/**
 * triage_publication_occurrences — first-writer-frozen canonical occurrence
 * store for structured Finding cluster intake.
 *
 * One row per canonical candidate identity (`id` = versioned digest of the
 * canonical candidate snapshot; `snapshot_digest` UNIQUE enforces one row per
 * lifecycle/pulse snapshot). The FIRST writer freezes the first rendered
 * payload and the COMPLETE prepared Mission/Task/workflow aggregate; conflict
 * losers and later replays publish ONLY the persisted snapshot — the mutable
 * template is never reread after the winner commits.
 */
export const triagePublicationOccurrences = sqliteTable(
  "triage_publication_occurrences",
  {
    /** Versioned canonical occurrence id: `tpo-v1:<sha256(JCS(candidate_snapshot))>`. */
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    clusterKey: text("cluster_key").notNull(),
    /** Occurrence identity schema version (bumped when the snapshot shape changes). */
    occurrenceVersion: integer("occurrence_version").notNull(),
    /** Canonical JSON of the candidate snapshot (sorted identities, predecessors, sorted novel Pulse ids). */
    candidateSnapshot: text("candidate_snapshot").notNull(),
    /** sha256 of the canonical candidate snapshot — the unique lifecycle/pulse snapshot identity. */
    snapshotDigest: text("snapshot_digest").notNull().unique(),
    /** Canonical JSON of the first rendered payload (title/description/variables). */
    renderedPayload: text("rendered_payload").notNull(),
    /** Canonical JSON of the COMPLETE prepared Mission/Task/workflow aggregate. */
    preparedAggregate: text("prepared_aggregate").notNull(),
    /** sha256 of the canonical prepared aggregate. */
    preparedDigest: text("prepared_digest").notNull(),
    /** The mission template the winner rendered from. */
    templateId: text("template_id").notNull(),
    /** sha256 of the canonical template-definition snapshot (provenance only — never identity). */
    templateDigest: text("template_digest").notNull(),
    /** Distinguishes the winning insert from a conflicting re-reader (portable winner detection). */
    winnerNonce: text("winner_nonce").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_triage_publication_occurrences_cluster").on(table.habitatId, table.clusterKey),
    index("idx_triage_publication_occurrences_template").on(table.templateId),
  ],
);

/**
 * migration_preflight_attestations — DB-local clean-result attestation keyed
 * by enforcement migration id + schema/preflight version. Records THIS
 * database's local preflight result and timestamp. NOT a fleet assertion.
 */
export const migrationPreflightAttestations = sqliteTable(
  "migration_preflight_attestations",
  {
    enforcementMigrationId: text("enforcement_migration_id").notNull(),
    schemaVersion: text("schema_version").notNull(),
    preflightVersion: text("preflight_version").notNull(),
    anomalyQueryDigest: text("anomaly_query_digest").notNull(),
    clean: integer("clean").notNull(),
    anomalyReport: text("anomaly_report"),
    attestedAt: text("attested_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [],
);
