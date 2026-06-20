import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../lib/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../repositories/task.js", () => ({
  getTaskById: vi.fn(),
  getTasksByDependency: vi.fn().mockReturnValue([]),
  areAllDependenciesMet: vi.fn(),
  getHabitatIdForTask: vi.fn(),
}));

vi.mock("../repositories/agent.js", () => ({
  getAgentById: vi.fn(),
}));

vi.mock("../repositories/event.js", () => ({
  createEvent: vi.fn(),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: {
    publish: vi.fn(),
  },
}));

vi.mock("../services/watcherService.js", () => ({
  notifyWatchers: vi.fn(),
}));

vi.mock("../services/retryService.js", () => ({
  shouldRetry: vi.fn().mockReturnValue(false),
  scheduleRetry: vi.fn(),
  escalateToHuman: vi.fn(),
  getEffectivePolicy: vi.fn().mockReturnValue(null),
}));

vi.mock("../plugins/pluginManager.js", () => ({
  emitTaskCreated: vi.fn().mockResolvedValue(undefined),
  emitTaskClaimed: vi.fn().mockResolvedValue(undefined),
  emitTaskSubmitted: vi.fn().mockResolvedValue(undefined),
  emitTaskApproved: vi.fn().mockResolvedValue(undefined),
  emitTaskRejected: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/featureService.js", () => ({
  recalculateMissionStatus: vi.fn(),
}));

vi.mock("../services/pulseService.js", () => ({
  emitAutoSignal: vi.fn(),
}));

import { logger } from "../lib/logger.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as eventRepo from "../repositories/event.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as watcherService from "../services/watcherService.js";
import * as retryService from "../services/retryService.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as missionService from "../services/featureService.js";
import * as pulseService from "../services/pulseService.js";
import {
  emitTransition,
  setRecalcDebounceEnabled,
  isRecalcDebounceEnabled,
  onTaskEvent,
  onTransition,
  type TaskAction,
  type TransitionContext,
} from "../services/tasks/transition-emitter.js";
import type { Task } from "../models/index.js";

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Sample task",
    description: null,
    status: "pending",
    priority: "medium",
    order: 0,
    columnId: "col-1",
    missionId: "mission-1",
    assignedAgentId: null,
    delegatedToAgentId: null,
    estimatedMinutes: null,
    actualMinutes: 0,
    result: null,
    labels: [],
    requiredDomain: null,
    requiredCapabilities: [],
    rejectionReason: null,
    retryCount: 0,
    nextRetryAt: null,
    isArchived: false,
    version: 1,
    createdBy: "user-1",
    createdAt: "2026-06-10T00:00:00Z",
    updatedAt: "2026-06-10T00:00:00Z",
    claimedAt: null,
    completedAt: null,
    ...overrides,
  } as Task;
}

const baseCtx = (overrides: Partial<TransitionContext> = {}): TransitionContext => ({
  actorType: "agent",
  actorId: "agent-1",
  ...overrides,
});

describe("TransitionEmitter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRecalcDebounceEnabled(false);
    (taskRepo.getTaskById as ReturnType<typeof vi.fn>).mockReturnValue(makeTask());
    (taskRepo.getHabitatIdForTask as ReturnType<typeof vi.fn>).mockReturnValue("hab-1");
    (taskRepo.getTasksByDependency as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  afterEach(() => {
    setRecalcDebounceEnabled(false);
  });

  describe("debounce flag", () => {
    it("defaults to disabled", () => {
      setRecalcDebounceEnabled(false);
      expect(isRecalcDebounceEnabled()).toBe(false);
    });

    it("can be toggled", () => {
      setRecalcDebounceEnabled(true);
      expect(isRecalcDebounceEnabled()).toBe(true);
      setRecalcDebounceEnabled(false);
      expect(isRecalcDebounceEnabled()).toBe(false);
    });

    it("coalesces rapid transitions to one recalc per mission when enabled", () => {
      setRecalcDebounceEnabled(true);
      const task = makeTask();
      const recalcSpy = missionService.recalculateMissionStatus as ReturnType<typeof vi.fn>;

      emitTransition("task-1", "completed", "hab-1", { ...baseCtx(), task, newStatus: "done" });
      emitTransition("task-2", "completed", "hab-1", {
        ...baseCtx(),
        task: { ...task, id: "task-2" },
        newStatus: "done",
      });
      emitTransition("task-3", "completed", "hab-1", {
        ...baseCtx(),
        task: { ...task, id: "task-3" },
        newStatus: "done",
      });

      expect(recalcSpy).not.toHaveBeenCalled();
    });

    it("runs recalc immediately per transition when debounce disabled", () => {
      setRecalcDebounceEnabled(false);
      const recalcSpy = missionService.recalculateMissionStatus as ReturnType<typeof vi.fn>;

      emitTransition("task-1", "completed", "hab-1", baseCtx({ newStatus: "done" }));
      emitTransition("task-2", "completed", "hab-1", baseCtx({ newStatus: "done" }));

      expect(recalcSpy).toHaveBeenCalledTimes(2);
    });
  });

  describe("per-action event emission", () => {
    it("emits a 'claimed' event for claimed action", () => {
      const task = makeTask({ status: "claimed" });
      emitTransition("task-1", "claimed", "hab-1", baseCtx({ task, newStatus: "claimed" }));
      expect(eventRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "claimed", toStatus: "claimed" }),
      );
    });

    it("emits a 'completed' event for completed action", () => {
      const task = makeTask({ status: "done" });
      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));
      expect(eventRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "completed", toStatus: "done" }),
      );
    });

    it("does NOT emit a task event for 'deleted' (per inventory)", () => {
      emitTransition("task-1", "deleted", "hab-1", baseCtx());
      const createEventMock = eventRepo.createEvent as ReturnType<typeof vi.fn>;
      const deletedCalls = createEventMock.mock.calls.filter(
        (c) => (c[0] as { action?: string })?.action === "deleted",
      );
      expect(deletedCalls).toHaveLength(0);
    });

    it("emits a 'cloned' event action via mapped lookup for retry_executed", () => {
      const task = makeTask({ status: "pending" });
      emitTransition("task-1", "retry_executed", "hab-1", baseCtx({ task, newStatus: "pending" }));
      expect(eventRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "retry_executed", toStatus: "pending" }),
      );
    });
  });

  describe("per-action SSE broadcasts", () => {
    it("publishes 'task.claimed' + 'task.updated' for claimed action", () => {
      const task = makeTask({ status: "claimed" });
      emitTransition("task-1", "claimed", "hab-1", baseCtx({ task, newStatus: "claimed" }));
      const publishMock = sseBroadcaster.publish as ReturnType<typeof vi.fn>;
      const types = publishMock.mock.calls.map((c) => (c[1] as { type: string }).type);
      expect(types).toContain("task.claimed");
      expect(types).toContain("task.updated");
    });

    it("publishes 'task.completed' (only specific) without task.updated for completed action with task", () => {
      const task = makeTask({ status: "done" });
      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));
      const publishMock = sseBroadcaster.publish as ReturnType<typeof vi.fn>;
      const types = publishMock.mock.calls.map((c) => (c[1] as { type: string }).type);
      expect(types).toContain("task.completed");
      expect(types).toContain("task.updated");
    });

    it("publishes 'task.created' but NOT 'task.updated' for created action", () => {
      const task = makeTask();
      emitTransition("task-1", "created", "hab-1", baseCtx({ task }));
      const publishMock = sseBroadcaster.publish as ReturnType<typeof vi.fn>;
      const types = publishMock.mock.calls.map((c) => (c[1] as { type: string }).type);
      expect(types).toContain("task.created");
      expect(types).not.toContain("task.updated");
    });

    it("publishes 'task.deleted' but NOT 'task.updated' for deleted action", () => {
      emitTransition("task-1", "deleted", "hab-1", baseCtx());
      const publishMock = sseBroadcaster.publish as ReturnType<typeof vi.fn>;
      const types = publishMock.mock.calls.map((c) => (c[1] as { type: string }).type);
      expect(types).toContain("task.deleted");
      expect(types).not.toContain("task.updated");
    });

    it("publishes 'task.delegated' with from/to agents for delegated action", () => {
      const task = makeTask();
      emitTransition("task-1", "delegated", "hab-1", {
        ...baseCtx({ task, fromAgentId: "from-a", toAgentId: "to-b" }),
      });
      expect(sseBroadcaster.publish).toHaveBeenCalledWith("hab-1", {
        type: "task.delegated",
        data: { taskId: "task-1", fromAgentId: "from-a", toAgentId: "to-b" },
      });
    });

    it("publishes retry events with nextRetryAt and retryCount", () => {
      emitTransition("task-1", "retry_scheduled", "hab-1", {
        ...baseCtx(),
        nextRetryAt: "2026-06-11T00:00:00Z",
        retryCount: 2,
      });
      expect(sseBroadcaster.publish).toHaveBeenCalledWith("hab-1", {
        type: "task.retry_scheduled",
        data: { taskId: "task-1", nextRetryAt: "2026-06-11T00:00:00Z", retryCount: 2 },
      });
    });
  });

  describe("watcher notifications", () => {
    it("notifies watchers with the per-action event name", () => {
      emitTransition("task-1", "claimed", "hab-1", baseCtx({ newStatus: "claimed" }));
      expect(watcherService.notifyWatchers).toHaveBeenCalledWith("task-1", "hab-1", "task.claimed");
    });

    it("does not call watchers for updated action with no watchers config", () => {
      const task = makeTask();
      emitTransition("task-1", "updated", "hab-1", baseCtx({ task }));
      expect(watcherService.notifyWatchers).toHaveBeenCalledWith("task-1", "hab-1", "task.updated");
    });
  });

  describe("plugin hooks", () => {
    it("fires emitTaskClaimed when agent exists", () => {
      const task = makeTask();
      (agentRepo.getAgentById as ReturnType<typeof vi.fn>).mockReturnValue({
        id: "agent-1",
        name: "Agent One",
      });
      emitTransition("task-1", "claimed", "hab-1", baseCtx({ task, newStatus: "claimed" }));
      expect(pluginManager.emitTaskClaimed).toHaveBeenCalledWith(
        task,
        expect.objectContaining({ id: "agent-1" }),
      );
    });

    it("does NOT fire emitTaskClaimed when agent lookup fails", () => {
      const task = makeTask();
      (agentRepo.getAgentById as ReturnType<typeof vi.fn>).mockReturnValue(null);
      emitTransition("task-1", "claimed", "hab-1", baseCtx({ task, newStatus: "claimed" }));
      expect(pluginManager.emitTaskClaimed).not.toHaveBeenCalled();
    });

    it("fires emitTaskSubmitted for submitted action", () => {
      const task = makeTask();
      emitTransition("task-1", "submitted", "hab-1", baseCtx({ task, newStatus: "submitted" }));
      expect(pluginManager.emitTaskSubmitted).toHaveBeenCalledWith(task);
    });

    it("fires emitTaskApproved for approved action", () => {
      const task = makeTask();
      emitTransition("task-1", "approved", "hab-1", baseCtx({ task, newStatus: "approved" }));
      expect(pluginManager.emitTaskApproved).toHaveBeenCalledWith(task);
    });

    it("fires emitTaskRejected for rejected action with reason", () => {
      const task = makeTask();
      emitTransition(
        "task-1",
        "rejected",
        "hab-1",
        baseCtx({ task, newStatus: "rejected", reason: "bad" }),
      );
      expect(pluginManager.emitTaskRejected).toHaveBeenCalledWith(task, "bad");
    });

    it("does NOT fire any plugin hook for started (per inventory)", () => {
      const task = makeTask();
      emitTransition("task-1", "started", "hab-1", baseCtx({ task, newStatus: "in_progress" }));
      expect(pluginManager.emitTaskSubmitted).not.toHaveBeenCalled();
      expect(pluginManager.emitTaskApproved).not.toHaveBeenCalled();
    });
  });

  describe("mission recalc modes", () => {
    it("runs recalc for 'wrapped' actions", () => {
      emitTransition("task-1", "started", "hab-1", baseCtx({ newStatus: "in_progress" }));
      expect(missionService.recalculateMissionStatus).toHaveBeenCalled();
    });

    it("does NOT run recalc for 'none' mode (delegated)", () => {
      emitTransition("task-1", "delegated", "hab-1", baseCtx());
      expect(missionService.recalculateMissionStatus).not.toHaveBeenCalled();
    });

    it("runs recalc for 'conditional' only when status changed (updateTask)", () => {
      const task = makeTask({ status: "done" });
      emitTransition("task-1", "updated", "hab-1", {
        ...baseCtx({ task, oldStatus: "in_progress", newStatus: "in_progress" }),
      });
      expect(missionService.recalculateMissionStatus).not.toHaveBeenCalled();
    });

    it("runs recalc for 'conditional' when status changed", () => {
      const task = makeTask({ status: "done" });
      emitTransition("task-1", "updated", "hab-1", {
        ...baseCtx({ task, oldStatus: "in_progress", newStatus: "done" }),
      });
      expect(missionService.recalculateMissionStatus).toHaveBeenCalled();
    });

    it("logs error when wrapped recalc throws (does not propagate)", () => {
      setRecalcDebounceEnabled(false);
      (missionService.recalculateMissionStatus as ReturnType<typeof vi.fn>).mockImplementation(
        () => {
          throw new Error("recalc boom");
        },
      );
      emitTransition("task-1", "started", "hab-1", baseCtx({ newStatus: "in_progress" }));
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "Mission recalculation failed",
      );
    });
  });

  describe("pulse auto-signals", () => {
    it("emits a 'context' pulse for claimed action", () => {
      const task = makeTask();
      emitTransition("task-1", "claimed", "hab-1", baseCtx({ task, newStatus: "claimed" }));
      expect(pulseService.emitAutoSignal).toHaveBeenCalledWith(
        expect.objectContaining({ signalType: "context", taskId: task.id }),
      );
    });

    it("emits an 'offer' pulse for submitted action", () => {
      const task = makeTask();
      emitTransition("task-1", "submitted", "hab-1", baseCtx({ task, newStatus: "submitted" }));
      expect(pulseService.emitAutoSignal).toHaveBeenCalledWith(
        expect.objectContaining({ signalType: "offer" }),
      );
    });

    it("emits a 'warning' pulse for failed action", () => {
      const task = makeTask();
      emitTransition(
        "task-1",
        "failed",
        "hab-1",
        baseCtx({ task, newStatus: "failed", reason: "oops" }),
      );
      expect(pulseService.emitAutoSignal).toHaveBeenCalledWith(
        expect.objectContaining({ signalType: "warning" }),
      );
    });

    it("emits blocker-clearance extra pulse for completed with blocker-clearance label", () => {
      const task = makeTask({
        status: "done",
        labels: ["blocker-clearance"],
        title: "Clear Blocker: foo",
      });
      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));
      expect(pulseService.emitAutoSignal).toHaveBeenCalledWith(
        expect.objectContaining({ subject: expect.stringContaining("Blocker cleared:") }),
      );
    });

    it("does NOT emit blocker-clearance pulse for completed without that label", () => {
      const task = makeTask({ status: "done" });
      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));
      const calls = (pulseService.emitAutoSignal as ReturnType<typeof vi.fn>).mock.calls;
      const subjects = calls.map((c) => (c[0] as { subject: string }).subject);
      expect(subjects.find((s) => s.startsWith("Blocker cleared"))).toBeUndefined();
    });
  });

  describe("unblock dependents (complete/approved)", () => {
    it("calls unblockDependents via getTasksByDependency for completed action", () => {
      const dep = makeTask({ id: "dep-1", status: "pending" });
      (taskRepo.getTasksByDependency as ReturnType<typeof vi.fn>).mockReturnValue([dep]);
      (taskRepo.areAllDependenciesMet as ReturnType<typeof vi.fn>).mockReturnValue(true);

      const task = makeTask({ status: "done" });
      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));

      expect(taskRepo.getTasksByDependency).toHaveBeenCalledWith("task-1");
      expect(eventRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "dependency_resolved" }),
      );
    });

    it("does NOT call unblockDependents for rejected action (per inventory #8)", () => {
      const task = makeTask({ status: "rejected" });
      emitTransition("task-1", "rejected", "hab-1", baseCtx({ task, newStatus: "rejected" }));
      expect(taskRepo.getTasksByDependency).not.toHaveBeenCalled();
    });
  });

  describe("retry trigger (rejected/failed)", () => {
    it("calls scheduleRetry when shouldRetry returns true for failed action", () => {
      const task = makeTask({ status: "failed" });
      (retryService.shouldRetry as ReturnType<typeof vi.fn>).mockReturnValue(true);

      emitTransition("task-1", "failed", "hab-1", baseCtx({ task, newStatus: "failed" }));
      expect(retryService.scheduleRetry).toHaveBeenCalledWith(task);
    });

    it("calls escalateToHuman when policy has escalateToHuman for failed action", () => {
      const task = makeTask({ status: "failed" });
      (retryService.shouldRetry as ReturnType<typeof vi.fn>).mockReturnValue(false);
      (retryService.getEffectivePolicy as ReturnType<typeof vi.fn>).mockReturnValue({
        escalateToHuman: true,
      });

      emitTransition("task-1", "failed", "hab-1", baseCtx({ task, newStatus: "failed" }));
      expect(retryService.escalateToHuman).toHaveBeenCalledWith(task);
    });

    it("does NOT trigger retry for started action", () => {
      const task = makeTask();
      emitTransition("task-1", "started", "hab-1", baseCtx({ task, newStatus: "in_progress" }));
      expect(retryService.scheduleRetry).not.toHaveBeenCalled();
    });
  });

  describe("notifyTaskEvent (inconsistency #2 preserved)", () => {
    it("fires task event for completed", () => {
      const hook = vi.fn();
      onTaskEvent(hook);
      const task = makeTask({ status: "done" });
      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ event: "completed", taskId: "task-1" }),
      );
    });

    it("fires task event for approved", () => {
      const hook = vi.fn();
      onTaskEvent(hook);
      const task = makeTask();
      emitTransition("task-1", "approved", "hab-1", baseCtx({ task, newStatus: "approved" }));
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ event: "approved" }));
    });

    it("does NOT fire task event for claimed (per inventory #2)", () => {
      const hook = vi.fn();
      onTaskEvent(hook);
      const task = makeTask();
      emitTransition("task-1", "claimed", "hab-1", baseCtx({ task, newStatus: "claimed" }));
      expect(hook).not.toHaveBeenCalled();
    });

    it("does NOT fire task event for submitted (per inventory #2)", () => {
      const hook = vi.fn();
      onTaskEvent(hook);
      const task = makeTask();
      emitTransition("task-1", "submitted", "hab-1", baseCtx({ task, newStatus: "submitted" }));
      expect(hook).not.toHaveBeenCalled();
    });

    it("does NOT fire task event for released (per inventory #2)", () => {
      const hook = vi.fn();
      onTaskEvent(hook);
      const task = makeTask();
      emitTransition("task-1", "released", "hab-1", baseCtx({ task, newStatus: "pending" }));
      expect(hook).not.toHaveBeenCalled();
    });

    it("continues to call other hooks even if one throws", () => {
      const hook1 = vi.fn(() => {
        throw new Error("hook1 boom");
      });
      const hook2 = vi.fn();
      onTaskEvent(hook1);
      onTaskEvent(hook2);

      const task = makeTask({ status: "done" });
      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));
      expect(hook1).toHaveBeenCalled();
      expect(hook2).toHaveBeenCalled();
    });
  });

  describe("onTransition (parallel channel, fires for all actions)", () => {
    beforeEach(() => {
      (missionService.recalculateMissionStatus as ReturnType<typeof vi.fn>).mockReset();
    });

    const allTransitionActions: TaskAction[] = [
      "claimed",
      "started",
      "submitted",
      "approved",
      "rejected",
      "completed",
      "released",
      "failed",
      "created",
      "updated",
      "deleted",
      "delegated",
      "claimed_delegated",
      "retry_scheduled",
      "retry_executed",
      "escalated",
    ];

    it.each(allTransitionActions)("fires for %s action", (action) => {
      const hook = vi.fn();
      const unsub = onTransition(hook);
      const task = makeTask();
      emitTransition("task-1", action, "hab-1", baseCtx({ task }));
      expect(hook).toHaveBeenCalledTimes(1);
      expect(hook).toHaveBeenCalledWith(expect.objectContaining({ taskId: "task-1", action }));
      unsub();
    });

    it("fires for submitted and released (the actions onTaskEvent skips)", () => {
      const hook = vi.fn();
      const unsub = onTransition(hook);
      const task = makeTask();
      emitTransition("task-1", "submitted", "hab-1", baseCtx({ task, newStatus: "submitted" }));
      emitTransition("task-1", "released", "hab-1", baseCtx({ task, newStatus: "pending" }));
      expect(hook).toHaveBeenCalledTimes(2);
      expect(hook).toHaveBeenNthCalledWith(1, expect.objectContaining({ action: "submitted" }));
      expect(hook).toHaveBeenNthCalledWith(2, expect.objectContaining({ action: "released" }));
      unsub();
    });

    it("passes resolved newStatus from action config when context omits it", () => {
      const hook = vi.fn();
      const unsub = onTransition(hook);
      const task = makeTask();
      emitTransition("task-1", "claimed", "hab-1", baseCtx({ task }));
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({ action: "claimed", newStatus: "claimed" }),
      );
      unsub();
    });

    it("passes task, actorType, actorId, habitatId, metadata, and reason through", () => {
      const hook = vi.fn();
      const unsub = onTransition(hook);
      const task = makeTask({ status: "failed" });
      emitTransition("task-1", "failed", "hab-1", {
        actorType: "system",
        actorId: "cron",
        task,
        newStatus: "failed",
        reason: "timeout",
        metadata: { retry: 3 },
      });
      expect(hook).toHaveBeenCalledWith(
        expect.objectContaining({
          taskId: "task-1",
          action: "failed",
          habitatId: "hab-1",
          actorType: "system",
          actorId: "cron",
          newStatus: "failed",
          reason: "timeout",
          metadata: { retry: 3 },
          task,
        }),
      );
      unsub();
    });

    it("does NOT affect onTaskEvent firing set (channels are independent)", () => {
      const transitionHook = vi.fn();
      const eventHook = vi.fn();
      const unsubT = onTransition(transitionHook);
      const unsubE = onTaskEvent(eventHook);
      const task = makeTask({ status: "done" });

      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));

      expect(transitionHook).toHaveBeenCalledTimes(1);
      expect(eventHook).toHaveBeenCalledTimes(1);

      emitTransition("task-1", "submitted", "hab-1", baseCtx({ task, newStatus: "submitted" }));

      expect(transitionHook).toHaveBeenCalledTimes(2);
      expect(eventHook).toHaveBeenCalledTimes(1);

      unsubT();
      unsubE();
    });

    it("unsubscribes via the returned disposer", () => {
      const hook = vi.fn();
      const unsub = onTransition(hook);
      const task = makeTask();

      emitTransition("task-1", "claimed", "hab-1", baseCtx({ task }));
      expect(hook).toHaveBeenCalledTimes(1);

      unsub();
      emitTransition("task-1", "started", "hab-1", baseCtx({ task }));
      expect(hook).toHaveBeenCalledTimes(1);
    });

    it("continues to call other hooks even if one throws", () => {
      const hook1 = vi.fn(() => {
        throw new Error("transition hook1 boom");
      });
      const hook2 = vi.fn();
      const unsub1 = onTransition(hook1);
      const unsub2 = onTransition(hook2);

      const task = makeTask({ status: "done" });
      emitTransition("task-1", "completed", "hab-1", baseCtx({ task, newStatus: "done" }));

      expect(hook1).toHaveBeenCalled();
      expect(hook2).toHaveBeenCalled();
      expect(logger.error).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.any(Error) }),
        "Transition hook failed",
      );
      unsub1();
      unsub2();
    });
  });

  describe("updateTask conditional recalc", () => {
    it("recalcs when status actually changed", () => {
      const task = makeTask({ status: "done" });
      emitTransition("task-1", "updated", "hab-1", {
        ...baseCtx({ task, oldStatus: "in_progress", newStatus: "done" }),
      });
      expect(missionService.recalculateMissionStatus).toHaveBeenCalledWith("mission-1");
    });

    it("does NOT recalc when only non-status fields changed", () => {
      const task = makeTask({ status: "in_progress" });
      emitTransition("task-1", "updated", "hab-1", {
        ...baseCtx({ task, oldStatus: "in_progress", newStatus: "in_progress" }),
      });
      expect(missionService.recalculateMissionStatus).not.toHaveBeenCalled();
    });
  });
});

describe("TransitionEmitter: action coverage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setRecalcDebounceEnabled(false);
    (taskRepo.getTaskById as ReturnType<typeof vi.fn>).mockReturnValue(makeTask());
    (taskRepo.getHabitatIdForTask as ReturnType<typeof vi.fn>).mockReturnValue("hab-1");
    (missionService.recalculateMissionStatus as ReturnType<typeof vi.fn>).mockReset();
  });

  const allActions: TaskAction[] = [
    "claimed",
    "started",
    "submitted",
    "approved",
    "rejected",
    "completed",
    "released",
    "failed",
    "created",
    "updated",
    "deleted",
    "delegated",
    "claimed_delegated",
    "retry_scheduled",
    "retry_executed",
    "escalated",
  ];

  it.each(allActions)("handles %s action without throwing", (action) => {
    const task = makeTask();
    expect(() => {
      emitTransition("task-1", action, "hab-1", baseCtx({ task }));
    }).not.toThrow();
  });
});
