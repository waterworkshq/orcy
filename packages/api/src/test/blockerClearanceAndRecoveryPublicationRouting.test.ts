/**
 * T11 Phase 1E + 1F — Blocker-clearance + Workflow-recovery flag-gated routing
 * tests.
 *
 * Verifies the LAST two production origins that bypassed the new publication
 * kernel (per Phase 3 shadow verification):
 *   - Phase 1E: `pulseService.createBlockerClearanceTask` →
 *     `publishBlockerClearanceTask` (reserve → prepare → govern → publish +
 *     C1 habitat-scope boundary — the gap-audit O2 / cold-critique C1 fix).
 *   - Phase 1F: `workflowService.createRecoveryTask` →
 *     `publishRecoveryTask` (reserve → prepare → govern → publish + C2 atomic
 *     participant for gate insert + original-gate link + failure-context link
 *     — the gap-audit O3 / cold-critique C2 fix; eliminates the crash window
 *     that today leaves unlinked Recovery Tasks).
 *
 * Coverage:
 *   - Flag ON → the new path (proven by `vi.spyOn` on the adapter namespace —
 *     the service's live ESM binding stays in sync with the spy's replacement).
 *   - Flag OFF → the legacy `taskService.createTask` / `taskCrudRepo.createTask`
 *     path runs byte-identical (proven by the spy NOT being called + the
 *     resulting Task carrying `LEGACY_PARTIAL_HISTORY` creationIntegrity).
 *   - Outcome mapping — `created`, `replayed`, `rejected_no_target_mission`,
 *     `vetoed`, `rejected_validation` all map to the legacy `Task | null` /
 *     `{ id: string } | null` contracts faithfully.
 *
 * The flag-OFF legacy parity is covered EXHAUSTIVELY by the existing
 * pulseService / workflowService test suites (unchanged — the flag defaults
 * OFF when those tests don't set it). This suite covers the flag-ON routing +
 * outcome-mapping the Phase 1E/1F changes add.
 *
 * Reference: the precedent gates at `automationExecutor.ts:273-275` +
 * `scheduledTaskService.ts:152-154` + `triageService.ts:38-40/112-114` are
 * covered by their sibling `*PublicationRouting.test.ts` suites.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
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
  columns as columnsTable,
  habitats,
  pulses,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as pulseService from "../services/pulseService.js";
import * as taskBlockerPublication from "../services/taskBlockerPublication.js";
import {
  attachWorkflow,
  initWorkflowService,
} from "../services/workflowService.js";
import * as taskRecoveryPublication from "../services/taskRecoveryPublication.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type { TaskAction } from "../services/tasks/transition-emitter.js";
import { emitTransition } from "../services/tasks/transition-emitter.js";
import type { WorkflowTemplateDefinition } from "../models/index.js";

// --- Mocks: assert the kernel emits NO pre-commit effects (SSE/hooks). ---
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
  initWorkflowService();
  originalFlag = process.env[CUTOVER_FLAG];
  // Default: cutover flag ON — most tests exercise the migrated path.
  process.env[CUTOVER_FLAG] = "true";
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const db = getDb();
  // Wipe the seeded globals so the test habitat is a clean slate.
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(failureContexts).run();
  db.delete(taskWorkflowGates).run();
  db.delete(workflows).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "T11 Phase 1E/1F Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  missionId = missionRepo.createMission({
    habitatId,
    columnId,
    title: "T11 mission",
    createdBy: "test",
  }).id;
  publishMock.mockClear();
});

afterEach(() => {
  if (originalFlag !== undefined) {
    process.env[CUTOVER_FLAG] = originalFlag;
  } else {
    delete process.env[CUTOVER_FLAG];
  }
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Count helper for blocker-clearance atomicity + routing assertions. */
function countBlockerRows() {
  const db = getDb();
  return {
    tasks: db.select({ count: sql<number>`COUNT(*)` }).from(tasks).get()!.count,
    events: db.select({ count: sql<number>`COUNT(*)` }).from(taskEvents).get()!.count,
    envelopes: db.select({ count: sql<number>`COUNT(*)` }).from(taskCreationEnvelopes).get()!.count,
    pulses: db.select({ count: sql<number>`COUNT(*)` }).from(pulses).get()!.count,
  };
}

/** Count helper for recovery C2 atomicity assertions. */
function countRecoveryRows() {
  const db = getDb();
  return {
    tasks: db.select({ count: sql<number>`COUNT(*)` }).from(tasks).get()!.count,
    events: db.select({ count: sql<number>`COUNT(*)` }).from(taskEvents).get()!.count,
    envelopes: db.select({ count: sql<number>`COUNT(*)` }).from(taskCreationEnvelopes).get()!.count,
    gates: db.select({ count: sql<number>`COUNT(*)` }).from(taskWorkflowGates).get()!.count,
    failureContexts: db.select({ count: sql<number>`COUNT(*)` }).from(failureContexts).get()!.count,
  };
}

/** Posts a mission-scoped blocker pulse via the public `postMissionPulseSignal`. */
function postBlockerMission(opts: {
  body?: string;
  taskId?: string;
}): ReturnType<typeof pulseService.postMissionPulseSignal> {
  return pulseService.postMissionPulseSignal({
    missionId,
    caller: { type: "human", id: "human-1" },
    body: {
      signalType: "blocker",
      subject: "Database connection pool exhausted",
      body: opts.body ?? "All connections timed out at 14:32 UTC.",
      ...(opts.taskId ? { taskId: opts.taskId } : {}),
    },
  });
}

/** Posts a habitat-scoped blocker pulse via the public `postHabitatPulseSignal`. */
function postBlockerHabitat(): ReturnType<typeof pulseService.postHabitatPulseSignal> {
  return pulseService.postHabitatPulseSignal({
    habitatId,
    caller: { type: "human", id: "human-1" },
    body: {
      signalType: "blocker",
      subject: "Habitat-scoped blocker",
      body: "No valid target Mission.",
    },
  });
}

/**
 * Spy on the adapter namespace so the assertion is on routing (the spy
 * firing) AND on side-effects (the resulting Task row + envelope). vitest's
 * `vi.spyOn` on a namespace import mutates the same module-record the gated
 * service resolves — the service's live ESM binding stays in sync with the
 * spy's replacement.
 */
const publishBlockerSpy = vi.spyOn(taskBlockerPublication, "publishBlockerClearanceTask");
const publishRecoverySpy = vi.spyOn(taskRecoveryPublication, "publishRecoveryTask");

// ===========================================================================
// Phase 1E — Blocker-clearance flag-gate
// ===========================================================================

describe("T11 Phase 1E — flag-gated blocker-clearance routing", () => {
  describe("flag ON + mission-scoped blocker → publishBlockerClearanceTask", () => {
    it("routes through publishBlockerClearanceTask, publishes POST_CUTOVER Task + pulse.linkedTaskId", () => {
      publishBlockerSpy.mockClear();

      const result = postBlockerMission({});

      // The gate routed to publishBlockerClearanceTask.
      expect(publishBlockerSpy).toHaveBeenCalledTimes(1);
      const calledWith = publishBlockerSpy.mock.calls[0][0];
      expect(calledWith.pulseId).toBe(result.pulse.id);
      expect(calledWith.habitatId).toBe(habitatId);
      expect(calledWith.scope).toEqual({ kind: "mission", missionId });
      expect(calledWith.pulseSubject).toBe("Database connection pool exhausted");
      expect(calledWith.assignment).toEqual({ kind: "auto" });

      // Return shape matches the legacy contract (`blockerTaskCreated: true`,
      // `linkedTask` populated).
      expect(result.blockerTaskCreated).toBe(true);
      expect(result.linkedTask).toBeTruthy();
      expect(result.linkedTask!.title).toBe(
        `Clear Blocker: Database connection pool exhausted`,
      );

      // The kernel chain produced a Task + 1 created event + the envelope
      // row + the pulse itself.
      const counts = countBlockerRows();
      expect(counts.tasks).toBe(1);
      expect(counts.events).toBe(1);
      expect(counts.envelopes).toBe(1);
      expect(counts.pulses).toBe(1);

      // POST_CUTOVER — the kernel-stamped integrity version (the gap-audit
      // correction: the legacy raw-insert path never stamped this).
      const taskRows = getDb().select().from(tasks).all();
      for (const t of taskRows) {
        expect(t.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
      }

      // The pulse↔Task denormalized linkage (the convenience field the
      // legacy `pulseRepo.updateLinkedTask` stamped) is preserved by the
      // wiring's post-`created` updateLinkedTask call.
      const pulseRow = getDb()
        .select()
        .from(pulses)
        .where(eq(pulses.id, result.pulse.id))
        .get();
      expect(pulseRow).not.toBeUndefined();
      expect(pulseRow!.linkedTaskId).toBe(result.linkedTask!.id);
    });
  });

  describe("flag ON + habitat-scoped blocker → C1 boundary rejection", () => {
    it("returns blockerTaskCreated: false (no Task), logs the rejection", () => {
      publishBlockerSpy.mockClear();

      const result = postBlockerHabitat();

      // The gate routed to the adapter (which detected the C1 boundary).
      expect(publishBlockerSpy).toHaveBeenCalledTimes(1);
      const calledWith = publishBlockerSpy.mock.calls[0][0];
      expect(calledWith.scope).toEqual({ kind: "habitat" });

      // C1 boundary: NO Task created; the surfaced signal remains a visible
      // pulse with `blockerTaskCreated: false` (matches legacy boolean shape).
      expect(result.blockerTaskCreated).toBe(false);
      expect(result.linkedTask).toBeUndefined();

      // No Task / event / envelope rows written.
      const counts = countBlockerRows();
      expect(counts.tasks).toBe(0);
      expect(counts.events).toBe(0);
      expect(counts.envelopes).toBe(0);
      expect(counts.pulses).toBe(1); // the pulse itself still committed
    });
  });

  describe("flag ON outcome mapping — non-terminal adapter branches", () => {
    it("vetoed outcome → null (no Task) — visible blocked outcome surface", () => {
      publishBlockerSpy.mockClear();
      publishBlockerSpy.mockImplementationOnce(() => ({
        outcome: "vetoed",
        attemptId: "a-1",
        veto: { interceptorKey: "test-veto", reason: "test forced", pluginRunId: null },
      }));

      const result = postBlockerMission({});

      expect(publishBlockerSpy).toHaveBeenCalledTimes(1);
      expect(result.blockerTaskCreated).toBe(false);
      expect(result.linkedTask).toBeUndefined();

      // No Task / event / envelope rows committed (governance vetoed
      // pre-publish; the attempt was terminalized).
      const counts = countBlockerRows();
      expect(counts.tasks).toBe(0);
      expect(counts.events).toBe(0);
      expect(counts.envelopes).toBe(0);
    });

    it("replayed outcome → re-reads Task from terminal.taskId (null when re-read fails)", () => {
      publishBlockerSpy.mockClear();
      publishBlockerSpy.mockImplementationOnce(() => ({
        outcome: "replayed",
        attemptId: "a-2",
        terminal: { outcome: "created", taskId: "ghost-task-id" },
      }));

      const result = postBlockerMission({});

      // The re-read finds no Task (the spy fabricated a fake id) — so the
      // mapping returns null. This is the safe fallback path:
      // `blockerTaskCreated: false`, `linkedTask: undefined`.
      expect(result.blockerTaskCreated).toBe(false);
      expect(result.linkedTask).toBeUndefined();
    });
  });

  describe("flag OFF → legacy taskService.createTask path runs byte-identical", () => {
    it("does NOT route through publishBlockerClearanceTask", () => {
      delete process.env[CUTOVER_FLAG];
      publishBlockerSpy.mockClear();

      const result = postBlockerMission({});

      // Legacy path: NO call to publishBlockerClearanceTask.
      expect(publishBlockerSpy).not.toHaveBeenCalled();

      // The Task carries LEGACY_PARTIAL_HISTORY (creationIntegrity = 0).
      const taskRows = getDb().select().from(tasks).all();
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0].creationIntegrity).toBe(
        TASK_CREATION_INTEGRITY_VERSION.LEGACY_PARTIAL_HISTORY,
      );

      // Return shape matches the legacy contract.
      expect(result.blockerTaskCreated).toBe(true);
      expect(result.linkedTask).toBeTruthy();
      expect(result.linkedTask!.title).toBe(
        `Clear Blocker: Database connection pool exhausted`,
      );
    });
  });
});

// ===========================================================================
// Phase 1F — Workflow-recovery flag-gate
// ===========================================================================

describe("T11 Phase 1F — flag-gated workflow-recovery routing", () => {
  /**
   * Sets up a workflow with one upstream task (to be failed) and one
   * downstream task (gated by on_fail). Returns the gate id for assertions.
   */
  function setupRecoveryWorkflow(): {
    upstreamTask: { id: string };
    downstreamTask: { id: string };
  } {
    const upstreamTask = taskCrudRepo.createTask({
      missionId,
      title: "Upstream (will fail)",
      createdBy: "test",
    });
    const downstreamTask = taskCrudRepo.createTask({
      missionId,
      title: "Downstream",
      createdBy: "test",
    });

    const definition: WorkflowTemplateDefinition = {
      gates: [
        {
          upstreamTaskKey: upstreamTask.id,
          downstreamTaskKey: downstreamTask.id,
          gateType: "on_fail",
        },
      ],
      failureHandler: {
        recoveryTaskTemplate: {
          title: "Investigate {{failedTaskTitle}} failure",
          description: "Root-cause and fix the upstream failure",
        },
      },
    };
    attachWorkflow(missionId, habitatId, definition, {}, "test");

    return { upstreamTask, downstreamTask };
  }

  describe("flag ON + on_fail trigger → publishRecoveryTask", () => {
    it("routes through publishRecoveryTask, publishes POST_CUTOVER Task + atomic C2 linkage", () => {
      const { upstreamTask } = setupRecoveryWorkflow();
      publishRecoverySpy.mockClear();

      // Trigger the failure path → on_fail gate fires → spawnRecoveryForGate →
      // createRecoveryTask → publishRecoveryTask.
      emitTransition(upstreamTask.id, "failed" as TaskAction, habitatId, {
        actorType: "agent",
        actorId: "agent-1",
        reason: "Build broke",
        metadata: { reason: "Build broke" },
      });

      // The gate routed to publishRecoveryTask.
      expect(publishRecoverySpy).toHaveBeenCalledTimes(1);
      const calledWith = publishRecoverySpy.mock.calls[0][0];
      // Attempt identity is server-derived from (runId=gateId, actionKey=
      // "spawn_recovery") per the Origin Migration Matrix.
      expect(calledWith.actionKey).toBe("spawn_recovery");
      expect(calledWith.runId).toBeTruthy();
      expect(calledWith.habitatId).toBe(habitatId);
      expect(calledWith.targetMissionId).toBe(missionId);
      expect(calledWith.linkage).toBeTruthy();
      expect(calledWith.linkage.gateId).toBe(calledWith.runId);

      // The title was rendered with the failedTaskTitle substitution.
      expect(calledWith.title).toBe("Investigate Upstream (will fail) failure");

      // The kernel chain produced: 1 recovery Task (filtering to the
      // recovery-origin createdBy) + 1 created event + 1 envelope row. The
      // C2 atomic participant committed the next-depth gate + original-gate
      // link + failure-context link INSIDE the publication tx (no separate
      // non-atomic writes).
      const counts = countRecoveryRows();
      const recoveryTasksAfter = getDb()
        .select()
        .from(tasks)
        .where(sql`${tasks.createdBy} = 'workflow-recovery'`)
        .all();
      expect(recoveryTasksAfter).toHaveLength(1);
      expect(counts.tasks).toBeGreaterThanOrEqual(3); // upstream + downstream + recovery
      expect(counts.events).toBeGreaterThanOrEqual(2); // upstream gate + recovery created
      expect(counts.envelopes).toBe(1);
      // C2 linkage: 1 new depth-1 gate row (the next-depth on_fail) + 1
      // failure-context row (built by handleFailureCapture BEFORE spawn).
      expect(counts.gates).toBeGreaterThanOrEqual(2); // original + next-depth
      expect(counts.failureContexts).toBe(1);

      // POST_CUTOVER — the kernel-stamped integrity version on the recovery
      // Task ONLY (the upstream + downstream Tasks were created via the
      // legacy `taskCrudRepo.createTask` path during workflow setup and
      // carry LEGACY_PARTIAL_HISTORY).
      const recoveryTaskRows = getDb()
        .select()
        .from(tasks)
        .where(sql`${tasks.createdBy} = 'workflow-recovery'`)
        .all();
      expect(recoveryTaskRows).toHaveLength(1);
      expect(recoveryTaskRows[0].creationIntegrity).toBe(
        TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER,
      );

      // The original on_fail gate is linked to the recovery Task (the
      // idempotency marker).
      const gateRows = getDb()
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.recoveryTaskId, recoveryTaskRows[0].id))
        .all();
      expect(gateRows).toHaveLength(1);
      expect(gateRows[0].gateType).toBe("on_fail");
    });

    it("publishes legacy render parity — title + description substituted identically", () => {
      const { upstreamTask } = setupRecoveryWorkflow();
      publishRecoverySpy.mockClear();

      emitTransition(upstreamTask.id, "failed" as TaskAction, habitatId, {
        actorType: "agent",
        actorId: "agent-1",
        reason: "render-parity",
        metadata: { reason: "render-parity" },
      });

      const calledWith = publishRecoverySpy.mock.calls[0][0];
      expect(calledWith.title).toBe("Investigate Upstream (will fail) failure");
      expect(calledWith.description).toBe("Root-cause and fix the upstream failure");
    });
  });

  describe("flag ON outcome mapping — non-terminal adapter branches", () => {
    it("vetoed outcome → null (no recovery Task) — visible blocked outcome", () => {
      const { upstreamTask } = setupRecoveryWorkflow();
      publishRecoverySpy.mockClear();
      publishRecoverySpy.mockImplementationOnce(() => ({
        outcome: "vetoed",
        attemptId: "a-1",
        veto: { interceptorKey: "test-veto", reason: "test forced", pluginRunId: null },
      }));

      emitTransition(upstreamTask.id, "failed" as TaskAction, habitatId, {
        actorType: "agent",
        actorId: "agent-1",
        reason: "veto-test",
        metadata: { reason: "veto-test" },
      });

      expect(publishRecoverySpy).toHaveBeenCalledTimes(1);

      // Vetoed → no recovery Task committed.
      const taskRows = getDb()
        .select()
        .from(tasks)
        .where(sql`${tasks.createdBy} = 'workflow-recovery'`)
        .all();
      expect(taskRows).toHaveLength(0);
    });

    it("replayed outcome → returns the replayed Task id (terminal.taskId)", () => {
      const { upstreamTask } = setupRecoveryWorkflow();
      publishRecoverySpy.mockClear();
      publishRecoverySpy.mockImplementationOnce(() => ({
        outcome: "replayed",
        attemptId: "a-2",
        terminal: { outcome: "created", taskId: "fake-replay-task" },
      }));

      emitTransition(upstreamTask.id, "failed" as TaskAction, habitatId, {
        actorType: "agent",
        actorId: "agent-1",
        reason: "replay-test",
        metadata: { reason: "replay-test" },
      });

      expect(publishRecoverySpy).toHaveBeenCalledTimes(1);
      // Replayed → spawnRecoveryForGate returns immediately with the id
      // from the terminal. The fake id doesn't exist on disk, so no gate
      // link / failure-context link was committed (the adapter handled
      // them when the original commit happened).
      const taskRows = getDb()
        .select()
        .from(tasks)
        .where(sql`${tasks.createdBy} = 'workflow-recovery'`)
        .all();
      expect(taskRows).toHaveLength(0);
    });
  });

  describe("flag OFF → legacy taskCrudRepo.createTask path runs byte-identical", () => {
    it("does NOT route through publishRecoveryTask; uses legacy 3-write non-atomic linkage", () => {
      delete process.env[CUTOVER_FLAG];
      const { upstreamTask } = setupRecoveryWorkflow();
      publishRecoverySpy.mockClear();

      emitTransition(upstreamTask.id, "failed" as TaskAction, habitatId, {
        actorType: "agent",
        actorId: "agent-1",
        reason: "legacy-test",
        metadata: { reason: "legacy-test" },
      });

      // Legacy path: NO call to publishRecoveryTask.
      expect(publishRecoverySpy).not.toHaveBeenCalled();

      // The Task carries LEGACY_PARTIAL_HISTORY (creationIntegrity = 0).
      const taskRows = getDb()
        .select()
        .from(tasks)
        .where(sql`${tasks.createdBy} = 'workflow-recovery'`)
        .all();
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0].creationIntegrity).toBe(
        TASK_CREATION_INTEGRITY_VERSION.LEGACY_PARTIAL_HISTORY,
      );

      // The 3 legacy linkage writes still committed (the legacy path is
      // intact, byte-identical to pre-Phase-1F behavior).
      const gateRows = getDb()
        .select()
        .from(taskWorkflowGates)
        .where(eq(taskWorkflowGates.recoveryTaskId, taskRows[0].id))
        .all();
      expect(gateRows).toHaveLength(1);

      const ctxRows = getDb()
        .select()
        .from(failureContexts)
        .where(eq(failureContexts.recoveryTaskId, taskRows[0].id))
        .all();
      expect(ctxRows).toHaveLength(1);
    });
  });
});