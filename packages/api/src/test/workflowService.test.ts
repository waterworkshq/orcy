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

vi.mock("../services/workflow/workflowGateAdvancer.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/workflow/workflowGateAdvancer.js")>();
  return {
    ...actual,
    advanceGates: vi.fn(),
  };
});

import { logger } from "../lib/logger.js";
import { onTransition } from "../services/tasks/transition-emitter.js";
import { onPulseCreated } from "../services/pulseService.js";
import { onAutomationRunCompleted } from "../services/automationExecutor.js";
import { evaluateCondition } from "../services/automationEvaluator.js";
import { advanceGates } from "../services/workflow/workflowGateAdvancer.js";

let transitionHook: ((opts: any) => void) | null = null;
let pulseHook: ((pulse: any) => void) | null = null;
let automationHook: ((opts: any) => void) | null = null;

// Thin adapter wiring mock. The deep per-gate transaction (satisfy + audit +
// recovery handoff) is owned by `advanceGates` and covered by real-DB module
// tests in workflowAdvancer.test.ts; pure gate/signal/automation matching lives
// at the evaluator boundary in workflowGateEvaluator.test.ts. These adapter
// tests assert subscription registration, trigger translation, and the
// eventId defensive guard — NOT DB write call counts.
const mockDb = {
  select: vi.fn(),
  update: vi.fn(),
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
      where: vi.fn().mockReturnValue({ run: vi.fn() }),
    }),
  });
}

/** Mocks the gate-list query to return `gates` so the adapter reaches advanceGates. */
function mockGateList(gates: unknown[]) {
  mockDb.select.mockReturnValue({
    from: vi.fn().mockReturnValue({
      innerJoin: vi.fn().mockReturnValue({
        where: vi.fn().mockReturnValue({
          all: vi.fn().mockReturnValue(gates),
        }),
      }),
    }),
  });
}

describe("workflowService adapter wiring", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    transitionHook = null;
    pulseHook = null;
    automationHook = null;
    resetMockDb();
    vi.mocked(advanceGates).mockReturnValue([]);
    vi.resetModules();
  });

  it("subscribes to onTransition on init", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(onTransition).toHaveBeenCalledTimes(1);
  });

  it("subscribes to onPulseCreated on init", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(onPulseCreated).toHaveBeenCalledTimes(1);
  });

  it("subscribes to onAutomationRunCompleted on init", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(onAutomationRunCompleted).toHaveBeenCalledTimes(1);
  });

  it("does not double-subscribe on repeated init calls", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    initWorkflowService();
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(onPulseCreated).toHaveBeenCalledTimes(1);
    expect(onAutomationRunCompleted).toHaveBeenCalledTimes(1);
  });

  it("skips non-relevant actions (submitted, started, etc.) before any DB access", async () => {
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    // 'failed', 'rejected', and 'released' ARE relevant — they trigger on_fail
    // gate evaluation. Only mid-lifecycle actions are non-relevant.
    for (const action of ["started", "submitted", "claimed", "created", "updated", "delegated"]) {
      transitionHook!({ taskId: "task-x", action, habitatId: "h1" });
    }
    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("does nothing when no gates exist for the task (early filter)", async () => {
    mockGateList([]);
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    transitionHook!({
      taskId: "task-lone",
      action: "completed",
      habitatId: "h1",
      eventId: "evt-1",
    });
    expect(mockDb.update).not.toHaveBeenCalled();
  });

  it("guards the lifecycle trigger on a missing forwarded eventId (defensive, no synthetic fallback)", async () => {
    // A gate exists so the adapter reaches the eventId guard (past the empty-gates filter).
    mockGateList([{ id: "gate-1", satisfied: false }]);
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    // No eventId forwarded → the adapter must NOT call advanceGates (which needs
    // db.transaction, absent on this mock). A warn is emitted; no throw escapes.
    expect(() =>
      transitionHook!({ taskId: "task-up", action: "completed", habitatId: "h1" }),
    ).not.toThrow();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(Object),
      "Lifecycle gate trigger missing forwarded transition eventId; skipping advanceGates",
    );
  });

  it("logs correlated lifecycle advancement write errors in the adapter", async () => {
    mockGateList([{ id: "gate-lifecycle-write", satisfied: false }]);
    vi.mocked(advanceGates).mockReturnValue([
      {
        gateId: "gate-lifecycle-write",
        status: "write_error",
        triggerKind: "lifecycle",
        triggerEventId: "evt-lifecycle-write",
        error: "audit unavailable",
      },
    ]);
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    transitionHook!({
      taskId: "task-up",
      action: "failed",
      habitatId: "h1",
      eventId: "evt-lifecycle-write",
    });

    expect(logger.error).toHaveBeenCalledWith(
      {
        error: "audit unavailable",
        gateId: "gate-lifecycle-write",
        triggerKind: "lifecycle",
        triggerEventId: "evt-lifecycle-write",
      },
      "Workflow gate advancement write failed",
    );
  });

  it("logs correlated pulse and automation advancement write errors in their adapters", async () => {
    vi.mocked(advanceGates).mockReturnValue([
      {
        gateId: "gate-write",
        status: "write_error",
        triggerKind: "pulse",
        triggerEventId: "pulse-write",
        error: "pulse audit unavailable",
      },
    ]);
    mockGateList([{ id: "gate-write", satisfied: false }]);
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    pulseHook!({
      id: "pulse-write",
      signalType: "blocker",
      subject: "Blocked",
      taskId: "task-up",
      missionId: "m1",
      habitatId: "h1",
      metadata: {},
    });

    expect(logger.error).toHaveBeenCalledWith(
      {
        error: "pulse audit unavailable",
        gateId: "gate-write",
        triggerKind: "pulse",
        triggerEventId: "pulse-write",
      },
      "Workflow gate advancement write failed",
    );

    vi.mocked(advanceGates).mockReturnValue([
      {
        gateId: "gate-automation-write",
        status: "write_error",
        triggerKind: "automation",
        triggerEventId: "run-write",
        error: "automation audit unavailable",
      },
    ]);
    mockGateList([{ id: "gate-automation-write", satisfied: false }]);
    automationHook!({
      run: { id: "run-write", targetType: "task", targetId: "task-up" },
      rule: { id: "rule-write" },
      outcome: "succeeded",
      habitatId: "h1",
    });

    expect(logger.error).toHaveBeenCalledWith(
      {
        error: "automation audit unavailable",
        gateId: "gate-automation-write",
        triggerKind: "automation",
        triggerEventId: "run-write",
      },
      "Workflow gate advancement write failed",
    );
  });

  it("forwards the full lifecycle transition payload into condition evaluation", async () => {
    const condition = { type: "always" };
    mockGateList([{ id: "gate-condition", satisfied: false, condition }]);
    vi.mocked(evaluateCondition).mockReturnValue({
      matched: false,
      conditionType: "always",
      reason: "test boundary",
    });
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();

    transitionHook!({
      taskId: "task-up",
      action: "failed",
      habitatId: "h1",
      actorType: "agent",
      actorId: "agent-1",
      oldStatus: "submitted",
      newStatus: "done",
      metadata: { reason: "work finished" },
      eventId: "evt-condition",
    });

    expect(evaluateCondition).toHaveBeenCalledWith(
      condition,
      expect.objectContaining({
        raw: {
          action: "failed",
          actorType: "agent",
          actorId: "agent-1",
          oldStatus: "submitted",
          newStatus: "done",
          metadata: { reason: "work finished" },
        },
      }),
    );
  });

  it("catches errors from the transition subscriber itself (top-level isolation)", async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error("DB connection lost");
    });
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(() =>
      transitionHook!({
        taskId: "task-up",
        action: "completed",
        habitatId: "h1",
        eventId: "evt-1",
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Workflow service subscriber error",
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
        id: "pulse-1",
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

  it("catches errors from the automation subscriber itself (top-level isolation)", async () => {
    mockDb.select.mockImplementation(() => {
      throw new Error("DB connection lost");
    });
    const { initWorkflowService } = await import("../services/workflowService.js");
    initWorkflowService();
    expect(() =>
      automationHook!({
        run: { id: "run-1", targetType: "task", targetId: "task-up" },
        rule: { id: "rule-1" },
        outcome: "succeeded",
        habitatId: "h1",
      }),
    ).not.toThrow();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      "Workflow service automation subscriber error",
    );
  });
});
