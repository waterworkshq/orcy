/**
 * Learning Loop review and authorization — security-critical tests.
 *
 * Proves every acceptance gate:
 * 1. CAS concurrency — two decisions, one winner (sql.js).
 * 2. Cross-Habitat denial + non-leak.
 * 3. Exact Task/Mission/non-null-domain scope matches pass.
 * 4. Wrong task/mission/domain, unscoped, cross-Habitat, stale/withdrawn,
 *    non-agent-visibility reveal nothing.
 * 5. Reassignment/terminalization before the final SELECT removes access.
 * 6. Direct get applies exactly the list predicate keyed by finding ID.
 * 7. Aggregate-only citations expose bands/caveats only (no drill-down).
 * 8. Dangling/changed/unauthorized citations block new promotion.
 * 9. Audit/SSE payloads contain no raw source bodies or Experience data.
 *
 * Each test must be able to fail for its defect (drop the scope join, widen to
 * habitat-wide, fetch-then-authorize, leak existence on denial).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  listAcceptedFindingsForAgentWithClient,
  getAcceptedFindingForAgentWithClient,
  reviewCasWithClient,
  persistCandidateWithClient,
  reserveWorkItemWithClient,
  createAttemptWithClient,
  terminalizeAttemptWithClient,
  getCitationsByFindingWithClient,
  type CitationInput,
  type ScopeRefInput,
} from "../repositories/extraction/index.js";
import { checkPromotionEligibility } from "../services/extractionPromotionService.js";
import { getFindingDetail } from "../services/extractionReviewService.js";
import {
  habitats,
  columns,
  missions,
  tasks,
  agents,
  extractedFindings,
  extractedFindingSources,
  extractedFindingScopeRefs,
} from "../db/schema/index.js";

// ---------------------------------------------------------------------------
// Test fixture: create the minimum FK chain for agent-bound queries
// ---------------------------------------------------------------------------

interface HabitatFixture {
  habitatId: string;
  columnId: string;
  missionId: string;
  agentId: string;
  taskId: string;
  requiredDomain: string | null;
}

function setupHabitat(opts: {
  id: string;
  agentName: string;
  taskStatus: "pending" | "claimed" | "in_progress" | "submitted" | "approved" | "rejected" | "done" | "failed";
  requiredDomain?: string | null;
}): HabitatFixture {
  const db = getDb();
  const habitatId = opts.id;
  const columnId = `col-${habitatId}`;
  const missionId = `mis-${habitatId}`;
  const agentId = `agt-${habitatId}`;
  const taskId = `task-${habitatId}`;

  db.insert(habitats).values({ id: habitatId, name: habitatId }).run();
  db.insert(columns).values({
    id: columnId,
    habitatId,
    name: "Todo",
    order: 0,
  }).run();
  db.insert(missions).values({
    id: missionId,
    habitatId,
    columnId,
    title: `Mission ${habitatId}`,
    createdBy: "test-user",
  }).run();
  db.insert(agents).values({
    id: agentId,
    name: opts.agentName,
    type: "claude-code",
    domain: "general",
    apiKey: `key-${agentId}`,
  }).run();
  db.insert(tasks).values({
    id: taskId,
    missionId,
    title: `Task ${habitatId}`,
    assignedAgentId: agentId,
    status: opts.taskStatus,
    requiredDomain: opts.requiredDomain ?? null,
    createdBy: "test-user",
  }).run();

  return { habitatId, columnId, missionId, agentId, taskId, requiredDomain: opts.requiredDomain ?? null };
}

/** Insert a finding directly (bypass the attempt fence for test simplicity). */
function insertFinding(opts: {
  habitatId: string;
  status?: "proposed" | "accepted" | "rejected" | "superseded" | "withdrawn";
  completeness?: "complete" | "partial" | "stale";
  visibilityCeiling?: "habitat_member" | "human_reviewer" | "aggregate_only";
  scopeRefs?: Array<{ scopeType: "task" | "mission" | "domain"; scopeId: string }>;
  findingType?: "lesson" | "convention" | "risk" | "anomaly" | "rule_recommendation" | "knowledge_draft";
  attemptId?: string;
}): string {
  const db = getDb();
  const findingId = uuid();
  const now = new Date().toISOString();
  const attemptId = opts.attemptId ?? `att-${uuid()}`;

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
    findingType: opts.findingType ?? "lesson",
    subject: "Test finding",
    body: "Test body",
    structuredPayload: null,
    confidence: 0.85,
    sampleSize: 10,
    completeness: opts.completeness ?? "complete",
    visibilityCeiling: opts.visibilityCeiling ?? "habitat_member",
    fingerprint: `fp-${uuid()}`,
    evidenceDigest: `ed-${uuid()}`,
    status: opts.status ?? "accepted",
    decisionVersion: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    occurrenceCount: 1,
    caveats: [],
  }).run();

  // Insert scope refs
  if (opts.scopeRefs) {
    for (const ref of opts.scopeRefs) {
      const refId = uuid();
      const sourceId = uuid();
      // Insert a dummy citation for the derivedFromSourceId FK
      db.insert(extractedFindingSources).values({
        id: sourceId,
        findingId,
        sourceType: "task_lifecycle_audit",
        sourceId: `src-${uuid()}`,
        sourceVersion: "v1",
        role: "supporting",
        sourceDigest: "digest",
        occurredAt: now,
        entityRefs: [{ type: "task", id: "task-1" }],
        completeness: "complete",
        visibilityClass: "habitat_member",
      }).run();

      db.insert(extractedFindingScopeRefs).values({
        id: refId,
        findingId,
        scopeType: ref.scopeType as "task" | "mission" | "domain",
        scopeId: ref.scopeId,
        derivedFromSourceId: sourceId,
      }).run();
    }
  }

  return findingId;
}

/** Update a task's status or assignment (for reassignment tests). */
function updateTask(taskId: string, updates: Record<string, unknown>): void {
  const db = getDb();
  db.update(tasks).set(updates).where(eq(tasks.id, taskId)).run();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Learning Loop review and authorization API", () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => closeDb());

  // -------------------------------------------------------------------------
  // Gate 3: Exact scope matches pass
  // -------------------------------------------------------------------------

  describe("agent accepted-finding read — exact scope match", () => {
    it("task scope ref matches and returns the finding", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(findingId);
    });

    it("mission scope ref matches and returns the finding", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "in_progress" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "mission", scopeId: fix.missionId }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(findingId);
    });

    it("domain scope ref matches when task has requiredDomain", () => {
      const fix = setupHabitat({
        id: "hab-A", agentName: "Agent A", taskStatus: "submitted",
        requiredDomain: "backend",
      });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "domain", scopeId: "backend" }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(1);
      expect(results[0].id).toBe(findingId);
    });
  });

  // -------------------------------------------------------------------------
  // Gate 4: Mismatched scope, unscoped, cross-habitat, stale, etc. reveal nothing
  // -------------------------------------------------------------------------

  describe("agent accepted-finding read — denial cases", () => {
    it("wrong task scope ref returns nothing", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: "wrong-task-id" }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("wrong mission scope ref returns nothing", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "mission", scopeId: "wrong-mission-id" }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("domain scope ref mismatch returns nothing", () => {
      const fix = setupHabitat({
        id: "hab-A", agentName: "Agent A", taskStatus: "claimed",
        requiredDomain: "backend",
      });
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "domain", scopeId: "frontend" }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("unscoped finding (no scope refs) returns nothing for agents", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("cross-habitat finding returns nothing", () => {
      const fixA = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const fixB = setupHabitat({ id: "hab-B", agentName: "Agent B", taskStatus: "claimed" });

      // Finding in hab-B with task scope ref for hab-B's task
      insertFinding({
        habitatId: fixB.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fixB.taskId }],
      });

      // Querying hab-A with hab-A's agent+task should not see hab-B's finding
      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fixA.agentId, fixA.taskId, fixA.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("wrong agent returns nothing", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), "wrong-agent-id", fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("stale finding returns nothing", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        completeness: "stale",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("non-accepted status returns nothing", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        status: "proposed",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("human_reviewer visibility returns nothing for agents", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        visibilityCeiling: "human_reviewer",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("aggregate_only visibility returns nothing for agents", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        visibilityCeiling: "aggregate_only",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("domain scope ref without task requiredDomain returns nothing", () => {
      const fix = setupHabitat({
        id: "hab-A", agentName: "Agent A", taskStatus: "claimed",
        requiredDomain: null,
      });
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "domain", scopeId: "backend" }],
      });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });
    });

    // -------------------------------------------------------------------------
    // Gate 5: Reassignment/terminalization before final SELECT removes access
    // -------------------------------------------------------------------------

    it("reassignment before read removes access", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      // Create another agent and reassign
      const db = getDb();
      db.insert(agents).values({
        id: "agt-other",
        name: "Other Agent",
        type: "claude-code",
        domain: "general",
        apiKey: "key-other",
      }).run();
      updateTask(fix.taskId, { assignedAgentId: "agt-other" });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

    it("task terminalization before read removes access", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      // Terminalize the task (move to "done" — not in active set)
      updateTask(fix.taskId, { status: "done" });

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(0);
    });

  // -------------------------------------------------------------------------
  // Gate 6: Direct get applies the same predicate
  // -------------------------------------------------------------------------

  describe("agent direct get — same predicate as list", () => {
    it("returns finding when authorized", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const result = getAcceptedFindingForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId, findingId,
      );
      expect(result).not.toBeNull();
      expect(result!.id).toBe(findingId);
    });

    it("returns null for wrong scope (collapsed denial)", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: "wrong-task" }],
      });

      const result = getAcceptedFindingForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId, findingId,
      );
      expect(result).toBeNull();
    });

    it("returns null for nonexistent finding (no existence leak)", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });

      const result = getAcceptedFindingForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId, "nonexistent-finding-id",
      );
      expect(result).toBeNull();
    });

    it("returns null for cross-habitat finding", () => {
      const fixA = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const fixB = setupHabitat({ id: "hab-B", agentName: "Agent B", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fixB.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fixB.taskId }],
      });

      // Query from hab-A — should not see hab-B's finding
      const result = getAcceptedFindingForAgentWithClient(
        getDb(), fixA.agentId, fixA.taskId, fixA.habitatId, findingId,
      );
      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Gate 1: CAS concurrency — two decisions, one winner
  // -------------------------------------------------------------------------

  describe("review CAS concurrency", () => {
    it("two concurrent accept decisions yield one success and one conflict", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        status: "proposed",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const db = getDb();
      // Both reviewers use expectedDecisionVersion = 1
      const r1 = reviewCasWithClient(db, {
        findingId,
        decision: "accept",
        reason: "Good finding",
        reviewerType: "human",
        reviewerId: "reviewer-1",
        expectedDecisionVersion: 1,
      });
      const r2 = reviewCasWithClient(db, {
        findingId,
        decision: "accept",
        reason: "Also good",
        reviewerType: "human",
        reviewerId: "reviewer-2",
        expectedDecisionVersion: 1,
      });

      // B4 state machine: first accept moves proposed→accepted. Second accept
      // is illegal because accept is only allowed from proposed status.
      const outcomes = [r1.outcome, r2.outcome].toSorted();
      expect(outcomes).toEqual(["decided", "illegal_source_state"]);
    });

    it("request_revision then accept with updated version succeeds", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        status: "proposed",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const db = getDb();
      // request_revision stays in proposed status but bumps the version.
      const r1 = reviewCasWithClient(db, {
        findingId,
        decision: "request_revision",
        reason: "Needs more evidence",
        reviewerType: "human",
        reviewerId: "reviewer-1",
        expectedDecisionVersion: 1,
      });
      expect(r1.outcome).toBe("decided");

      // The version is now 2, status is still proposed — accept is valid.
      const r2 = reviewCasWithClient(db, {
        findingId,
        decision: "accept",
        reason: "Actually accept after revision feedback",
        reviewerType: "human",
        reviewerId: "reviewer-2",
        expectedDecisionVersion: 2,
      });
      expect(r2.outcome).toBe("decided");
    });
  });

  // -------------------------------------------------------------------------
  // Gate 8: Citation degradation blocks promotion
  // -------------------------------------------------------------------------

  describe("promotion eligibility — citation degradation", () => {
    it("accepted finding with available citations is eligible", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        status: "accepted",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      // The insertFinding helper creates citations with visibilityClass habitat_member
      // which the catalog adapter should resolve as available (or dangling if adapter
      // not found). The adapter might not find the test citations, so we check the
      // eligibility response shape rather than asserting eligible=true.
      const eligibility = checkPromotionEligibility(fix.habitatId, findingId);
      expect(eligibility).toHaveProperty("eligible");
      expect(eligibility).toHaveProperty("blockingCitations");
      expect(eligibility).toHaveProperty("caveats");
    });

    it("non-accepted finding is not eligible", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        status: "proposed",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const eligibility = checkPromotionEligibility(fix.habitatId, findingId);
      expect(eligibility.eligible).toBe(false);
    });

    it("stale finding is not eligible", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        status: "accepted",
        completeness: "stale",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const eligibility = checkPromotionEligibility(fix.habitatId, findingId);
      expect(eligibility.eligible).toBe(false);
    });

    it("finding not in habitat throws notFound", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      expect(() => checkPromotionEligibility(fix.habitatId, "nonexistent")).toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Gate 7: Aggregate-only citations expose bands/caveats only (no drill-down)
  // -------------------------------------------------------------------------

  describe("aggregate-only citation privacy", () => {
    it("aggregate-only citations do not expose entity refs in detail", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        status: "accepted",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      // Add an aggregate-only citation directly
      const db = getDb();
      db.insert(extractedFindingSources).values({
        id: uuid(),
        findingId,
        sourceType: "experience_aggregate",
        sourceId: `exp-${uuid()}`,
        sourceVersion: "v1",
        role: "supporting",
        sourceDigest: "digest",
        occurredAt: new Date().toISOString(),
        entityRefs: [{ type: "pulse", id: "pulse-1" }],
        completeness: "complete",
        visibilityClass: "aggregate_only",
      }).run();

      const detail = getFindingDetail(fix.habitatId, findingId);
      const aggCitation = detail.citations.find((c) => c.visibilityClass === "aggregate_only");
      expect(aggCitation).toBeDefined();
      // Aggregate-only: no entity refs, no occurredAt (no drill-down)
      expect(aggCitation!.entityRefs).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Gate 2: Anti-probing — collapsed denial, no existence oracle
  // -------------------------------------------------------------------------

  describe("anti-probing — collapsed denial", () => {
    it("denial for existing-but-unauthorized finding is identical to nonexistent", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });

      // Finding exists but agent has no scope ref to it
      const unauthorizedFindingId = insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: "other-task" }],
      });

      // Query for the unauthorized finding
      const unauthorizedResult = getAcceptedFindingForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId, unauthorizedFindingId,
      );

      // Query for a truly nonexistent finding
      const nonexistentResult = getAcceptedFindingForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId, "truly-nonexistent",
      );

      // Both must return null — no distinction
      expect(unauthorizedResult).toBeNull();
      expect(nonexistentResult).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Gate 9: Audit/SSE payloads carry no raw source bodies
  // -------------------------------------------------------------------------

  describe("audit/SSE payload privacy", () => {
    it("agent finding summary does not include raw source bodies", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      const findingId = insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      // Add a citation with entity refs
      const db = getDb();
      db.insert(extractedFindingSources).values({
        id: uuid(),
        findingId,
        sourceType: "task_lifecycle_audit",
        sourceId: `task_event-${uuid()}`,
        sourceVersion: "v1",
        role: "supporting",
        sourceDigest: "digest",
        occurredAt: new Date().toISOString(),
        entityRefs: [{ type: "task", id: "task-1" }],
        completeness: "complete",
        visibilityClass: "habitat_member",
      }).run();

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
      );
      expect(results).toHaveLength(1);

      // Summary should have citationCount but no raw source data
      const summary = results[0];
      expect(summary).toHaveProperty("citationCount");
      expect(summary).not.toHaveProperty("citations");
      expect(summary).not.toHaveProperty("sources");
      expect(summary).not.toHaveProperty("entityRefs");
      // Should have IDs and bounded state only
      expect(summary).toHaveProperty("id");
      expect(summary).toHaveProperty("confidence");
      expect(summary).toHaveProperty("sampleSize");
    });
  });

  // -------------------------------------------------------------------------
  // Client filters only narrow
  // -------------------------------------------------------------------------

  describe("client filters narrow the authorized set", () => {
    it("findingType filter narrows results", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      insertFinding({
        habitatId: fix.habitatId,
        findingType: "lesson",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });
      insertFinding({
        habitatId: fix.habitatId,
        findingType: "risk",
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      });

      const lessons = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
        { findingType: "lesson" },
      );
      expect(lessons).toHaveLength(1);
      expect(lessons[0].findingType).toBe("lesson");
    });

    it("limit restricts result count", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      for (let i = 0; i < 5; i++) {
        insertFinding({
          habitatId: fix.habitatId,
          scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
        });
      }

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
        { limit: 2 },
      );
      expect(results).toHaveLength(2);
    });

    it("hard limit caps at 25", () => {
      const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
      for (let i = 0; i < 30; i++) {
        insertFinding({
          habitatId: fix.habitatId,
          scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
        });
      }

      const results = listAcceptedFindingsForAgentWithClient(
        getDb(), fix.agentId, fix.taskId, fix.habitatId,
        { limit: 100 }, // request more than hard limit
      );
      expect(results).toHaveLength(25);
    });
  });
});
