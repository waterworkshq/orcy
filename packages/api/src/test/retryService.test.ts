import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../repositories/task.js", () => ({
  getHabitatIdForTask: vi.fn(),
  updateTask: vi.fn(),
  getTasksPendingRetry: vi.fn(),
}));

vi.mock("../repositories/board.js", () => ({
  getHabitatById: vi.fn(),
}));

vi.mock("../repositories/event.js", () => ({
  createEvent: vi.fn(),
}));

vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

vi.mock("../services/featureService.js", () => ({
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
  escalateToHuman,
  processPendingRetries,
} from "../services/retryService.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import * as eventRepo from "../repositories/event.js";
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

  describe("executeRetry", () => {
    it("resets task to pending", () => {
      vi.mocked(taskRepo.getHabitatIdForTask).mockReturnValue("h1");
      vi.mocked(taskRepo.updateTask).mockReturnValue({
        success: true,
        task: makeTask({ status: "pending", retryCount: 1 }),
      });

      const result = executeRetry(makeTask({ retryCount: 0 }));

      expect(result).not.toBeNull();
      expect(taskRepo.updateTask).toHaveBeenCalledWith(
        "task-1",
        expect.objectContaining({ status: "pending" }),
      );
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
