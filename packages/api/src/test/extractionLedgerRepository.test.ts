/**
 * Learning Loop ledger — repository behavioral tests (sql.js).
 *
 * Proves every acceptance gate: logical-work reservation, attempt fencing,
 * recurrence vs. revision, atomic candidate persistence with rollback,
 * review CAS, promotion idempotency, Habitat isolation, and stale-fence
 * rejection.
 *
 * All tests run on sql.js (the test backend). Driver-sensitive invariants
 * (SELECT changes(), unique-constraint detection) are proven by the same
 * patterns that hold on better-sqlite3; the cross-backend detector in
 * types.ts recognises both error shapes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { v4 as uuid } from "uuid";
import {
  reserveWorkItemWithClient,
  terminalizeWorkItemWithClient,
  createAttemptWithClient,
  terminalizeAttemptWithClient,
  persistCandidateWithClient,
  reviewCasWithClient,
  reservePromotionWithClient,
  terminalizePromotionWithClient,
  getFindingsByHabitatWithClient,
  createPolicyWithClient,
  updatePolicyWithClient,
  type CitationInput,
} from "../repositories/extraction/index.js";
import { habitats } from "../db/schema/index.js";

// ---------------------------------------------------------------------------
// Type-narrowing helper: runtime-assert the outcome and return the narrowed branch.
// ---------------------------------------------------------------------------

function asOutcome<T extends { outcome: string }, const S extends T["outcome"]>(
  r: T,
  expected: S,
): Extract<T, { outcome: S }> {
  if (r.outcome !== expected) {
    throw new Error(`Expected outcome "${expected}", got "${r.outcome}"`);
  }
  return r as Extract<T, { outcome: S }>;
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeReservationInput(overrides: Record<string, unknown> = {}) {
  return {
    habitatId: "hab-A",
    policyId: null as string | null,
    extractorKey: "test_extractor",
    extractorVersion: 1,
    policyVersion: 1,
    windowFrom: "2026-01-01T00:00:00Z",
    windowTo: "2026-01-02T00:00:00Z",
    sourceBoundaryTokens: {} as Record<string, unknown>,
    logicalWorkKey: `lwkey-${uuid()}`,
    deliveryMode: "scheduled" as const,
    rerunGeneration: 0,
    supersedesWorkId: null as string | null,
    freshReason: null as string | null,
    policySnapshot: {} as Record<string, unknown>,
    ...overrides,
  };
}

function setupWorkItem(db: ReturnType<typeof getDb>, overrides: Record<string, unknown> = {}) {
  const result = reserveWorkItemWithClient(db, makeReservationInput(overrides));
  return asOutcome(result, "created").workItem;
}

function setupAttempt(
  db: ReturnType<typeof getDb>,
  workItemId: string,
  overrides: Record<string, unknown> = {},
) {
  return asOutcome(
    createAttemptWithClient(db, {
      workItemId,
      deliveryMode: "scheduled" as const,
      leaseOwner: "owner-1",
      leaseGeneration: 1,
      leaseExpiresAt: "2026-12-31T23:59:59Z",
      ...overrides,
    }),
    "created",
  ).attempt;
}

function makeCitation(overrides: Partial<CitationInput> = {}): CitationInput {
  return {
    id: uuid(),
    sourceType: "task_lifecycle_audit",
    sourceId: `task_event:${uuid()}`,
    sourceVersion: "v1",
    role: "supporting",
    sourceDigest: "digest-1",
    occurredAt: "2026-01-01T12:00:00Z",
    entityRefs: [{ type: "task", id: "task-1" }],
    completeness: "complete",
    visibilityClass: "habitat_member",
    ...overrides,
  };
}

function makeCandidateInput(overrides: Record<string, unknown> = {}) {
  return {
    habitatId: "hab-A",
    fingerprint: "fp-" + uuid(),
    evidenceDigest: "ed-" + uuid(),
    extractorKey: "test_extractor",
    extractorVersion: 1,
    findingType: "lesson" as const,
    subject: "Test lesson",
    body: "This is a test finding body.",
    confidence: 0.85,
    sampleSize: 10,
    completeness: "complete" as const,
    visibilityCeiling: "habitat_member" as const,
    caveats: [] as string[],
    lineageRootId: uuid(),
    revision: 1,
    supersedesFindingId: null as string | null,
    citations: [makeCitation()],
    scopeRefs: [] as Array<{ scopeType: "task" | "mission" | "domain"; scopeId: string; derivedFromSourceId: string }>,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Learning Loop ledger — repository behavior", () => {
  beforeEach(async () => {
    await initTestDb();
    // Seed minimal habitats for FK constraints
    const db = getDb();
    for (const id of ["hab-A", "hab-B"]) {
      db.insert(habitats).values({ id, name: id }).run();
    }
  });
  afterEach(() => closeDb());

  // -------------------------------------------------------------------------
  // 1. Logical-work reservation
  // -------------------------------------------------------------------------

  describe("logical-work reservation", () => {
    it("two reservations for the same logical key yield one row", () => {
      const db = getDb();
      const input = makeReservationInput();
      const r1 = reserveWorkItemWithClient(db, input);
      expect(r1.outcome).toBe("created");

      const r2 = reserveWorkItemWithClient(db, input);
      expect(r2.outcome).toBe("already_exists");
      if (r1.outcome !== "created" || r2.outcome !== "already_exists") return;
      expect(r2.workItem.id).toBe(r1.workItem.id);
    });

    it("scheduled and manual delivery modes converge on one work item", () => {
      const db = getDb();
      const sharedKey = `lwkey-${uuid()}`;
      const scheduled = reserveWorkItemWithClient(db, makeReservationInput({ logicalWorkKey: sharedKey, deliveryMode: "scheduled" }));
      expect(scheduled.outcome).toBe("created");

      const manual = reserveWorkItemWithClient(db, makeReservationInput({ logicalWorkKey: sharedKey, deliveryMode: "manual" }));
      expect(manual.outcome).toBe("already_exists");
      if (scheduled.outcome !== "created" || manual.outcome !== "already_exists") return;
      expect(manual.workItem.id).toBe(scheduled.workItem.id);
    });

    it("different rerun generation creates a different work item", () => {
      const db = getDb();
      const key = `lwkey-${uuid()}`;
      const gen0 = asOutcome(reserveWorkItemWithClient(db, makeReservationInput({ logicalWorkKey: key, rerunGeneration: 0 })), "created");
      const gen1 = asOutcome(reserveWorkItemWithClient(db, makeReservationInput({ logicalWorkKey: key + "-gen1", rerunGeneration: 1 })), "created");
      expect(gen0.workItem.id).not.toBe(gen1.workItem.id);
      expect(gen1.workItem.rerunGeneration).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Attempt monotonic numbering and lease fencing
  // -------------------------------------------------------------------------

  describe("attempt creation and fencing", () => {
    it("attempt numbers are monotonic", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const a1 = setupAttempt(db, workItem.id);
      const a2 = setupAttempt(db, workItem.id);
      expect(a2.attemptNo).toBe(a1.attemptNo + 1);
    });

    it("terminalization succeeds with correct fence", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      const result = terminalizeAttemptWithClient(db, {
        attemptId: attempt.id,
        workItemId: workItem.id,
        leaseOwner: "owner-1",
        leaseGeneration: 1,
        status: "succeeded",
      });
      expect(result.outcome).toBe("terminalized");
    });

    it("stale fence cannot terminalize", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      const result = terminalizeAttemptWithClient(db, {
        attemptId: attempt.id,
        workItemId: workItem.id,
        leaseOwner: "wrong-owner",
        leaseGeneration: 1,
        status: "succeeded",
      });
      expect(result.outcome).toBe("fence_mismatch");
    });

    it("stale lease generation cannot terminalize", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      const result = terminalizeAttemptWithClient(db, {
        attemptId: attempt.id,
        workItemId: workItem.id,
        leaseOwner: "owner-1",
        leaseGeneration: 999,
        status: "succeeded",
      });
      expect(result.outcome).toBe("fence_mismatch");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Candidate persistence with attempt fence
  // -------------------------------------------------------------------------

  describe("candidate persistence", () => {
    it("persists a new finding with citations and scope refs", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      const cite = makeCitation();
      const result = asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput(),
            attemptId: attempt.id,
            workItemId: workItem.id,
            leaseOwner: "owner-1",
            leaseGeneration: 1,
            firstAttemptId: attempt.id,
            citations: [cite],
            scopeRefs: [{
              scopeType: "task",
              scopeId: "task-1",
              derivedFromSourceId: cite.id,
            }],
          }),
        ),
        "created",
      );
      expect(result.finding.subject).toBe("Test lesson");
      expect(result.citations).toHaveLength(1);
      expect(result.scopeRefs).toHaveLength(1);
    });

    it("stale fence cannot persist a candidate", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      const result = db.transaction((tx) =>
        persistCandidateWithClient(tx, {
          ...makeCandidateInput(),
          attemptId: attempt.id,
          workItemId: workItem.id,
          leaseOwner: "wrong-owner",
          leaseGeneration: 1,
          firstAttemptId: attempt.id,
        }),
      );
      expect(result.outcome).toBe("fence_mismatch");
    });

    it("injected citation failure rolls back the finding and all subordinate rows", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      // Duplicate citation IDs → unique constraint violation on second insert
      const duplicateId = uuid();
      const c1 = makeCitation({ id: duplicateId });
      const c2 = makeCitation({ id: duplicateId });

      expect(() => {
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput(),
            attemptId: attempt.id,
            workItemId: workItem.id,
            leaseOwner: "owner-1",
            leaseGeneration: 1,
            firstAttemptId: attempt.id,
            citations: [c1, c2],
          }),
        );
      }).toThrow();

      // Verify no finding was persisted
      const findings = getFindingsByHabitatWithClient(db, "hab-A");
      expect(findings).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Recurrence vs. revision
  // -------------------------------------------------------------------------

  describe("recurrence and immutability", () => {
    it("identical fingerprint and evidence increments recurrence without duplicating", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      const fingerprint = "fp-recur-1";
      const evidenceDigest = "ed-recur-1";
      const lineageRoot = uuid();

      const r1 = asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({ fingerprint, evidenceDigest, lineageRootId: lineageRoot }),
            attemptId: attempt.id, workItemId: workItem.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attempt.id,
          }),
        ),
        "created",
      );
      expect(r1.finding.occurrenceCount).toBe(1);

      const r2 = asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({ fingerprint, evidenceDigest, lineageRootId: lineageRoot }),
            attemptId: attempt.id, workItemId: workItem.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attempt.id,
          }),
        ),
        "recurrence",
      );
      expect(r2.finding.occurrenceCount).toBe(2);
      expect(r2.finding.id).toBe(r1.finding.id);
      // Immutable fields unchanged
      expect(r2.finding.subject).toBe(r1.finding.subject);
      expect(r2.finding.body).toBe(r1.finding.body);
      expect(r2.finding.confidence).toBe(r1.finding.confidence);
    });

    it("changed evidence creates a new revision preserving the old row", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      const fingerprint = "fp-rev-1";
      const lineageRoot = uuid();

      const r1 = asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({ fingerprint, evidenceDigest: "ed-old", lineageRootId: lineageRoot }),
            attemptId: attempt.id, workItemId: workItem.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attempt.id,
          }),
        ),
        "created",
      );

      const r2 = asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({
              fingerprint, evidenceDigest: "ed-new", lineageRootId: lineageRoot,
              revision: 2, supersedesFindingId: r1.finding.id,
            }),
            attemptId: attempt.id, workItemId: workItem.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attempt.id,
          }),
        ),
        "created",
      );
      expect(r2.finding.id).not.toBe(r1.finding.id);
      expect(r2.finding.evidenceDigest).toBe("ed-new");
      expect(r2.finding.revision).toBe(2);
      expect(r2.finding.supersedesFindingId).toBe(r1.finding.id);
      // B3 fix: lineageRootId is derived by the repository (revision 1 self-roots).
      expect(r2.finding.lineageRootId).toBe(r1.finding.lineageRootId);
      expect(r1.finding.lineageRootId).toBe(r1.finding.id); // Revision 1 self-root

      // Old row preserved
      expect(getFindingsByHabitatWithClient(db, "hab-A")).toHaveLength(2);
    });

  });

  // -------------------------------------------------------------------------
  // 5. Review compare-and-set
  // -------------------------------------------------------------------------

  describe("review CAS", () => {
    it("two reviewers with one expected version yield one decision and one conflict", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);
      const lineageRoot = uuid();

      const { finding } = asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({ lineageRootId: lineageRoot }),
            attemptId: attempt.id, workItemId: workItem.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attempt.id,
          }),
        ),
        "created",
      );

      // First reviewer: accept at version 1
      const r1 = asOutcome(reviewCasWithClient(db, {
        findingId: finding.id, decision: "accept", reason: "Good finding",
        reviewerId: "human-1", expectedDecisionVersion: 1,
      }), "decided");
      expect(r1.finding.status).toBe("accepted");
      expect(r1.finding.decisionVersion).toBe(2);

      // Second reviewer: tries withdraw at stale version 1 → version_conflict.
      // Withdraw IS valid from accepted status, but the version is wrong.
      const r2 = asOutcome(reviewCasWithClient(db, {
        findingId: finding.id, decision: "withdraw", reason: "Stale version",
        reviewerId: "human-2", expectedDecisionVersion: 1,
      }), "version_conflict");
      expect(r2.finding.status).toBe("accepted");
      expect(r2.finding.decisionVersion).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // 6. Promotion idempotency and fenced terminalization
  // -------------------------------------------------------------------------

  describe("promotion reservation and terminalization", () => {
    it("reservation is idempotent for the same finding/destination", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);
      const lineageRoot = uuid();

      const { finding } = asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({ lineageRootId: lineageRoot }),
            attemptId: attempt.id, workItemId: workItem.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attempt.id,
          }),
        ),
        "created",
      );

      const r1 = asOutcome(reservePromotionWithClient(db, {
        findingId: finding.id, destinationType: "wiki_draft", destinationKey: `wiki-${uuid()}`,
        idempotencyKey: "idem-1", leaseOwner: "owner-1", leaseGeneration: 1,
        consumedFindingRevision: finding.revision,
      }), "created");

      const r2 = asOutcome(reservePromotionWithClient(db, {
        findingId: finding.id, destinationType: "wiki_draft", destinationKey: r1.promotion.destinationKey,
        idempotencyKey: "idem-1", leaseOwner: "owner-1", leaseGeneration: 1,
        consumedFindingRevision: finding.revision,
      }), "already_exists");
      expect(r2.promotion.id).toBe(r1.promotion.id);
    });

    it("stale ownership cannot terminalize promotion", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);
      const lineageRoot = uuid();

      const { finding } = asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({ lineageRootId: lineageRoot }),
            attemptId: attempt.id, workItemId: workItem.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attempt.id,
          }),
        ),
        "created",
      );

      const { promotion } = asOutcome(reservePromotionWithClient(db, {
        findingId: finding.id, destinationType: "wiki_draft", destinationKey: `wiki-${uuid()}`,
        idempotencyKey: "idem-2", leaseOwner: "owner-1", leaseGeneration: 1,
        consumedFindingRevision: finding.revision,
      }), "created");

      // Wrong owner → fence_mismatch
      const r1 = terminalizePromotionWithClient(db, {
        promotionId: promotion.id, leaseOwner: "wrong-owner",
        leaseGeneration: 1, status: "succeeded",
      });
      expect(r1.outcome).toBe("fence_mismatch");

      // Correct owner → succeeds
      const r2 = asOutcome(terminalizePromotionWithClient(db, {
        promotionId: promotion.id, leaseOwner: "owner-1",
        leaseGeneration: 1, status: "succeeded",
        targetType: "wiki_page", targetId: "wiki-page-1",
      }), "terminalized");
      expect(r2.promotion.status).toBe("succeeded");
      expect(r2.promotion.targetId).toBe("wiki-page-1");
    });
  });

  // -------------------------------------------------------------------------
  // 7. Habitat isolation
  // -------------------------------------------------------------------------

  describe("Habitat isolation", () => {
    it("getFindingsByHabitat does not return another Habitat's rows", () => {
      const db = getDb();
      const wiA = setupWorkItem(db, { habitatId: "hab-A" });
      const attA = setupAttempt(db, wiA.id);
      const wiB = setupWorkItem(db, { habitatId: "hab-B", logicalWorkKey: `lwkey-B-${uuid()}` });
      const attB = setupAttempt(db, wiB.id);

      asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({ habitatId: "hab-A", lineageRootId: uuid() }),
            attemptId: attA.id, workItemId: wiA.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attA.id,
          }),
        ),
        "created",
      );

      asOutcome(
        db.transaction((tx) =>
          persistCandidateWithClient(tx, {
            ...makeCandidateInput({ habitatId: "hab-B", lineageRootId: uuid() }),
            attemptId: attB.id, workItemId: wiB.id,
            leaseOwner: "owner-1", leaseGeneration: 1, firstAttemptId: attB.id,
          }),
        ),
        "created",
      );

      const habAFindings = getFindingsByHabitatWithClient(db, "hab-A");
      const habBFindings = getFindingsByHabitatWithClient(db, "hab-B");
      expect(habAFindings).toHaveLength(1);
      expect(habBFindings).toHaveLength(1);
      expect(habAFindings[0].habitatId).toBe("hab-A");
      expect(habBFindings[0].habitatId).toBe("hab-B");
    });
  });

  // -------------------------------------------------------------------------
  // 8. Policy CRUD with version CAS
  // -------------------------------------------------------------------------

  describe("policy CRUD with version CAS", () => {
    it("creates a policy and reads it back", () => {
      const db = getDb();
      const r = asOutcome(createPolicyWithClient(db, {
        habitatId: "hab-A",
        extractorKey: "test_extractor",
        sourceTypes: ["task_lifecycle_audit"],
        schedule: "0 2 * * *",
        windowSeconds: 86400,
        lookbackSeconds: 604800,
      }), "created");
      expect(r.policy.version).toBe(1);
    });

    it("update with correct version succeeds; stale version conflicts", () => {
      const db = getDb();
      const { policy } = asOutcome(createPolicyWithClient(db, {
        habitatId: "hab-A",
        extractorKey: "ext1",
        sourceTypes: ["task_lifecycle_audit"],
        schedule: "0 2 * * *",
        windowSeconds: 86400,
        lookbackSeconds: 604800,
      }), "created");

      const r1 = asOutcome(updatePolicyWithClient(db, {
        policyId: policy.id, expectedVersion: 1, schedule: "0 3 * * *",
      }), "updated");
      expect(r1.policy.version).toBe(2);

      const r2 = asOutcome(updatePolicyWithClient(db, {
        policyId: policy.id, expectedVersion: 1, schedule: "0 4 * * *",
      }), "version_conflict");
      expect(r2.policy.version).toBe(2);
      expect(r2.policy.schedule).toBe("0 3 * * *");
    });
  });

  // -------------------------------------------------------------------------
  // 9. Work-item terminalization fence
  // -------------------------------------------------------------------------

  describe("work-item terminalization", () => {
    it("succeeds when attempt matches and work is running", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      const tResult = asOutcome(terminalizeWorkItemWithClient(db, {
        workItemId: workItem.id, attemptId: attempt.id, status: "succeeded",
      }), "terminalized");
      expect(tResult.workItem.status).toBe("succeeded");
      expect(tResult.workItem.completedByAttemptId).toBe(attempt.id);
    });

    it("second terminalization fails (already terminal)", () => {
      const db = getDb();
      const workItem = setupWorkItem(db);
      const attempt = setupAttempt(db, workItem.id);

      terminalizeWorkItemWithClient(db, {
        workItemId: workItem.id, attemptId: attempt.id, status: "succeeded",
      });

      const r2 = terminalizeWorkItemWithClient(db, {
        workItemId: workItem.id, attemptId: attempt.id, status: "succeeded",
      });
      expect(r2.outcome).toBe("illegal_source_state");
    });
  });
});
