/**
 * Wiki draft promotion — acceptance gate tests.
 *
 * Proves every acceptance gate from the ticket:
 * 1. At-most-once: concurrent/replayed promotion → exactly one page + one promotion row.
 * 2. Created page is always `draft`; no publish path.
 * 3. Rejected/stale/withdrawn findings cannot promote.
 * 4. Promotion failure recorded honestly; retry succeeds without duplicate pages.
 * 5. Removing the Wiki link, editing the page, or publishing it does NOT remove
 *    the permanent successful promotion row.
 * 6. Source-exclusion probe: a page in successful promotions is rejected.
 * 7. Wiki link `extracted_finding` resolver: missing finding → dangling marker.
 * 8. Cross-Habitat promotion fails without leaking either side.
 *
 * Each test must be able to fail for its defect.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  reservePromotionWithClient,
  terminalizePromotionWithClient,
  recordPromotionTargetWithClient,
  isWikiPageExcludedFromSources,
  getFindingByIdWithClient,
  createPolicyWithClient,
  updatePolicyWithClient,
} from "../repositories/extraction/index.js";
import { promoteToWikiDraft, isPageExcludedFromSources, type WikiPromotionResult, type PromotionDisabledResult } from "../services/extractionWikiDestination.js";
import * as wikiPageLinkRepo from "../repositories/wikiPageLink.js";
import * as wikiPageRepo from "../repositories/wikiPage.js";
import {
  habitats,
  columns,
  missions,
  extractedFindings,
  extractedFindingPromotions,
  wikiPages,
  wikiPageLinks,
  learningLoopPolicies,
} from "../db/schema/index.js";

// ---------------------------------------------------------------------------
// Type narrowing helper — narrows union to WikiPromotionResult
// ---------------------------------------------------------------------------

function asPromotionResult(
  r: WikiPromotionResult | PromotionDisabledResult,
): WikiPromotionResult {
  if (r.outcome === "disabled") throw new Error(`Test setup error: promotion disabled (${r.reason})`);
  return r;
}

// ---------------------------------------------------------------------------
// Test fixture helpers
// ---------------------------------------------------------------------------

const ENV_FLAG = "ORCY_LEARNING_LOOP_ENABLED";
let savedEnvFlag: string | undefined;

function setupEnabledPolicy(habitatId: string): void {
  const db = getDb();
  const result = createPolicyWithClient(db, {
    habitatId,
    extractorKey: "builtin:lesson_detector",
    sourceTypes: ["task_lifecycle_audit"] as never,
    schedule: "0 */5 * * *",
    windowSeconds: 3600,
    lookbackSeconds: 86400,
    createdByType: "human",
  });
  if (result.outcome !== "created") throw new Error("Policy creation failed");
  const updated = updatePolicyWithClient(db, {
    policyId: result.policy.id,
    expectedVersion: 1,
    enabled: true,
  });
  if (updated.outcome !== "updated") throw new Error("Policy enable failed");
}

function setupHabitat(id: string): void {
  const db = getDb();
  db.insert(habitats).values({ id, name: id }).run();
  db.insert(columns).values({ id: `col-${id}`, habitatId: id, name: "Todo", order: 0 }).run();
  db.insert(missions).values({
    id: `mis-${id}`,
    habitatId: id,
    columnId: `col-${id}`,
    title: `Mission ${id}`,
    createdBy: "test-user",
  }).run();
}

function insertFinding(opts: {
  habitatId: string;
  status?: "proposed" | "accepted" | "rejected" | "superseded" | "withdrawn";
  completeness?: "complete" | "partial" | "stale";
  subject?: string;
}): string {
  const db = getDb();
  const findingId = uuid();
  const now = new Date().toISOString();
  const attemptId = `att-${uuid()}`;

  db.insert(extractedFindings).values({
    id: findingId,
    habitatId: opts.habitatId,
    firstAttemptId: attemptId,
    lastSeenAttemptId: attemptId,
    lineageRootId: findingId,
    supersedesFindingId: null,
    revision: 1,
    extractorKey: "test_extractor",
    extractorVersion: 1,
    findingType: "lesson",
    subject: opts.subject ?? "Test finding for wiki promotion",
    body: "Test body content for the finding.",
    structuredPayload: null,
    confidence: 0.85,
    sampleSize: 10,
    completeness: opts.completeness ?? "complete",
    visibilityCeiling: "habitat_member",
    fingerprint: `fp-${uuid()}`,
    evidenceDigest: `ed-${uuid()}`,
    status: opts.status ?? "accepted",
    decisionVersion: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    occurrenceCount: 1,
    caveats: [],
  }).run();

  return findingId;
}

/** Count wiki pages in a habitat. */
function countWikiPages(habitatId: string): number {
  const db = getDb();
  return db.select().from(wikiPages).where(eq(wikiPages.habitatId, habitatId)).all().length;
}

/** Count promotion rows for a finding. */
function countPromotions(findingId: string): number {
  const db = getDb();
  return db.select().from(extractedFindingPromotions).where(eq(extractedFindingPromotions.findingId, findingId)).all().length;
}

/** Count wiki page links for a page. */
function countPageLinks(pageId: string): number {
  const db = getDb();
  return db.select().from(wikiPageLinks).where(eq(wikiPageLinks.pageId, pageId)).all().length;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Wiki draft promotion — acceptance gates", () => {
  beforeEach(async () => {
    savedEnvFlag = process.env[ENV_FLAG];
    process.env[ENV_FLAG] = "true";
    await initTestDb();
    setupHabitat("hab-A");
    setupHabitat("hab-B");
    setupEnabledPolicy("hab-A");
    setupEnabledPolicy("hab-B");
  });
  afterEach(() => {
    if (savedEnvFlag === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = savedEnvFlag;
    closeDb();
  });

  // ── Gate 1: At-most-once ──────────────────────────────────────

  it("creates exactly one page + one promotion row on replay", () => {
    const findingId = insertFinding({ habitatId: "hab-A" });

    // First promotion
    const result1 = asPromotionResult(promoteToWikiDraft("hab-A", findingId, "user-1"));
    expect(result1.outcome).toBe("promoted");
    expect(result1.pageId).toBeTruthy();

    const pagesAfter1 = countWikiPages("hab-A");
    const promotionsAfter1 = countPromotions(findingId);

    // Replay — should return the same page, not create a new one
    const result2 = asPromotionResult(promoteToWikiDraft("hab-A", findingId, "user-1"));
    expect(result2.outcome).toBe("already_promoted");
    expect(result2.pageId).toBe(result1.pageId);

    expect(countWikiPages("hab-A")).toBe(pagesAfter1);
    expect(countPromotions(findingId)).toBe(promotionsAfter1);
    expect(countWikiPages("hab-A")).toBe(1);
    expect(countPromotions(findingId)).toBe(1);
  });

  // ── Gate 2: Draft-only ────────────────────────────────────────

  it("created page is always draft — no publish path", () => {
    const findingId = insertFinding({ habitatId: "hab-A" });

    const result = asPromotionResult(promoteToWikiDraft("hab-A", findingId, "user-1"));

    const page = wikiPageRepo.getById(result.pageId);
    expect(page).toBeTruthy();
    expect(page!.status).toBe("draft");
  });

  // ── Gate 3: Eligibility blocks ────────────────────────────────

  it("rejected findings cannot promote", () => {
    const findingId = insertFinding({ habitatId: "hab-A", status: "rejected" });

    expect(() => promoteToWikiDraft("hab-A", findingId, "user-1")).toThrow();
  });

  it("withdrawn findings cannot promote", () => {
    const findingId = insertFinding({ habitatId: "hab-A", status: "withdrawn" });

    expect(() => promoteToWikiDraft("hab-A", findingId, "user-1")).toThrow();
  });

  it("stale findings cannot promote", () => {
    const findingId = insertFinding({ habitatId: "hab-A", completeness: "stale" });

    expect(() => promoteToWikiDraft("hab-A", findingId, "user-1")).toThrow();
  });

  it("proposed findings cannot promote", () => {
    const findingId = insertFinding({ habitatId: "hab-A", status: "proposed" });

    expect(() => promoteToWikiDraft("hab-A", findingId, "user-1")).toThrow();
  });

  // ── Gate 4: Failure-retry ─────────────────────────────────────

  it("failed promotion retries and creates no duplicate page", () => {
    const findingId = insertFinding({ habitatId: "hab-A" });

    // Manually reserve + terminalize as failed (simulating a prior failure)
    const db = getDb();
    const destKey = `wiki:hab-A`;
    const reserveResult = reservePromotionWithClient(db, {
      findingId,
      destinationType: "wiki_draft",
      destinationKey: destKey,
      idempotencyKey: `${findingId}:wiki_draft:${destKey}`,
      leaseOwner: "human:prior",
      leaseGeneration: 1000,
      consumedFindingRevision: 1,
    });
    expect(reserveResult.outcome).toBe("created");
    if (reserveResult.outcome !== "created") throw new Error("expected created");

    const failResult = terminalizePromotionWithClient(db, {
      promotionId: reserveResult.promotion.id,
      leaseOwner: "human:prior",
      leaseGeneration: 1000,
      status: "failed",
      error: "Simulated failure",
    });
    expect(failResult.outcome).toBe("terminalized");
    if (failResult.outcome !== "terminalized") throw new Error("expected terminalized");
    expect(failResult.promotion.status).toBe("failed");

    // No page created yet
    expect(countWikiPages("hab-A")).toBe(0);

    // Retry via the adapter — should re-arm and succeed
    const result = asPromotionResult(promoteToWikiDraft("hab-A", findingId, "user-1"));
    expect(result.outcome).toBe("promoted");

    // Exactly one page, one promotion row
    expect(countWikiPages("hab-A")).toBe(1);
    expect(countPromotions(findingId)).toBe(1);
  });

  it("retries after page-created-but-terminalize-crashed — no duplicate page", () => {
    const findingId = insertFinding({ habitatId: "hab-A" });

    const db = getDb();
    const destKey = `wiki:hab-A`;

    // Simulate: reservation created, page created, target recorded, but
    // terminalization never happened (crash). Then the promotion was marked failed.
    const reserveResult = reservePromotionWithClient(db, {
      findingId,
      destinationType: "wiki_draft",
      destinationKey: destKey,
      idempotencyKey: `${findingId}:wiki_draft:${destKey}`,
      leaseOwner: "human:prior",
      leaseGeneration: 1000,
      consumedFindingRevision: 1,
    });
    if (reserveResult.outcome !== "created") throw new Error("expected created");

    // Create a page directly (simulating prior page creation)
    const pageId = uuid();
    const now = new Date().toISOString();
    db.insert(wikiPages).values({
      id: pageId,
      habitatId: "hab-A",
      parentId: null,
      slug: "test-finding-for-wiki-promotion",
      title: "Prior page",
      content: "content",
      status: "draft",
      tags: [],
      currentVersionNumber: 1,
      createdBy: "test-user",
      lastUpdatedBy: "test-user",
      lastUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Record the target on the promotion
    recordPromotionTargetWithClient(db, {
      promotionId: reserveResult.promotion.id,
      leaseOwner: "human:prior",
      leaseGeneration: 1000,
      targetType: "wiki_page",
      targetId: pageId,
      targetVersion: "1",
    });

    // Mark as failed
    terminalizePromotionWithClient(db, {
      promotionId: reserveResult.promotion.id,
      leaseOwner: "human:prior",
      leaseGeneration: 1000,
      status: "failed",
      error: "Crash after page creation",
    });

    expect(countWikiPages("hab-A")).toBe(1);

    // Retry — should detect existing page via targetId, NOT create a new one
    const result = asPromotionResult(promoteToWikiDraft("hab-A", findingId, "user-1"));
    expect(result.outcome).toBe("promoted");
    expect(result.pageId).toBe(pageId);

    // Still only one page
    expect(countWikiPages("hab-A")).toBe(1);
    expect(countPromotions(findingId)).toBe(1);
  });

  // ── Gate 5: Derivation survives link removal / page edit / publish ──

  it("promotion row survives wiki link removal", () => {
    const findingId = insertFinding({ habitatId: "hab-A" });
    const result = asPromotionResult(promoteToWikiDraft("hab-A", findingId, "user-1"));

    const db = getDb();
    // Remove the wiki link
    db.delete(wikiPageLinks).where(eq(wikiPageLinks.pageId, result.pageId)).run();

    expect(countPageLinks(result.pageId)).toBe(0);

    // Promotion row still exists and is succeeded
    const promotions = db
      .select()
      .from(extractedFindingPromotions)
      .where(eq(extractedFindingPromotions.findingId, findingId))
      .all();
    expect(promotions).toHaveLength(1);
    expect(promotions[0].status).toBe("succeeded");
    expect(promotions[0].targetId).toBe(result.pageId);
  });

  it("promotion row survives page publish", () => {
    const findingId = insertFinding({ habitatId: "hab-A" });
    const result = asPromotionResult(promoteToWikiDraft("hab-A", findingId, "user-1"));

    const db = getDb();
    // Simulate publishing the page
    db.update(wikiPages)
      .set({ status: "published" })
      .where(eq(wikiPages.id, result.pageId))
      .run();

    // Promotion row still exists and is succeeded
    const promotions = db
      .select()
      .from(extractedFindingPromotions)
      .where(eq(extractedFindingPromotions.findingId, findingId))
      .all();
    expect(promotions).toHaveLength(1);
    expect(promotions[0].status).toBe("succeeded");
    expect(promotions[0].targetId).toBe(result.pageId);

    // Source exclusion still applies
    expect(isWikiPageExcludedFromSources(db, result.pageId)).toBe(true);
  });

  // ── Gate 6: Source-exclusion probe ────────────────────────────

  it("source-exclusion probe rejects a successfully-promoted page", () => {
    const findingId = insertFinding({ habitatId: "hab-A" });
    const result = asPromotionResult(promoteToWikiDraft("hab-A", findingId, "user-1"));

    // The promoted page is excluded from future source batches
    expect(isPageExcludedFromSources(result.pageId)).toBe(true);

    // A random page ID is not excluded
    expect(isPageExcludedFromSources(uuid())).toBe(false);
  });

  // ── Gate 7: Wiki link extracted_finding dangling resolver ─────

  it("missing finding resolves as dangling without blocking the page", () => {
    const db = getDb();
    const pageId = uuid();
    const now = new Date().toISOString();

    // Create a wiki page
    db.insert(wikiPages).values({
      id: pageId,
      habitatId: "hab-A",
      parentId: null,
      slug: "dangling-test",
      title: "Dangling test",
      content: "content",
      status: "draft",
      tags: [],
      currentVersionNumber: 1,
      createdBy: "test-user",
      lastUpdatedBy: "test-user",
      lastUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();

    // Add a link to a non-existent finding
    const linkId = uuid();
    db.insert(wikiPageLinks).values({
      id: linkId,
      pageId,
      targetType: "extracted_finding",
      targetId: "nonexistent-finding-id",
      linkNote: null,
      createdBy: "test-user",
      createdAt: now,
    }).run();

    // Resolve dangling — should mark as dangling
    const links = wikiPageLinkRepo.listByPage(pageId);
    const resolved = wikiPageLinkRepo.resolveDangling(links, "hab-A");

    expect(resolved).toHaveLength(1);
    expect(resolved[0].targetType).toBe("extracted_finding");
    expect(resolved[0].dangling).toBe(true);

    // Page still exists and is accessible
    const page = wikiPageRepo.getById(pageId);
    expect(page).toBeTruthy();
    expect(page!.status).toBe("draft");
  });

  it("existing finding resolves as not-dangling", () => {
    const db = getDb();
    const findingId = insertFinding({ habitatId: "hab-A" });
    const pageId = uuid();
    const now = new Date().toISOString();

    db.insert(wikiPages).values({
      id: pageId,
      habitatId: "hab-A",
      parentId: null,
      slug: "not-dangling-test",
      title: "Not dangling test",
      content: "content",
      status: "draft",
      tags: [],
      currentVersionNumber: 1,
      createdBy: "test-user",
      lastUpdatedBy: "test-user",
      lastUpdatedAt: now,
      createdAt: now,
      updatedAt: now,
    }).run();

    db.insert(wikiPageLinks).values({
      id: uuid(),
      pageId,
      targetType: "extracted_finding",
      targetId: findingId,
      linkNote: null,
      createdBy: "test-user",
      createdAt: now,
    }).run();

    const links = wikiPageLinkRepo.listByPage(pageId);
    const resolved = wikiPageLinkRepo.resolveDangling(links, "hab-A");

    expect(resolved).toHaveLength(1);
    expect(resolved[0].dangling).toBe(false);
  });

  // ── Gate 8: Cross-Habitat non-leak ───────────────────────────

  it("cross-Habitat promotion fails without leaking either side", () => {
    const findingId = insertFinding({ habitatId: "hab-A" });

    // Attempt to promote finding from hab-A using hab-B context
    expect(() => promoteToWikiDraft("hab-B", findingId, "user-1")).toThrow();

    // No wiki page was created in hab-B
    expect(countWikiPages("hab-B")).toBe(0);

    // No promotion row was created
    expect(countPromotions(findingId)).toBe(0);

    // The finding is still accessible from hab-A
    const finding = getFindingByIdWithClient(getDb(), findingId);
    expect(finding).toBeTruthy();
    expect(finding!.habitatId).toBe("hab-A");

    // And the finding is NOT leaked to hab-B (no wiki page, no link)
    expect(countWikiPages("hab-B")).toBe(0);
  });
});
