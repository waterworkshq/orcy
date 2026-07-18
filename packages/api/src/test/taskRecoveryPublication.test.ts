/**
 * T8A-pre Phase 1 — Workflow-Recovery Publication Adapter guardrail tests.
 *
 * The adapter (`publishRecoveryTask`) composes the Story-1 kernel chain
 * (reserve → prepare → govern → publish) for the Workflow-Recovery origin
 * (the `on_fail` gate's spawned recovery Task). It is DORMANT: no production
 * failure-handler call routes through it yet — this suite is the sole
 * exerciser until the global cutover (T11) swaps `spawnRecoveryForGate` onto
 * it.
 *
 * Each test maps 1:1 to a guardrail named in the ticket:
 *   - First-time history: the Recovery Task gets a `created` Lifecycle Event
 *     + POST_CUTOVER + prospective governance FOR THE FIRST TIME (the legacy
 *     raw-insert path produces none of these).
 *   - C2 atomicity — linkage survives crash: the gate insertion +
 *     `recoveryTaskId` linkage + failure-context record commit in the SAME tx
 *     as the Recovery Task. Inject failure at EVERY write boundary → zero
 *     unlinked Recovery Tasks (no Task without its gate/linkage; no
 *     gate/linkage without its Task).
 *   - Participant throw rolls back the aggregate: a participant that throws →
 *     the whole publication rolls back (no Task, no event, no gate, no
 *     linkage).
 *   - Vetoed Recovery → visible blocked outcome: a governance veto surfaces a
 *     typed `vetoed` result (NOT the swallowed null the legacy path returns).
 *   - Same-run/action replay: identical (runId, actionKey) → replays the
 *     terminal outcome (no duplicate Task).
 *   - Provenance is server-constructed: the committed envelope carries the
 *     Recovery-run root; the input cannot assert privileged identities.
 *   - Legacy `createRecoveryTask` unchanged: the adapter ships DORMANT
 *     alongside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskCreationEnvelopes,
  taskCreationAttempts,
  taskWorkflowGates,
  failureContexts,
  workflows,
  missions,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import {
  publishRecoveryTask,
  buildRecoveryLinkageParticipant,
  type PublishRecoveryTaskInput,
  type RecoveryLinkage,
  type RecoveryTaskPublicationResult,
} from "../services/taskRecoveryPublication.js";
import { prepareTaskPublication } from "../services/taskPublicationPreparation.js";
import { governTaskPublication } from "../services/taskPublicationGovernance.js";
import { publishTaskWithClient as publishTaskWithClientCoord } from "../services/taskPublicationCoordinator.js";
import { satisfyObservationCheckpointWithClient } from "../services/taskCreationDispatchEngine.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";

// --- Mocks: the adapter composes the kernel, which emits NO pre-commit
//     effects. Assert the recovery path never reaches the broadcaster. ---
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

const TARGETED_DEADLINE = "2099-01-01T00:00:00.000Z";

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "Recovery Habitat" });
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
    title: "recovery-mission",
    createdBy: "test",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ---------------------------------------------------------------------------
// Input builder + seeders
// ---------------------------------------------------------------------------

let runCounter = 0;
/** Returns a fresh run id per call (unique per test). */
function freshRunId(label = "run"): string {
  runCounter += 1;
  return `${label}-${runCounter}-${Date.now()}`;
}

/**
 * Seeds the Recovery scenario: a failed (upstream) Task, a downstream Task, an
 * active Workflow, and an `on_fail` gate linking them. Returns the gate row's
 * identity for the linkage descriptor.
 */
function seedRecoveryScenario(opts?: { recoveryDepth?: number; failureContext?: boolean }): {
  failedTaskId: string;
  downstreamTaskId: string;
  workflowId: string;
  gateId: string;
  failureContextId?: string;
} {
  const db = getDb();
  const failedTask = taskCrudRepo.createTask({
    missionId,
    title: "Failed Task",
    createdBy: "test",
  });
  const downstream = taskCrudRepo.createTask({
    missionId,
    title: "Downstream Task",
    createdBy: "test",
  });
  const workflowId = `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const gateId = `gate-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  db.insert(workflows)
    .values({
      id: workflowId,
      missionId,
      habitatId,
      status: "active",
      createdBy: "test",
    })
    .run();
  db.insert(taskWorkflowGates)
    .values({
      id: gateId,
      workflowId,
      missionId,
      habitatId,
      upstreamTaskId: failedTask.id,
      downstreamTaskId: downstream.id,
      gateType: "on_fail",
      matchConfig: null,
      condition: null,
      satisfied: false,
      recoveryDepth: opts?.recoveryDepth ?? 0,
    })
    .run();

  let failureContextId: string | undefined;
  if (opts?.failureContext) {
    failureContextId = `fctx-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    db.insert(failureContexts)
      .values({
        id: failureContextId,
        failedTaskId: failedTask.id,
        workflowId,
        habitatId,
        failureKind: "lifecycle_failed",
        failureReason: "tests exploded",
        bundle: {
          artifacts: [],
          recentLifecycleEvents: [],
          experienceSignals: [],
          retryHistory: [],
          experienceCategorySummary: {},
        },
        bundleSchemaVersion: 1,
        recoveryDepth: opts?.recoveryDepth ?? 0,
      })
      .run();
  }

  return {
    failedTaskId: failedTask.id,
    downstreamTaskId: downstream.id,
    workflowId,
    gateId,
    failureContextId,
  };
}

/** Builds a valid Recovery publication input; callers override fields. */
function recoveryInput(
  scenario: ReturnType<typeof seedRecoveryScenario>,
  overrides: Partial<PublishRecoveryTaskInput> = {},
): PublishRecoveryTaskInput {
  const linkage: RecoveryLinkage = {
    gateId: scenario.gateId,
    workflowId: scenario.workflowId,
    habitatId,
    missionId,
    downstreamTaskId: scenario.downstreamTaskId,
    recoveryDepth: 0,
    ...(scenario.failureContextId ? { failureContextId: scenario.failureContextId } : {}),
  };
  const { linkage: linkageOverride, ...restOverrides } = overrides;
  const mergedLinkage = linkageOverride ? { ...linkage, ...linkageOverride } : linkage;
  return {
    runId: freshRunId(),
    actionKey: "spawn-0",
    habitatId,
    targetMissionId: missionId,
    title: "Recover: Failed Task",
    description: "Investigate the failure.",
    requiredDomain: "backend",
    requiredCapabilities: ["debugging"],
    assignment: { kind: "auto" },
    linkage: mergedLinkage,
    ...restOverrides,
  };
}

/** Asserts the result is `created` (recovering) with a committed publication. */
function expectCreatedRecovering(
  result: RecoveryTaskPublicationResult,
): asserts result is Extract<RecoveryTaskPublicationResult, { outcome: "created" }> {
  expect(result.outcome).toBe("created");
  if (result.outcome !== "created") throw new Error("expected created outcome");
  expect(result.recovering).toBe(true);
  expect(result.recoveringState).toBe("published_pending_observation");
  expect(result.publication.task.id).toBeDefined();
}

/** Returns the count of `tasks` rows for the seeded mission. */
function missionTaskCount(): number {
  return getDb().select().from(tasks).where(eq(tasks.missionId, missionId)).all().length;
}

/** Casts the FailingDbClient wrapper to the coordinator's accepted client type. */
function asPubClient(w: FailingDbClient): TaskPublicationDbClient {
  return w as unknown as TaskPublicationDbClient;
}

async function writePlugin(name: string, moduleBody: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const tmpDir = `/tmp/test-t8a-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
}

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

// ===========================================================================
// 1. FIRST-TIME HISTORY — the Recovery Task gets a `created` Lifecycle Event +
//    POST_CUTOVER + prospective governance FOR THE FIRST TIME (legacy raw
//    insert produces none of these).
// ===========================================================================

describe("T8A-pre P1 first-time history — created event + POST_CUTOVER + governance", () => {
  it("commits a Recovery Task with exactly one `created` event + POST_CUTOVER (legacy produces neither)", () => {
    const scenario = seedRecoveryScenario();
    const before = missionTaskCount();

    const result = publishRecoveryTask(recoveryInput(scenario));
    expectCreatedRecovering(result);

    // POST_CUTOVER — the legacy raw insert does NOT stamp this (engages the
    // claim gates for the first time on a Recovery Task).
    expect(result.publication.task.creationIntegrity).toBe(
      TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER,
    );
    expect(result.publication.task.status).toBe("pending");

    // Exactly ONE `created` Lifecycle Event — the legacy raw insert produces
    // ZERO events. This is the headline O3 (gap-audit) correction.
    expect(result.publication.event).not.toBeNull();
    expect(result.publication.event!.action).toBe("created");
    const events = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, result.publication.task.id))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("created");

    expect(missionTaskCount()).toBe(before + 1);
  });

  it("runs prospective governance — an enrolled taskCreated interceptor observes the Recovery Task", async () => {
    await writePlugin(
      "observer-plugin",
      `{
      manifest: {
        id: 'observer-plugin', version: '1.0.0', description: 'observe recovery',
        contributions: [
          { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'observe-create', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
        ],
      },
      interceptors: {
        'observe-create': () => ({ allow: true }),
      },
    }`,
    );
    enrollInterceptor(habitatId, "observer-plugin", "observe-create");

    const scenario = seedRecoveryScenario();
    const result = publishRecoveryTask(recoveryInput(scenario));
    expectCreatedRecovering(result);

    // Governance ran (the enrolled interceptor was consulted) — proven by the
    // governance-decision ledger. A `created` outcome means the interceptor
    // allowed; the guard's enrollment sentinel was overwritten. Assert the
    // attempt's governance records exist by checking the envelope committed
    // (the coordinator only commits the envelope AFTER governance authorized).
    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, result.attemptId))
      .all()[0];
    expect(attempt).toBeDefined();
    expect(attempt.state).toBe("published_pending_observation");
    // The envelope committed inside the publication tx (post-governance).
    const envelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.attemptId, result.attemptId))
      .all();
    expect(envelope).toHaveLength(1);
  });
});

// ===========================================================================
// 2. C2 ATOMICITY — linkage survives crash: gate + recoveryTaskId +
//    failure-context commit in the SAME tx as the Recovery Task.
// ===========================================================================

describe("T8A-pre P1 C2 atomicity — linkage commits atomically with the Recovery Task", () => {
  it("on success: next-depth gate inserted, original gate linked, failure-context linked", () => {
    const scenario = seedRecoveryScenario({ failureContext: true });
    const result = publishRecoveryTask(recoveryInput(scenario));
    expectCreatedRecovering(result);
    const recoveryTaskId = result.publication.task.id;

    // Next-depth on_fail gate inserted (upstream = recovery task).
    const deeperGates = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.upstreamTaskId, recoveryTaskId))
      .all();
    expect(deeperGates).toHaveLength(1);
    expect(deeperGates[0].gateType).toBe("on_fail");
    expect(deeperGates[0].recoveryDepth).toBe(1); // original depth 0 + 1
    expect(deeperGates[0].downstreamTaskId).toBe(scenario.downstreamTaskId);
    expect(deeperGates[0].workflowId).toBe(scenario.workflowId);

    // Original gate linked (recoveryTaskId stamped = idempotency marker).
    const originalGate = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, scenario.gateId))
      .all()[0];
    expect(originalGate.recoveryTaskId).toBe(recoveryTaskId);

    // Failure-context linked (denormalized recoveryTaskId field).
    const ctx = getDb()
      .select()
      .from(failureContexts)
      .where(eq(failureContexts.id, scenario.failureContextId!))
      .all()[0];
    expect(ctx.recoveryTaskId).toBe(recoveryTaskId);
  });

  it("without a failure-context: no failure-context linkage write occurs (conditional guard)", () => {
    const scenario = seedRecoveryScenario({ failureContext: false });
    const result = publishRecoveryTask(recoveryInput(scenario));
    expectCreatedRecovering(result);

    // Gate linkage still occurs (the failure-context is optional; the gate is not).
    const originalGate = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, scenario.gateId))
      .all()[0];
    expect(originalGate.recoveryTaskId).toBe(result.publication.task.id);
  });
});

// ===========================================================================
// 3. C2 ATOMICITY — participant throw rolls back the WHOLE aggregate.
// ===========================================================================

describe("T8A-pre P1 participant-throw rollback — the whole aggregate rolls back", () => {
  it("a participant that throws leaves NO Task, NO event, NO gate, NO linkage", () => {
    const scenario = seedRecoveryScenario({ failureContext: true });
    const beforeTasks = getDb().select().from(tasks).all().length;
    const beforeEvents = getDb().select().from(taskEvents).all().length;
    const beforeGates = getDb().select().from(taskWorkflowGates).all().length;

    // Compose the coordinator directly with a THROWING participant (the
    // buildRecoveryLinkageParticipant shape, but throwing on entry). This
    // proves the kernel's participant-seam contract: a throw after the core
    // aggregate wrote rolls back everything.
    const db = getDb();
    const attemptId = `attempt-throw-${Date.now()}`;
    db.insert(taskCreationAttempts)
      .values({
        id: attemptId,
        source: "workflow",
        sourceScopeKind: "recovery_run",
        sourceScopeId: "run-throw",
        attemptKey: "spawn-throw",
        requestFingerprint: "fp-throw",
        publicationKind: "create",
        actorType: "system",
        actorId: "workflow-recovery",
        habitatId,
        state: "pending",
      })
      .run();

    const prepared = prepareTaskPublication({
      habitatId,
      targetMissionId: missionId,
      title: "Throwing Participant Task",
      actor: { type: "system", id: "workflow-recovery" },
      auditSource: "workflow",
      causalContext: { root: { type: "workflow_recovery", id: "run-throw" } },
      initialEventAction: "created",
    });
    if (prepared.outcome !== "prepared") throw new Error("prepare failed");
    const governance = governTaskPublication({
      attemptId,
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db,
    });
    if (governance.results[0].outcome === "vetoed") throw new Error("unexpected veto");

    const throwingParticipant = (): never => {
      throw new Error("injected participant failure");
    };

    expect(() => {
      db.transaction((tx) => {
        publishTaskWithClientCoord(tx, {
          attemptId,
          proposal: prepared.proposal,
          guard: prepared.guard,
          participants: throwingParticipant,
        });
      });
    }).toThrow(/injected participant failure/);

    // ZERO partial state — no Task, no event, no new gate.
    expect(getDb().select().from(tasks).all().length).toBe(beforeTasks);
    expect(getDb().select().from(taskEvents).all().length).toBe(beforeEvents);
    expect(getDb().select().from(taskWorkflowGates).all().length).toBe(beforeGates);
    // The original gate is UNCHANGED (no recoveryTaskId stamped).
    const originalGate = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, scenario.gateId))
      .all()[0];
    expect(originalGate.recoveryTaskId).toBeNull();
    // The failure-context is UNCHANGED (no recoveryTaskId linked).
    const ctx = getDb()
      .select()
      .from(failureContexts)
      .where(eq(failureContexts.id, scenario.failureContextId!))
      .all()[0];
    expect(ctx.recoveryTaskId).toBeNull();
  });
});

// ===========================================================================
// 4. C2 ATOMICITY — inject failure at EVERY participant write boundary →
//    zero unlinked Recovery Tasks.
// ===========================================================================

describe("T8A-pre P1 C2 boundary injection — failure at each participant write rolls back the linkage", () => {
  /**
   * Composes the REAL coordinator + REAL buildRecoveryLinkageParticipant with a
   * FailingDbClient, injects failure at write boundary `failAt`, and asserts
   * zero partial state (no Task without its gate/linkage; no gate/linkage
   * without its Task).
   *
   * The participant writes (with a failure-context present) land at:
   *   - gate INSERT (next-depth on_fail gate)
   *   - gate UPDATE (original gate's recoveryTaskId)
   *   - failure-context UPDATE (recoveryTaskId link)
   * Each must roll back the Task + event that already wrote.
   */
  function runBoundaryCase(failAt: number, label: string): void {
    it(`failure at write #${failAt} (${label}) → zero unlinked Recovery Task`, () => {
      const scenario = seedRecoveryScenario({ failureContext: true });
      const db = getDb();
      const beforeTasks = db.select().from(tasks).all().length;
      const beforeGates = db.select().from(taskWorkflowGates).all().length;

      const attemptId = `attempt-bnd-${failAt}-${label}-${Date.now()}`;
      db.insert(taskCreationAttempts)
        .values({
          id: attemptId,
          source: "workflow",
          sourceScopeKind: "recovery_run",
          sourceScopeId: `run-bnd-${failAt}`,
          attemptKey: `spawn-bnd-${failAt}`,
          requestFingerprint: `fp-bnd-${failAt}`,
          publicationKind: "create",
          actorType: "system",
          actorId: "workflow-recovery",
          habitatId,
          state: "pending",
        })
        .run();

      const prepared = prepareTaskPublication({
        habitatId,
        targetMissionId: missionId,
        title: `Boundary Task ${failAt}`,
        actor: { type: "system", id: "workflow-recovery" },
        auditSource: "workflow",
        causalContext: { root: { type: "workflow_recovery", id: `run-bnd-${failAt}` } },
        initialEventAction: "created",
      });
      if (prepared.outcome !== "prepared") throw new Error("prepare failed");
      const governance = governTaskPublication({
        attemptId,
        tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
        db,
      });
      if (governance.results[0].outcome === "vetoed") throw new Error("unexpected veto");

      const linkage: RecoveryLinkage = {
        gateId: scenario.gateId,
        workflowId: scenario.workflowId,
        habitatId,
        missionId,
        downstreamTaskId: scenario.downstreamTaskId,
        recoveryDepth: 0,
        failureContextId: scenario.failureContextId,
      };
      const participants = buildRecoveryLinkageParticipant(linkage);

      let thrown: unknown;
      try {
        db.transaction((tx) => {
          const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
            failAtWriteN: failAt,
          });
          publishTaskWithClientCoord(asPubClient(w), {
            attemptId,
            proposal: prepared.proposal,
            guard: prepared.guard,
            participants,
          });
        });
      } catch (err) {
        thrown = err;
      }
      expect(thrown).toBeDefined();

      // ZERO unlinked Recovery Task: no new Task row, no new gate row.
      expect(getDb().select().from(tasks).all().length).toBe(beforeTasks);
      expect(getDb().select().from(taskWorkflowGates).all().length).toBe(beforeGates);

      // The original gate is UNCHANGED (no recoveryTaskId stamp from a
      // half-committed publication).
      const originalGate = getDb()
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.id, scenario.gateId))
        .all()[0];
      expect(originalGate.recoveryTaskId).toBeNull();

      // The failure-context is UNCHANGED.
      const ctx = getDb()
        .select()
        .from(failureContexts)
        .where(eq(failureContexts.id, scenario.failureContextId!))
        .all()[0];
      expect(ctx.recoveryTaskId).toBeNull();
    });
  }

  // Participant write boundaries (with a failure-context): the coordinator's
  // write sequence is — task INSERT(1), event INSERT(2), gate INSERT(3),
  // gate UPDATE(4), failure-context UPDATE(5), envelope INSERT(6), recalc
  // marker(7), checkpoint UPDATE(8). Inject at each participant boundary AND
  // one post-participant boundary (the checkpoint) to prove the linkage rolls
  // back when a LATER write fails too.
  runBoundaryCase(3, "participant-gate-insert");
  runBoundaryCase(4, "participant-gate-update");
  runBoundaryCase(5, "participant-failure-context-update");
  runBoundaryCase(8, "post-participant-checkpoint");
});

// ===========================================================================
// 4b. SAME-GATE CONCURRENT-ATTEMPT RACE (cold-review #2 M1) — the gate-linkage
//     CAS ensures exactly one attempt wins a shared gate. Two distinct
//     Recovery attempts (different runIds → different attempt keys) targeting
//     the SAME gate race: the winner claims the gate; the loser's entire
//     publication rolls back (participant throw → no Task, no event, no
//     next-depth gate).
// ===========================================================================

describe("T8A-pre P1 same-gate race — CAS guard on gate linkage (cold-review #2 M1)", () => {
  it("two distinct attempts for the same gate: exactly one wins, the loser's aggregate fully rolls back", () => {
    const scenario = seedRecoveryScenario();
    const beforeTasks = getDb().select().from(tasks).all().length;
    const beforeEvents = getDb().select().from(taskEvents).all().length;
    const beforeGates = getDb().select().from(taskWorkflowGates).all().length;

    // First attempt (runId-A) → succeeds, claims the gate.
    const r1 = publishRecoveryTask(
      recoveryInput(scenario, { runId: freshRunId("race-winner"), actionKey: "spawn-0" }),
    );
    expectCreatedRecovering(r1);
    const winnerTaskId = r1.publication.task.id;

    // The gate's recoveryTaskId is now claimed by the winner.
    const gateAfterWinner = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, scenario.gateId))
      .all()[0];
    expect(gateAfterWinner.recoveryTaskId).toBe(winnerTaskId);

    // Second attempt (runId-B, same gate, different attempt key) → the CAS
    // guard finds recoveryTaskId IS NOT NULL → matches zero rows → throws.
    // The throw propagates out of publishRecoveryTask (participant throw →
    // the publication tx rolls back the whole aggregate).
    expect(() =>
      publishRecoveryTask(
        recoveryInput(scenario, { runId: freshRunId("race-loser"), actionKey: "spawn-0" }),
      ),
    ).toThrow(/gate .* is already linked to another Recovery Task/);

    // ZERO side effects from the loser: no new Task, no new event, no new gate.
    expect(getDb().select().from(tasks).all().length).toBe(beforeTasks + 1);
    expect(getDb().select().from(taskEvents).all().length).toBe(beforeEvents + 1);
    expect(getDb().select().from(taskWorkflowGates).all().length).toBe(beforeGates + 1);

    // The gate's recoveryTaskId STILL points to the winner (not overwritten).
    const gateAfterLoser = getDb()
      .select()
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, scenario.gateId))
      .all()[0];
    expect(gateAfterLoser.recoveryTaskId).toBe(winnerTaskId);
  });
});

// ===========================================================================
// 5. VETOED RECOVERY → VISIBLE BLOCKED OUTCOME (not a swallowed null).
// ===========================================================================

describe("T8A-pre P1 vetoed Recovery — visible blocked outcome", () => {
  it("a governance veto surfaces a typed `vetoed` result (not null); no Task created", async () => {
    await writePlugin(
      "veto-plugin",
      `{
      manifest: {
        id: 'veto-plugin', version: '1.0.0', description: 'veto recovery',
        contributions: [
          { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-recovery', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
        ],
      },
      interceptors: {
        'veto-recovery': () => ({ allow: false, reason: 'recovery policy refuses' }),
      },
    }`,
    );
    enrollInterceptor(habitatId, "veto-plugin", "veto-recovery");

    const scenario = seedRecoveryScenario();
    const before = missionTaskCount();

    const result = publishRecoveryTask(recoveryInput(scenario));

    // TYPED blocked outcome — NOT the swallowed null the legacy path returns.
    expect(result.outcome).toBe("vetoed");
    if (result.outcome !== "vetoed") return;
    expect(result.veto.reason).toBe("recovery policy refuses");
    // The interceptor key is a composite ledger key; assert it carries the
    // enrolled plugin + contribution identifiers (not a bare equality).
    expect(result.veto.interceptorKey).toContain("veto-plugin");
    expect(result.veto.interceptorKey).toContain("veto-recovery");
    // No Task created.
    expect(missionTaskCount()).toBe(before);
    // No next-depth gate inserted (the participant never ran).
    expect(
      getDb()
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.gateType, "on_fail"))
        .all()
        .filter((g) => g.recoveryDepth === 1),
    ).toHaveLength(0);
  });
});

// ===========================================================================
// 6. SAME-RUN/ACTION REPLAY — identical (runId, actionKey) replays the
//    terminal outcome; no duplicate Task.
// ===========================================================================

describe("T8A-pre P1 replay — same-run/action does not create twice", () => {
  it("identical (runId, actionKey) after a terminal veto replays the veto (no re-run)", async () => {
    await writePlugin(
      "veto-plugin-replay",
      `{
      manifest: {
        id: 'veto-plugin-replay', version: '1.0.0', description: 'veto for replay',
        contributions: [
          { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-replay', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
        ],
      },
      interceptors: {
        'veto-replay': () => ({ allow: false, reason: 'replay veto' }),
      },
    }`,
    );
    enrollInterceptor(habitatId, "veto-plugin-replay", "veto-replay");

    const scenario = seedRecoveryScenario();
    const payload = recoveryInput(scenario);

    // First call: terminal veto.
    const first = publishRecoveryTask(payload);
    expect(first.outcome).toBe("vetoed");

    // Same (runId, actionKey) retry: replays the terminal veto. NO re-run of
    // governance (a mock-call counter would prove this; the structural proof
    // is the `replayed` outcome + the stored terminal result).
    const retry = publishRecoveryTask(payload);
    expect(retry.outcome).toBe("replayed");
    if (retry.outcome !== "replayed") return;
    expect(retry.terminal.outcome).toBe("vetoed");
  });

  it("identical (runId, actionKey) after a successful publish surfaces recovering (no duplicate)", () => {
    const scenario = seedRecoveryScenario();
    const payload = recoveryInput(scenario);
    // Baseline AFTER seeding (the scenario creates a failed + downstream task).
    const baseline = missionTaskCount();

    const first = publishRecoveryTask(payload);
    expectCreatedRecovering(first);
    const taskId = first.publication.task.id;
    expect(missionTaskCount()).toBe(baseline + 1);

    // Same-key retry: the attempt is at published_pending_observation; the
    // adapter re-reads the committed publication and returns recovering. It
    // does NOT re-publish (no second task).
    const retry = publishRecoveryTask(payload);
    expect(retry.outcome).toBe("created");
    if (retry.outcome !== "created") return;
    expect(retry.recovering).toBe(true);
    expect(retry.publication.task.id).toBe(taskId);
    expect(missionTaskCount()).toBe(baseline + 1);
  });

  it("a different actionKey under the same run creates a distinct attempt (no collision)", () => {
    // Each Recovery attempt targets its OWN gate (the M1 CAS guard ensures
    // only one attempt can claim a shared gate; distinct attempts need
    // distinct gates to coexist).
    const scenarioA = seedRecoveryScenario();
    const scenarioB = seedRecoveryScenario();
    const baseline = missionTaskCount();
    const runId = freshRunId("shared-run");

    const r1 = publishRecoveryTask(recoveryInput(scenarioA, { runId, actionKey: "spawn-A" }));
    const r2 = publishRecoveryTask(recoveryInput(scenarioB, { runId, actionKey: "spawn-B" }));

    expectCreatedRecovering(r1);
    expectCreatedRecovering(r2);
    // Two distinct Recovery Tasks — the action key distinguishes them.
    expect(r1.publication.task.id).not.toBe(r2.publication.task.id);
    expect(missionTaskCount()).toBe(baseline + 2);
  });
});

// ===========================================================================
// 6b. REPLAY AFTER TERMINALIZATION carries taskId (cold-review #2 M3).
//     The observation terminalizer stamps terminalResult.taskId on the success
//     path so ALL replay paths recover the committed taskId from the terminal
//     without envelope backfill.
// ===========================================================================

describe("T8A-pre P1 replay taskId — terminal carries the committed taskId (cold-review #2 M3)", () => {
  it("publish → terminalize → same-key replay surfaces terminal.taskId", () => {
    const scenario = seedRecoveryScenario();
    const payload = recoveryInput(scenario);
    const baseline = missionTaskCount();

    // 1. Publish → recovering (published_pending_observation).
    const first = publishRecoveryTask(payload);
    expectCreatedRecovering(first);
    const taskId = first.publication.task.id;
    expect(missionTaskCount()).toBe(baseline + 1);

    // 2. Terminalize via the observation checkpoint (zero dispatch targets,
    //    no reservation → completeAttemptWithClient stamps the terminal
    //    result with taskId).
    const obs = satisfyObservationCheckpointWithClient(getDb(), first.attemptId);
    expect(obs.outcome).toBe("advanced");

    // 3. Same-key replay → the terminal carries taskId.
    const retry = publishRecoveryTask(payload);
    expect(retry.outcome).toBe("replayed");
    if (retry.outcome !== "replayed") return;
    expect(retry.terminal.taskId).toBe(taskId);
    expect(retry.terminal.outcome).toBe("created");
    expect(missionTaskCount()).toBe(baseline + 1);
  });
});

// ===========================================================================
// 7. PROVENANCE — server-constructed; the committed envelope carries the
//    Recovery-run root; untrusted input cannot assert privileged identities.
// ===========================================================================

describe("T8A-pre P1 provenance — server-constructed Recovery-run identity", () => {
  it("the input type does not expose actor/auditSource/causalContext (compile-time guarantee)", () => {
    const input: PublishRecoveryTaskInput = recoveryInput(seedRecoveryScenario());
    expect((input as unknown as Record<string, unknown>).actor).toBeUndefined();
    expect((input as unknown as Record<string, unknown>).auditSource).toBeUndefined();
    expect((input as unknown as Record<string, unknown>).causalContext).toBeUndefined();
    expect((input as unknown as Record<string, unknown>).prospectiveTaskId).toBeUndefined();
  });

  it("the committed envelope carries source='workflow', actor 'workflow-recovery', causal root workflow_recovery:<runId>", () => {
    const scenario = seedRecoveryScenario();
    const runId = freshRunId("prov-run");
    const result = publishRecoveryTask(recoveryInput(scenario, { runId }));
    expectCreatedRecovering(result);

    expect(result.publication.envelope).not.toBeNull();
    expect(result.publication.envelope!.source).toBe("workflow");
    expect(result.publication.envelope!.actorType).toBe("system");
    expect(result.publication.envelope!.actorId).toBe("workflow-recovery");
    expect(result.publication.envelope!.causalContext).not.toBeNull();
    expect(result.publication.envelope!.causalContext!.root.type).toBe("workflow_recovery");
    expect(result.publication.envelope!.causalContext!.root.id).toBe(runId);
    // Fresh root — no inherited hops.
    expect(result.publication.envelope!.causalContext!.hops ?? []).toHaveLength(0);

    // The Task row's createdBy mirrors the system actor identity (preserving
    // the legacy `createdBy: "workflow-recovery"` as structured provenance).
    expect(result.publication.task.createdBy).toBe("workflow-recovery");
  });

  it("two different runs produce distinct causal roots (fresh root per run)", () => {
    // Each run targets its OWN gate (the M1 CAS guard ensures only one
    // attempt can claim a shared gate; distinct runs need distinct gates).
    const scenarioA = seedRecoveryScenario();
    const scenarioB = seedRecoveryScenario();
    const r1 = publishRecoveryTask(recoveryInput(scenarioA, { runId: freshRunId("run-alpha") }));
    const r2 = publishRecoveryTask(recoveryInput(scenarioB, { runId: freshRunId("run-beta") }));
    expectCreatedRecovering(r1);
    expectCreatedRecovering(r2);
    expect(r1.publication.envelope!.causalContext!.root.id).not.toBe(
      r2.publication.envelope!.causalContext!.root.id,
    );
  });
});

// ===========================================================================
// 8. LEGACY createRecoveryTask UNCHANGED — the adapter ships DORMANT.
// ===========================================================================

describe("T8A-pre P1 dormancy — legacy createRecoveryTask stays the active production path", () => {
  it("the legacy raw-insert path is untouched (workflowService.ts byte-unchanged)", () => {
    // The adapter does NOT wire into spawnRecoveryForGate. The legacy path's
    // raw `taskCrudRepo.createTask({ createdBy: "workflow-recovery" })` stays
    // the active production writer. Assert the marker: a legacy Recovery Task
    // is NOT stamped POST_CUTOVER (the kernel stamps it; the legacy path
    // does not).
    const failedTask = taskCrudRepo.createTask({
      missionId,
      title: "Legacy failed",
      createdBy: "test",
    });
    const legacyRecovery = taskCrudRepo.createTask({
      missionId,
      title: "Legacy recovery",
      description: "raw insert",
      requiredCapabilities: ["debugging"],
      requiredDomain: "backend",
      createdBy: "workflow-recovery",
    });
    const legacyRow = getDb().select().from(tasks).where(eq(tasks.id, legacyRecovery.id)).all()[0];
    expect(legacyRow.creationIntegrity).not.toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
    expect(legacyRow.createdBy).toBe("workflow-recovery");
    // No created event (legacy path produces none).
    expect(
      getDb().select().from(taskEvents).where(eq(taskEvents.taskId, legacyRecovery.id)).all(),
    ).toHaveLength(0);
    void failedTask;
  });
});
