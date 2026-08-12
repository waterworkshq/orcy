/**
 * Learning Loop boot recovery — integration tests.
 *
 * Proves:
 *   1. Stale running attempts with expired leases are marked failed.
 *   2. Stale attempts without committed findings get a child attempt.
 *   3. Stale attempts WITH committed findings get work-item repair (no re-run).
 *   4. Work items whose finalization failed (running status + terminal attempt
 *      with findings) are reconciled.
 *   5. Fresh DB → empty summary.
 *
 * Each test injects a specific failure condition and proves the recovery
 * handles it correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { v4 as uuid } from "uuid";
import { habitats } from "../db/schema/index.js";
import { extractionAttempts, extractionWorkItems } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import {
  reserveWorkItemWithClient,
  createAttemptWithClient,
  terminalizeAttemptWithClient,
  persistCandidateWithClient,
  getLatestAttemptWithClient,
  getFindingsByHabitatWithClient,
  type CitationInput,
} from "../repositories/extraction/index.js";
import { runExtractionReconciliationPass } from "../services/extractionRecovery.js";
import { BUILTIN_EXTRACTOR_KEY, BUILTIN_EXTRACTOR_VERSION } from "../services/extractionExtractors.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupHabitat(db: ReturnType<typeof getDb>, id = "hab-A"): void {
  db.insert(habitats).values({ id, name: id }).run();
}

function makeWorkItem(
  db: ReturnType<typeof getDb>,
  overrides: Record<string, unknown> = {},
) {
  const result = reserveWorkItemWithClient(db, {
    habitatId: "hab-A",
    policyId: null,
    extractorKey: BUILTIN_EXTRACTOR_KEY,
    extractorVersion: BUILTIN_EXTRACTOR_VERSION,
    policyVersion: 1,
    windowFrom: "2026-06-01T00:00:00Z",
    windowTo: "2026-06-02T00:00:00Z",
    sourceBoundaryTokens: {},
    logicalWorkKey: `lwkey-${uuid()}`,
    deliveryMode: "scheduled",
    ...overrides,
  });
  if (result.outcome !== "created") throw new Error("Work item creation failed");
  return result.workItem;
}

function makeRunningAttempt(
  db: ReturnType<typeof getDb>,
  workItemId: string,
  overrides: Record<string, unknown> = {},
) {
  const result = createAttemptWithClient(db, {
    workItemId,
    deliveryMode: "scheduled",
    leaseOwner: "owner-1",
    leaseGeneration: 1,
    leaseExpiresAt: "2026-12-31T23:59:59Z",
    ...overrides,
  });
  if (result.outcome !== "created") throw new Error("Attempt creation failed");
  return result.attempt;
}

function makeCitation(overrides: Partial<CitationInput> = {}): CitationInput {
  return {
    id: uuid(),
    sourceType: "task_lifecycle_audit",
    sourceId: `task_event:${uuid()}`,
    sourceVersion: "v1",
    role: "supporting",
    visibilityClass: "habitat_member",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Learning Loop boot recovery", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    setupHabitat(db);
  });
  afterEach(() => closeDb());

  // -------------------------------------------------------------------------
  // 1. Fresh DB → empty summary
  // -------------------------------------------------------------------------

  it("returns empty summary on a fresh DB with no stale attempts", () => {
    const summary = runExtractionReconciliationPass();

    expect(summary.staleAttempts).toBe(0);
    expect(summary.failedAttempts).toBe(0);
    expect(summary.childAttemptsCreated).toBe(0);
    expect(summary.runningWorkItems).toBe(0);
    expect(summary.repairedWorkItems).toBe(0);
  });

  // -------------------------------------------------------------------------
  // 2. Stale running attempt → marked failed + child attempt created
  // -------------------------------------------------------------------------

  it("marks a stale running attempt as failed and creates a child attempt", () => {
    const db = getDb();
    const workItem = makeWorkItem(db);
    const attempt = makeRunningAttempt(db, workItem.id, {
      leaseExpiresAt: "2020-01-01T00:00:00Z", // Expired long ago.
    });

    const summary = runExtractionReconciliationPass();

    expect(summary.staleAttempts).toBe(1);
    expect(summary.failedAttempts).toBe(1);
    expect(summary.childAttemptsCreated).toBe(1);

    // Verify the original attempt is now failed.
    const reloaded = db
      .select()
      .from(extractionAttempts)
      .where(eq(extractionAttempts.id, attempt.id))
      .all()[0];
    expect(reloaded?.status).toBe("failed");
    expect(reloaded?.error).toContain("lease_expired");

    // Verify a child attempt was created.
    const latest = getLatestAttemptWithClient(db, workItem.id);
    expect(latest).toBeTruthy();
    expect(latest!.id).not.toBe(attempt.id);
    expect(latest!.parentAttemptId).toBe(attempt.id);
    expect(latest!.deliveryMode).toBe("boot_recovery");
  });

  // -------------------------------------------------------------------------
  // 3. Stale attempt WITH committed findings → work-item repair (no re-run)
  // -------------------------------------------------------------------------

  it("repairs work-item status when stale attempt had committed findings", () => {
    const db = getDb();
    const workItem = makeWorkItem(db);
    const attempt = makeRunningAttempt(db, workItem.id, {
      leaseExpiresAt: "2020-01-01T00:00:00Z", // Expired.
    });

    // Persist a finding under this attempt (simulating crash-after-commit).
    const persistResult = persistCandidateWithClient(db, {
      attemptId: attempt.id,
      workItemId: workItem.id,
      leaseOwner: attempt.leaseOwner,
      leaseGeneration: attempt.leaseGeneration,
      habitatId: "hab-A",
      firstAttemptId: attempt.id,
      fingerprint: "fp-committed",
      evidenceDigest: "ed-committed",
      extractorKey: BUILTIN_EXTRACTOR_KEY,
      extractorVersion: BUILTIN_EXTRACTOR_VERSION,
      findingType: "lesson",
      subject: "Committed before crash",
      body: "This finding was committed but not finalized.",
      confidence: 0.8,
      sampleSize: 5,
      completeness: "complete",
      visibilityCeiling: "habitat_member",
      caveats: [],
      lineageRootId: uuid(),
      revision: 1,
      citations: [makeCitation()],
      scopeRefs: [],
    });
    expect(persistResult.outcome).toBe("created");

    // Manually update the attempt's persistedCount (simulating partial finalization).
    db.update(extractionAttempts)
      .set({ persistedCount: 1 })
      .where(eq(extractionAttempts.id, attempt.id))
      .run();

    const summary = runExtractionReconciliationPass();

    expect(summary.staleAttempts).toBe(1);
    expect(summary.failedAttempts).toBe(1);
    expect(summary.childAttemptsCreated).toBe(0); // No child — findings exist.
    expect(summary.repairedWorkItems).toBeGreaterThanOrEqual(1);

    // Work item should now be terminal.
    const wi = db
      .select()
      .from(extractionWorkItems)
      .where(eq(extractionWorkItems.id, workItem.id))
      .all()[0];
    expect(wi?.status).oneOf(["succeeded", "partial"]);

    // Finding should still exist (not re-run, not duplicated).
    const findings = getFindingsByHabitatWithClient(db, "hab-A");
    expect(findings.length).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 4. Work item in running status with terminal attempt → reconciled
  // -------------------------------------------------------------------------

  it("reconciles a work item whose latest attempt terminalized but work item didn't", () => {
    const db = getDb();
    const workItem = makeWorkItem(db);
    const attempt = makeRunningAttempt(db, workItem.id);

    // Terminalize the attempt as succeeded, but leave the work item in running.
    const termResult = terminalizeAttemptWithClient(db, {
      attemptId: attempt.id,
      workItemId: workItem.id,
      leaseOwner: attempt.leaseOwner,
      leaseGeneration: attempt.leaseGeneration,
      status: "succeeded",
      candidateCount: 1,
      persistedCount: 1,
    });
    expect(termResult.outcome).toBe("terminalized");

    // The work item should still be in pending/running status.
    const wiBefore = db
      .select()
      .from(extractionWorkItems)
      .where(eq(extractionWorkItems.id, workItem.id))
      .all()[0];
    expect(wiBefore?.status).oneOf(["pending", "running"]);

    // Persist a finding so the work item has committed data.
    // (We need to create a second attempt since the first is terminalized.)
    const attempt2 = createAttemptWithClient(db, {
      workItemId: workItem.id,
      deliveryMode: "manual",
      leaseOwner: "owner-2",
      leaseGeneration: 2,
      leaseExpiresAt: "2026-12-31T23:59:59Z",
    });

    // Persist under attempt2.
    persistCandidateWithClient(db, {
      attemptId: attempt2.attempt.id,
      workItemId: workItem.id,
      leaseOwner: "owner-2",
      leaseGeneration: 2,
      habitatId: "hab-A",
      firstAttemptId: attempt2.attempt.id,
      fingerprint: "fp-recon",
      evidenceDigest: "ed-recon",
      extractorKey: BUILTIN_EXTRACTOR_KEY,
      extractorVersion: BUILTIN_EXTRACTOR_VERSION,
      findingType: "lesson",
      subject: "Reconciliation test",
      body: "Finding committed before work-item finalization.",
      confidence: 0.8,
      sampleSize: 5,
      completeness: "complete",
      visibilityCeiling: "habitat_member",
      caveats: [],
      lineageRootId: uuid(),
      revision: 1,
      citations: [makeCitation()],
      scopeRefs: [],
    });

    // Terminalize attempt2 as succeeded too, but DON'T terminalize the work item.
    terminalizeAttemptWithClient(db, {
      attemptId: attempt2.attempt.id,
      workItemId: workItem.id,
      leaseOwner: "owner-2",
      leaseGeneration: 2,
      status: "succeeded",
      candidateCount: 1,
      persistedCount: 1,
    });

    const summary = runExtractionReconciliationPass();

    // Work item should be repaired to terminal status.
    expect(summary.repairedWorkItems).toBeGreaterThanOrEqual(1);

    const wiAfter = db
      .select()
      .from(extractionWorkItems)
      .where(eq(extractionWorkItems.id, workItem.id))
      .all()[0];
    expect(wiAfter?.status).oneOf(["succeeded", "partial"]);
  });

  // -------------------------------------------------------------------------
  // 5. Non-stale running attempt is NOT touched
  // -------------------------------------------------------------------------

  it("does not touch a running attempt whose lease is still valid", () => {
    const db = getDb();
    const workItem = makeWorkItem(db);
    makeRunningAttempt(db, workItem.id, {
      leaseExpiresAt: "2099-12-31T23:59:59Z", // Far future.
    });

    const summary = runExtractionReconciliationPass();

    expect(summary.staleAttempts).toBe(0);
    expect(summary.failedAttempts).toBe(0);
  });
});
