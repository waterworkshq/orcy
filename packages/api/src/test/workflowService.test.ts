import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/index.js", () => ({
  getDb: () => mockDb,
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../repositories/workflow.js", () => ({
  areAllWorkflowGatesSatisfied: vi.fn().mockReturnValue(true),
}));

vi.mock("../services/tasks/transition-emitter.js", () => ({
  onTransition: vi.fn((fn: (opts: any) => void) => {
    transitionHook = fn;
    return () => {};
  }),
}));

vi.mock("../services/pulseService.js", () => ({
  onPulseCreated: vi.fn((fn: (pulse: any) => void) => {
    pulseHook = fn;
    return () => {};
  }),
}));

vi.mock("../services/automationEvaluator.js", () => ({
  evaluateCondition: vi.fn(),
}));

vi.mock("../services/automationContextBuilder.js", () => ({
  buildEvaluationContext: vi.fn((trigger: any) => ({
    habitat: null,
    task: null,
    mission: null,
    agent: null,
    sprint: null,
    warnings: [],
    missingFields: [],
    raw: trigger?.payload ?? {},
  })),
  buildTriggerContext: vi.fn((args: any) => args),
}));

vi.mock("../services/automationExecutor.js", () => ({
  onAutomationRunCompleted: vi.fn((fn: (opts: any) => void) => {
    automationHook = fn;
    return () => {};
  }),
}));

import { logger } from "../lib/logger.js";
import { onTransition } from "../services/tasks/transition-emitter.js";
import { onPulseCreated } from "../services/pulseService.js";
import { evaluateCondition } from "../services/automationEvaluator.js";

let transitionHook: ((opts: any) => void) | null = null;
let pulseHook: ((pulse: any) => void) | null = null;
let automationHook: ((opts: any) => void) | null = null;

const mockDb = {
  select: vi.fn(),
  update: vi.fn(),
  insert: vi.fn(),
};

function resetMockDb() {
  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue([]),
          get: vi.fn().mockReturnValue(null),
        }),
      }),
      where: vi.fn().mockReturnValue({
        all: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue(null),
      }),
    }),
  });
  mockDb.update.mockReturnValue({
    set: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        run: vi.fn(),
      }),
    }),
  });
  mockDb.insert.mockReturnValue({
    values: vi.fn().mockReturnValue({
      run: vi.fn(),
    }),
  });
}

/** Mocks the `mockDb.select` chain for a gate-evaluation test: the gate-list
 *  query (`.from().innerJoin().where().all()`) returns `gates`, and the
 *  gate-satisfaction read (`.from().where().get()`) returns a not-yet-satisfied
 *  gate so `satisfyGateIfUnsatisfied` proceeds to the UPDATE. The `get` path is
 *  unused when `gates` is empty (early-filter tests never reach a satisfaction
 *  write). */
function mockGateQuery(gates: unknown[]) {
  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue(gates),
        }),
      }),
      where: vi.fn().mockReturnValue({
        get: vi.fn().mockReturnValue({ satisfied: false }),
      }),
    }),
  });
}

describe("workflowService gate evaluation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transitionHook = null;
    pulseHook = null;
    resetMockDb();
    // Import fresh to reset initialized flag
    vi.resetModules();
  });

  it("subscribes to onTransition on init", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it("does not double-subscribe on repeated init calls", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    initWorkflowService();
    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it("fires on_complete gates when completed action received", async () => {
    const gates = [
      { id: "gate-1", satisfied: false },
      { id: "gate-2", satisfied: false },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" });

    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("fires on_approve gates when approved action received", async () => {
    const gates = [{ id: "gate-3", satisfied: false }];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({ taskId: "task-up", action: "approved", habitatId: "h1" });

    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("skips non-relevant actions (submitted, started, etc.)", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Note: 'failed', 'rejected', and 'released' ARE relevant — they trigger on_fail
    // gate evaluation since F2 landed. Only mid-lifecycle actions are non-relevant.
    for (const action of ["started", "submitted", "claimed", "created", "updated", "delegated"]) {
      transitionHook!({ taskId: "task-x", action, habitatId: "h1" });
    }

    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("is idempotent — already-satisfied gates are not re-updated", async () => {
    const gates = [
      { id: "gate-1", satisfied: true },
      { id: "gate-2", satisfied: false },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" });

    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("swallows errors from individual gate updates (error isolation)", async () => {
    const gates = [
      { id: "gate-1", satisfied: false },
      { id: "gate-2", satisfied: false },
    ];
    mockGateQuery(gates);
    let callCount = 0;
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          run: vi.fn(() => {
            callCount++;
            if (callCount === 1) throw new Error("DB write failed");
          }),
        }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(() =>
      transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" }),
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to satisfy workflow gate",
    );
  });

  it("does nothing when no gates exist for the task (early filter)", async () => {
    mockGateQuery([]);

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({ taskId: "task-lone", action: "completed", habitatId: "h1" });

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("catches errors from the subscriber itself (top-level isolation)", async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error("DB connection lost");
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(() =>
      transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" }),
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Workflow service subscriber error",
    );
  });
});

describe("workflowService on_signal gate evaluation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transitionHook = null;
    pulseHook = null;
    resetMockDb();
    vi.resetModules();
  });

  it("subscribes to onPulseCreated on init", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(onPulseCreated).toHaveBeenCalledTimes(1);
  });

  it("fires on_signal gate when signalType matches", async () => {
    const gates = [
      {
        id: "gate-s1",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    pulseHook!({
      id: "pulse-1",
      signalType: "blocker",
      subject: "Something blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });

    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("does not fire when signalType does not match", async () => {
    const gates = [
      {
        id: "gate-s2",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    pulseHook!({
      id: "pulse-2",
      signalType: "finding",
      subject: "A finding",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });

    expect(updateRun).not.toHaveBeenCalled();
  });

  it("respects experience filter from matchConfig", async () => {
    const gates = [
      {
        id: "gate-s3",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "experience", experience: "stuck", matchScope: "task" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Non-matching experience does not fire
    pulseHook!({
      id: "pulse-3a",
      signalType: "experience",
      subject: "Feeling smooth",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: { experience: "smooth" },
    });
    expect(updateRun).not.toHaveBeenCalled();

    // Matching experience fires
    pulseHook!({
      id: "pulse-3b",
      signalType: "experience",
      subject: "Feeling stuck",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: { experience: "stuck" },
    });
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("subjectContains is case-insensitive substring match", async () => {
    const gates = [
      {
        id: "gate-s4",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: {
          signalType: "warning",
          subjectContains: "DEPLOY FAILED",
          matchScope: "task",
        },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Case-insensitive match
    pulseHook!({
      id: "pulse-4a",
      signalType: "warning",
      subject: "The deploy failed at step 3",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).toHaveBeenCalledTimes(1);

    // Non-matching subject does not fire
    pulseHook!({
      id: "pulse-4b",
      signalType: "warning",
      subject: "All good here",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("matchScope 'task' requires pulse on the upstream task", async () => {
    const gates = [
      {
        id: "gate-s5",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Pulse on a different task does not fire
    pulseHook!({
      id: "pulse-5a",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-other",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).not.toHaveBeenCalled();

    // Pulse on the upstream task fires
    pulseHook!({
      id: "pulse-5b",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("matchScope 'mission' accepts any pulse in the same mission", async () => {
    const gates = [
      {
        id: "gate-s6",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "mission" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Pulse on a different task but same mission fires
    pulseHook!({
      id: "pulse-6",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-other",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("matchScope 'either' accepts pulse on upstream task or same mission", async () => {
    const gates = [
      {
        id: "gate-s7",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "either" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Pulse on upstream task fires
    pulseHook!({
      id: "pulse-7a",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).toHaveBeenCalledTimes(1);

    // Pulse on same mission but null taskId also fires
    pulseHook!({
      id: "pulse-7b",
      signalType: "blocker",
      subject: "Mission-level blocker",
      taskId: null,
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).toHaveBeenCalledTimes(2);

    // Pulse on different mission does not fire
    pulseHook!({
      id: "pulse-7c",
      signalType: "blocker",
      subject: "Other mission",
      taskId: null,
      missionId: "m-other",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).toHaveBeenCalledTimes(2);
  });

  it("matchScope defaults to 'task' when omitted", async () => {
    const gates = [
      {
        id: "gate-s8",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Pulse on different task does not fire (default scope is "task")
    pulseHook!({
      id: "pulse-8",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-other",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("is idempotent — already-satisfied gates are not re-updated", async () => {
    const gates = [
      {
        id: "gate-s9",
        satisfied: true,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    pulseHook!({
      id: "pulse-9",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });

    expect(updateRun).not.toHaveBeenCalled();
  });

  it("skips gates with null matchConfig", async () => {
    const gates = [
      {
        id: "gate-s10",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: null,
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    pulseHook!({
      id: "pulse-10",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });

    expect(updateRun).not.toHaveBeenCalled();
  });

  it("does nothing when no on_signal gates exist (early filter)", async () => {
    mockGateQuery([]);

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    pulseHook!({
      id: "pulse-11",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("swallows errors from individual gate evaluations (per-gate isolation)", async () => {
    const gates = [
      {
        id: "gate-s12a",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      },
      {
        id: "gate-s12b",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "task" },
      },
    ];
    mockGateQuery(gates);
    let callCount = 0;
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          run: vi.fn(() => {
            callCount++;
            if (callCount === 1) throw new Error("DB write failed");
          }),
        }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(() =>
      pulseHook!({
        id: "pulse-12",
        signalType: "blocker",
        subject: "Blocked",
        taskId: "task-up",
        missionId: "m1",
        habitatId: "h1",
        metadata: {},
      }),
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to evaluate on_signal gate",
    );
  });

  it("catches errors from the pulse subscriber itself (top-level isolation)", async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error("DB connection lost");
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(() =>
      pulseHook!({
        id: "pulse-13",
        signalType: "blocker",
        subject: "Blocked",
        taskId: "task-up",
        missionId: "m1",
        habitatId: "h1",
        metadata: {},
      }),
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Workflow service pulse subscriber error",
    );
  });
});

describe("workflowService conditional predicate evaluation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transitionHook = null;
    pulseHook = null;
    resetMockDb();
    vi.resetModules();
  });

  it("fires on_complete gate with { type: 'always' } condition", async () => {
    vi.mocked(evaluateCondition).mockReturnValue({
      matched: true,
      conditionType: "always",
      reason: "Always matches",
    });
    const gates = [
      {
        id: "gate-c1",
        satisfied: false,
        condition: { type: "always" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" });

    expect(evaluateCondition).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("does not fire on_complete gate when condition evaluates to false", async () => {
    vi.mocked(evaluateCondition).mockReturnValue({
      matched: false,
      conditionType: "status_in",
      reason: "Status not in list",
    });
    const gates = [
      {
        id: "gate-c2",
        satisfied: false,
        condition: { type: "status_in", statuses: ["blocked"] },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" });

    expect(evaluateCondition).toHaveBeenCalledTimes(1);
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("fires gate when condition is null (no condition evaluation)", async () => {
    const gates = [
      {
        id: "gate-c3",
        satisfied: false,
        condition: null,
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" });

    expect(evaluateCondition).not.toHaveBeenCalled();
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("does not fire on_signal gate when signal matches but condition is false", async () => {
    vi.mocked(evaluateCondition).mockReturnValue({
      matched: false,
      conditionType: "field",
      reason: "Field mismatch",
    });
    const gates = [
      {
        id: "gate-c4",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "task" },
        condition: { type: "field", field: "task.priority", operator: "equals", value: "critical" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    pulseHook!({
      id: "pulse-c4",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });

    expect(evaluateCondition).toHaveBeenCalledTimes(1);
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("fires on_signal gate when both signal match and condition are true", async () => {
    vi.mocked(evaluateCondition).mockReturnValue({
      matched: true,
      conditionType: "status_in",
      reason: "Status matches",
    });
    const gates = [
      {
        id: "gate-c5",
        satisfied: false,
        upstreamTaskId: "task-up",
        missionId: "m1",
        matchConfig: { signalType: "blocker", matchScope: "task" },
        condition: { type: "status_in", statuses: ["in_progress"] },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    pulseHook!({
      id: "pulse-c5",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });

    expect(evaluateCondition).toHaveBeenCalledTimes(1);
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("supports nested AND/OR/NOT conditions to depth 5", async () => {
    vi.mocked(evaluateCondition).mockReturnValue({
      matched: true,
      conditionType: "and",
      reason: "All children matched",
    });
    // Depth-5 nested condition: NOT(AND(OR(NOT(AND(always)))))
    const deepCondition = {
      type: "not",
      child: {
        type: "and",
        children: [
          {
            type: "or",
            children: [
              {
                type: "not",
                child: {
                  type: "and",
                  children: [{ type: "always" }],
                },
              },
            ],
          },
        ],
      },
    };
    const gates = [
      {
        id: "gate-c6",
        satisfied: false,
        condition: deepCondition,
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" });

    expect(evaluateCondition).toHaveBeenCalledWith(deepCondition, expect.any(Object));
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("catches predicate evaluation errors without crashing subscriber", async () => {
    vi.mocked(evaluateCondition).mockImplementation(() => {
      throw new Error("Condition nesting depth exceeds maximum of 5: 6");
    });
    const gates = [
      {
        id: "gate-c7",
        satisfied: false,
        condition: { type: "always" },
      },
      {
        id: "gate-c8",
        satisfied: false,
        condition: { type: "always" },
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(() =>
      transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" }),
    ).not.toThrow();

    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Failed to satisfy workflow gate",
    );
  });

  it("passes task event payload into the condition context", async () => {
    vi.mocked(evaluateCondition).mockReturnValue({
      matched: true,
      conditionType: "always",
      reason: "test",
    });
    const gates = [
      {
        id: "gate-c9",
        satisfied: false,
        condition: { type: "always" },
      },
    ];
    mockGateQuery(gates);
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: vi.fn() }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({
      taskId: "task-up",
      action: "completed",
      habitatId: "h1",
      actorType: "agent",
      actorId: "agent-1",
      oldStatus: "submitted",
      newStatus: "done",
      metadata: { reason: "work finished" },
    });

    expect(evaluateCondition).toHaveBeenCalledWith(
      { type: "always" },
      expect.objectContaining({
        raw: expect.objectContaining({
          action: "completed",
          actorType: "agent",
          actorId: "agent-1",
          oldStatus: "submitted",
          newStatus: "done",
          metadata: { reason: "work finished" },
        }),
      }),
    );
  });
});

describe("workflowService on_automation gate evaluation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transitionHook = null;
    pulseHook = null;
    automationHook = null;
    resetMockDb();
    vi.resetModules();
  });

  it("satisfies on_automation gate when ruleId matches", async () => {
    const gates = [
      {
        id: "gate-a1",
        satisfied: false,
        upstreamTaskId: "task-up",
        downstreamTaskId: "task-down",
        workflowId: "wf-1",
        missionId: "m1",
        matchConfig: { ruleId: "rule-1", matchScope: "either" },
        condition: null,
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    automationHook!({
      run: { id: "run-1", targetType: "task", targetId: "task-up" },
      rule: { id: "rule-1" },
      outcome: "succeeded",
      habitatId: "h1",
    });

    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("does not satisfy gate when ruleId does not match", async () => {
    const gates = [
      {
        id: "gate-a2",
        satisfied: false,
        upstreamTaskId: "task-up",
        downstreamTaskId: "task-down",
        workflowId: "wf-1",
        missionId: "m1",
        matchConfig: { ruleId: "rule-1", matchScope: "either" },
        condition: null,
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    automationHook!({
      run: { id: "run-2", targetType: "task", targetId: "task-up" },
      rule: { id: "rule-different" },
      outcome: "succeeded",
      habitatId: "h1",
    });

    expect(updateRun).not.toHaveBeenCalled();
  });

  it("respects outcome filter in match config", async () => {
    const gates = [
      {
        id: "gate-a3",
        satisfied: false,
        upstreamTaskId: "task-up",
        downstreamTaskId: "task-down",
        workflowId: "wf-1",
        missionId: "m1",
        matchConfig: { ruleId: "rule-1", outcome: "failed", matchScope: "either" },
        condition: null,
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Succeeded outcome should NOT match a gate configured for "failed"
    automationHook!({
      run: { id: "run-3", targetType: "task", targetId: "task-up" },
      rule: { id: "rule-1" },
      outcome: "succeeded",
      habitatId: "h1",
    });
    expect(updateRun).not.toHaveBeenCalled();
  });

  it("does nothing when no on_automation gates exist", async () => {
    mockGateQuery([]);

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    automationHook!({
      run: { id: "run-4", targetType: "task", targetId: "task-up" },
      rule: { id: "rule-1" },
      outcome: "succeeded",
      habitatId: "h1",
    });

    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("matchScope 'task' requires the run target to be the gate's upstream task", async () => {
    const gates = [
      {
        id: "gate-a-scope-task",
        satisfied: false,
        upstreamTaskId: "task-up",
        downstreamTaskId: "task-down",
        workflowId: "wf-1",
        missionId: "m1",
        matchConfig: { ruleId: "rule-1", matchScope: "task" },
        condition: null,
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Positive: run target is the gate's upstream task → satisfies
    automationHook!({
      run: { id: "run-pos", targetType: "task", targetId: "task-up" },
      rule: { id: "rule-1" },
      outcome: "succeeded",
      habitatId: "h1",
    });
    expect(updateRun).toHaveBeenCalledTimes(1);

    // Negative: run target is a different task → does not satisfy
    automationHook!({
      run: { id: "run-neg", targetType: "task", targetId: "task-other" },
      rule: { id: "rule-1" },
      outcome: "succeeded",
      habitatId: "h1",
    });
    expect(updateRun).toHaveBeenCalledTimes(1);
  });

  it("matchScope 'mission' requires the run target to be the gate's mission", async () => {
    const gates = [
      {
        id: "gate-a-scope-mission",
        satisfied: false,
        upstreamTaskId: "task-up",
        downstreamTaskId: "task-down",
        workflowId: "wf-1",
        missionId: "m1",
        matchConfig: { ruleId: "rule-1", matchScope: "mission" },
        condition: null,
      },
    ];
    mockGateQuery(gates);
    const updateRun = vi.fn();
    mockDb.update.mockReturnValue({
      set: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({ run: updateRun }),
      }),
    });

    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    // Positive: run target is the gate's mission → satisfies
    automationHook!({
      run: { id: "run-pos", targetType: "mission", targetId: "m1" },
      rule: { id: "rule-1" },
      outcome: "succeeded",
      habitatId: "h1",
    });
    expect(updateRun).toHaveBeenCalledTimes(1);

    // Negative: run target is a task (not the mission) → does not satisfy
    automationHook!({
      run: { id: "run-neg", targetType: "task", targetId: "task-up" },
      rule: { id: "rule-1" },
      outcome: "succeeded",
      habitatId: "h1",
    });
    expect(updateRun).toHaveBeenCalledTimes(1);
  });
});
