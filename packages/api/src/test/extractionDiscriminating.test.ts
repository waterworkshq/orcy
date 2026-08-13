/**
 * Learning Loop discriminating (falsifying) tests — remediation round 3.
 *
 * Each test injects the specific failure the blocker fix addresses and
 * asserts the observable production outcome. Each test MUST fail if the
 * fix is reverted (mutation-checked — evidence recorded in SCRATCHPAD.md).
 *
 * Coverage:
 *   B2: (a) window-scoped floor (all-time 5/3 but window 1/1 → no cohort)
 *       (b) fail-closed on null sourcePulseIds (all-time 5/3, null IDs → no cohort)
 *   B4: State machine (accept withdrawn → illegal_source_state)
 *   B3: Two full lifecycle runs over changed evidence → linked revision 2
 *   B5: Crash-safe promotion plus observed-fence single-winner re-arm
 *   B6: Kill switch (globally disabled → promote disabled)
 *   B7: (a) replay-safe recovery identity (stored window reused, no recapture)
 *       (b) status-guarded markAttemptFailed (CAS on status='running')
 *   B8: (a) source_snapshot persisted on attempt
 *       (b) failed source → watermark not advanced → partial
 *       (c) detector failure → partial outcome (no fake source)
 *   B9: IMMEDIATE allocation transaction is selected before read-MAX
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  reviewCasWithClient,
  persistCandidateWithClient,
  reserveWorkItemWithClient,
  createAttemptWithClient,
  terminalizeAttemptWithClient,
  getLatestAttemptWithClient,
  getFindingsByHabitatWithClient,
  createPolicyWithClient,
  updatePolicyWithClient,
  getWorkItemsByHabitatWithClient,
  reservePromotionWithClient,
  reArmPendingPromotionLeaseWithClient,
  type CitationInput,
} from "../repositories/extraction/index.js";
import { runExtraction } from "../services/extractionRunLifecycle.js";
import { runExtractionReconciliationPass } from "../services/extractionRecovery.js";
import { promoteToWikiDraft } from "../services/extractionWikiDestination.js";
import { getAdapter } from "../services/extractionSourceCatalog/index.js";
import {
  projectExperienceSignals,
  defaultFloor,
  deriveCoarseWindow,
  computeExperienceSourceId,
} from "../services/extractionSourceCatalog/experiencePrivacy.js";
import * as wikiService from "../services/wikiService.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/index.js";
import { logger } from "../lib/logger.js";
import {
  habitats,
  columns,
  missions,
  tasks,
  agents,
  extractedFindings,
  extractedFindingSources,
  extractedFindingReviews,
  extractedFindingPromotions,
  extractionAttempts,
  extractionWorkItems,
  habitatSkillSignals,
  pulses,
  wikiPages,
} from "../db/schema/index.js";
import { BUILTIN_EXTRACTOR_KEY, BUILTIN_EXTRACTOR_VERSION } from "../services/extractionExtractors.js";
import type { LearningLoopPolicyRow } from "@orcy/shared";

const ENV_FLAG = "ORCY_LEARNING_LOOP_ENABLED";
let savedEnvFlag: string | undefined;
const WINDOW_FROM = "2020-01-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function setupHabitat(id: string): void {
  const db = getDb();
  db.insert(habitats).values({ id, name: id }).run();
  db.insert(columns).values({ id: `col-${id}`, habitatId: id, name: "Todo", order: 0 }).run();
  db.insert(missions).values({
    id: `mis-${id}`, habitatId: id, columnId: `col-${id}`,
    title: `Mission ${id}`, createdBy: "test-user",
  }).run();
}

function setupPolicy(opts: { habitatId?: string; enabled?: boolean } = {}): LearningLoopPolicyRow {
  const db = getDb();
  const result = createPolicyWithClient(db, {
    habitatId: opts.habitatId ?? "hab-A",
    extractorKey: BUILTIN_EXTRACTOR_KEY,
    sourceTypes: ["task_lifecycle_audit"] as never,
    schedule: "0 */5 * * *",
    windowSeconds: 3600,
    lookbackSeconds: 86400,
    createdByType: "human",
  });
  if (result.outcome !== "created") throw new Error("Policy creation failed");
  if (opts.enabled) {
    const updated = updatePolicyWithClient(db, {
      policyId: result.policy.id, expectedVersion: 1, enabled: true,
    });
    if (updated.outcome !== "updated") throw new Error("Policy enable failed");
    return updated.policy;
  }
  return result.policy;
}

function insertProposedFinding(
  habitatId: string,
  status: "proposed" | "accepted" | "rejected" | "superseded" | "withdrawn" = "proposed",
): string {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();
  const attemptId = `att-${uuid()}`;
  db.insert(extractedFindings).values({
    id, habitatId, firstAttemptId: attemptId, lastSeenAttemptId: attemptId,
    lineageRootId: id, supersedesFindingId: null, revision: 1,
    extractorKey: "test", extractorVersion: 1,
    findingType: "lesson" as const,
    subject: "Test", body: "Body", structuredPayload: null,
    confidence: 0.8, sampleSize: 5,
    completeness: "complete" as const,
    visibilityCeiling: "habitat_member" as const,
    fingerprint: `fp-${id}`,
    evidenceDigest: `ed-${id}`, status, decisionVersion: 1,
    firstSeenAt: now, lastSeenAt: now, occurrenceCount: 1, caveats: [],
  }).run();
  return id;
}

function makeResolvableCitation(findingId: string, habitatId: string): void {
  const db = getDb();
  const task = taskRepo.createTask({
    missionId: `mis-${habitatId}`,
    title: "Discriminating fixture task",
    createdBy: "test-user",
  });
  const event = eventRepo.createEvent({
    taskId: task.id,
    actorType: "human",
    actorId: "test-user",
    action: "created",
  });
  db.insert(extractedFindingSources).values({
    id: uuid(), findingId, sourceType: "task_lifecycle_audit",
    sourceId: `task_event:${event.id}`, sourceVersion: "lifecycle-task-v1", role: "supporting",
    sourceDigest: null, occurredAt: event.timestamp,
    entityRefs: [{ type: "task", id: task.id }, { type: "mission", id: `mis-${habitatId}` }],
    completeness: "complete", visibilityClass: "habitat_member",
  }).run();
}

function makeCitation(findingId: string): void {
  const db = getDb();
  db.insert(extractedFindingSources).values({
    id: uuid(), findingId, sourceType: "task_lifecycle_audit",
    sourceId: "task_event:1", sourceVersion: "v1", role: "supporting",
    sourceDigest: "digest-1", occurredAt: "2026-06-01T00:00:00Z",
    entityRefs: [], completeness: "complete", visibilityClass: "habitat_member",
  }).run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Learning Loop discriminating tests (remediation round 3)", () => {
  beforeEach(async () => {
    savedEnvFlag = process.env[ENV_FLAG];
    process.env[ENV_FLAG] = "true";
    await initTestDb();
    setupHabitat("hab-A");
  });

  // ── B3: Production lifecycle derives linked revision 2 ───────────

  describe("B3: lifecycle-composed finding revision", () => {
    it("two runExtraction calls over changed evidence preserve revision 1 and link revision 2", () => {
      const policy = setupPolicy({ enabled: true });
      const adapter = getAdapter("task_lifecycle_audit");
      const boundaryToken = {
        sourceType: "task_lifecycle_audit" as const,
        highWaterMark: "2026-06-15T12:00:00Z",
        capturedAt: "2026-06-15T12:00:00Z",
      };
      vi.spyOn(adapter, "captureBoundary").mockReturnValue(boundaryToken);

      const batch = (evidenceVersion: string) => ({
        sourceType: "task_lifecycle_audit" as const,
        observations: [1, 2, 3].map((index) => ({
          observationId: `b3-observation-${index}`,
          sourceType: "task_lifecycle_audit" as const,
          underlyingId: `b3-event-${index}`,
          occurredAt: `2026-06-15T11:0${index}:00Z`,
          entityRefs: [{ type: "task", id: "task-b3" }],
          domains: [],
          digest: `b3-digest-${evidenceVersion}-${index}`,
          contractVersion: "v1",
          collectorFamily: "task_lifecycle",
          habitatId: "hab-A",
          visibilityClass: "habitat_member" as const,
        })),
        completeness: "complete" as const,
        warnings: [],
        boundaryToken,
        collectionOutcome: "collected" as const,
      });
      vi.spyOn(adapter, "collect")
        .mockReturnValueOnce(batch("one"))
        .mockReturnValueOnce(batch("two"));

      const first = runExtraction({
        habitatId: "hab-A", policy, deliveryMode: "manual",
        actorType: "human", actorId: "reviewer", now: "2026-06-15T12:00:00Z",
      });
      const second = runExtraction({
        habitatId: "hab-A", policy, deliveryMode: "manual",
        actorType: "human", actorId: "reviewer", now: "2026-06-15T12:00:00Z",
        isFreshRerun: true, freshReason: "Evidence changed",
      });

      expect(first.kind).toBe("executed");
      expect(second.kind).toBe("executed");
      const findings = getFindingsByHabitatWithClient(getDb(), "hab-A")
        .toSorted((a, b) => a.revision - b.revision);
      expect(findings).toHaveLength(2);
      expect(findings[0]!.revision).toBe(1);
      expect(findings[0]!.lineageRootId).toBe(findings[0]!.id);
      expect(findings[1]!.revision).toBe(2);
      expect(findings[1]!.supersedesFindingId).toBe(findings[0]!.id);
      expect(findings[1]!.lineageRootId).toBe(findings[0]!.id);
    });
  });
  afterEach(() => {
    if (savedEnvFlag === undefined) delete process.env[ENV_FLAG];
    else process.env[ENV_FLAG] = savedEnvFlag;
    vi.restoreAllMocks();
    closeDb();
  });

  // ── B2(a): Window-scoped floor falsifier ────────────────────────

  describe("B2(a): window-scoped privacy floor", () => {
    it("all-time 5/3 but window 1/1 → no eligible cohort from collect", () => {
      const db = getDb();
      const now = new Date().toISOString();

      const outsidePulseId = "pulse-b2-outside";
      db.insert(pulses).values({
        id: outsidePulseId, habitatId: "hab-A", scope: "habitat",
        fromType: "agent", fromId: "agent-x", signalType: "experience",
        subject: "Old", body: "",
        createdAt: "2019-01-01T00:00:00Z",
      }).run();

      for (const cat of ["pitfall", "pattern"]) {
        db.insert(habitatSkillSignals).values({
          id: `sig-b2-${cat}`, habitatId: "hab-A",
          clusterKey: `b2-${cat}`, skillCategory: cat,
          sourceSignalType: "experience", sourceType: "pulse",
          subject: `B2 ${cat}`, summary: null, strength: 0.5,
          frequency: 5, corroboratingAgents: 3,
          crossMissionCount: 0, successfulTasks: 0, failedTasks: 0,
          firstSeenAt: "2019-01-01T00:00:00Z", lastSeenAt: now,
          sourcePulseIds: JSON.stringify([outsidePulseId]),
          sourceTaskIds: null, sourceCommentIds: null,
          corroboratingAgentIds: '["agent-x","agent-y","agent-z"]',
          promotedToSkill: 0, createdAt: now, updatedAt: now,
        }).run();
      }

      const adapter = getAdapter("experience_aggregate");
      const batch = adapter.collect({
        habitatId: "hab-A",
        windowFrom: WINDOW_FROM,
      });

      expect(batch.observations.length).toBe(0);
    });

    it("all-time 5/3 but window 1/1 → resolveByRefs returns unauthorized", () => {
      const db = getDb();
      const now = new Date().toISOString();
      const coarseWindow = deriveCoarseWindow(WINDOW_FROM);

      const outsidePulseId = "pulse-b2-resolve";
      db.insert(pulses).values({
        id: outsidePulseId, habitatId: "hab-A", scope: "habitat",
        fromType: "agent", fromId: "agent-x", signalType: "experience",
        subject: "Old", body: "",
        createdAt: "2019-01-01T00:00:00Z",
      }).run();

      for (const cat of ["pitfall", "pattern"]) {
        db.insert(habitatSkillSignals).values({
          id: `sig-b2r-${cat}`, habitatId: "hab-A",
          clusterKey: `b2r-${cat}`, skillCategory: cat,
          sourceSignalType: "experience", sourceType: "pulse",
          subject: `B2r ${cat}`, summary: null, strength: 0.5,
          frequency: 5, corroboratingAgents: 3,
          crossMissionCount: 0, successfulTasks: 0, failedTasks: 0,
          firstSeenAt: "2019-01-01T00:00:00Z", lastSeenAt: now,
          sourcePulseIds: JSON.stringify([outsidePulseId]),
          sourceTaskIds: null, sourceCommentIds: null,
          corroboratingAgentIds: '["agent-x","agent-y","agent-z"]',
          promotedToSkill: 0, createdAt: now, updatedAt: now,
        }).run();
      }

      const adapter = getAdapter("experience_aggregate");
      const fakeSourceId = computeExperienceSourceId("hab-A", "b2r-pitfall", "pitfall", coarseWindow);

      const resolved = adapter.resolveByRefs(
        [{ sourceType: "experience_aggregate", sourceId: fakeSourceId, sourceVersion: coarseWindow }],
        { habitatId: "hab-A" },
      );

      expect(resolved[0]!.state).toBe("unauthorized");
    });
  });

  // ── B2(b): Fail-closed on null/absent sourcePulseIds ─────────────

  describe("B2(b): fail-closed on null sourcePulseIds", () => {
    it("all-time 5/3 but null sourcePulseIds → no eligible cohort (fail closed)", () => {
      const db = getDb();
      const now = new Date().toISOString();

      // Two signals with all-time 5/3 but NULL sourcePulseIds.
      // The projection must fail closed: these cohorts are ineligible
      // because their window membership cannot be verified.
      for (const cat of ["pitfall", "pattern"]) {
        db.insert(habitatSkillSignals).values({
          id: `sig-b2n-${cat}`, habitatId: "hab-A",
          clusterKey: `b2n-${cat}`, skillCategory: cat,
          sourceSignalType: "experience", sourceType: "pulse",
          subject: `B2n ${cat}`, summary: null, strength: 0.5,
          frequency: 5, corroboratingAgents: 3,
          crossMissionCount: 0, successfulTasks: 0, failedTasks: 0,
          firstSeenAt: "2019-01-01T00:00:00Z", lastSeenAt: now,
          sourcePulseIds: null, // ← null provenance
          sourceTaskIds: null, sourceCommentIds: null,
          corroboratingAgentIds: '["agent-x","agent-y","agent-z"]',
          promotedToSkill: 0, createdAt: now, updatedAt: now,
        }).run();
      }

      const adapter = getAdapter("experience_aggregate");
      const batch = adapter.collect({
        habitatId: "hab-A",
        windowFrom: WINDOW_FROM,
      });

      // B2 fix: null sourcePulseIds → fail closed → no observations.
      // WITHOUT the fix: falls back to all-time 5/3 → admits the cohort.
      expect(batch.observations.length).toBe(0);
    });

    it("all-time 5/3 but empty sourcePulseIds [] → no eligible cohort", () => {
      const db = getDb();
      const now = new Date().toISOString();

      for (const cat of ["pitfall", "pattern"]) {
        db.insert(habitatSkillSignals).values({
          id: `sig-b2e-${cat}`, habitatId: "hab-A",
          clusterKey: `b2e-${cat}`, skillCategory: cat,
          sourceSignalType: "experience", sourceType: "pulse",
          subject: `B2e ${cat}`, summary: null, strength: 0.5,
          frequency: 5, corroboratingAgents: 3,
          crossMissionCount: 0, successfulTasks: 0, failedTasks: 0,
          firstSeenAt: "2019-01-01T00:00:00Z", lastSeenAt: now,
          sourcePulseIds: "[]", // ← empty array
          sourceTaskIds: null, sourceCommentIds: null,
          corroboratingAgentIds: '["agent-x","agent-y","agent-z"]',
          promotedToSkill: 0, createdAt: now, updatedAt: now,
        }).run();
      }

      const adapter = getAdapter("experience_aggregate");
      const batch = adapter.collect({
        habitatId: "hab-A",
        windowFrom: WINDOW_FROM,
      });

      expect(batch.observations.length).toBe(0);
    });

    it("all-time 5/3 but malformed sourcePulseIds → no eligible cohort", () => {
      const db = getDb();
      const now = new Date().toISOString();

      for (const cat of ["pitfall", "pattern"]) {
        db.insert(habitatSkillSignals).values({
          id: `sig-b2m-${cat}`, habitatId: "hab-A",
          clusterKey: `b2m-${cat}`, skillCategory: cat,
          sourceSignalType: "experience", sourceType: "pulse",
          subject: `B2m ${cat}`, summary: null, strength: 0.5,
          frequency: 5, corroboratingAgents: 3,
          crossMissionCount: 0, successfulTasks: 0, failedTasks: 0,
          firstSeenAt: "2019-01-01T00:00:00Z", lastSeenAt: now,
          sourcePulseIds: "{not valid json", // ← malformed
          sourceTaskIds: null, sourceCommentIds: null,
          corroboratingAgentIds: '["agent-x","agent-y","agent-z"]',
          promotedToSkill: 0, createdAt: now, updatedAt: now,
        }).run();
      }

      const adapter = getAdapter("experience_aggregate");
      const batch = adapter.collect({
        habitatId: "hab-A",
        windowFrom: WINDOW_FROM,
      });

      expect(batch.observations.length).toBe(0);
    });
  });

  // ── B4: State machine ───────────────────────────────────────────

  describe("B4: review state machine", () => {
    it("accept on withdrawn finding returns illegal_source_state (no resurrection)", () => {
      const db = getDb();
      const findingId = insertProposedFinding("hab-A", "accepted");
      makeCitation(findingId);

      const withdrawResult = reviewCasWithClient(db, {
        findingId, decision: "withdraw", reason: "Privacy invalidation",
        reviewerType: "human", reviewerId: "reviewer-1", expectedDecisionVersion: 1,
      });
      expect(withdrawResult.outcome).toBe("decided");

      const acceptResult = reviewCasWithClient(db, {
        findingId, decision: "accept", reason: "Re-accept",
        reviewerType: "human", reviewerId: "reviewer-2", expectedDecisionVersion: 2,
      });

      expect(acceptResult.outcome).toBe("illegal_source_state");
    });

    it("request_revision on accepted finding returns illegal_source_state", () => {
      const db = getDb();
      const findingId = insertProposedFinding("hab-A", "accepted");
      makeCitation(findingId);

      const result = reviewCasWithClient(db, {
        findingId, decision: "request_revision", reason: "Revision",
        reviewerType: "human", reviewerId: "reviewer-1", expectedDecisionVersion: 1,
      });

      expect(result.outcome).toBe("illegal_source_state");
    });
  });

  // ── B5: Crash-safe promotion — genuine failure injection ───────

  describe("B5: crash-safe wiki promotion", () => {
    it("throw after createPage → retry reaches tag recovery → exactly one page", () => {
      const db = getDb();
      const findingId = insertProposedFinding("hab-A", "accepted");
      makeResolvableCitation(findingId, "hab-A");
      setupPolicy({ habitatId: "hab-A", enabled: true });

      // B5 genuine test: inject failure AFTER createPage succeeds but BEFORE
      // recordTarget. The promotion row is left pending with null target_id.
      // A retry must reach the tag-recovery path (not conflict on lease).
      const realCreatePage = wikiService.createPage;
      let firstCall = true;
      const spy = vi.spyOn(wikiService, "createPage").mockImplementation(
        (habitatId: string, input: Parameters<typeof realCreatePage>[1], createdBy: string) => {
          const page = realCreatePage(habitatId, input, createdBy);
          if (firstCall) {
            firstCall = false;
            throw new Error("CRASH_AFTER_CREATE_PAGE");
          }
          return page;
        },
      );

      // First promotion attempt: createPage succeeds then throws → promotion
      // stays pending with null target_id.
      expect(() => promoteToWikiDraft("hab-A", findingId, "user-1")).toThrow();

      // Verify crash state: promotion is pending, no target_id.
      const promoRow = db.select().from(extractedFindingPromotions)
        .where(eq(extractedFindingPromotions.findingId, findingId)).all()[0];
      expect(promoRow?.status).toBe("pending");
      expect(promoRow?.targetId).toBeNull();

      db.update(extractedFindingPromotions)
        .set({ updatedAt: new Date(Date.now() - 60_000).toISOString() })
        .where(eq(extractedFindingPromotions.findingId, findingId))
        .run();

      // One page was created by the crashed attempt.
      const pagesAfterCrash = db.select().from(wikiPages)
        .where(eq(wikiPages.habitatId, "hab-A")).all().length;
      expect(pagesAfterCrash).toBe(1);

      // Retry: must find the existing page via the deterministic tag,
      // NOT create a second page. B5 fix re-arms the lease on the pending
      // promotion and reaches the tag lookup.
      spy.mockRestore();
      const result2 = promoteToWikiDraft("hab-A", findingId, "user-2");
      expect(result2.outcome).not.toBe("disabled");

      // Exactly ONE wiki page total — no duplicate.
      const pagesAfterRetry = db.select().from(wikiPages)
        .where(eq(wikiPages.habitatId, "hab-A")).all().length;
      expect(pagesAfterRetry).toBe(1);
    });

    it("only the retry that observed the stored old fence can re-arm a pending row", () => {
      const findingId = insertProposedFinding("hab-A", "accepted");
      const reservation = reservePromotionWithClient(getDb(), {
        findingId,
        destinationType: "wiki_draft",
        destinationKey: `wiki:${findingId}`,
        idempotencyKey: `promotion:${findingId}`,
        leaseOwner: "old-owner",
        leaseGeneration: 10,
        consumedFindingRevision: 1,
      });
      expect(reservation.outcome).toBe("created");

      const winner = reArmPendingPromotionLeaseWithClient(getDb(), {
        promotionId: reservation.promotion.id,
        leaseOwner: "retry-a",
        leaseGeneration: 11,
        expectedLeaseOwner: "old-owner",
        expectedLeaseGeneration: 10,
      });
      const loser = reArmPendingPromotionLeaseWithClient(getDb(), {
        promotionId: reservation.promotion.id,
        leaseOwner: "retry-b",
        leaseGeneration: 12,
        expectedLeaseOwner: "different-observed-owner",
        expectedLeaseGeneration: 9,
      });

      expect(winner.outcome).toBe("re_armed");
      expect(loser.outcome).toBe("fence_mismatch");
      if (loser.outcome === "fence_mismatch") {
        expect(loser.promotion.leaseOwner).toBe("retry-a");
        expect(loser.promotion.leaseGeneration).toBe(11);
      }
    });
  });

  // ── B6: Kill switch on promotion ────────────────────────────────

  describe("B6: promotion kill switch", () => {
    it("globally disabled → promote returns disabled, no page created", () => {
      delete process.env[ENV_FLAG];
      const findingId = insertProposedFinding("hab-A", "accepted");
      makeCitation(findingId);

      const result = promoteToWikiDraft("hab-A", findingId, "user-1");

      expect(result.outcome).toBe("disabled");
      if (result.outcome === "disabled") {
        expect(result.reason).toBe("global_kill_switch");
      }

      const pages = getDb()
        .select().from(wikiPages).where(eq(wikiPages.habitatId, "hab-A")).all();
      expect(pages.length).toBe(0);
    });

    it("habitat not enrolled (no enabled policy) → promote returns disabled", () => {
      const findingId = insertProposedFinding("hab-A", "accepted");
      makeCitation(findingId);

      const result = promoteToWikiDraft("hab-A", findingId, "user-1");

      expect(result.outcome).toBe("disabled");
      if (result.outcome === "disabled") {
        expect(result.reason).toBe("habitat_not_enrolled");
      }
    });
  });

  // ── B7(a): Replay-safe recovery identity ─────────────────────────

  describe("B7(a): replay-safe recovery identity", () => {
    it("boot recovery reuses stored window and boundary tokens (does not recapture)", () => {
      const db = getDb();
      const policy = setupPolicy({ enabled: true });

      // Create a work item with a SPECIFIC old window and boundary tokens.
      const storedWindow = {
        windowFrom: "2020-06-01T00:00:00Z",
        windowTo: "2020-06-02T00:00:00Z",
      };
      const storedTokens = {
        task_lifecycle_audit: "2020-06-01T12:00:00Z",
      };

      const workItem = reserveWorkItemWithClient(db, {
        habitatId: "hab-A", policyId: policy.id,
        extractorKey: BUILTIN_EXTRACTOR_KEY, extractorVersion: BUILTIN_EXTRACTOR_VERSION,
        policyVersion: 1,
        windowFrom: storedWindow.windowFrom,
        windowTo: storedWindow.windowTo,
        sourceBoundaryTokens: storedTokens,
        logicalWorkKey: `lwkey-b7a-${uuid()}`,
        deliveryMode: "scheduled",
        policySnapshot: {
          schedule: "0 */5 * * *", windowSeconds: 3600, lookbackSeconds: 86400,
          sourceTypes: ["task_lifecycle_audit"], minConfidence: null, minSampleSize: null,
        },
      });
      if (workItem.outcome !== "created") throw new Error("work item failed");

      const attempt = createAttemptWithClient(db, {
        workItemId: workItem.workItem.id, deliveryMode: "scheduled",
        leaseOwner: "owner-1", leaseGeneration: 1,
        leaseExpiresAt: "2020-01-01T00:00:00Z", // Already expired.
      });
      if (attempt.outcome !== "created") throw new Error("attempt failed");

      // Spy on the task_lifecycle_audit adapter's captureBoundary.
      // B7(a) fix: boot recovery must NOT recapture — it reuses stored tokens.
      const adapter = getAdapter("task_lifecycle_audit" as never);
      const captureSpy = vi.spyOn(adapter, "captureBoundary");

      // Run recovery — the stale attempt will be failed and a new one created
      // via runExtraction with the existing work item.
      runExtractionReconciliationPass();

      // B7(a) fix: captureBoundary must NOT be called during boot recovery.
      // If it IS called, the fix was reverted (recomputing window/tokens).
      expect(captureSpy).not.toHaveBeenCalled();
    });
  });

  // ── B7(b): Status-guarded markAttemptFailed ──────────────────────

  describe("B7(b): status-guarded markAttemptFailed", () => {
    it("concurrently terminalized attempt is NOT overwritten by markAttemptFailed", () => {
      const db = getDb();
      const policy = setupPolicy({ enabled: true });

      // Create work item + attempt.
      const workItem = reserveWorkItemWithClient(db, {
        habitatId: "hab-A", policyId: policy.id,
        extractorKey: BUILTIN_EXTRACTOR_KEY, extractorVersion: BUILTIN_EXTRACTOR_VERSION,
        policyVersion: 1, windowFrom: "2026-06-01T00:00:00Z", windowTo: "2026-06-02T00:00:00Z",
        sourceBoundaryTokens: {}, logicalWorkKey: `lwkey-b7b-${uuid()}`,
        deliveryMode: "scheduled",
        policySnapshot: {
          schedule: "0 */5 * * *", windowSeconds: 3600, lookbackSeconds: 86400,
          sourceTypes: ["task_lifecycle_audit"], minConfidence: null, minSampleSize: null,
        },
      });
      if (workItem.outcome !== "created") throw new Error("work item failed");

      const attempt = createAttemptWithClient(db, {
        workItemId: workItem.workItem.id, deliveryMode: "scheduled",
        leaseOwner: "owner-1", leaseGeneration: 1,
        leaseExpiresAt: "2020-01-01T00:00:00Z", // Expired.
      });
      if (attempt.outcome !== "created") throw new Error("attempt failed");

      // The recovery scan is a SELECT. Intercept its first subsequent UPDATE and
      // terminalize the already-selected row immediately before markAttemptFailed
      // builds its UPDATE. This forces the status guard to decide the outcome.
      const originalUpdate = db.update.bind(db);
      vi.spyOn(db, "update").mockImplementationOnce(((table: Parameters<typeof db.update>[0]) => {
        const termResult = terminalizeAttemptWithClient(db, {
          attemptId: attempt.attempt.id,
          workItemId: workItem.workItem.id,
          leaseOwner: "owner-1", leaseGeneration: 1,
          status: "succeeded" as const,
          candidateCount: 0, persistedCount: 0,
        });
        expect(termResult.outcome).toBe("terminalized");
        return originalUpdate(table);
      }) as typeof db.update);

      const summary = runExtractionReconciliationPass();

      // The attempt should NOT have been marked failed — it's already succeeded.
      const rawAttempt = db.select().from(extractionAttempts)
        .where(eq(extractionAttempts.id, attempt.attempt.id)).all()[0];
      expect(rawAttempt?.status).toBe("succeeded");

      expect(summary.staleAttempts).toBe(1);
      expect(summary.failedAttempts).toBe(0);
    });
  });

  // ── B7: Recovery commit-truth ───────────────────────────────────

  describe("B7: boot recovery commit-truth", () => {
    it("actual commit-before-terminalize (persistedCount=0) → recovery repairs via hasCommittedFindings", () => {
      const db = getDb();
      const policy = setupPolicy({ enabled: true });

      const workItem = reserveWorkItemWithClient(db, {
        habitatId: "hab-A", policyId: policy.id,
        extractorKey: BUILTIN_EXTRACTOR_KEY, extractorVersion: BUILTIN_EXTRACTOR_VERSION,
        policyVersion: 1, windowFrom: "2026-06-01T00:00:00Z", windowTo: "2026-06-02T00:00:00Z",
        sourceBoundaryTokens: {}, logicalWorkKey: `lwkey-${uuid()}`,
        deliveryMode: "scheduled",
        policySnapshot: {
          schedule: "0 */5 * * *", windowSeconds: 3600, lookbackSeconds: 86400,
          sourceTypes: ["task_lifecycle_audit"], minConfidence: null, minSampleSize: null,
        },
      });
      if (workItem.outcome !== "created") throw new Error("work item failed");

      const attempt = createAttemptWithClient(db, {
        workItemId: workItem.workItem.id, deliveryMode: "scheduled",
        leaseOwner: "owner-1", leaseGeneration: 1,
        leaseExpiresAt: "2020-01-01T00:00:00Z",
      });
      if (attempt.outcome !== "created") throw new Error("attempt failed");

      const persistResult = persistCandidateWithClient(db, {
        attemptId: attempt.attempt.id, workItemId: workItem.workItem.id,
        leaseOwner: "owner-1", leaseGeneration: 1,
        habitatId: "hab-A", firstAttemptId: attempt.attempt.id,
        fingerprint: `fp-${uuid()}`, evidenceDigest: `ed-${uuid()}`,
        extractorKey: BUILTIN_EXTRACTOR_KEY, extractorVersion: BUILTIN_EXTRACTOR_VERSION,
        findingType: "lesson", subject: "Committed", body: "Before terminalize",
        confidence: 0.8, sampleSize: 5, completeness: "complete",
        visibilityCeiling: "habitat_member", caveats: [],
        citations: [{
          id: uuid(), sourceType: "task_lifecycle_audit",
          sourceId: "task_event:b7", sourceVersion: "v1", role: "supporting",
          visibilityClass: "habitat_member",
        } as CitationInput],
        scopeRefs: [],
      });
      expect(persistResult.outcome).toBe("created");

      const rawAttempt = db.select().from(extractionAttempts)
        .where(eq(extractionAttempts.id, attempt.attempt.id)).all()[0];
      expect(rawAttempt?.persistedCount).toBe(0);

      const summary = runExtractionReconciliationPass();

      expect(summary.staleAttempts).toBe(1);
      expect(summary.failedAttempts).toBe(1);
      expect(summary.repairedWorkItems).toBeGreaterThanOrEqual(1);

      const findings = getFindingsByHabitatWithClient(db, "hab-A");
      expect(findings.length).toBe(1);
    });
  });

  // ── B8: Source diagnostics, snapshot, watermark, tallies ────────

  describe("B8(a): source_snapshot persisted on attempt", () => {
    it("dry-run persists source_snapshot on the attempt row", () => {
      const db = getDb();
      const policy = setupPolicy({ enabled: true });

      const result = runExtraction({
        habitatId: "hab-A", policy,
        deliveryMode: "manual", actorType: "human", actorId: "user-1",
        dryRun: true,
      });

      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") return;

      // Reload the attempt and verify source_snapshot was persisted.
      const rawAttempt = db.select().from(extractionAttempts)
        .where(eq(extractionAttempts.id, result.attempt.id)).all()[0];
      expect(rawAttempt).toBeTruthy();
      const snapshot = rawAttempt!.sourceSnapshot as unknown[];
      expect(Array.isArray(snapshot)).toBe(true);
      expect(snapshot!.length).toBeGreaterThan(0);

      // Verify the snapshot has the expected source diagnostics shape.
      const first = snapshot![0] as Record<string, unknown>;
      expect(first).toHaveProperty("sourceType");
      expect(first).toHaveProperty("completeness");
      expect(first).toHaveProperty("watermarkAdvanced");
    });
  });

  describe("B8(b): failed source → watermark not advanced → partial outcome", () => {
    it("adapter collection failure produces partial attempt with watermarkAdvanced=false", () => {
      const db = getDb();
      const policy = setupPolicy({ enabled: true });

      // Spy on an adapter's collect to inject failure.
      const adapter = getAdapter("task_lifecycle_audit" as never);
      const collectSpy = vi.spyOn(adapter, "collect").mockReturnValue({
        sourceType: "task_lifecycle_audit",
        observations: [],
        completeness: "partial",
        warnings: ["source_unavailable"],
        boundaryToken: {
          sourceType: "task_lifecycle_audit",
          highWaterMark: "2026-01-01T00:00:00Z",
          capturedAt: "2026-01-01T00:00:00Z",
        },
        collectionOutcome: "failed" as const,
      });

      const result = runExtraction({
        habitatId: "hab-A", policy,
        deliveryMode: "manual", actorType: "human", actorId: "user-1",
      });

      collectSpy.mockRestore();

      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") return;

      // B8 fix: failed source → watermark NOT advanced → partial outcome.
      expect(result.outcome).toBe("partial");

      // Verify the snapshot records watermarkAdvanced=false.
      const failedSource = result.sources.find(
        (s) => s.sourceType === "task_lifecycle_audit",
      );
      expect(failedSource).toBeTruthy();
      expect(failedSource!.watermarkAdvanced).toBe(false);
    });
  });

  describe("B8(c): detector failure → partial outcome (no fake source)", () => {
    it("a real detector throw marks the attempt partial, logs diagnostics, and fabricates no source", () => {
      const policy = setupPolicy({ enabled: true });

      const adapter = getAdapter("task_lifecycle_audit");
      const boundaryToken = {
        sourceType: "task_lifecycle_audit" as const,
        highWaterMark: "2026-06-15T12:00:00Z",
        capturedAt: "2026-06-15T12:00:00Z",
      };
      vi.spyOn(adapter, "captureBoundary").mockReturnValue(boundaryToken);
      const throwingObservation = {
        observationId: "b8c-observation",
        sourceType: "task_lifecycle_audit" as const,
        underlyingId: "b8c-event",
        occurredAt: "2026-06-15T11:00:00Z",
        get entityRefs(): never {
          throw new Error("B8C_DETECTOR_THROW");
        },
        domains: [],
        digest: "b8c-digest",
        contractVersion: "v1",
        collectorFamily: "task_lifecycle",
        habitatId: "hab-A",
        visibilityClass: "habitat_member" as const,
      };
      vi.spyOn(adapter, "collect").mockReturnValue({
        sourceType: "task_lifecycle_audit",
        observations: [throwingObservation],
        completeness: "complete",
        warnings: [],
        boundaryToken,
        collectionOutcome: "collected",
      });
      const diagnosticSpy = vi.spyOn(logger, "warn");

      const result = runExtraction({
        habitatId: "hab-A", policy,
        deliveryMode: "manual", actorType: "human", actorId: "user-1",
      });

      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") return;
      expect(result.outcome).toBe("partial");
      const hasFakeExperienceSource = result.sources.some(
        (s) =>
          s.sourceType === "experience_aggregate" &&
          s.observationCount === 0 &&
          s.warnings.some((w) => w.startsWith("detector_")),
      );
      expect(hasFakeExperienceSource).toBe(false);
      expect(diagnosticSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          diagnostics: expect.arrayContaining([
            expect.objectContaining({ error: "B8C_DETECTOR_THROW" }),
          ]),
        }),
        "Extraction detector failures recorded",
      );
    });
  });

  describe("B8(d): dry-run terminalizes work item", () => {
    it("dry-run terminalizes the work item (not just the attempt)", () => {
      const db = getDb();
      const policy = setupPolicy({ enabled: true });

      const result = runExtraction({
        habitatId: "hab-A", policy,
        deliveryMode: "manual", actorType: "human", actorId: "user-1",
        dryRun: true,
      });

      expect(result.kind).toBe("executed");
      if (result.kind !== "executed") return;

      const workItems = getWorkItemsByHabitatWithClient(db, "hab-A");
      const workItem = workItems.find((w) => w.id === result.workItem.id);
      expect(workItem).toBeTruthy();
      expect(workItem!.status).not.toBe("pending");
      expect(workItem!.status).not.toBe("running");
    });
  });

  // ── B9: Atomic rerun-generation allocation ──────────────────────

  describe("B9(a): sequential fresh-rerun behavior (not a concurrency proof)", () => {
    it("two fresh reruns produce generations 1 and 2 with exact linkage", () => {
      const policy = setupPolicy({ enabled: true });
      const now = "2026-06-15T12:00:00Z";

      runExtraction({
        habitatId: "hab-A", policy, deliveryMode: "scheduled",
        actorType: "system", actorId: "scheduler", now,
      });

      const rerun1 = runExtraction({
        habitatId: "hab-A", policy, deliveryMode: "manual",
        actorType: "human", actorId: "human-1", now,
        isFreshRerun: true, freshReason: "First rerun",
      });
      expect(rerun1.kind).not.toBe("deduplicated");

      const rerun2 = runExtraction({
        habitatId: "hab-A", policy, deliveryMode: "manual",
        actorType: "human", actorId: "human-1", now,
        isFreshRerun: true, freshReason: "Second rerun",
      });
      expect(rerun2.kind).not.toBe("deduplicated");

      if (rerun1.kind === "executed" && rerun2.kind === "executed") {
        const gen1 = rerun1.workItem.rerunGeneration;
        const gen2 = rerun2.workItem.rerunGeneration;
        expect(gen2).toBeGreaterThan(gen1);
        expect(gen2).toBe(gen1 + 1);
        expect(rerun2.workItem.supersedesWorkId).toBe(rerun1.workItem.id);
      }
    });
  });

  describe("B9(b): writer lock is reserved before read-MAX", () => {
    it("fresh rerun requests an IMMEDIATE transaction", () => {
      const db = getDb();
      const policy = setupPolicy({ enabled: true });
      const transactionSpy = vi.spyOn(db, "transaction");

      const result = runExtraction({
        habitatId: "hab-A", policy, deliveryMode: "manual",
        actorType: "human", actorId: "human-1", now: "2026-06-15T12:00:00Z",
        isFreshRerun: true, freshReason: "Prove lock mode",
      });
      expect(result.kind).toBe("executed");
      expect(transactionSpy.mock.calls.some(([, config]) =>
        config?.behavior === "immediate"
      )).toBe(true);
    });
  });
});
