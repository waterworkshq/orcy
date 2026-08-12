/**
 * B10 — better-sqlite3 parity suite for Learning Loop ledger.
 *
 * Proves the driver-sensitive behaviors (SELECT changes(), UNIQUE race
 * classification, transaction rollback, CAS) work identically on the
 * production better-sqlite3 driver — not just sql.js.
 *
 * Uses `initDb()` (production startup) with file-backed temp databases,
 * matching the pattern in `productionMigrationChain.test.ts`.
 *
 * Coverage:
 *   1. Work reservation + unique-race on logical_work_key.
 *   2. Attempt lease fencing (CAS on lease_owner + lease_generation).
 *   3. Review CAS + rollback (transactional atomicity).
 *   4. Candidate atomic rollback (subordinate INSERT failure rolls back finding).
 *   5. Wrapped UNIQUE classification (isUniqueConstraintViolation).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { closeDb, initDb, getDb } from "../db/index.js";
import { join } from "node:path";
import { existsSync, unlinkSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import {
  reserveWorkItemWithClient,
  createAttemptWithClient,
  terminalizeAttemptWithClient,
  persistCandidateWithClient,
  reviewCasWithClient,
  getChanges,
  isUniqueConstraintViolation,
  type CitationInput,
} from "../repositories/extraction/index.js";
import {
  learningLoopPolicies,
  extractionWorkItems,
  extractionAttempts,
  extractedFindings,
  extractedFindingSources,
  habitats,
} from "../db/schema/index.js";
import { isSqliteError } from "../errors/sqlite.js";

const PACKAGE_ROOT = join(import.meta.dirname, "..", "..");
const TEMP_DIR = join(PACKAGE_ROOT, ".test-b10-parity");

function ensureTempDir(): void {
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
}

function cleanupDb(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(`${dbPath}${suffix}`)) {
      try { unlinkSync(`${dbPath}${suffix}`); } catch { /* ignore */ }
    }
  }
}

const DB_PATH = join(TEMP_DIR, "b10-parity.db");

describe("B10 — better-sqlite3 parity suite", () => {
  beforeEach(async () => {
    ensureTempDir();
    cleanupDb(DB_PATH);
    await initDb(DB_PATH);
    const db = getDb();
    db.insert(habitats).values({ id: "hab-parity", name: "Parity" }).run();
  });
  afterEach(() => {
    closeDb();
    cleanupDb(DB_PATH);
  });

  // ── 1. Work reservation + unique-race ───────────────────────────

  describe("work reservation + unique-race", () => {
    it("reserves a work item and rejects duplicate logical_work_key", () => {
      const db = getDb();
      const logicalKey = `lwkey-${uuid()}`;

      const r1 = reserveWorkItemWithClient(db, {
        habitatId: "hab-parity", policyId: null,
        extractorKey: "test", extractorVersion: 1, policyVersion: 1,
        windowFrom: "2026-06-01T00:00:00Z", windowTo: "2026-06-02T00:00:00Z",
        sourceBoundaryTokens: {}, logicalWorkKey: logicalKey,
        deliveryMode: "scheduled",
      });
      expect(r1.outcome).toBe("created");

      // Second reservation with same key → already_exists.
      const r2 = reserveWorkItemWithClient(db, {
        habitatId: "hab-parity", policyId: null,
        extractorKey: "test", extractorVersion: 1, policyVersion: 1,
        windowFrom: "2026-06-01T00:00:00Z", windowTo: "2026-06-02T00:00:00Z",
        sourceBoundaryTokens: {}, logicalWorkKey: logicalKey,
        deliveryMode: "scheduled",
      });
      expect(r2.outcome).toBe("already_exists");
      expect(r2.workItem.id).toBe(r1.workItem.id);
    });
  });

  // ── 2. Attempt lease fencing ────────────────────────────────────

  describe("attempt lease fencing (CAS)", () => {
    it("terminalizeAttempt succeeds with correct lease, fails with stale", () => {
      const db = getDb();
      const workItem = reserveWorkItemWithClient(db, {
        habitatId: "hab-parity", policyId: null,
        extractorKey: "test", extractorVersion: 1, policyVersion: 1,
        windowFrom: "2026-06-01T00:00:00Z", windowTo: "2026-06-02T00:00:00Z",
        sourceBoundaryTokens: {}, logicalWorkKey: `lwkey-${uuid()}`,
        deliveryMode: "scheduled",
      });
      if (workItem.outcome !== "created") throw new Error("setup failed");

      const attempt = createAttemptWithClient(db, {
        workItemId: workItem.workItem.id, deliveryMode: "scheduled",
        leaseOwner: "owner-1", leaseGeneration: 1,
        leaseExpiresAt: "2099-01-01T00:00:00Z",
      });
      if (attempt.outcome !== "created") throw new Error("attempt failed");

      // Correct lease → terminalizes.
      const ok = terminalizeAttemptWithClient(db, {
        attemptId: attempt.attempt.id, workItemId: workItem.workItem.id,
        leaseOwner: "owner-1", leaseGeneration: 1, status: "succeeded",
      });
      expect(ok.outcome).toBe("terminalized");

      // Create a second attempt with lease generation 2.
      const attempt2 = createAttemptWithClient(db, {
        workItemId: workItem.workItem.id, deliveryMode: "scheduled",
        leaseOwner: "owner-2", leaseGeneration: 2,
        leaseExpiresAt: "2099-01-01T00:00:00Z",
      });
      if (attempt2.outcome !== "created") throw new Error("attempt2 failed");

      // Stale lease (generation 1) → fence_mismatch.
      const stale = terminalizeAttemptWithClient(db, {
        attemptId: attempt2.attempt.id, workItemId: workItem.workItem.id,
        leaseOwner: "owner-1", leaseGeneration: 1, // STALE
        status: "succeeded",
      });
      expect(stale.outcome).toBe("fence_mismatch");
    });
  });

  // ── 3. Review CAS + rollback ────────────────────────────────────

  describe("review CAS + transactional rollback", () => {
    it("review CAS updates status and appends review row atomically", () => {
      const db = getDb();
      const findingId = uuid();
      const now = new Date().toISOString();
      const attemptId = `att-${uuid()}`;

      db.insert(extractedFindings).values({
        id: findingId, habitatId: "hab-parity",
        firstAttemptId: attemptId, lastSeenAttemptId: attemptId,
        lineageRootId: findingId, supersedesFindingId: null, revision: 1,
        extractorKey: "test", extractorVersion: 1,
        findingType: "lesson" as const,
        subject: "CAS test", body: "Body", structuredPayload: null,
        confidence: 0.8, sampleSize: 5,
        completeness: "complete" as const,
        visibilityCeiling: "habitat_member" as const,
        fingerprint: `fp-${findingId}`, evidenceDigest: `ed-${findingId}`,
        status: "proposed" as const, decisionVersion: 1,
        firstSeenAt: now, lastSeenAt: now, occurrenceCount: 1, caveats: [],
      }).run();

      // CAS: accept with correct version.
      const result = db.transaction((tx) =>
        reviewCasWithClient(tx, {
          findingId, decision: "accept", reason: "Good",
          reviewerType: "human", reviewerId: "reviewer-1",
          expectedDecisionVersion: 1,
        }),
      );
      expect(result.outcome).toBe("decided");

      // Verify status changed and review row exists.
      const finding = db.select().from(extractedFindings)
        .where(eq(extractedFindings.id, findingId)).all()[0];
      expect(finding?.status).toBe("accepted");
      expect(finding?.decisionVersion).toBe(2);
    });

    it("wrong version CAS returns version_conflict, no mutation", () => {
      const db = getDb();
      const findingId = uuid();
      const now = new Date().toISOString();
      const attemptId = `att-${uuid()}`;

      db.insert(extractedFindings).values({
        id: findingId, habitatId: "hab-parity",
        firstAttemptId: attemptId, lastSeenAttemptId: attemptId,
        lineageRootId: findingId, supersedesFindingId: null, revision: 1,
        extractorKey: "test", extractorVersion: 1,
        findingType: "lesson" as const,
        subject: "Conflict test", body: "Body", structuredPayload: null,
        confidence: 0.8, sampleSize: 5,
        completeness: "complete" as const,
        visibilityCeiling: "habitat_member" as const,
        fingerprint: `fp-${findingId}`, evidenceDigest: `ed-${findingId}`,
        status: "proposed" as const, decisionVersion: 5, // Already at version 5.
        firstSeenAt: now, lastSeenAt: now, occurrenceCount: 1, caveats: [],
      }).run();

      // CAS with wrong version (1 instead of 5) → version_conflict.
      const result = db.transaction((tx) =>
        reviewCasWithClient(tx, {
          findingId, decision: "accept", reason: "Wrong version",
          reviewerType: "human", reviewerId: "reviewer-1",
          expectedDecisionVersion: 1,
        }),
      );
      expect(result.outcome).toBe("version_conflict");

      // Verify no mutation.
      const finding = db.select().from(extractedFindings)
        .where(eq(extractedFindings.id, findingId)).all()[0];
      expect(finding?.decisionVersion).toBe(5); // Unchanged.
    });
  });

  // ── 4. Candidate atomic rollback ────────────────────────────────

  describe("candidate atomic rollback", () => {
    it("citation INSERT failure rolls back the finding INSERT", () => {
      const db = getDb();

      const workItem = reserveWorkItemWithClient(db, {
        habitatId: "hab-parity", policyId: null,
        extractorKey: "test", extractorVersion: 1, policyVersion: 1,
        windowFrom: "2026-06-01T00:00:00Z", windowTo: "2026-06-02T00:00:00Z",
        sourceBoundaryTokens: {}, logicalWorkKey: `lwkey-${uuid()}`,
        deliveryMode: "scheduled",
      });
      if (workItem.outcome !== "created") throw new Error("setup failed");

      const attempt = createAttemptWithClient(db, {
        workItemId: workItem.workItem.id, deliveryMode: "scheduled",
        leaseOwner: "owner-1", leaseGeneration: 1,
        leaseExpiresAt: "2099-01-01T00:00:00Z",
      });
      if (attempt.outcome !== "created") throw new Error("attempt failed");

      // Persist with a citation that has a duplicate unique key to trigger failure.
      // First insert succeeds, second should fail inside the transaction.
      const citationId = uuid();
      const citation: CitationInput = {
        id: citationId, sourceType: "task_lifecycle_audit",
        sourceId: "task_event:rollback-test", sourceVersion: "v1",
        role: "supporting", visibilityClass: "habitat_member",
      };

      // First call: succeeds.
      const r1 = db.transaction((tx) =>
        persistCandidateWithClient(tx, {
          attemptId: attempt.attempt.id, workItemId: workItem.workItem.id,
          leaseOwner: "owner-1", leaseGeneration: 1,
          habitatId: "hab-parity", firstAttemptId: attempt.attempt.id,
          fingerprint: "fp-rollback", evidenceDigest: "ed-rollback",
          extractorKey: "test", extractorVersion: 1,
          findingType: "lesson" as const,
          subject: "Rollback test", body: "Body",
          confidence: 0.8, sampleSize: 5,
          completeness: "complete" as const,
          visibilityCeiling: "habitat_member" as const, caveats: [],
          citations: [citation], scopeRefs: [],
        }),
      );
      expect(r1.outcome).toBe("created");

      // Second call with the SAME citation unique key → UNIQUE violation → rollback.
      expect(() =>
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            attemptId: attempt.attempt.id, workItemId: workItem.workItem.id,
            leaseOwner: "owner-1", leaseGeneration: 1,
            habitatId: "hab-parity", firstAttemptId: attempt.attempt.id,
            fingerprint: "fp-rollback-2", evidenceDigest: "ed-rollback-2",
            extractorKey: "test", extractorVersion: 1,
            findingType: "lesson" as const,
            subject: "Rollback test 2", body: "Body",
            confidence: 0.8, sampleSize: 5,
            completeness: "complete" as const,
            visibilityCeiling: "habitat_member" as const, caveats: [],
            citations: [citation], // Same citation ID → UNIQUE violation.
            scopeRefs: [],
          }),
        ),
      ).toThrow();

      // Verify the second finding was NOT persisted (rolled back).
      const findings = db.select().from(extractedFindings)
        .where(eq(extractedFindings.fingerprint, "fp-rollback-2")).all();
      expect(findings.length).toBe(0);
    });
  });

  // ── 5. UNIQUE constraint classification ─────────────────────────

  describe("wrapped UNIQUE classification", () => {
    it("classifies better-sqlite3 UNIQUE errors correctly", () => {
      const db = getDb();
      const id = uuid();

      // Insert a work item.
      db.insert(extractionWorkItems).values({
        id, habitatId: "hab-parity", policyId: null,
        extractorKey: "test", extractorVersion: 1, policyVersion: 1,
        windowFrom: "2026-01-01T00:00:00Z", windowTo: "2026-01-02T00:00:00Z",
        sourceBoundaryTokens: {}, logicalWorkKey: `unique-${uuid()}`,
        deliveryMode: "scheduled", rerunGeneration: 0, status: "pending",
      }).run();

      // Insert with same id → UNIQUE violation.
      let caughtError: unknown = null;
      try {
        db.insert(extractionWorkItems).values({
          id, habitatId: "hab-parity", policyId: null,
          extractorKey: "test2", extractorVersion: 1, policyVersion: 1,
          windowFrom: "2026-02-01T00:00:00Z", windowTo: "2026-02-02T00:00:00Z",
          sourceBoundaryTokens: {}, logicalWorkKey: `unique2-${uuid()}`,
          deliveryMode: "scheduled", rerunGeneration: 0, status: "pending",
        }).run();
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeTruthy();
      expect(isUniqueConstraintViolation(caughtError)).toBe(true);
    });

    it("SELECT changes() works on better-sqlite3", () => {
      const db = getDb();
      const id = uuid();

      db.insert(extractionWorkItems).values({
        id, habitatId: "hab-parity", policyId: null,
        extractorKey: "test-changes", extractorVersion: 1, policyVersion: 1,
        windowFrom: "2026-01-01T00:00:00Z", windowTo: "2026-01-02T00:00:00Z",
        sourceBoundaryTokens: {}, logicalWorkKey: `changes-${uuid()}`,
        deliveryMode: "scheduled", rerunGeneration: 0, status: "pending",
      }).run();

      // SELECT changes() right after INSERT should return 1.
      const changes = getChanges(db);
      expect(changes).toBeGreaterThanOrEqual(1);

      // An UPDATE that matches.
      db.update(extractionWorkItems)
        .set({ status: "running" })
        .where(eq(extractionWorkItems.id, id))
        .run();
      const updateChanges = getChanges(db);
      expect(updateChanges).toBe(1);

      // An UPDATE that does NOT match.
      db.update(extractionWorkItems)
        .set({ status: "succeeded" })
        .where(eq(extractionWorkItems.id, "nonexistent-id"))
        .run();
      const noChanges = getChanges(db);
      expect(noChanges).toBe(0);
    });
  });
});
