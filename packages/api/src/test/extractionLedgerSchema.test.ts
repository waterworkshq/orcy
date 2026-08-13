/**
 * Learning Loop ledger — migration, schema, and audit-vocabulary tests.
 *
 * Proves: fresh migration on sql.js, explicit sqlite_master inspection for
 * all eight tables and every load-bearing unique/index contract, Drizzle
 * schema read/write parity, and audit enum additions do not falsely register
 * query collectors.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { sql } from "drizzle-orm";
import {
  AUDIT_SOURCES,
  AUDIT_ENTITY_TYPES,
  AUDIT_QUERY_ENTITY_TYPES,
  DEFAULT_AUDIT_QUERY_ENTITY_TYPES,
} from "@orcy/shared";
import { assertCatalogCoverage } from "../services/auditProjection/catalog.js";
import {
  learningLoopPolicies,
  extractionWorkItems,
  extractionAttempts,
  extractedFindings,
  extractedFindingSources,
  extractedFindingScopeRefs,
  extractedFindingReviews,
  extractedFindingPromotions,
  habitats,
} from "../db/schema/index.js";

describe("Learning Loop ledger — migration and schema", () => {
  beforeEach(async () => {
    await initTestDb();
    // Seed minimal habitats for FK constraints
    const db = getDb();
    for (const id of ["test-habitat-1", "hab-A", "hab-B"]) {
      db.insert(habitats).values({ id, name: id }).run();
    }
  });
  afterEach(() => closeDb());

  // -------------------------------------------------------------------------
  // All eight tables exist after migration
  // -------------------------------------------------------------------------

  const EXPECTED_TABLES = [
    "learning_loop_policies",
    "extraction_work_items",
    "extraction_attempts",
    "extracted_findings",
    "extracted_finding_sources",
    "extracted_finding_scope_refs",
    "extracted_finding_reviews",
    "extracted_finding_promotions",
  ];

  it("creates all eight ledger tables on fresh sql.js migration", () => {
    const tables = getDb()
      .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'learning_loop_%' OR name LIKE 'extraction_%' OR name LIKE 'extracted_%' ORDER BY name`)
      .map((r) => r.name);
    for (const expected of EXPECTED_TABLES) {
      expect(tables).toContain(expected);
    }
    expect(tables).toHaveLength(EXPECTED_TABLES.length);
  });

  // -------------------------------------------------------------------------
  // Load-bearing unique indexes
  // -------------------------------------------------------------------------

  it("creates unique index for policy (habitat_id, extractor_key)", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("uq_learning_loop_policies_habitat_extractor");
  });

  it("creates unique index for work items (logical_work_key)", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("uq_extraction_work_items_logical_key");
  });

  it("creates unique index for attempts (work_item_id, attempt_no)", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("uq_extraction_attempts_work_no");
  });

  it("creates unique index for finding recurrence", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("uq_extracted_findings_recurrence");
  });

  it("creates unique index for finding lineage (lineage_root_id, revision)", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("uq_extracted_findings_lineage");
  });

  it("creates unique index for citation identity", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("uq_extracted_finding_sources_citation");
  });

  it("creates unique index for scope refs (finding_id, scope_type, scope_id)", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("uq_extracted_finding_scope_refs_finding_scope");
  });

  it("creates unique index for promotion (finding_id, destination_type, destination_key)", () => {
    const indexes = getIndexNames();
    expect(indexes).toContain("uq_extracted_finding_promotions_finding_dest");
  });

  // -------------------------------------------------------------------------
  // Drizzle schema read/write parity
  // -------------------------------------------------------------------------

  it("writes and reads a policy through Drizzle schema", () => {
    const db = getDb();
    const id = crypto.randomUUID();
    db.insert(learningLoopPolicies)
      .values({
        id,
        habitatId: "test-habitat-1",
        extractorKey: "task_lifecycle_extractor",
        enabled: 0,
        sourceTypes: ["task_lifecycle_audit"],
        schedule: "0 2 * * *",
        windowSeconds: 86400,
        lookbackSeconds: 604800,
        config: {},
        version: 1,
        createdByType: "human",
      })
      .run();

    const row = db.select().from(learningLoopPolicies).where(sql`id = ${id}`).all()[0];
    expect(row).toBeDefined();
    expect(row.extractorKey).toBe("task_lifecycle_extractor");
    expect(row.sourceTypes).toEqual(["task_lifecycle_audit"]);
    expect(row.enabled).toBe(0);
  });

  it("writes and reads a finding with JSON columns through Drizzle schema", () => {
    const db = getDb();
    const workItemId = crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const findingId = crypto.randomUUID();

    // Prerequisite: create work item and attempt
    db.insert(extractionWorkItems).values({
      id: workItemId,
      habitatId: "test-habitat-1",
      policyId: null,
      extractorKey: "test_extractor",
      extractorVersion: 1,
      policyVersion: 1,
      windowFrom: "2026-01-01T00:00:00Z",
      windowTo: "2026-01-02T00:00:00Z",
      logicalWorkKey: "test-key-" + findingId,
      deliveryMode: "scheduled",
      rerunGeneration: 0,
      status: "running",
      completedByAttemptId: null,
    }).run();

    db.insert(extractionAttempts).values({
      id: attemptId,
      workItemId,
      attemptNo: 1,
      deliveryMode: "scheduled",
      leaseOwner: "test-owner",
      leaseGeneration: 1,
      leaseExpiresAt: "2026-01-01T01:00:00Z",
      status: "running",
      startedAt: new Date().toISOString(),
    }).run();

    db.insert(extractedFindings).values({
      id: findingId,
      habitatId: "test-habitat-1",
      firstAttemptId: attemptId,
      lastSeenAttemptId: attemptId,
      lineageRootId: findingId,
      revision: 1,
      extractorKey: "test_extractor",
      extractorVersion: 1,
      findingType: "lesson",
      subject: "Test finding",
      body: "Test body",
      confidence: 0.85,
      sampleSize: 10,
      completeness: "complete",
      visibilityCeiling: "habitat_member",
      fingerprint: "fp-test-1",
      evidenceDigest: "ed-test-1",
      caveats: ["caveat-1"],
      firstSeenAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    }).run();

    const row = db.select().from(extractedFindings).where(sql`id = ${findingId}`).all()[0];
    expect(row).toBeDefined();
    expect(row.findingType).toBe("lesson");
    expect(row.confidence).toBe(0.85);
    expect(row.caveats).toEqual(["caveat-1"]);
    expect(row.lineageRootId).toBe(findingId);
  });

  // -------------------------------------------------------------------------
  // Audit enum additions do not falsely register query collectors
  // -------------------------------------------------------------------------

  it("adds learning_loop to AUDIT_SOURCES", () => {
    expect(AUDIT_SOURCES).toContain("learning_loop");
  });

  it("adds three extraction entity types to AUDIT_ENTITY_TYPES", () => {
    expect(AUDIT_ENTITY_TYPES).toContain("extraction_work_item");
    expect(AUDIT_ENTITY_TYPES).toContain("extraction_attempt");
    expect(AUDIT_ENTITY_TYPES).toContain("extracted_finding");
  });

  it("does NOT add extraction entity types to AUDIT_QUERY_ENTITY_TYPES", () => {
    expect(AUDIT_QUERY_ENTITY_TYPES).not.toContain("extraction_work_item");
    expect(AUDIT_QUERY_ENTITY_TYPES).not.toContain("extraction_attempt");
    expect(AUDIT_QUERY_ENTITY_TYPES).not.toContain("extracted_finding");
  });

  it("does NOT add extraction entity types to DEFAULT_AUDIT_QUERY_ENTITY_TYPES", () => {
    expect(DEFAULT_AUDIT_QUERY_ENTITY_TYPES).not.toContain("extraction_work_item");
    expect(DEFAULT_AUDIT_QUERY_ENTITY_TYPES).not.toContain("extraction_attempt");
    expect(DEFAULT_AUDIT_QUERY_ENTITY_TYPES).not.toContain("extracted_finding");
  });

  it("catalog coverage assertion still passes (no unclaimed query entity types)", () => {
    // This will throw if any AUDIT_QUERY_ENTITY_TYPES member has no collector.
    expect(() => assertCatalogCoverage()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getIndexNames(): string[] {
  return getDb()
    .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'uq_%' OR name LIKE 'idx_%extraction%' OR name LIKE 'idx_%extracted%' OR name LIKE 'idx_%learning_loop%' ORDER BY name`)
    .map((r) => r.name);
}
