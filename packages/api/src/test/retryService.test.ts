import { describe, it, expect, vi, beforeEach } from "vitest";
import * as taskStateMachine from "../repositories/taskStateMachine.js";

vi.mock("../repositories/taskStateMachine.js", () => ({
  // Review-safety cutover: the retry ladder's privileged writes moved to the
  // dedicated immediate writers (asserted below); the rest of the state
  // machine is out of scope for this unit test. The typed budget-refusal
  // error class lives in its own runtime-leaf module (retryBudgetRefusal.js)
  // so this factory stays simple and instanceof still matches the real class.
  retryTransitionToPendingWithEffects: vi.fn(() => ({ id: "task-1", status: "pending" })),
  retryEscalateClearOwnerWithEffects: vi.fn(
    () => ({ id: "task-1", status: "failed", assignedAgentId: null }),
  ),
}));
vi.mock("../services/tasks/transitionBudget.js", () => ({
  // Budget guard seam: allow (this suite exercises retry-ladder mechanics).
  // Factory mirrors the module surface retryService imports (a mock factory
  // must expose the full consumed surface, not just the classic guard).
  guardTransitionTop: vi.fn(() => ({ outcome: "allow", count: 0, ceiling: 12 })),
  resolveCeiling: vi.fn(() => 12),
  countMeteredTransitions: vi.fn(() => 0),
  habitatIdForTaskWithClient: vi.fn(() => "h1"),
}));

vi.mock("../repositories/task.js", () => ({
  getHabitatIdForTask: vi.fn(),
  updateTask: vi.fn(),
  getTasksPendingRetry: vi.fn(),
}));

vi.mock("../repositories/habitat.js", () => ({
  getHabitatById: vi.fn(),
}));

vi.mock("../repositories/event.js", () => ({
  createEvent: vi.fn(),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

vi.mock("../services/missionService.js", () => ({
  recalculateMissionStatus: vi.fn(),
}));

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn() },
}));

import {
  getDefaultPolicy,
  getEffectivePolicy,
  shouldRetry,
  calculateBackoff,
  scheduleRetry,
  executeRetry,
  executeRetryWithOutcome,
  escalateToHuman,
  processPendingRetries,
} from "../services/retryService.js";
import { RetryTransitionBudgetRefusedError } from "../repositories/retryBudgetRefusal.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as eventRepo from "../repositories/event.js";
import { guardTransitionTop } from "../services/tasks/transitionBudget.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: "task-1",
    missionId: "m1",
    priority: "medium",
    status: "failed",
    retryPolicy: null,
    retryCount: 0,
    rejectionReason: null,
    nextRetryAt: null,
    title: "T",
    assignedAgentId: "a1",
    ...overrides,
  } as any;
}

describe("retryService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue(null);
    vi.mocked(habitatRepo.getHabitatById).mockReturnValue(null);
    vi.mocked(taskRepo.updateTask).mockReturnValue({ success: false, task: null } as any);
    vi.mocked(taskRepo.getTasksPendingRetry).mockReturnValue([]);
  });

  describe("getDefaultPolicy", () => {
    it("returns default policy", () => {
      const p = getDefaultPolicy();
      expect(p.maxRetries).toBe(3);
      expect(p.backoffBase).toBe(60);
      expect(p.escalateToHuman).toBe(true);
    });
  });

  describe("getEffectivePolicy", () => {
    it("returns task-level policy", () => {
      const t = makeTask({ retryPolicy: { maxRetries: 5 } });
      const p = getEffectivePolicy(t);
      expect(p?.maxRetries).toBe(5);
    });
    it("returns habitat policy when task has none", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(habitatRepo.getHabitatById).mockReturnValue({
        retrySettings: { maxRetries: 2 },
      } as any);
      const t = makeTask();
      const p = getEffectivePolicy(t);
      expect(p?.maxRetries).toBe(2);
    });
    it("returns null when no policy found", () => {
      const t = makeTask();
      expect(getEffectivePolicy(t)).toBeNull();
    });
  });

  describe("shouldRetry", () => {
    it("returns false when no policy", () => {
      expect(shouldRetry(makeTask(), null)).toBe(false);
    });
    it("returns false when retryCount >= max", () => {
      const t = makeTask({ retryCount: 3 });
      expect(shouldRetry(t, { maxRetries: 3 } as any)).toBe(false);
    });
    it("returns true when under max", () => {
      const t = makeTask({ retryCount: 1 });
      expect(shouldRetry(t, { maxRetries: 3 } as any)).toBe(true);
    });
    it("filters by rejection reason", () => {
      const t = makeTask({ rejectionReason: "quality" });
      expect(shouldRetry(t, { maxRetries: 3, retryOnStatuses: ["quality"] } as any)).toBe(true);
    });
  });

  describe("calculateBackoff", () => {
    it("calculates exponential backoff", () => {
      const p = { backoffBase: 60, backoffMultiplier: 2, maxBackoff: 3600 } as any;
      expect(calculateBackoff(p, 0)).toBe(60);
      expect(calculateBackoff(p, 1)).toBe(120);
      expect(calculateBackoff(p, 2)).toBe(240);
    });
    it("caps at max", () => {
      const p = { backoffBase: 60, backoffMultiplier: 2, maxBackoff: 100 } as any;
      expect(calculateBackoff(p, 5)).toBe(100);
    });
  });

  describe("scheduleRetry", () => {
    it("returns null when no policy", () => {
      const t = makeTask();
      expect(scheduleRetry(t)).toBeNull();
    });
    it("schedules retry and creates event", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(habitatRepo.getHabitatById).mockReturnValue({
        retrySettings: { maxRetries: 3 },
      } as any);
      vi.mocked(taskRepo.updateTask).mockReturnValue({ success: true, task: makeTask() });

      const result = scheduleRetry(makeTask({ retryCount: 1 }));

      expect(result).not.toBeNull();
      expect(eventRepo.createEvent).toHaveBeenCalled();
      expect(sseBroadcaster.publish).toHaveBeenCalled();
    });
  });

  describe("executeRetryWithOutcome", () => {
    it("wrapper executeRetry returns the task on success (null-on-failure contract)", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(taskRepo.updateTask).mockReturnValue({
        success: true,
        task: makeTask({ status: "pending", retryCount: 1 }),
      });

      const result = executeRetry(makeTask({ retryCount: 0 }));

      expect(result).not.toBeNull();
      expect(result?.status).toBe("pending");
      // Review safety: the privileged status/assignee reset now runs through
      // the dedicated immediate retry writer (mocked here) — 2-arg call when
      // no options are supplied (background ladder arity unchanged).
      expect(taskStateMachine.retryTransitionToPendingWithEffects).toHaveBeenCalledWith(
        "task-1",
        1,
      );
    });

    it("wrapper executeRetry collapses a typed refusal to null", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(guardTransitionTop).mockReturnValueOnce({
        outcome: "refused",
        reason: "transition_budget_exhausted",
        count: 21,
        ceiling: 21,
      });

      expect(executeRetry(makeTask())).toBeNull();
    });

    it("returns the #152 refused outcome (guard refusal) without writing", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(guardTransitionTop).mockReturnValueOnce({
        outcome: "refused",
        reason: "transition_budget_exhausted",
        count: 21,
        ceiling: 21,
      });

      const result = executeRetryWithOutcome(makeTask());

      expect(result).toEqual({
        outcome: "refused",
        refusal: { outcome: "refused", reason: "transition_budget_exhausted", count: 21, ceiling: 21 },
      });
      expect(taskStateMachine.retryTransitionToPendingWithEffects).not.toHaveBeenCalled();
    });

    it("threads the manual-retry options to the writer", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      const expected = { status: "rejected", version: 7 };

      const result = executeRetryWithOutcome(
        makeTask({ retryCount: 2, rejectionReason: "needs work" }),
        { expected, preserveRejectionReason: true, requireClaimHeadroom: true },
      );

      expect(result.outcome).toBe("executed");
      expect(taskStateMachine.retryTransitionToPendingWithEffects).toHaveBeenCalledWith(
        "task-1",
        3,
        { expected, preserveRejectionReason: true, requireClaimHeadroom: true },
      );
      // Audit provenance: the preserved rejection feedback rides the emitted
      // retry_executed event (reason + metadata).
      expect(eventRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          action: "retry_executed",
          metadata: expect.objectContaining({ retryCount: 3, rejectionReason: "needs work" }),
        }),
      );
    });

    it("maps a writer CAS refusal to failed/preimage_conflict with no event", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      // One-shot override only — the factory default implementation must
      // survive for later tests (clearAllMocks keeps implementations).
      vi.mocked(taskStateMachine.retryTransitionToPendingWithEffects).mockReturnValueOnce(
        null as any,
      );

      const result = executeRetryWithOutcome(makeTask(), { expected: { status: "rejected", version: 3 } });

      expect(result).toEqual({ outcome: "failed", reason: "preimage_conflict" });
      expect(eventRepo.createEvent).not.toHaveBeenCalled();
    });

    it("maps an in-writer headroom refusal (typed throw) to the refused outcome", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(taskStateMachine.retryTransitionToPendingWithEffects).mockImplementationOnce(
        (() => {
          throw new RetryTransitionBudgetRefusedError({
            outcome: "refused",
            reason: "transition_budget_exhausted",
            count: 4,
            ceiling: 5,
          });
        }) as any,
      );

      const result = executeRetryWithOutcome(makeTask(), { requireClaimHeadroom: true });

      expect(result).toEqual({
        outcome: "refused",
        refusal: { outcome: "refused", reason: "transition_budget_exhausted", count: 4, ceiling: 5 },
      });
      expect(eventRepo.createEvent).not.toHaveBeenCalled();
    });
  });

  describe("escalateToHuman", () => {
    it("clears assignment and publishes", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(taskRepo.updateTask).mockReturnValue({
        success: true,
        task: makeTask({ assignedAgentId: null }),
      });

      const result = escalateToHuman(makeTask({ retryCount: 3 }));

      expect(result).not.toBeNull();
      expect(sseBroadcaster.publish).toHaveBeenCalledWith(
        "h1",
        expect.objectContaining({ type: "task.escalated" }),
      );
    });
  });

  describe("processPendingRetries", () => {
    it("processes overdue retries", () => {
      vi.mocked(taskRepo.getTasksPendingRetry).mockReturnValue([makeTask({ retryCount: 1 })]);
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(habitatRepo.getHabitatById).mockReturnValue({
        retrySettings: { maxRetries: 3 },
      } as any);
      vi.mocked(taskRepo.updateTask).mockReturnValue({
        success: true,
        task: makeTask({ retryCount: 2, status: "pending" }),
      });

      processPendingRetries();

      expect(taskRepo.getTasksPendingRetry).toHaveBeenCalled();
    });
    it("escalates when max retries exceeded", () => {
      vi.mocked(taskRepo.getTasksPendingRetry).mockReturnValue([makeTask({ retryCount: 3 })]);
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(habitatRepo.getHabitatById).mockReturnValue({
        retrySettings: { maxRetries: 3, escalateToHuman: true },
      } as any);
      vi.mocked(taskRepo.updateTask).mockReturnValue({
        success: true,
        task: makeTask({ assignedAgentId: null }),
      });

      processPendingRetries();

      expect(eventRepo.createEvent).toHaveBeenCalledWith(
        expect.objectContaining({ action: "escalated" }),
      );
    });
  });
});
