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

import { logger } from "../lib/logger.js";
import { onTransition } from "../services/tasks/transition-emitter.js";
import { onPulseCreated } from "../services/pulseService.js";

let transitionHook: ((opts: any) => void) | null = null;
let pulseHook: ((pulse: any) => void) | null = null;

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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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

    for (const action of [
      "started",
      "submitted",
      "claimed",
      "rejected",
      "released",
      "failed",
      "created",
    ]) {
      transitionHook!({ taskId: "task-x", action, habitatId: "h1" });
    }

    expect(mockDb.select).not.toHaveBeenCalled();
  });

  it("is idempotent — already-satisfied gates are not re-updated", async () => {
    const gates = [
      { id: "gate-1", satisfied: true },
      { id: "gate-2", satisfied: false },
    ];
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue([]),
          }),
        }),
      }),
    });

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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue([]),
          }),
        }),
      }),
    });

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
    mockDb.select.mockReturnValue({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            all: vi.fn().mockReturnValue(gates),
          }),
        }),
      }),
    });
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
