/**
 * T8B Phase 1 — Automation `create_task` producer migration guardrail tests.
 *
 * The adapter (`publishAutomationTask` + `executeCreateTaskViaPublication`)
 * composes the Story-1 kernel chain (reserve → prepare → govern → publish)
 * for the Automation `create_task` origin. It is DORMANT: no production
 * `executeCreateTask` call routes through it unless
 * `ORCY_CREATION_PUBLICATION_ENABLED=true`. The migrated `executeCreateTask`
 * gates on `isCreationPublicationEnabled` (flag ON → adapter; OFF → legacy
 * byte-unchanged).
 *
 * This suite is the SOLE exerciser until T11 cutover. Each test maps 1:1 to a
 * guardrail named in the T8B ticket:
 *
 *   - **Live A→B→A cycle proof** (the capstone): Rule A creates a Task whose
 *     trusted envelope triggers Rule B; B creates a Task whose envelope would
 *     trigger Rule A; T4C's ingestion records exactly ONE `causal_cycle` skip
 *     and NO duplicate Task. Requires the live producer migration — T4C's
 *     synthetic-envelope tests could not prove it.
 *   - **Distinct chain (A→B→C)**: non-repeating rules chain without cycle.
 *   - **Depth limit**: 32-hop chain → `causal_depth_limit` skip.
 *   - **Hop propagation**: the committed envelope's `causalContext.hops`
 *     includes the appended `{type:"automation", id:ruleId}` (chain grew by 1).
 *   - **Replay**: same-`(runId, actionIndex)` replays (no duplicate Task).
 *   - **Flag OFF → legacy**: legacy raw insert (byte-unchanged behavior).
 *   - **Provenance server-constructed**: committed envelope carries `source`,
 *     `actor`, the appended causalContext.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, taskEvents, taskCreationEnvelopes } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { ingestEvent } from "../services/automationEventService.js";
import {
  publishAutomationTask,
  executeCreateTaskViaPublication,
} from "../services/automationTaskPublication.js";
import { satisfyObservationCheckpointWithClient } from "../services/taskCreationDispatchEngine.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type { AutomationRuleRun, CausalContext } from "@orcy/shared";

// --- Mocks: the adapter composes the kernel, which emits NO pre-commit
//     effects. Assert the automation path never reaches the broadcaster. ---
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
const CUTOVER_FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";
let habitatId: string;
let columnId: string;
let missionId: string;
let originalFlag: string | undefined;

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  originalFlag = process.env[CUTOVER_FLAG];
  // Default: cutover flag ON — most tests exercise the migrated path.
  process.env[CUTOVER_FLAG] = "true";
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "T8B Habitat" });
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
    title: "t8b-mission",
    createdBy: "test",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  if (originalFlag !== undefined) {
    process.env[CUTOVER_FLAG] = originalFlag;
  } else {
    delete process.env[CUTOVER_FLAG];
  }
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
  closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let ruleCounter = 0;
/** Creates an enabled rule with `trigger:task.created` + `action:create_task`. */
function createChainedCreateTaskRule(label: string): {
  ruleId: string;
  action: { type: "create_task"; title: string };
} {
  ruleCounter += 1;
  ruleRepo.createAutomationRule({
    habitatId,
    name: `T8B Rule ${label}`,
    trigger: { type: "event", eventType: "task.created" },
    condition: { type: "always" },
    actions: [{ type: "create_task", title: `Task from ${label}` }],
    cooldownSeconds: 0,
    maxRunsPerHour: 1000,
    priority: 0,
    enabled: true,
    createdBy: "test",
  });
  const rule = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, "task.created").reverse()[0];
  return { ruleId: rule.id, action: rule.actions[0] as { type: "create_task"; title: string } };
}

/** Starts a fresh Automation Run for a rule + returns the run row. */
function startRun(ruleId: string, label = "run"): AutomationRuleRun {
  const { run } = runRepo.startRuleRun({
    ruleId,
    habitatId,
    triggerType: "task.created",
    triggerEventId: `seed-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
  });
  return run;
}

/** Reads the committed envelope row for a taskId. */
function envelopeForTask(taskId: string) {
  return getDb()
    .select()
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.taskId, taskId))
    .all()[0];
}

/** Returns the count of `tasks` rows for the seeded mission. */
function missionTaskCount(): number {
  return getDb().select().from(tasks).where(eq(tasks.missionId, missionId)).all().length;
}

/** Returns the count of `tasks` rows in the entire habitat (across missions). */
function allTaskCount(): number {
  return getDb().select().from(tasks).all().length;
}

/** Counts runs for a rule (any status). */
function countRunsForRule(ruleId: string): number {
  return runRepo.listRunsByRule(ruleId).total;
}

/**
 * Builds a minimal evaluation context with the seeded mission populated (the
 * producer resolves the target Mission from `action.missionId ?? ctx.mission?.id`).
 * Pass `inheritedCausalContext` to test chain inheritance.
 */
function ctxWithMission(inheritedCausalContext?: CausalContext) {
  return {
    habitat: null,
    task: null,
    mission: missionRepo.getMissionById(missionId),
    agent: null,
    sprint: null,
    warnings: [],
    missingFields: [],
    raw: {},
    ...(inheritedCausalContext ? { causalContext: inheritedCausalContext } : {}),
  };
}

/** Returns the skipped runs for a rule. */
function skippedRunsForRule(ruleId: string) {
  return runRepo.getSkippedRunsByRule(ruleId).runs;
}

/**
 * Drives the producer for the capstone cycle proof: step 1 (seed Rule A
 * directly via publishAutomationTask, no inherited chain). Returns Rule A's
 * committed envelope data so step 2 can feed it to ingestEvent.
 */
function seedRuleA(ruleAId: string, action: { type: "create_task"; title: string }) {
  const ruleA = ruleRepo.getAutomationRuleById(ruleAId)!;
  const runA = startRun(ruleAId, "ruleA-seed");

  // Step 1: drive Rule A directly with NO inherited causalContext (a fresh
  // chain whose root is runA). The envelope A produces carries
  // hops=[{type:"automation", id: ruleAId}]. The trigger-context mission is
  // seeded so the producer can resolve the target Mission.
  const result = publishAutomationTask(ruleA, runA, action, 0, {
    habitat: null,
    task: null,
    mission: missionRepo.getMissionById(missionId),
    agent: null,
    sprint: null,
    warnings: [],
    missingFields: [],
    raw: {},
    // No causalContext → fresh root = runA; hops = [ruleA hop]
  });

  if (result.outcome !== "created") {
    throw new Error(`seedRuleA: expected created, got ${result.outcome}`);
  }
  const taskA = result.publication.task;
  const envelopeA = result.publication.envelope;
  return { result, taskA, envelopeA, runA };
}

/**
 * Builds the trusted-envelope `data` payload that the automationAdapter
 * (taskCreationDispatchAdapters.ts) would hand to ingestEvent. This is the
 * exact shape the dispatcher uses to forward a committed envelope into the
 * automation-ingestion path.
 */
function envelopeToIngestData(
  envelope: typeof taskCreationEnvelopes.$inferSelect,
  task: typeof tasks.$inferSelect,
): Record<string, unknown> {
  return {
    taskId: task.id,
    eventId: envelope.eventId,
    habitatId: envelope.habitatId,
    lifecycleAction: envelope.lifecycleAction,
    causalContext: envelope.causalContext as CausalContext,
    id: task.id,
    title: task.title,
    status: task.status,
    priority: task.priority,
  };
}

// ===========================================================================
// 1. LIVE A→B→A CYCLE PROOF — the capstone.
//    Rule A creates Task A; A's envelope → ingestEvent → Rule B creates Task B;
//    B's envelope → ingestEvent → Rule A's id is in B's chain → exactly ONE
//    causal_cycle skip, NO duplicate Task. Total: 2 Tasks, 1 skip.
// ===========================================================================

describe("T8B P1 capstone — live A→B→A cycle proof", () => {
  it("Rule A → Task A → Rule B → Task B → Rule A (cycle) → 1 causal_cycle skip, 0 duplicates", async () => {
    const { ruleId: ruleAId, action: actionA } = createChainedCreateTaskRule("A");
    const { ruleId: ruleBId, action: actionB } = createChainedCreateTaskRule("B");

    // ===== STEP 1: Rule A produces Task A (fresh chain, no inheritance) =====
    const baselineTaskCount = allTaskCount();
    const seed = seedRuleA(ruleAId, actionA);

    // Assert: Task A committed + envelope carries exactly 1 hop (A's hop).
    // Fresh chain (no inherited context) → root = runA; no parent (the run
    // IS the root, not a predecessor). The inherited-chain case asserts
    // parent separately.
    expect(seed.envelopeA.causalContext).not.toBeNull();
    const aCausal = seed.envelopeA.causalContext as unknown as CausalContext;
    expect(aCausal.hops).toHaveLength(1);
    expect(aCausal.hops![0]).toEqual({ type: "automation", id: ruleAId });
    expect(aCausal.root).toEqual({ type: "automation_run", id: seed.runA.id });
    expect(aCausal.parent).toBeUndefined();
    expect(allTaskCount()).toBe(baselineTaskCount + 1);

    // ===== STEP 2: A's envelope → ingestEvent → Rule B matches → creates Task B =====
    const dataA = envelopeToIngestData(seed.envelopeA, seed.taskA);
    const resultStep2 = await ingestEventSync(habitatId, {
      type: "task.created",
      data: dataA,
    });

    // Rule B matched; Rule A re-enters its own chain → cycle skip.
    expect(resultStep2.matched).toBe(1); // Rule B
    expect(resultStep2.skipped).toBe(1); // Rule A cycle

    // Task B was created (Rule B's action ran through the migrated path).
    const tasksAfterStep2 = getDb().select().from(tasks).all();
    expect(tasksAfterStep2.length).toBe(baselineTaskCount + 2);

    // Find Task B + its envelope — it must carry hops = [A's hop, B's hop].
    const taskB = tasksAfterStep2.find((t) => t.id !== seed.taskA.id);
    expect(taskB).toBeDefined();
    const envelopeB = envelopeForTask(taskB!.id);
    expect(envelopeB).toBeDefined();
    const bCausal = envelopeB.causalContext as unknown as CausalContext;
    expect(bCausal.hops).toHaveLength(2);
    expect(bCausal.hops![0]).toEqual({ type: "automation", id: ruleAId });
    expect(bCausal.hops![1]).toEqual({ type: "automation", id: ruleBId });

    // ===== STEP 3: B's envelope → ingestEvent → Rule A would re-enter → CYCLE =====
    // Snapshot Rule A's cycle skips BEFORE step 3 so we can isolate the
    // load-bearing A→B→A cycle from any self-cycle in step 2.
    const aCycleSkipsBeforeStep3 = skippedRunsForRule(ruleAId).filter(
      (r) => r.skipReason === "causal_cycle",
    ).length;
    const baselineBeforeStep3 = allTaskCount();

    const dataB = envelopeToIngestData(envelopeB, taskB!);
    const resultStep3 = await ingestEventSync(habitatId, {
      type: "task.created",
      data: dataB,
    });

    // Step 3: ZERO rules match (Rule A would cycle — ruleA is in B's hops;
    // Rule B would cycle — ruleB is in B's hops). Both produce causal_cycle
    // skips. The LOAD-BEARING assertion is that Rule A — the rule that
    // started this chain — produces EXACTLY ONE causal_cycle skip from this
    // delivery of B's envelope, and ZERO new Tasks.
    expect(resultStep3.matched).toBe(0);
    expect(resultStep3.skipped).toBeGreaterThanOrEqual(1);

    const aCycleSkipsAfterStep3 = skippedRunsForRule(ruleAId).filter(
      (r) => r.skipReason === "causal_cycle",
    ).length;
    // Step 3 produced exactly ONE new causal_cycle skip on Rule A.
    expect(aCycleSkipsAfterStep3 - aCycleSkipsBeforeStep3).toBe(1);

    // No duplicate Task created — exactly the 2 we created in steps 1 + 2.
    expect(allTaskCount()).toBe(baselineBeforeStep3);
    expect(allTaskCount()).toBe(baselineTaskCount + 2);
  });
});

/**
 * Sync wrapper for ingestEvent. The production signature is async; under the
 * test DB the body is synchronous, so we drain the promise by awaiting it
 * inside an async helper. Tests that call this must be inside `it("...", async () => ...)`.
 */
async function ingestEventSync(
  hId: string,
  event: { type: string; data?: Record<string, unknown> },
): Promise<{ matched: number; skipped: number; errors: string[] }> {
  return ingestEvent(hId, event);
}

// ===========================================================================
// 2. DISTINCT CHAIN (A → B → C) — non-repeating rules chain without cycle.
// ===========================================================================

describe("T8B P1 distinct chain — A→B→C succeeds without cycle", () => {
  it("three distinct rules each append their hop; no cycle skip", async () => {
    const { ruleId: ruleAId, action: actionA } = createChainedCreateTaskRule("ChainA");
    const { ruleId: ruleBId, action: actionB } = createChainedCreateTaskRule("ChainB");
    // Rule C will be created inside the test to assert it fires on B's envelope.

    // Step 1: seed Rule A directly.
    const seed = seedRuleA(ruleAId, actionA);

    // Step 2: A's envelope triggers rules. Rule A would re-enter (cycle —
    // its own id is in A's hops) → skipped. Rule B is fresh → matches +
    // appends B's hop on top of A's.
    const dataA = envelopeToIngestData(seed.envelopeA, seed.taskA);
    const r2 = await ingestEventSync(habitatId, { type: "task.created", data: dataA });
    expect(r2.matched).toBe(1); // Rule B
    expect(r2.skipped).toBe(1); // Rule A cycle

    const taskB = getDb()
      .select()
      .from(tasks)
      .all()
      .find((t) => t.id !== seed.taskA.id);
    expect(taskB).toBeDefined();
    const envB = envelopeForTask(taskB!.id);
    const bCausal = envB.causalContext as unknown as CausalContext;
    expect(bCausal.hops).toHaveLength(2);

    // Step 3: register Rule C, then deliver B's envelope. Both Rule A and
    // Rule B are in B's hops, so they would cycle — but Rule C is fresh and
    // should match. (Rule A + Rule B skip as causal_cycle; Rule C creates.)
    const { ruleId: ruleCId } = createChainedCreateTaskRule("ChainC");

    const baselineTaskCount = allTaskCount();
    const dataB = envelopeToIngestData(envB, taskB!);
    const r3 = await ingestEventSync(habitatId, { type: "task.created", data: dataB });

    // Rule C matched + created; Rule A and Rule B skipped (cycle). Total: 1
    // matched (Rule C), 2 skipped (A + B cycles).
    expect(r3.matched).toBe(1);
    expect(r3.skipped).toBe(2);

    // Exactly one NEW task (Task C).
    expect(allTaskCount()).toBe(baselineTaskCount + 1);

    // Rule C's run exists; A's and B's skip runs are causal_cycle.
    expect(countRunsForRule(ruleCId)).toBe(1);
    const cSkips = skippedRunsForRule(ruleCId).filter((r) => r.skipReason === "causal_cycle");
    expect(cSkips).toHaveLength(0);
    void actionB;
    void ruleBId;
  });
});

// ===========================================================================
// 3. DEPTH LIMIT — a 32-hop chain → causal_depth_limit skip.
//    The producer keeps appending; at 32 the ingestion skips.
// ===========================================================================

describe("T8B P1 depth limit — producer keeps appending; ingestion skips at 32 hops", () => {
  it("a 32-hop envelope → causal_depth_limit skip (no Task created)", async () => {
    const { ruleId } = createChainedCreateTaskRule("DepthLimit");

    // Build a synthetic trusted envelope with 32 hops (none of them = ruleId,
    // so the cycle check passes; the depth check fires).
    const hops: Array<{ type: string; id: string }> = [];
    for (let i = 0; i < 32; i++) {
      hops.push({ type: "automation", id: `other-rule-${i}` });
    }
    const seedTask = taskCrudRepo.createTask({
      missionId,
      title: "Depth seed",
      createdBy: "test",
    });
    const data = {
      taskId: seedTask.id,
      eventId: `evt-depth-${Date.now()}`,
      habitatId,
      lifecycleAction: "created",
      causalContext: {
        root: { type: "human", id: "user-1" },
        hops,
      } as CausalContext,
    };

    const r = await ingestEventSync(habitatId, { type: "task.created", data });

    expect(r.matched).toBe(0);
    expect(r.skipped).toBe(1);
    const skips = skippedRunsForRule(ruleId);
    expect(skips[0].skipReason).toBe("causal_depth_limit");

    // No Task created by the rule.
    expect(allTaskCount()).toBe(1); // only the seed task
  });
});

// ===========================================================================
// 4. HOP PROPAGATION — the committed envelope's causalContext.hops includes
//    the appended {type:"automation", id:ruleId} (chain grew by exactly 1).
// ===========================================================================

describe("T8B P1 hop propagation — chain grows by exactly 1 hop per producer", () => {
  it("fresh chain: produces exactly 1 hop (the rule's own)", () => {
    const { ruleId, action } = createChainedCreateTaskRule("PropFresh");
    const { result } = seedRuleA(ruleId, action);

    const causal = result.publication.envelope.causalContext as unknown as CausalContext;
    expect(causal.hops).toHaveLength(1);
    expect(causal.hops![0]).toEqual({ type: "automation", id: ruleId });
  });

  it("inherited chain: appends exactly 1 hop on top of inherited hops", () => {
    const { ruleId, action } = createChainedCreateTaskRule("PropAppend");
    const rule = ruleRepo.getAutomationRuleById(ruleId)!;
    const run = startRun(ruleId, "prop-append");

    // Inherited context with 3 hops; the adapter must produce 4.
    const inherited: CausalContext = {
      root: { type: "human", id: "user-1" },
      hops: [
        { type: "automation", id: "rule-x" },
        { type: "automation", id: "rule-y" },
        { type: "automation", id: "rule-z" },
      ],
    };

    const result = publishAutomationTask(rule, run, action, 0, ctxWithMission(inherited));

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    const causal = result.publication.envelope.causalContext as unknown as CausalContext;
    expect(causal.hops).toHaveLength(4);
    expect(causal.hops![3]).toEqual({ type: "automation", id: ruleId });
    // Inherited root preserved.
    expect(causal.root).toEqual({ type: "human", id: "user-1" });
    // Run encoded as parent.
    expect(causal.parent).toEqual({ type: "automation_run", id: run.id });
  });
});

// ===========================================================================
// 5. REPLAY — same-(runId, actionIndex) replays the terminal outcome (no
//    duplicate Task).
// ===========================================================================

describe("T8B P1 replay — same-(runId, actionIndex) does not create twice", () => {
  it("identical (runId, actionIndex) after a successful publish replays (no duplicate)", () => {
    const { ruleId, action } = createChainedCreateTaskRule("Replay");
    const rule = ruleRepo.getAutomationRuleById(ruleId)!;
    const run = startRun(ruleId, "replay");
    const ctx = ctxWithMission();

    const baseline = allTaskCount();

    // First call: publishes a Task.
    const r1 = publishAutomationTask(rule, run, action, 0, ctx);
    expect(r1.outcome).toBe("created");
    if (r1.outcome !== "created") return;
    const firstTaskId = r1.publication.task.id;
    expect(allTaskCount()).toBe(baseline + 1);

    // Same-`(runId, actionIndex=0)` retry: the attempt is at
    // `published_pending_observation` — the adapter's recovering-replay
    // branch surfaces it as recovering `created`. NO duplicate Task.
    const r2 = publishAutomationTask(rule, run, action, 0, ctx);
    expect(r2.outcome).toBe("created");
    if (r2.outcome !== "created") return;
    expect(r2.publication.task.id).toBe(firstTaskId);
    expect(allTaskCount()).toBe(baseline + 1);
  });

  it("a different actionIndex under the same run creates a distinct attempt", () => {
    const { ruleId } = createChainedCreateTaskRule("ReplayDistinct");
    const rule = ruleRepo.getAutomationRuleById(ruleId)!;
    const run = startRun(ruleId, "replay-distinct");
    const action = { type: "create_task" as const, title: "Action A" };
    const action2 = { type: "create_task" as const, title: "Action B" };
    const ctx = ctxWithMission();

    const baseline = allTaskCount();

    const r1 = publishAutomationTask(rule, run, action, 0, ctx);
    const r2 = publishAutomationTask(rule, run, action2, 1, ctx);

    expect(r1.outcome).toBe("created");
    expect(r2.outcome).toBe("created");
    if (r1.outcome !== "created" || r2.outcome !== "created") return;
    expect(r1.publication.task.id).not.toBe(r2.publication.task.id);
    expect(allTaskCount()).toBe(baseline + 2);
  });
});

// ===========================================================================
// 5b. REPLAY AFTER TERMINALIZATION carries taskId (cold-review #2 M3).
//     The observation terminalizer stamps terminalResult.taskId on the success
//     path; the Automation replay mapper surfaces it on the succeeded action.
// ===========================================================================

describe("T8B P1 replay taskId — replay-after-terminal surfaces taskId (cold-review #2 M3)", () => {
  it("publish → terminalize → same-key replay carries taskId on the succeeded action result", () => {
    const { ruleId, action } = createChainedCreateTaskRule("ReplayTaskId");
    const rule = ruleRepo.getAutomationRuleById(ruleId)!;
    const run = startRun(ruleId, "replay-taskid");
    const ctx = ctxWithMission();
    const baseline = allTaskCount();

    // 1. Publish via the full entry point (publish + mapToActionResult) →
    //    succeeded with taskId from the publication.
    const r1 = executeCreateTaskViaPublication(rule, run, action, 0, ctx);
    expect(r1.status).toBe("succeeded");
    expect(r1.result?.taskId).toBeDefined();
    const firstTaskId = r1.result!.taskId as string;
    expect(allTaskCount()).toBe(baseline + 1);

    // 2. Terminalize via the observation checkpoint (zero dispatch targets,
    //    no reservation → stamps terminalResult.taskId).
    const pubResult = publishAutomationTask(rule, run, action, 0, ctx);
    if (pubResult.outcome !== "created") throw new Error("expected recovering created");
    const obs = satisfyObservationCheckpointWithClient(getDb(), pubResult.attemptId);
    expect(obs.outcome).toBe("advanced");

    // 3. Same-key replay via the full entry point → succeeded with taskId
    //    recovered from the terminal (NOT null — the M3 fix).
    const r2 = executeCreateTaskViaPublication(rule, run, action, 0, ctx);
    expect(r2.status).toBe("succeeded");
    expect(r2.result?.taskId).toBe(firstTaskId);
    expect(r2.result?.replayed).toBe(true);
    expect(allTaskCount()).toBe(baseline + 1);
  });
});

// ===========================================================================
// 6. FLAG OFF → LEGACY — executeCreateTask does the legacy raw insert
//    (byte-unchanged behavior).
// ===========================================================================

describe("T8B P1 flag-OFF → legacy raw insert (byte-unchanged)", () => {
  it("with flag OFF, executeCreateTaskViaPublication is NOT used; legacy creates a Task with no envelope + no created event", async () => {
    // Flip the flag OFF for this test only.
    delete process.env[CUTOVER_FLAG];

    // Re-import the executor dynamically so the flag check reads the new
    // value (the import is cached, but the env var is read at CALL time
    // inside executeCreateTask — so a single import works for both paths).
    const { executeActions } = await import("../services/automationExecutor.js");

    // Create a rule + run.
    ruleRepo.createAutomationRule({
      habitatId,
      name: "Legacy Rule",
      trigger: { type: "event", eventType: "task.created" },
      condition: { type: "always" },
      actions: [{ type: "create_task", title: "Legacy Task" }],
      cooldownSeconds: 0,
      maxRunsPerHour: 1000,
      priority: 0,
      enabled: true,
      createdBy: "test",
    });
    const rule = ruleRepo
      .getEnabledRulesByHabitatAndTrigger(habitatId, "task.created")
      .reverse()[0];
    const { run } = runRepo.startRuleRun({
      ruleId: rule.id,
      habitatId,
      triggerType: "task.created",
      triggerEventId: `legacy-${Date.now()}`,
    });

    const baseline = missionTaskCount();

    // Drive executeActions directly (this is what executeAndRecordRuleRun calls).
    await executeActions(
      rule,
      run,
      // Minimal context — the legacy path needs mission.
      {
        habitat: null,
        task: null,
        mission: missionRepo.getMissionById(missionId),
        agent: null,
        sprint: null,
        warnings: [],
        missingFields: [],
        raw: {},
      } as never,
    );

    // Legacy: ONE Task created, BUT no envelope + no `created` event.
    expect(missionTaskCount()).toBe(baseline + 1);

    // No task-creation envelope row exists for the new task.
    const newTask = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.missionId, missionId))
      .all()
      .reverse()[0];
    const env = envelopeForTask(newTask.id);
    expect(env).toBeUndefined();

    // No `created` Lifecycle Event (legacy raw-insert produces none).
    const events = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, newTask.id)).all();
    expect(events).toHaveLength(0);

    // The Task is NOT stamped POST_CUTOVER (the kernel stamps it; legacy
    // does not).
    expect(newTask.creationIntegrity).not.toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);

    // The legacy `createdBy: "automation:<ruleId>"` provenance is preserved.
    expect(newTask.createdBy).toBe(`automation:${rule.id}`);
  });
});

// ===========================================================================
// 7. PROVENANCE — server-constructed; the committed envelope carries source,
//    actor, the appended causalContext.
// ===========================================================================

describe("T8B P1 provenance — server-constructed Automation identity", () => {
  it("committed envelope carries source='automation', actor 'automation:<ruleId>', appended causalContext", () => {
    const { ruleId, action } = createChainedCreateTaskRule("Prov");
    const rule = ruleRepo.getAutomationRuleById(ruleId)!;
    const run = startRun(ruleId, "prov");
    const ctx = ctxWithMission();

    const result = publishAutomationTask(rule, run, action, 0, ctx);
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;

    const env = result.publication.envelope;
    expect(env.source).toBe("automation");
    expect(env.actorType).toBe("system");
    expect(env.actorId).toBe(`automation:${ruleId}`);
    expect(env.causalContext).not.toBeNull();
    const causal = env.causalContext as unknown as CausalContext;
    expect(causal.root).toEqual({ type: "automation_run", id: run.id });
    expect(causal.hops).toEqual([{ type: "automation", id: ruleId }]);

    // The Task row's createdBy mirrors the system actor identity (preserving
    // the legacy `createdBy: "automation:<ruleId>"` as structured provenance).
    expect(result.publication.task.createdBy).toBe(`automation:${ruleId}`);
  });

  it("executeCreateTaskViaPublication maps `created` → succeeded with taskId/title", () => {
    const { ruleId, action } = createChainedCreateTaskRule("Map");
    const rule = ruleRepo.getAutomationRuleById(ruleId)!;
    const run = startRun(ruleId, "map");
    const ctx = {
      habitat: null,
      task: null,
      mission: missionRepo.getMissionById(missionId),
      agent: null,
      sprint: null,
      warnings: [],
      missingFields: [],
      raw: {},
    };

    const ar = executeCreateTaskViaPublication(rule, run, action, 0, ctx);
    expect(ar.actionType).toBe("create_task");
    expect(ar.actionIndex).toBe(0);
    expect(ar.status).toBe("succeeded");
    expect(ar.result).toBeDefined();
    expect((ar.result as { taskId: string }).taskId).toBeDefined();
    expect((ar.result as { title: string }).title).toBeDefined();
  });

  it("executeCreateTaskViaPublication surfaces no-mission as a failed action (legacy semantics)", () => {
    const { ruleId, action } = createChainedCreateTaskRule("NoMission");
    const rule = ruleRepo.getAutomationRuleById(ruleId)!;
    const run = startRun(ruleId, "no-mission");
    // No mission in the action + no mission in the ctx → the adapter throws
    // → the wrapper maps it to a failed action.
    const ctx = {
      habitat: null,
      task: null,
      mission: null,
      agent: null,
      sprint: null,
      warnings: [],
      missingFields: [],
      raw: {},
    };
    const ar = executeCreateTaskViaPublication(rule, run, action, 0, ctx);
    expect(ar.actionType).toBe("create_task");
    expect(ar.status).toBe("failed");
    expect(ar.error).toMatch(/mission/i);
  });
});
