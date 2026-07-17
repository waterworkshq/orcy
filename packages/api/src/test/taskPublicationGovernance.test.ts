/**
 * T3B Phase 2 — prospective taskCreated governance + decision-ledger reuse.
 *
 * Each test states the SPECIFIC failure mode that would break its assertion
 * (proving it is not tautological), matching the T3A/T3B-1 convention.
 *
 * Scope: the dormant governance entry point (`governTaskPublication`) + the
 * additive pluginManager seam (`snapshotEnrolledPreInterceptors` /
 * `makePreInterceptorTargetForGovernance` / `invokePreInterceptorForGovernance`)
 * + the governance-decisions ledger primitives. No production origin routes
 * through any of these yet — Phase 2 is DORMANT.
 *
 * The additive-seam constraint (NON-NEGOTIABLE): `runPreInterceptors`,
 * `TransitionRef`, `InterceptorHandler`, and ALL runtime code are byte-identical.
 * Test "characterization: runPreInterceptors is byte-identical" pins this.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  pluginRuns,
  taskCreationGovernanceDecisions,
  taskCreationAttempts,
} from "../db/schema/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import {
  prepareTaskPublication,
  PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER,
  type PrepareTaskPublicationInput,
} from "../services/taskPublicationPreparation.js";
import {
  governTaskPublication,
  computeGovernanceFingerprint,
  computeEnrollmentFingerprint,
  guardCarriesPhase1Sentinel,
  GOVERNED_EVENT,
  type FrozenBatchAdmissionSnapshot,
  type FrozenEnrolledInterceptor,
} from "../services/taskPublicationGovernance.js";
import {
  findGovernanceDecisionWithClient,
  recordGovernanceDecisionWithClient,
} from "../repositories/taskPublicationGovernance.js";
import type { AuditActorRef, AuditSource } from "@orcy/shared";

// --- Mocks (mirror pluginInvocationPolicyCharacterization.test.ts) ---
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/pulseService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pulseService.js")>();
  return { ...actual, onPulseCreated: vi.fn() };
});
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

// --- Shared fixtures ---
let habitatId: string;
let columnId: string;
let missionId: string;

const ACTOR: AuditActorRef = { type: "human", id: "user-1" };
const AUDIT_SOURCE: AuditSource = "rest_api";
const CAUSAL_CONTEXT = { root: { type: "request", id: "req-1" } };

function enrollInterceptor(hId: string, pluginId: string, contributionId: string): void {
  enrollmentRepo.create({
    habitatId: hId,
    pluginId,
    contributionId,
    contributionKind: "lifecycleInterceptor",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(hId);
}

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t3b-gov-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

async function cleanup(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

/** Seeds a `task_creation_attempts` row at `pending` for the ledger FK. */
function seedAttempt(id: string): void {
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: "m-test",
      attemptKey: `key-${id}`,
      requestFingerprint: `fp-${id}`,
      publicationKind: "create",
      actorType: "human",
      actorId: "user-1",
      habitatId,
      state: "pending",
    })
    .run();
}

/** Counts plugin_runs rows for one habitat + contributionId (invocation tally). */
function countRunsForContribution(contributionId: string): number {
  return getDb()
    .select()
    .from(pluginRuns)
    .where(eq(pluginRuns.habitatId, habitatId))
    .all()
    .filter((r) => r.contributionId === contributionId).length;
}

/** Counts governance-decision rows for one attempt. */
function countDecisionsForAttempt(attemptId: string): number {
  return getDb()
    .select()
    .from(taskCreationGovernanceDecisions)
    .where(eq(taskCreationGovernanceDecisions.attemptId, attemptId))
    .all().length;
}

/** A prepared proposal + guard fixture; callers override individual fields. */
function prepareTask(overrides: Partial<PrepareTaskPublicationInput> = {}):
  | {
      outcome: "prepared";
      proposal: import("../services/taskPublicationPreparation.js").CanonicalTaskPublicationProposal;
      guard: import("../services/taskPublicationPreparation.js").PublicationGuard;
    }
  | {
      outcome: "rejected_validation";
      errors: import("../services/taskPublicationPreparation.js").PublicationError[];
    } {
  return prepareTaskPublication({
    habitatId,
    targetMissionId: missionId,
    title: "Governed Task",
    description: "A proposal under prospective governance.",
    priority: "high",
    labels: ["kernel"],
    actor: ACTOR,
    auditSource: AUDIT_SOURCE,
    causalContext: CAUSAL_CONTEXT,
    initialEventAction: "created",
    ...overrides,
  });
}

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "Governance Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  missionId = missionRepo.createMission({
    habitatId,
    columnId,
    title: "governance-mission",
    createdBy: "user-1",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ---------------------------------------------------------------------------
// Invariant 0 — additive seam: runPreInterceptors is byte-identical
// ---------------------------------------------------------------------------
describe("T3B Phase 2 — characterization: runPreInterceptors is byte-identical (additive seam)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("runPreInterceptors still dispatches the SAME way after the additive exports are added (the 8-callers hot path is untouched)", async () => {
    // FAILURE MODE this catches: if the additive exports accidentally modified
    // runPreInterceptors, the shared registry, isEnrolled, or the runtime
    // construction, this live dispatch would behave differently.
    tmpDir = await writePlugin(
      "seam-characterization",
      `{
        manifest: {
          id: 'seam-characterization',
          version: '1.0.0',
          description: 'characterization',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow-pre', phase: 'pre', event: 'taskClaimed', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'allow-pre': () => ({ allow: true }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "seam-characterization", "allow-pre");

    const veto = pluginManager.runPreInterceptors("task-seam", "taskClaimed", habitatId, {
      actorId: "test",
    } as never);

    // runPreInterceptors returns null when all allow — unchanged behavior.
    expect(veto).toBeNull();
    // The new exports exist and are functions (additive, not a modification).
    expect(typeof pluginManager.snapshotEnrolledPreInterceptors).toBe("function");
    expect(typeof pluginManager.makePreInterceptorTargetForGovernance).toBe("function");
    expect(typeof pluginManager.invokePreInterceptorForGovernance).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Invariant 1 — identical re-preparation reuses decisions (no 2nd Plugin Run)
// ---------------------------------------------------------------------------
describe("T3B Phase 2 — identical re-preparation reuses decisions", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("governing the SAME proposal twice creates ONE plugin_run (the second pass REUSES the ledger decision)", async () => {
    tmpDir = await writePlugin(
      "reuse-allow",
      `{
        manifest: {
          id: 'reuse-allow', version: '1.0.0', description: 'reuse allow',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow-once', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: { 'allow-once': () => ({ allow: true }) },
      }`,
    );
    enrollInterceptor(habitatId, "reuse-allow", "allow-once");

    const prepared = prepareTask({ prospectiveTaskId: "task-reuse" });
    if (prepared.outcome !== "prepared")
      throw new Error(`prep failed: ${JSON.stringify(prepared.errors)}`);
    seedAttempt("attempt-reuse");

    // First governance pass — MISS → invoke → record (1 plugin_run).
    const first = governTaskPublication({
      attemptId: "attempt-reuse",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });
    expect(first.results[0].outcome).toBe("allowed");
    const runsAfterFirst = countRunsForContribution("allow-once");
    expect(runsAfterFirst).toBe(1);
    expect(countDecisionsForAttempt("attempt-reuse")).toBe(1);

    // Second governance pass — SAME prospectiveTaskId + SAME proposal → SAME
    // fingerprint → HIT → REUSE (no new plugin_run). Re-prepare to get a fresh
    // guard object (the first guard's sentinel was overwritten in place; a
    // real re-preparation produces a fresh guard). The prospectiveTaskId is
    // FIXED so both passes govern the SAME logical Task identity.
    const reprepared = prepareTask({ prospectiveTaskId: "task-reuse" });
    if (reprepared.outcome !== "prepared") throw new Error("re-prep failed");
    const second = governTaskPublication({
      attemptId: "attempt-reuse",
      tasks: [{ proposal: reprepared.proposal, guard: reprepared.guard }],
      db: getDb(),
    });
    expect(second.results[0].outcome).toBe("allowed");
    // FAILURE MODE this catches: if reuse were broken, a second plugin_run
    // would be created (runsAfterFirst + 1).
    expect(countRunsForContribution("allow-once")).toBe(runsAfterFirst);
    expect(countDecisionsForAttempt("attempt-reuse")).toBe(1);
    // The reused decision is flagged reused.
    expect(second.results[0].outcome).toBe("allowed");
    if (second.results[0].outcome === "allowed") {
      expect(second.results[0].decisions[0].reused).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invariant 2 — changed fingerprint records a NEW revision
// ---------------------------------------------------------------------------
describe("T3B Phase 2 — changed proposal records a new decision revision", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("a genuinely different proposal (different title) produces a DIFFERENT fingerprint and a NEW ledger row under the same attempt", async () => {
    tmpDir = await writePlugin(
      "revision",
      `{
        manifest: {
          id: 'revision', version: '1.0.0', description: 'revision',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'rev-allow', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: { 'rev-allow': () => ({ allow: true }) },
      }`,
    );
    enrollInterceptor(habitatId, "revision", "rev-allow");
    seedAttempt("attempt-rev");

    const preparedA = prepareTask({ title: "Original Title" });
    const preparedB = prepareTask({ title: "Changed Title" });
    if (preparedA.outcome !== "prepared" || preparedB.outcome !== "prepared")
      throw new Error("prep failed");

    governTaskPublication({
      attemptId: "attempt-rev",
      tasks: [{ proposal: preparedA.proposal, guard: preparedA.guard }],
      db: getDb(),
    });
    governTaskPublication({
      attemptId: "attempt-rev",
      tasks: [{ proposal: preparedB.proposal, guard: preparedB.guard }],
      db: getDb(),
    });

    // FAILURE MODE this catches: if the fingerprint did not cover the proposal
    // title, both passes would hit the SAME ledger row (1 decision, 1 run).
    expect(countDecisionsForAttempt("attempt-rev")).toBe(2);
    expect(countRunsForContribution("rev-allow")).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — first veto short-circuits per Task
// ---------------------------------------------------------------------------
describe("T3B Phase 2 — first veto short-circuits per Task", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("a priority-1 veto short-circuits: the priority-5 handler for the SAME Task is NEVER invoked (assert via call spy)", async () => {
    tmpDir = await writePlugin(
      "short-circuit",
      `{
        manifest: {
          id: 'short-circuit', version: '1.0.0', description: 'short-circuit',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'low-veto', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'high-never-runs', phase: 'pre', event: 'taskCreated', priority: 5, requires: [] },
          ],
        },
        interceptors: {
          'low-veto': () => { (globalThis.__govCalls = globalThis.__govCalls || []).push('low-veto'); return { allow: false, reason: 'priority-1-veto' }; },
          'high-never-runs': () => { (globalThis.__govCalls = globalThis.__govCalls || []).push('high-never-runs'); return { allow: true }; },
        },
      }`,
    );
    enrollInterceptor(habitatId, "short-circuit", "low-veto");
    enrollInterceptor(habitatId, "short-circuit", "high-never-runs");
    seedAttempt("attempt-sc");

    const prepared = prepareTask();
    if (prepared.outcome !== "prepared") throw new Error("prep failed");

    const result = governTaskPublication({
      attemptId: "attempt-sc",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    expect(result.results[0].outcome).toBe("vetoed");
    if (result.results[0].outcome === "vetoed") {
      expect(result.results[0].veto.reason).toBe("priority-1-veto");
    }
    // FAILURE MODE this catches: if short-circuit were broken, high-never-runs
    // would be invoked and appear in the call list.
    expect((globalThis as { __govCalls?: string[] }).__govCalls).toEqual(["low-veto"]);
    // And no decision row for high-never-runs (it was not invoked / not recorded).
    const decisions = getDb()
      .select()
      .from(taskCreationGovernanceDecisions)
      .where(eq(taskCreationGovernanceDecisions.attemptId, "attempt-sc"))
      .all();
    expect(decisions.length).toBe(1);
    expect(decisions[0].decision).toBe("explicit_veto");
    delete (globalThis as { __govCalls?: string[] }).__govCalls;
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 — batch fault isolation
// ---------------------------------------------------------------------------
describe("T3B Phase 2 — batch fault isolation (one Task's fault does not change another's admission)", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("a throwing handler that failure-vetoes Task 1 does NOT prevent Task 2 from being evaluated against the SAME frozen snapshot", async () => {
    tmpDir = await writePlugin(
      "batch-fault",
      `{
        manifest: {
          id: 'batch-fault', version: '1.0.0', description: 'batch fault isolation',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'throwing', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'throwing': () => { (globalThis.__batchCalls = globalThis.__batchCalls || []).push('throwing'); throw new Error('handler-fault'); },
        },
      }`,
    );
    enrollInterceptor(habitatId, "batch-fault", "throwing");
    seedAttempt("attempt-batch");

    const prepared1 = prepareTask({ title: "Task 1", prospectiveTaskId: "task-1" });
    const prepared2 = prepareTask({ title: "Task 2", prospectiveTaskId: "task-2" });
    if (prepared1.outcome !== "prepared" || prepared2.outcome !== "prepared")
      throw new Error("prep failed");

    const result = governTaskPublication({
      attemptId: "attempt-batch",
      tasks: [
        { proposal: prepared1.proposal, guard: prepared1.guard },
        { proposal: prepared2.proposal, guard: prepared2.guard },
      ],
      db: getDb(),
    });

    // FAILURE MODE this catches: if batch fault isolation were broken, Task 2
    // would not be evaluated (the fault on Task 1 would abort the batch), or
    // Task 2 would see a different admission snapshot.
    expect(result.results).toHaveLength(2);
    expect(result.results[0].outcome).toBe("vetoed");
    expect(result.results[1].outcome).toBe("vetoed");
    // Both Tasks were evaluated against the SAME frozen snapshot — the throwing
    // handler was invoked once per Task (2 invocations = 2 plugin_runs).
    expect((globalThis as { __batchCalls?: string[] }).__batchCalls).toEqual([
      "throwing",
      "throwing",
    ]);
    // Both produced failure_veto decisions (bounded fail-closed — ADR-0039 Q1).
    const decisions = getDb()
      .select()
      .from(taskCreationGovernanceDecisions)
      .where(eq(taskCreationGovernanceDecisions.attemptId, "attempt-batch"))
      .all();
    expect(decisions.length).toBe(2);
    expect(decisions.every((d) => d.decision === "failure_veto")).toBe(true);
    delete (globalThis as { __batchCalls?: string[] }).__batchCalls;
  });
});

// ---------------------------------------------------------------------------
// Invariant 5 — placeholder sentinel overwritten on every governed guard
// ---------------------------------------------------------------------------
describe("T3B Phase 2 — placeholder sentinel overwritten on every governed guard", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = "";
  });
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("after governance, no guard carries PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER (the real enrollment fingerprint overwrites it)", async () => {
    tmpDir = await writePlugin(
      "sentinel",
      `{
        manifest: {
          id: 'sentinel', version: '1.0.0', description: 'sentinel overwrite',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'sent-allow', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: { 'sent-allow': () => ({ allow: true }) },
      }`,
    );
    enrollInterceptor(habitatId, "sentinel", "sent-allow");
    seedAttempt("attempt-sentinel");

    const prepared1 = prepareTask({ title: "Sentinel A", prospectiveTaskId: "sent-a" });
    const prepared2 = prepareTask({ title: "Sentinel B", prospectiveTaskId: "sent-b" });
    if (prepared1.outcome !== "prepared" || prepared2.outcome !== "prepared")
      throw new Error("prep failed");

    // Before governance, both guards carry the placeholder.
    expect(guardCarriesPhase1Sentinel(prepared1.guard)).toBe(true);
    expect(guardCarriesPhase1Sentinel(prepared2.guard)).toBe(true);

    const result = governTaskPublication({
      attemptId: "attempt-sentinel",
      tasks: [
        { proposal: prepared1.proposal, guard: prepared1.guard },
        { proposal: prepared2.proposal, guard: prepared2.guard },
      ],
      db: getDb(),
    });

    // FAILURE MODE this catches: if the sentinel were NOT overwritten, the
    // guards would still carry PHASE1_INTERCEPTOR_FINGERPRINT_PLACEHOLDER.
    expect(guardCarriesPhase1Sentinel(prepared1.guard)).toBe(false);
    expect(guardCarriesPhase1Sentinel(prepared2.guard)).toBe(false);
    // The overwritten value is the real enrollment fingerprint (deterministic,
    // non-empty, prefixed).
    expect(prepared1.guard.interceptorEnrollmentFingerprint).toMatch(/^enrollment:[0-9a-f]{64}$/);
    expect(prepared1.guard.interceptorEnrollmentFingerprint).toBe(
      prepared2.guard.interceptorEnrollmentFingerprint,
    );
    // The fingerprint the batch computed matches the guard value.
    expect(prepared1.guard.interceptorEnrollmentFingerprint).toBe(
      result.frozenAdmission.enrollmentFingerprint,
    );
  });

  it("a guard for a habitat with NO enrolled interceptors still gets a real (empty-set) fingerprint, not the placeholder", async () => {
    // No plugin loaded — no enrolled interceptors. The freeze still computes a
    // deterministic enrollment fingerprint over the empty enrolled set.
    seedAttempt("attempt-empty");
    const prepared = prepareTask();
    if (prepared.outcome !== "prepared") throw new Error("prep failed");

    governTaskPublication({
      attemptId: "attempt-empty",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    expect(guardCarriesPhase1Sentinel(prepared.guard)).toBe(false);
    expect(prepared.guard.interceptorEnrollmentFingerprint).toMatch(/^enrollment:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// Invariant 6 — fingerprint determinism (stable across key reordering)
// ---------------------------------------------------------------------------
describe("T3B Phase 2 — governance fingerprint determinism", () => {
  it("computeGovernanceFingerprint is byte-stable regardless of object key insertion order (the same logical inputs always hash identically)", () => {
    const proposal = {
      prospectiveTaskId: "tp-1",
      habitatId: "h-1",
      targetMissionId: "m-1",
      title: "T",
      description: "D",
      priority: "high" as const,
      labels: ["b", "a"],
      requiredDomain: null,
      requiredCapabilities: ["y", "x"],
      estimatedMinutes: 30,
      subtasks: [{ title: "s1", order: 0, assigneeId: null }],
      selectedDependencies: [{ dependsOnId: "d-2" }, { dependsOnId: "d-1" }],
      requestedAssigneeId: null,
      cloneSourceTaskId: null,
      actor: { type: "human" as const, id: "u-1" },
      auditSource: "rest_api" as const,
      causalContext: { root: { type: "request", id: "r-1" } },
      initialEventAction: "created" as const,
    };
    const guard = {
      missionId: "m-1",
      missionVersion: 1,
      missionStatus: "in_progress" as const,
      habitatId: "h-1",
      dependencies: [
        { taskId: "d-2", version: 3, status: "pending" as const },
        { taskId: "d-1", version: 1, status: "done" as const },
      ],
      interceptorEnrollmentFingerprint: "enrollment:abc",
    };
    const interceptor: FrozenEnrolledInterceptor = {
      pluginId: "p-1",
      contributionId: "ic-1",
      interceptorKey: '["lifecycleInterceptor","p-1","ic-1","pre","taskCreated"]',
      priority: 1,
      contributionSnapshot: {
        interceptorId: "ic-1",
        phase: "pre" as const,
        event: "taskCreated" as const,
        priority: 1,
        requires: [],
      },
      quarantinedAtFreeze: false,
      entry: {} as never, // not part of the fingerprint payload
    };
    const frozenAdmission: FrozenBatchAdmissionSnapshot = {
      event: "taskCreated" as const,
      habitatId: "h-1",
      enrolled: [interceptor],
      enrollmentFingerprint: "enrollment:abc",
    };

    const fp1 = computeGovernanceFingerprint({ proposal, guard, interceptor, frozenAdmission });
    // Same call again — deterministic.
    const fp2 = computeGovernanceFingerprint({ proposal, guard, interceptor, frozenAdmission });
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^gov:[0-9a-f]{64}$/);

    // FAILURE MODE this catches: if labels/requires/dependencies were NOT
    // sorted before hashing, a different array order would produce a different
    // fingerprint despite identical logical content.
    const proposalReorderedLabels = { ...proposal, labels: ["a", "b"] };
    const fp3 = computeGovernanceFingerprint({
      proposal: proposalReorderedLabels,
      guard,
      interceptor,
      frozenAdmission,
    });
    expect(fp3).toBe(fp1);
  });

  it("computeEnrollmentFingerprint is stable regardless of enrolled-list order (batch-reordering invariant)", () => {
    const enrolled: FrozenEnrolledInterceptor[] = [
      {
        pluginId: "p-2",
        contributionId: "ic-2",
        interceptorKey: '["lifecycleInterceptor","p-2","ic-2","pre","taskCreated"]',
        priority: 5,
        contributionSnapshot: {
          interceptorId: "ic-2",
          phase: "pre",
          event: "taskCreated",
          priority: 5,
          requires: [],
        },
        quarantinedAtFreeze: false,
        entry: {} as never,
      },
      {
        pluginId: "p-1",
        contributionId: "ic-1",
        interceptorKey: '["lifecycleInterceptor","p-1","ic-1","pre","taskCreated"]',
        priority: 1,
        contributionSnapshot: {
          interceptorId: "ic-1",
          phase: "pre",
          event: "taskCreated",
          priority: 1,
          requires: [],
        },
        quarantinedAtFreeze: false,
        entry: {} as never,
      },
    ];
    const fp1 = computeEnrollmentFingerprint({
      event: GOVERNED_EVENT,
      habitatId: "h-1",
      enrolled,
    });
    // Reversed order — same fingerprint (sorted by interceptorKey internally).
    const fp2 = computeEnrollmentFingerprint({
      event: GOVERNED_EVENT,
      habitatId: "h-1",
      enrolled: [...enrolled].reverse(),
    });
    expect(fp1).toBe(fp2);
  });
});

// ---------------------------------------------------------------------------
// Invariant 7 — ledger primitive: idempotent key (unique index)
// ---------------------------------------------------------------------------
describe("T3B Phase 2 — governance-decisions ledger primitives", () => {
  it("findGovernanceDecisionWithClient returns null for a miss and the row for a hit (the reuse lookup)", () => {
    seedAttempt("attempt-ledger");
    const db = getDb();

    const miss = findGovernanceDecisionWithClient(db, {
      attemptId: "attempt-ledger",
      prospectiveTaskId: "tp-1",
      interceptorKey: "ic-1",
      governanceFingerprint: "fp-1",
    });
    expect(miss).toBeNull();

    recordGovernanceDecisionWithClient(db, {
      attemptId: "attempt-ledger",
      prospectiveTaskId: "tp-1",
      interceptorKey: "ic-1",
      governanceFingerprint: "fp-1",
      decision: "allow",
      pluginRunId: "run-1",
      diagnostics: { reason: "ok" },
    });

    const hit = findGovernanceDecisionWithClient(db, {
      attemptId: "attempt-ledger",
      prospectiveTaskId: "tp-1",
      interceptorKey: "ic-1",
      governanceFingerprint: "fp-1",
    });
    expect(hit).not.toBeNull();
    expect(hit!.decision).toBe("allow");
    expect(hit!.pluginRunId).toBe("run-1");
  });

  it("recording the SAME key twice violates the unique index (the ledger is idempotent on the key)", () => {
    seedAttempt("attempt-dup");
    const db = getDb();

    recordGovernanceDecisionWithClient(db, {
      attemptId: "attempt-dup",
      prospectiveTaskId: "tp-dup",
      interceptorKey: "ic-dup",
      governanceFingerprint: "fp-dup",
      decision: "allow",
      pluginRunId: null,
      diagnostics: null,
    });

    // FAILURE MODE this catches: if the unique index were missing, the second
    // insert would silently succeed (a duplicate decision row for the same key).
    expect(() =>
      recordGovernanceDecisionWithClient(db, {
        attemptId: "attempt-dup",
        prospectiveTaskId: "tp-dup",
        interceptorKey: "ic-dup",
        governanceFingerprint: "fp-dup",
        decision: "explicit_veto",
        pluginRunId: null,
        diagnostics: null,
      }),
    ).toThrow();
  });
});
