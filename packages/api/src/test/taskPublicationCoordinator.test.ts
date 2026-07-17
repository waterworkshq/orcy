/**
 * T3C — atomic publication coordinator invariant tests.
 *
 * The coordinator (`publishTaskWithClient`) is the Story-1 keystone: the
 * origin-neutral guarded transaction that atomically persists a complete Task
 * aggregate + initial history + committed envelope/dispatch plan + recalc
 * marker + optional reservation + the `published_pending_observation`
 * checkpoint. Every contract invariant below has a discriminating failure mode
 * stated inline (proving the test is not tautological).
 *
 * The atomicity matrix (failure injected at EACH write → zero partial state)
 * is the core guardrail; it leans on the `FailingDbClient` wrapper the same way
 * `taskPublicationFailureInjection.test.ts` does.
 *
 * DORMANT: no production origin routes through the coordinator yet — this test
 * suite is the sole exerciser until the global cutover (T11) wires origins in.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  taskSubtasks,
  taskDependencies,
  taskCreationEnvelopes,
  taskCreationDispatchTargets,
  taskCreationAssignmentReservations,
  taskCreationAttempts,
  missionRecalculationMarkers,
  missions,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import {
  prepareTaskPublication,
  type PrepareTaskPublicationInput,
} from "../services/taskPublicationPreparation.js";
import { governTaskPublication } from "../services/taskPublicationGovernance.js";
import {
  publishTaskWithClient,
  PublicationCheckpointConsistencyError,
  type PublishTaskInput,
} from "../services/taskPublicationCoordinator.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import { FailingDbClient } from "./helpers/failingDbClient.js";
import type { TaskPublicationDbClient } from "../repositories/taskPublication.js";
import type { AuditActorRef, AuditSource } from "@orcy/shared";

// --- Mocks: assert the coordinator emits NO pre-commit effects (SSE/hooks). ---
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

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "Coordinator Habitat" });
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
    title: "coordinator-mission",
    createdBy: "user-1",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ---------------------------------------------------------------------------
// Seeders / helpers
// ---------------------------------------------------------------------------

/** Seeds a `task_creation_attempts` row at `pending` for the ledger FK. */
function seedAttempt(id: string): void {
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: missionId,
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

/** Casts the FailingDbClient wrapper to the union type the coordinator accepts. */
function asPubClient(w: FailingDbClient): TaskPublicationDbClient {
  return w as unknown as TaskPublicationDbClient;
}

/** A prepared proposal + guard fixture; callers override individual fields. */
function prepareTask(
  overrides: Partial<PrepareTaskPublicationInput> = {},
): ReturnType<typeof prepareTaskPublication> {
  return prepareTaskPublication({
    habitatId,
    targetMissionId: missionId,
    title: "Coordinator Task",
    description: "A proposal under atomic publication.",
    priority: "high",
    labels: ["kernel"],
    actor: ACTOR,
    auditSource: AUDIT_SOURCE,
    causalContext: CAUSAL_CONTEXT,
    initialEventAction: "created",
    ...overrides,
  });
}

/** Write + load a temp plugin; returns the tmp dir for cleanup. */
async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t3c-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
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

/**
 * Asserts ZERO partial state for a rolled-back publication: no Task row with the
 * prospective ID, no event, no subtask/dep, no envelope, no dispatch target, no
 * reservation, no recalc marker for this mission beyond the baseline; and the
 * attempt is STILL `pending` (resumable).
 */
function expectZeroPartialState(
  prospectiveTaskId: string,
  attemptId: string,
  baseline: { recalcMarkers: number },
  /**
   * The attempt state asserted after rollback. Defaults to `"pending"` (the
   * resumable state). The checkpoint-consistency test pre-advances the attempt
   * OUTSIDE the coordinator's tx, so the rollback leaves the pre-advanced state
   * intact — pass it here.
   */
  expectedAttemptState = "pending",
): void {
  const db = getDb();
  expect(db.select().from(tasks).where(eq(tasks.id, prospectiveTaskId)).all()).toHaveLength(0);
  expect(
    db.select().from(taskEvents).where(eq(taskEvents.taskId, prospectiveTaskId)).all(),
  ).toHaveLength(0);
  expect(
    db.select().from(taskSubtasks).where(eq(taskSubtasks.taskId, prospectiveTaskId)).all(),
  ).toHaveLength(0);
  expect(
    db
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.taskId, prospectiveTaskId))
      .all(),
  ).toHaveLength(0);
  expect(
    db
      .select()
      .from(taskCreationDispatchTargets)
      .where(eq(taskCreationDispatchTargets.eventId, prospectiveTaskId))
      .all(),
  ).toHaveLength(0);
  expect(
    db
      .select()
      .from(taskCreationAssignmentReservations)
      .where(eq(taskCreationAssignmentReservations.taskId, prospectiveTaskId))
      .all(),
  ).toHaveLength(0);
  // Recalc marker coalesces; a rollback means no NEW marker beyond baseline.
  expect(db.select().from(missionRecalculationMarkers).all().length).toBe(baseline.recalcMarkers);
  // The attempt is STILL pending (the checkpoint UPDATE rolled back).
  const attempt = db
    .select()
    .from(taskCreationAttempts)
    .where(eq(taskCreationAttempts.id, attemptId))
    .all()[0];
  expect(attempt).toBeDefined();
  expect(attempt.state).toBe(expectedAttemptState);
  if (expectedAttemptState === "pending") {
    expect(attempt.publishedAt).toBeNull();
  }
}

// ===========================================================================
// 1. Happy path — full aggregate committed; every invariant observable.
// ===========================================================================

describe("T3C happy path — full aggregate committed atomically", () => {
  it("publishes a complete Task + event + subtask + dependency + envelope + dispatch target + recalc marker + reservation + checkpoint in one tx", () => {
    // Seed a dependency target the publication will reference.
    const depTarget = getDb()
      .insert(tasks)
      .values({
        id: "dep-target-1",
        missionId,
        title: "dependency target",
        createdBy: "u",
      })
      .returning()
      .all()[0];

    const prepared = prepareTask({
      prospectiveTaskId: "task-happy",
      subtasks: [{ title: "happy-child", order: 0 }],
      selectedDependencies: [{ dependsOnId: depTarget.id }],
      requestedAssigneeId: "agent-happy",
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-happy");
    governTaskPublication({
      attemptId: "attempt-happy",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      outcome = publishTaskWithClient(tx, {
        attemptId: "attempt-happy",
        proposal: prepared.proposal,
        guard: prepared.guard,
        dispatchPlan: [{ targetKind: "agent", targetKey: "agent-happy" }],
        reservation: { deadline: "2099-01-01T00:00:00.000Z" },
      });
    });

    expect(outcome?.outcome).toBe("published");
    if (outcome?.outcome !== "published") return;
    const p = outcome.publication;

    // Task: prospective ID became final ID; POST_CUTOVER stamped; order allocated.
    expect(p.task.id).toBe("task-happy");
    expect(p.task.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
    expect(p.task.order).toBeGreaterThanOrEqual(0);
    expect(p.task.status).toBe("pending");

    // Exactly ONE initial event with the proposal's action.
    expect(p.event.taskId).toBe("task-happy");
    expect(p.event.action).toBe("created");

    // Editable aggregate.
    expect(p.subtasks).toHaveLength(1);
    expect(p.subtasks[0].title).toBe("happy-child");
    expect(p.dependencies).toHaveLength(1);
    expect(p.dependencies[0].dependsOnId).toBe(depTarget.id);

    // Committed envelope + dispatch target.
    expect(p.envelope.taskId).toBe("task-happy");
    expect(p.envelope.lifecycleAction).toBe("created");
    expect(p.dispatchTargets).toHaveLength(1);
    expect(p.dispatchTargets[0].targetKey).toBe("agent-happy");
    expect(p.dispatchTargets[0].state).toBe("pending");

    // Reservation (assignee was non-null).
    expect(p.reservation).not.toBeNull();
    expect(p.reservation!.requestedAgentId).toBe("agent-happy");
    expect(p.reservation!.deadline).toBe("2099-01-01T00:00:00.000Z");
    expect(p.reservation!.state).toBe("active");

    // Recalc marker intent.
    expect(p.recalculationMarker.missionId).toBe(missionId);

    // Checkpoint transitioned to published_pending_observation.
    expect(p.checkpoint.outcome).toBe("transitioned");
    expect(p.checkpoint.attempt.state).toBe("published_pending_observation");

    // FAILURE MODE: if any primitive wrote via getDb() instead of the passed
    // tx client, the row would commit despite a tx rollback (tested below) and
    // the prospective→final ID linkage would break.
  });

  it("omits the reservation when requestedAssigneeId is null (no assignee requested)", () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-no-res" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-no-res");
    governTaskPublication({
      attemptId: "attempt-no-res",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      outcome = publishTaskWithClient(tx, {
        attemptId: "attempt-no-res",
        proposal: prepared.proposal,
        guard: prepared.guard,
      });
    });

    expect(outcome?.outcome).toBe("published");
    if (outcome?.outcome !== "published") return;
    expect(outcome.publication.reservation).toBeNull();
  });
});

// ===========================================================================
// 2. ATOMICITY MATRIX — failure at EACH write → zero partial state.
//    This is the core guardrail.
// ===========================================================================

describe("T3C atomicity matrix — failure injected at each write rolls back the whole aggregate", () => {
  /**
   * Write sequence for a full publication (1 subtask, 1 dep, 1 dispatch target,
   * 1 reservation), NO participant hook:
   *   #1 INSERT task          (createTaskWithClient)
   *   #2 INSERT event         (createTaskEventWithClient)
   *   #3 INSERT subtask       (createSubtaskWithClient)
   *   #4 INSERT dependency    (addTaskDependencyWithClient)
   *   #5 INSERT envelope      (createCommittedTaskEnvelopeWithClient)
   *   #6 INSERT dispatch tgt  (createCommittedTaskEnvelopeWithClient)
   *   #7 INSERT recalc marker (markMissionForRecalculationWithClient)
   *   #8 INSERT reservation   (createAssignmentReservationWithClient)
   *   #9 UPDATE checkpoint    (checkpointAttemptWithClient)
   *
   * Each test injects a failure at ONE write boundary, expects a throw, and
   * asserts ZERO partial state + the attempt is STILL `pending`/resumable.
   */
  function runMatrixCase(failAtWriteN: number): void {
    const depTarget = getDb()
      .insert(tasks)
      .values({
        id: `dep-matrix-${failAtWriteN}`,
        missionId,
        title: "matrix dep",
        createdBy: "u",
      })
      .returning()
      .all()[0];

    const prepared = prepareTask({
      prospectiveTaskId: `task-matrix-${failAtWriteN}`,
      subtasks: [{ title: "matrix-child", order: 0 }],
      selectedDependencies: [{ dependsOnId: depTarget.id }],
      requestedAssigneeId: "agent-matrix",
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    const attemptId = `attempt-matrix-${failAtWriteN}`;
    seedAttempt(attemptId);
    governTaskPublication({
      attemptId,
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    const baseline = {
      recalcMarkers: getDb().select().from(missionRecalculationMarkers).all().length,
    };

    let thrown: unknown;
    try {
      getDb().transaction((tx) => {
        const w = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          failAtWriteN,
        });
        publishTaskWithClient(asPubClient(w), {
          attemptId,
          proposal: prepared.proposal,
          guard: prepared.guard,
          dispatchPlan: [{ targetKind: "agent", targetKey: "agent-matrix" }],
          reservation: { deadline: "2099-01-01T00:00:00.000Z" },
        });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeDefined();
    expectZeroPartialState(`task-matrix-${failAtWriteN}`, attemptId, baseline);

    // FAILURE MODE: if ANY primitive wrote via getDb() instead of the passed
    // tx client, that write would commit despite the throw → partial state
    // (a Task/event/envelope row) would survive and the zero-partial assertion
    // would fail. Each matrix index pins one write to the tx client.
  }

  it("write #1 (INSERT task) — whole aggregate rolls back", () => runMatrixCase(1));
  it("write #2 (INSERT event) — whole aggregate rolls back", () => runMatrixCase(2));
  it("write #3 (INSERT subtask) — whole aggregate rolls back", () => runMatrixCase(3));
  it("write #4 (INSERT dependency) — whole aggregate rolls back", () => runMatrixCase(4));
  it("write #5 (INSERT envelope) — whole aggregate rolls back", () => runMatrixCase(5));
  it("write #6 (INSERT dispatch target) — whole aggregate rolls back", () => runMatrixCase(6));
  it("write #7 (INSERT recalc marker) — whole aggregate rolls back", () => runMatrixCase(7));
  it("write #8 (INSERT reservation) — whole aggregate rolls back", () => runMatrixCase(8));
  it("write #9 (UPDATE checkpoint) — whole aggregate rolls back", () => runMatrixCase(9));

  it("a write AFTER #9 never happens (the full publication is exactly 9 writes for this fixture)", () => {
    // Confirm the matrix covers EVERY write: run with no failure and assert
    // writeCount === 9. If a primitive added a write, this guard fires and the
    // matrix above must be extended.
    const depTarget = getDb()
      .insert(tasks)
      .values({
        id: "dep-count",
        missionId,
        title: "count dep",
        createdBy: "u",
      })
      .returning()
      .all()[0];
    const prepared = prepareTask({
      prospectiveTaskId: "task-count",
      subtasks: [{ title: "count-child", order: 0 }],
      selectedDependencies: [{ dependsOnId: depTarget.id }],
      requestedAssigneeId: "agent-count",
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-count");
    governTaskPublication({
      attemptId: "attempt-count",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let captured: FailingDbClient | undefined;
    getDb().transaction((tx) => {
      captured = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
        failAtWriteN: null,
      });
      publishTaskWithClient(asPubClient(captured), {
        attemptId: "attempt-count",
        proposal: prepared.proposal,
        guard: prepared.guard,
        dispatchPlan: [{ targetKind: "agent", targetKey: "agent-count" }],
        reservation: { deadline: "2099-01-01T00:00:00.000Z" },
      });
    });
    expect(captured!.writeCount).toBe(9);
  });
});

// ===========================================================================
// 3. Guard mismatch — writes no aggregate; attempt stays resumable.
// ===========================================================================

describe("T3C guard mismatch — no aggregate written, attempt resumable", () => {
  it("bumping the mission version after governance yields guard_mismatch with zero writes", () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-mismatch" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-mismatch");
    governTaskPublication({
      attemptId: "attempt-mismatch",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    // Drift: bump the mission version → guard's missionVersion is now stale.
    getDb()
      .update(missions)
      .set({ version: prepared.guard.missionVersion + 1 })
      .where(eq(missions.id, missionId))
      .run();

    let wrapper: FailingDbClient | undefined;
    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      wrapper = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
        failAtWriteN: null,
      });
      outcome = publishTaskWithClient(asPubClient(wrapper), {
        attemptId: "attempt-mismatch",
        proposal: prepared.proposal,
        guard: prepared.guard,
      });
    });

    expect(outcome?.outcome).toBe("guard_mismatch");
    // ZERO writes — the coordinator returned before createTask.
    expect(wrapper!.writeCount).toBe(0);
    // Attempt still pending (resumable).
    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, "attempt-mismatch"))
      .all()[0];
    expect(attempt.state).toBe("pending");
  });
});

// ===========================================================================
// 4. Governance denial — writes no aggregate.
// ===========================================================================

describe("T3C governance denial — no aggregate written", () => {
  it("a proposal whose governance fingerprint has no recorded decision → governance_denied with zero writes", async () => {
    const tmpDir = await writePlugin(
      "denial",
      `{
        manifest: {
          id: 'denial', version: '1.0.0', description: 'denial',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'allow', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: { 'allow': () => ({ allow: true }) },
      }`,
    );
    try {
      enrollInterceptor(habitatId, "denial", "allow");

      // Govern under proposal A (title "Original") — records the allow decision
      // under proposal A's governance fingerprint.
      const preparedA = prepareTask({ title: "Original", prospectiveTaskId: "task-denied" });
      if (preparedA.outcome !== "prepared") throw new Error("prep A failed");
      seedAttempt("attempt-denied");
      governTaskPublication({
        attemptId: "attempt-denied",
        tasks: [{ proposal: preparedA.proposal, guard: preparedA.guard }],
        db: getDb(),
      });

      // Re-prepare under proposal B (title "Changed") — same prospectiveTaskId,
      // same enrollment, but the proposal title differs → different governance
      // fingerprint. Copy A's fingerprint so verify passes (enrollment
      // unchanged) but the decision under A's fingerprint is STALE for B.
      const preparedB = prepareTask({ title: "Changed", prospectiveTaskId: "task-denied" });
      if (preparedB.outcome !== "prepared") throw new Error("prep B failed");
      preparedB.guard.interceptorEnrollmentFingerprint =
        preparedA.guard.interceptorEnrollmentFingerprint;

      let wrapper: FailingDbClient | undefined;
      let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
      getDb().transaction((tx) => {
        wrapper = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          failAtWriteN: null,
        });
        outcome = publishTaskWithClient(asPubClient(wrapper), {
          attemptId: "attempt-denied",
          proposal: preparedB.proposal,
          guard: preparedB.guard,
        });
      });

      expect(outcome?.outcome).toBe("governance_denied");
      // ZERO writes — the coordinator returned before createTask.
      expect(wrapper!.writeCount).toBe(0);
      expectZeroPartialState("task-denied", "attempt-denied", {
        recalcMarkers: getDb().select().from(missionRecalculationMarkers).all().length,
      });

      // FAILURE MODE: if the coordinator wrote the Task BEFORE checking
      // authorization, a denied publication would leave a partial Task row.
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// 5. creationIntegrity stamped POST_CUTOVER (not 0).
// ===========================================================================

describe("T3C creationIntegrity — every published Task carries POST_CUTOVER", () => {
  it("the committed Task has creationIntegrity === POST_CUTOVER (1), not 0", () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-integrity" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-integrity");
    governTaskPublication({
      attemptId: "attempt-integrity",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      outcome = publishTaskWithClient(tx, {
        attemptId: "attempt-integrity",
        proposal: prepared.proposal,
        guard: prepared.guard,
      });
    });

    expect(outcome?.outcome).toBe("published");
    if (outcome?.outcome !== "published") return;
    expect(outcome.publication.task.creationIntegrity).toBe(
      TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER,
    );
    // FAILER MODE: if the coordinator omitted creationIntegrity, the column
    // default (0 = Legacy Partial History) would apply and the claim gates'
    // isLegacyPartialHistory would never engage on a published Task.
  });
});

// ===========================================================================
// 6. Order allocated in-tx — concurrent same-mission publications get distinct
//    contiguous orders.
// ===========================================================================

describe("T3C order allocation — distinct contiguous orders in one tx", () => {
  it("two publications in the same mission inside one tx get orders N and N+1", () => {
    const preparedA = prepareTask({ prospectiveTaskId: "task-order-a", title: "order A" });
    const preparedB = prepareTask({ prospectiveTaskId: "task-order-b", title: "order B" });
    if (preparedA.outcome !== "prepared" || preparedB.outcome !== "prepared") {
      throw new Error("prep failed");
    }
    seedAttempt("attempt-order-a");
    seedAttempt("attempt-order-b");
    governTaskPublication({
      attemptId: "attempt-order-a",
      tasks: [{ proposal: preparedA.proposal, guard: preparedA.guard }],
      db: getDb(),
    });
    governTaskPublication({
      attemptId: "attempt-order-b",
      tasks: [{ proposal: preparedB.proposal, guard: preparedB.guard }],
      db: getDb(),
    });

    const outcomes: Array<ReturnType<typeof publishTaskWithClient>> = [];
    getDb().transaction((tx) => {
      outcomes.push(
        publishTaskWithClient(tx, {
          attemptId: "attempt-order-a",
          proposal: preparedA.proposal,
          guard: preparedA.guard,
        }),
      );
      outcomes.push(
        publishTaskWithClient(tx, {
          attemptId: "attempt-order-b",
          proposal: preparedB.proposal,
          guard: preparedB.guard,
        }),
      );
    });

    expect(outcomes.every((o) => o.outcome === "published")).toBe(true);
    const [a, b] = outcomes.map((o) => (o.outcome === "published" ? o.publication.task.order : -1));
    expect(b).toBe(a + 1);
    expect(a).toBeGreaterThanOrEqual(0);

    // FAILURE MODE: if order allocation leaked to getDb() or ran outside the
    // tx, both publications could read the same max(order) and collide.
  });
});

// ===========================================================================
// 7. Participant seam — composes atomically; a throw rolls back the aggregate.
// ===========================================================================

describe("T3C participant seam — composes atomically", () => {
  it("a participant write that throws rolls back the whole aggregate (including the core Task)", () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-participant" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-participant");
    governTaskPublication({
      attemptId: "attempt-participant",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let thrown: unknown;
    try {
      getDb().transaction((tx) => {
        publishTaskWithClient(tx, {
          attemptId: "attempt-participant",
          proposal: prepared.proposal,
          guard: prepared.guard,
          participants: () => {
            throw new Error("participant domain write failed");
          },
        });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("participant domain write failed");
    expectZeroPartialState("task-participant", "attempt-participant", {
      recalcMarkers: getDb().select().from(missionRecalculationMarkers).all().length,
    });

    // FAILURE MODE: if the participant seam ran outside the caller's tx (or the
    // coordinator committed independently), the core Task would survive the
    // participant throw → partial state.
  });

  it("the participant hook receives the freshly-inserted task + event + the proposal", () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-participant-ctx" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-participant-ctx");
    governTaskPublication({
      attemptId: "attempt-participant-ctx",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let capturedCtx: { task: { id: string }; event: { id: string }; attemptId: string } | undefined;
    let outcome: ReturnType<typeof publishTaskWithClient> | undefined;
    getDb().transaction((tx) => {
      outcome = publishTaskWithClient(tx, {
        attemptId: "attempt-participant-ctx",
        proposal: prepared.proposal,
        guard: prepared.guard,
        participants: (_db, ctx) => {
          capturedCtx = ctx;
        },
      });
    });

    expect(outcome?.outcome).toBe("published");
    expect(capturedCtx!.task.id).toBe("task-participant-ctx");
    expect(capturedCtx!.event.id).toBeDefined();
    expect(capturedCtx!.attemptId).toBe("attempt-participant-ctx");
  });
});

// ===========================================================================
// 8. No pre-commit effects — the coordinator emits nothing until commit.
// ===========================================================================

describe("T3C no pre-commit effects — nothing observable until the caller's tx commits", () => {
  it("a successful publication emits ZERO SSE broadcasts (the caller owns post-commit effects)", () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-no-effects" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-no-effects");
    governTaskPublication({
      attemptId: "attempt-no-effects",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    publishMock.mockClear();
    getDb().transaction((tx) => {
      publishTaskWithClient(tx, {
        attemptId: "attempt-no-effects",
        proposal: prepared.proposal,
        guard: prepared.guard,
      });
    });

    expect(publishMock).not.toHaveBeenCalled();

    // FAILURE MODE: if the coordinator emitted an SSE/hook mid-tx, a rollback
    // (tested above) would leave an observable effect for an uncommitted
    // publication. The coordinator must be effect-free.
  });
});

// ===========================================================================
// 9. Checkpoint consistency failure — non-transitioned checkpoint throws +
//    rolls back the whole aggregate.
// ===========================================================================

describe("T3C checkpoint consistency — a non-transitioned checkpoint rolls back the aggregate", () => {
  it("pre-advancing the attempt to published_pending_observation → checkpoint no_op → throw + zero partial state", () => {
    const prepared = prepareTask({ prospectiveTaskId: "task-cp-consistency" });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-cp-consistency");
    governTaskPublication({
      attemptId: "attempt-cp-consistency",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });
    // Pre-advance the attempt so the coordinator's checkpoint is a no_op
    // (same-state) — a consistency failure (the attempt was not pending).
    getDb()
      .update(taskCreationAttempts)
      .set({ state: "published_pending_observation" })
      .where(eq(taskCreationAttempts.id, "attempt-cp-consistency"))
      .run();

    let thrown: unknown;
    try {
      getDb().transaction((tx) => {
        publishTaskWithClient(tx, {
          attemptId: "attempt-cp-consistency",
          proposal: prepared.proposal,
          guard: prepared.guard,
        });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(PublicationCheckpointConsistencyError);
    const cpErr = thrown as PublicationCheckpointConsistencyError;
    expect(cpErr.checkpoint.outcome).toBe("no_op");
    expect(cpErr.attemptId).toBe("attempt-cp-consistency");
    // The whole aggregate rolled back — no Task committed despite the writes.
    // The attempt retains its pre-advanced state (the pre-advance was a
    // separate committed write OUTSIDE the coordinator's tx).
    expectZeroPartialState(
      "task-cp-consistency",
      "attempt-cp-consistency",
      { recalcMarkers: getDb().select().from(missionRecalculationMarkers).all().length },
      "published_pending_observation",
    );

    // FAILURE MODE: if the coordinator returned a published outcome instead of
    // throwing on a no_op checkpoint, the Task would commit WITHOUT the attempt
    // advancing — an inconsistent state (Task published but checkpoint stale).
  });
});

// ===========================================================================
// 10. Contract validation — reservation directive required when assignee set.
// ===========================================================================

describe("T3C contract — reservation directive required when requestedAssigneeId is non-null", () => {
  it("throws BEFORE any write when requestedAssigneeId is set but no reservation directive is supplied", () => {
    const prepared = prepareTask({
      prospectiveTaskId: "task-contract",
      requestedAssigneeId: "agent-contract",
    });
    if (prepared.outcome !== "prepared") throw new Error("prep failed");
    seedAttempt("attempt-contract");
    governTaskPublication({
      attemptId: "attempt-contract",
      tasks: [{ proposal: prepared.proposal, guard: prepared.guard }],
      db: getDb(),
    });

    let wrapper: FailingDbClient | undefined;
    let thrown: unknown;
    try {
      getDb().transaction((tx) => {
        wrapper = new FailingDbClient(tx as unknown as TaskPublicationDbClient, {
          failAtWriteN: null,
        });
        // Intentionally omit `reservation`.
        publishTaskWithClient(asPubClient(wrapper), {
          attemptId: "attempt-contract",
          proposal: prepared.proposal,
          guard: prepared.guard,
        });
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain("reservation directive");
    // ZERO writes — the contract check fired before any primitive.
    expect(wrapper!.writeCount).toBe(0);
  });
});
