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

import { logger } from "../lib/logger.js";
import { onTransition } from "../services/tasks/transition-emitter.js";

let transitionHook: ((opts: any) => void) | null = null;

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
