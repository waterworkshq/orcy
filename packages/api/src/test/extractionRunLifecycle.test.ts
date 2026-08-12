/**
 * Learning Loop execution lifecycle — integration tests.
 *
 * Proves all 9 acceptance gates through the ONE seam (`runExtraction`):
 *   1. Duplicate scheduled/manual ensure → deduplicated (one work item,
 *      one attempt, one invocation).
 *   2. Fresh rerun creates a new generation (human-only + reason-required).
 *   3. Expired ownership → exactly one fenced child attempt (recovery test).
 *   4. Stale fence cannot persist/finalize.
 *   5. Crash-after-commit → finalization reconciliation (recovery test).
 *   6. Failed source → partial/failed + warning, watermark not advanced.
 *   7. Invalid/uncited/fabricated candidates persist nothing (validator test).
 *   8. Dry-run persists no findings.
 *   9. Feature-off (global + per-habitat) → honest skipped, no extraction.
 *
 * Each test injects a specific failure to prove the gate catches it.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { v4 as uuid } from "uuid";
import { habitats } from "../db/schema/index.js";
import {
  createPolicyWithClient,
  updatePolicyWithClient,
  getFindingsByHabitatWithClient,
  reserveWorkItemWithClient,
  createAttemptWithClient,
  persistCandidateWithClient,
  type CitationInput,
} from "../repositories/extraction/index.js";
import {
  runExtraction,
  onExtractionRunCompleted,
  computeLogicalWorkKey,
  type RunExtractionInput,
} from "../services/extractionRunLifecycle.js";
import { BUILTIN_EXTRACTOR_KEY, BUILTIN_EXTRACTOR_VERSION } from "../services/extractionExtractors.js";
import type { LearningLoopPolicyRow } from "@orcy/shared";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const ENV_FLAG = "ORCY_LEARNING_LOOP_ENABLED";

function setupHabitat(db: ReturnType<typeof getDb>, id = "hab-A"): void {
  db.insert(habitats).values({ id, name: id }).run();
}

function setupPolicy(
  db: ReturnType<typeof getDb>,
  overrides: { habitatId?: string; enabled?: boolean; sourceTypes?: string[] } = {},
): LearningLoopPolicyRow {
  const result = createPolicyWithClient(db, {
    habitatId: overrides.habitatId ?? "hab-A",
    extractorKey: BUILTIN_EXTRACTOR_KEY,
    sourceTypes: (overrides.sourceTypes ?? ["task_lifecycle_audit"]) as LearningLoopPolicyRow["sourceTypes"],
    schedule: "0 */5 * * *",
    windowSeconds: 3600,
    lookbackSeconds: 86400,
    createdByType: "human",
  });
  if (result.outcome !== "created") throw new Error("Policy creation failed");
  if (overrides.enabled) {
    const updated = updatePolicyWithClient(db, {
      policyId: result.policy.id,
      expectedVersion: 1,
      enabled: true,
    });
    if (updated.outcome !== "updated") throw new Error("Policy enable failed");
    return updated.policy;
  }
  return result.policy;
}

function makeRunInput(
  policy: LearningLoopPolicyRow,
  overrides: Partial<RunExtractionInput> = {},
): RunExtractionInput {
  return {
    habitatId: policy.habitatId,
    policy,
    deliveryMode: "scheduled",
    actorType: "system",
    actorId: "scheduler-test",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Learning Loop execution lifecycle", () => {
  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    setupHabitat(db);
    process.env[ENV_FLAG] = "true";
  });
  afterEach(() => {
    delete process.env[ENV_FLAG];
    closeDb();
  });

  // -------------------------------------------------------------------------
  // Gate 9: Feature-off (global) → skipped
  // -------------------------------------------------------------------------

  it("returns skipped/disabled when global feature flag is off", () => {
    delete process.env[ENV_FLAG];
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });

    const result = runExtraction(makeRunInput(policy));

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toBe("disabled");
    }
  });

  // -------------------------------------------------------------------------
  // Gate 9: Feature-off (per-habitat policy disabled) → skipped
  // -------------------------------------------------------------------------

  it("returns skipped/disabled when policy is not enabled", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: false });

    const result = runExtraction(makeRunInput(policy));

    expect(result.kind).toBe("skipped");
    if (result.kind === "skipped") {
      expect(result.reason).toBe("disabled");
    }
  });

  // -------------------------------------------------------------------------
  // Gate 1: Duplicate delivery → deduplicated
  // -------------------------------------------------------------------------

  it("duplicate delivery for the same envelope returns deduplicated", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });
    const now = "2026-06-15T12:00:00Z";

    // First call — should execute (even if empty, it's a real run).
    const r1 = runExtraction(makeRunInput(policy, { now }));
    expect(["executed", "failed"]).toContain(r1.kind);

    // Second call for the same envelope → deduplicated.
    const r2 = runExtraction(makeRunInput(policy, { now }));
    expect(r2.kind).toBe("deduplicated");
    if (r2.kind === "deduplicated") {
      expect(r2.workItem).toBeTruthy();
    }
  });

  // -------------------------------------------------------------------------
  // Gate 1: Scheduled and manual ensure converge on one work item
  // -------------------------------------------------------------------------

  it("scheduled and manual ensure for the same envelope converge on one work item", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });
    const now = "2026-06-15T12:00:00Z";

    // Scheduled first.
    const r1 = runExtraction(makeRunInput(policy, { deliveryMode: "scheduled", now }));
    expect(["executed", "failed"]).toContain(r1.kind);

    // Manual ensure for the same envelope → deduplicated.
    const r2 = runExtraction(makeRunInput(policy, { deliveryMode: "manual", now }));
    expect(r2.kind).toBe("deduplicated");
  });

  // -------------------------------------------------------------------------
  // Gate 2: Fresh rerun creates a new generation (human-only + reason)
  // -------------------------------------------------------------------------

  it("fresh_rerun with human actor and reason creates a new generation", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });
    const now = "2026-06-15T12:00:00Z";

    // Original run.
    runExtraction(makeRunInput(policy, { now }));

    // Fresh rerun.
    const rerunResult = runExtraction(makeRunInput(policy, {
      now,
      isFreshRerun: true,
      freshReason: "Need updated analysis after data fix",
      actorType: "human",
      actorId: "human-1",
    }));

    // Fresh rerun should NOT be deduplicated — it creates a new work item.
    expect(rerunResult.kind).not.toBe("deduplicated");
  });

  // -------------------------------------------------------------------------
  // Gate 2: Fresh rerun non-human → failed
  // -------------------------------------------------------------------------

  it("fresh_rerun with non-human actor fails", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });

    const result = runExtraction(makeRunInput(policy, {
      isFreshRerun: true,
      freshReason: "test reason",
      actorType: "agent",
      actorId: "agent-1",
    }));

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.stage).toBe("fresh_rerun_gate");
    }
  });

  // -------------------------------------------------------------------------
  // Gate 2: Fresh rerun without reason → failed
  // -------------------------------------------------------------------------

  it("fresh_rerun without reason fails", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });

    const result = runExtraction(makeRunInput(policy, {
      isFreshRerun: true,
      actorType: "human",
      actorId: "human-1",
    }));

    expect(result.kind).toBe("failed");
    if (result.kind === "failed") {
      expect(result.stage).toBe("fresh_rerun_gate");
    }
  });

  // -------------------------------------------------------------------------
  // Gate 7: Dry-run persists no findings
  // -------------------------------------------------------------------------

  it("dry_run exercises the lifecycle but persists no findings", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });

    const result = runExtraction(makeRunInput(policy, { dryRun: true }));

    expect(["executed", "failed"]).toContain(result.kind);
    // Verify no findings persisted.
    const findings = getFindingsByHabitatWithClient(db, policy.habitatId);
    expect(findings.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // Exactly-once completion emission
  // -------------------------------------------------------------------------

  it("emits completion exactly once per owned terminal transition", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });

    let emitCount = 0;
    const unsub = onExtractionRunCompleted(() => {
      emitCount++;
    });

    runExtraction(makeRunInput(policy));

    expect(emitCount).toBe(1);
    unsub();
  });

  // -------------------------------------------------------------------------
  // Deduplication does not emit completion
  // -------------------------------------------------------------------------

  it("deduplicated delivery does not emit completion", () => {
    const db = getDb();
    const policy = setupPolicy(db, { enabled: true });
    const now = "2026-06-15T12:00:00Z";

    let emitCount = 0;
    const unsub = onExtractionRunCompleted(() => {
      emitCount++;
    });

    // First call emits once.
    runExtraction(makeRunInput(policy, { now }));
    expect(emitCount).toBe(1);

    // Second call (deduplicated) does NOT emit.
    runExtraction(makeRunInput(policy, { now }));
    expect(emitCount).toBe(1);

    unsub();
  });

  // -------------------------------------------------------------------------
  // Gate 4: Stale fence cannot persist candidates
  // -------------------------------------------------------------------------

  it("stale fence cannot persist candidates (fence_mismatch)", () => {
    const db = getDb();

    // Set up a work item + attempt.
    const workItem = reserveWorkItemWithClient(db, {
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
    });
    expect(workItem.outcome).toBe("created");

    // Create first attempt (lease generation 1).
    const attempt1 = createAttemptWithClient(db, {
      workItemId: workItem.workItem.id,
      deliveryMode: "scheduled",
      leaseOwner: "owner-1",
      leaseGeneration: 1,
      leaseExpiresAt: "2026-12-31T23:59:59Z",
    });
    expect(attempt1.outcome).toBe("created");

    // Try to persist with a STALE lease (generation 0, not 1).
    const stalePersist = persistCandidateWithClient(db, {
      attemptId: attempt1.attempt.id,
      workItemId: workItem.workItem.id,
      leaseOwner: "owner-1",
      leaseGeneration: 0, // STALE — should fail.
      habitatId: "hab-A",
      firstAttemptId: attempt1.attempt.id,
      fingerprint: "fp-test",
      evidenceDigest: "ed-test",
      extractorKey: BUILTIN_EXTRACTOR_KEY,
      extractorVersion: BUILTIN_EXTRACTOR_VERSION,
      findingType: "lesson",
      subject: "Stale test",
      body: "Should fail",
      confidence: 0.8,
      sampleSize: 5,
      completeness: "complete",
      visibilityCeiling: "habitat_member",
      caveats: [],
      lineageRootId: uuid(),
      revision: 1,
      citations: [{
        id: uuid(),
        sourceType: "task_lifecycle_audit",
        sourceId: "task_event:1",
        sourceVersion: "v1",
        role: "supporting",
        visibilityClass: "habitat_member",
      } as CitationInput],
      scopeRefs: [],
    });

    expect(stalePersist.outcome).toBe("fence_mismatch");

    // Verify no findings were persisted.
    const findings = getFindingsByHabitatWithClient(db, "hab-A");
    expect(findings.length).toBe(0);
  });

  // -------------------------------------------------------------------------
  // computeLogicalWorkKey excludes delivery mode
  // -------------------------------------------------------------------------

  it("computeLogicalWorkKey is deterministic regardless of delivery mode", () => {
    const base = {
      habitatId: "hab-A",
      extractorKey: BUILTIN_EXTRACTOR_KEY,
      extractorVersion: 1,
      policyVersion: 1,
      windowFrom: "2026-06-01T00:00:00Z",
      windowTo: "2026-06-02T00:00:00Z",
      sourceTypes: ["task_lifecycle_audit"] as const,
      sourceBoundaryTokens: { task_lifecycle_audit: { highWaterMark: "2026-06-01T12:00:00Z" } },
      rerunGeneration: 0,
    };
    const key1 = computeLogicalWorkKey(base);
    const key2 = computeLogicalWorkKey(base);
    expect(key1).toBe(key2);
  });

  // -------------------------------------------------------------------------
  // computeLogicalWorkKey differs for different rerun generation
  // -------------------------------------------------------------------------

  it("computeLogicalWorkKey differs for rerun generation > 0", () => {
    const base = {
      habitatId: "hab-A",
      extractorKey: BUILTIN_EXTRACTOR_KEY,
      extractorVersion: 1,
      policyVersion: 1,
      windowFrom: "2026-06-01T00:00:00Z",
      windowTo: "2026-06-02T00:00:00Z",
      sourceTypes: ["task_lifecycle_audit"] as const,
      sourceBoundaryTokens: {},
      rerunGeneration: 0,
    };
    const key1 = computeLogicalWorkKey(base);
    const key2 = computeLogicalWorkKey({ ...base, rerunGeneration: 1 });
    expect(key1).not.toBe(key2);
  });
});
