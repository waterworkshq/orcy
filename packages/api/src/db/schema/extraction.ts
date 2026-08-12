/**
 * Learning Loop extraction ledger — Drizzle schema mirror of
 * `drizzle/0063_learning_loop_ledger.sql`.
 *
 * The hand-written SQL migration is the authority; this file mirrors every
 * column, type, default, and index so that `drizzle-kit` stays consistent and
 * the repository layer has typed table objects. See ADR-0044.
 *
 * Cross-chain provenance pointers (first_attempt_id, last_seen_attempt_id,
 * completed_by_attempt_id, parent_attempt_id, supersedes_*, lineage_root_id,
 * derived_from_source_id) are plain text columns WITHOUT `.references()` —
 * mirroring the SQL where they have no FK constraint. The habitat_id CASCADE
 * chain handles cleanup; these are application-layer invariants.
 */
import { sqliteTable, text, integer, real, uniqueIndex, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { habitats } from "./habitat.js";
import type {
  ExtractionSourceType,
  ExtractionWorkStatus,
  ExtractionAttemptStatus,
  ExtractionDeliveryMode,
  ExtractionFindingType,
  ExtractionFindingCompleteness,
  ExtractionVisibilityClass,
  ExtractionFindingStatus,
  ExtractionCitationRole,
  ExtractionSourceCompleteness,
  ExtractionScopeType,
  ExtractionReviewDecision,
  ExtractionPromotionDestination,
  ExtractionPromotionStatus,
} from "@orcy/shared";

// ---------------------------------------------------------------------------
// 1. learning_loop_policies
// ---------------------------------------------------------------------------

export const learningLoopPolicies = sqliteTable(
  "learning_loop_policies",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    extractorKey: text("extractor_key").notNull(),
    enabled: integer("enabled").notNull().default(0),
    sourceTypes: text("source_types", { mode: "json" })
      .$type<ExtractionSourceType[]>()
      .notNull()
      .default(sql`'[]'`)
      .$defaultFn(() => []),
    schedule: text("schedule").notNull(),
    windowSeconds: integer("window_seconds").notNull(),
    lookbackSeconds: integer("lookback_seconds").notNull(),
    minConfidence: real("min_confidence"),
    minSampleSize: integer("min_sample_size"),
    config: text("config", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
    version: integer("version").notNull().default(1),
    createdByType: text("created_by_type").notNull().default("human"),
    createdById: text("created_by_id"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("uq_learning_loop_policies_habitat_extractor").on(
      table.habitatId,
      table.extractorKey,
    ),
    index("idx_learning_loop_policies_habitat").on(table.habitatId),
    index("idx_learning_loop_policies_habitat_enabled").on(
      table.habitatId,
      table.enabled,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 2. extraction_work_items
// ---------------------------------------------------------------------------

export const extractionWorkItems = sqliteTable(
  "extraction_work_items",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    policyId: text("policy_id").references(() => learningLoopPolicies.id, {
      onDelete: "set null",
    }),
    extractorKey: text("extractor_key").notNull(),
    extractorVersion: integer("extractor_version").notNull(),
    policyVersion: integer("policy_version").notNull(),
    windowFrom: text("window_from").notNull(),
    windowTo: text("window_to").notNull(),
    sourceBoundaryTokens: text("source_boundary_tokens", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
    logicalWorkKey: text("logical_work_key").notNull(),
    deliveryMode: text("delivery_mode").$type<ExtractionDeliveryMode>().notNull(),
    rerunGeneration: integer("rerun_generation").notNull().default(0),
    supersedesWorkId: text("supersedes_work_id"),
    freshReason: text("fresh_reason"),
    status: text("status").$type<ExtractionWorkStatus>().notNull().default("pending"),
    completedByAttemptId: text("completed_by_attempt_id"),
    policySnapshot: text("policy_snapshot", { mode: "json" })
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
    uniqueIndex("uq_extraction_work_items_logical_key").on(table.logicalWorkKey),
    index("idx_extraction_work_items_habitat_status").on(
      table.habitatId,
      table.status,
    ),
    index("idx_extraction_work_items_policy").on(table.policyId),
    index("idx_extraction_work_items_habitat_extractor").on(
      table.habitatId,
      table.extractorKey,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 3. extraction_attempts
// ---------------------------------------------------------------------------

export const extractionAttempts = sqliteTable(
  "extraction_attempts",
  {
    id: text("id").primaryKey(),
    workItemId: text("work_item_id")
      .notNull()
      .references(() => extractionWorkItems.id, { onDelete: "cascade" }),
    attemptNo: integer("attempt_no").notNull(),
    parentAttemptId: text("parent_attempt_id"),
    deliveryMode: text("delivery_mode").$type<ExtractionDeliveryMode>().notNull(),
    leaseOwner: text("lease_owner").notNull(),
    leaseGeneration: integer("lease_generation").notNull(),
    leaseExpiresAt: text("lease_expires_at").notNull(),
    sourceSnapshot: text("source_snapshot", { mode: "json" })
      .$type<Record<string, unknown>[]>()
      .notNull()
      .default(sql`'[]'`)
      .$defaultFn(() => []),
    status: text("status").$type<ExtractionAttemptStatus>().notNull().default("running"),
    candidateCount: integer("candidate_count").notNull().default(0),
    persistedCount: integer("persisted_count").notNull().default(0),
    deduplicatedCount: integer("deduplicated_count").notNull().default(0),
    error: text("error"),
    startedAt: text("started_at"),
    completedAt: text("completed_at"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("uq_extraction_attempts_work_no").on(
      table.workItemId,
      table.attemptNo,
    ),
    index("idx_extraction_attempts_work_status").on(
      table.workItemId,
      table.status,
    ),
    index("idx_extraction_attempts_lease_recovery").on(
      table.status,
      table.leaseExpiresAt,
    ),
    index("idx_extraction_attempts_owner").on(table.leaseOwner, table.status),
  ],
);

// ---------------------------------------------------------------------------
// 4. extracted_findings
// ---------------------------------------------------------------------------

export const extractedFindings = sqliteTable(
  "extracted_findings",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    firstAttemptId: text("first_attempt_id").notNull(),
    lastSeenAttemptId: text("last_seen_attempt_id").notNull(),
    lineageRootId: text("lineage_root_id").notNull(),
    supersedesFindingId: text("supersedes_finding_id"),
    revision: integer("revision").notNull(),
    extractorKey: text("extractor_key").notNull(),
    extractorVersion: integer("extractor_version").notNull(),
    findingType: text("finding_type").$type<ExtractionFindingType>().notNull(),
    subject: text("subject").notNull(),
    body: text("body").notNull(),
    structuredPayload: text("structured_payload", { mode: "json" }).$type<unknown>(),
    confidence: real("confidence").notNull(),
    sampleSize: integer("sample_size").notNull(),
    completeness: text("completeness").$type<ExtractionFindingCompleteness>().notNull(),
    visibilityCeiling: text("visibility_ceiling").$type<ExtractionVisibilityClass>().notNull(),
    fingerprint: text("fingerprint").notNull(),
    evidenceDigest: text("evidence_digest").notNull(),
    status: text("status").$type<ExtractionFindingStatus>().notNull().default("proposed"),
    decisionVersion: integer("decision_version").notNull().default(1),
    firstSeenAt: text("first_seen_at").notNull(),
    lastSeenAt: text("last_seen_at").notNull(),
    occurrenceCount: integer("occurrence_count").notNull().default(1),
    caveats: text("caveats", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`)
      .$defaultFn(() => []),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("uq_extracted_findings_recurrence").on(
      table.habitatId,
      table.extractorKey,
      table.extractorVersion,
      table.fingerprint,
      table.evidenceDigest,
    ),
    uniqueIndex("uq_extracted_findings_lineage").on(
      table.lineageRootId,
      table.revision,
    ),
    index("idx_extracted_findings_habitat_status").on(
      table.habitatId,
      table.status,
    ),
    index("idx_extracted_findings_habitat_type").on(
      table.habitatId,
      table.findingType,
    ),
    index("idx_extracted_findings_fingerprint").on(
      table.fingerprint,
      table.evidenceDigest,
    ),
    index("idx_extracted_findings_attempt").on(table.firstAttemptId),
  ],
);

// ---------------------------------------------------------------------------
// 5. extracted_finding_sources (citations)
// ---------------------------------------------------------------------------

export const extractedFindingSources = sqliteTable(
  "extracted_finding_sources",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => extractedFindings.id, { onDelete: "cascade" }),
    sourceType: text("source_type").$type<ExtractionSourceType>().notNull(),
    sourceId: text("source_id").notNull(),
    sourceVersion: text("source_version").notNull().default(""),
    role: text("role").$type<ExtractionCitationRole>().notNull(),
    sourceDigest: text("source_digest"),
    occurredAt: text("occurred_at"),
    entityRefs: text("entity_refs", { mode: "json" })
      .$type<Array<{ type: string; id: string }>>()
      .notNull()
      .default(sql`'[]'`)
      .$defaultFn(() => []),
    completeness: text("completeness").$type<ExtractionSourceCompleteness>().notNull().default("complete"),
    visibilityClass: text("visibility_class").$type<ExtractionVisibilityClass>().notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("uq_extracted_finding_sources_citation").on(
      table.findingId,
      table.sourceType,
      table.sourceId,
      table.sourceVersion,
    ),
    index("idx_extracted_finding_sources_finding").on(table.findingId),
  ],
);

// ---------------------------------------------------------------------------
// 6. extracted_finding_scope_refs
// ---------------------------------------------------------------------------

export const extractedFindingScopeRefs = sqliteTable(
  "extracted_finding_scope_refs",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => extractedFindings.id, { onDelete: "cascade" }),
    scopeType: text("scope_type").$type<ExtractionScopeType>().notNull(),
    scopeId: text("scope_id").notNull(),
    derivedFromSourceId: text("derived_from_source_id").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("uq_extracted_finding_scope_refs_finding_scope").on(
      table.findingId,
      table.scopeType,
      table.scopeId,
    ),
    index("idx_extracted_finding_scope_refs_scope").on(
      table.scopeType,
      table.scopeId,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 7. extracted_finding_reviews
// ---------------------------------------------------------------------------

export const extractedFindingReviews = sqliteTable(
  "extracted_finding_reviews",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => extractedFindings.id, { onDelete: "cascade" }),
    decision: text("decision").$type<ExtractionReviewDecision>().notNull(),
    reason: text("reason"),
    reviewerType: text("reviewer_type").notNull(),
    reviewerId: text("reviewer_id").notNull(),
    expectedDecisionVersion: integer("expected_decision_version").notNull(),
    resultingDecisionVersion: integer("resulting_decision_version").notNull(),
    resolvedCitationStates: text("resolved_citation_states", { mode: "json" })
      .$type<Array<{ sourceId: string; state: string }>>()
      .notNull()
      .default(sql`'[]'`)
      .$defaultFn(() => []),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_extracted_finding_reviews_finding").on(table.findingId),
    index("idx_extracted_finding_reviews_finding_created").on(
      table.findingId,
      table.createdAt,
    ),
  ],
);

// ---------------------------------------------------------------------------
// 8. extracted_finding_promotions
// ---------------------------------------------------------------------------

export const extractedFindingPromotions = sqliteTable(
  "extracted_finding_promotions",
  {
    id: text("id").primaryKey(),
    findingId: text("finding_id")
      .notNull()
      .references(() => extractedFindings.id, { onDelete: "cascade" }),
    destinationType: text("destination_type").$type<ExtractionPromotionDestination>().notNull(),
    destinationKey: text("destination_key").notNull(),
    status: text("status").$type<ExtractionPromotionStatus>().notNull().default("pending"),
    idempotencyKey: text("idempotency_key").notNull(),
    leaseOwner: text("lease_owner").notNull(),
    leaseGeneration: integer("lease_generation").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    targetVersion: text("target_version"),
    consumedFindingRevision: integer("consumed_finding_revision").notNull(),
    error: text("error"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("uq_extracted_finding_promotions_finding_dest").on(
      table.findingId,
      table.destinationType,
      table.destinationKey,
    ),
    index("idx_extracted_finding_promotions_status").on(table.status),
  ],
);
