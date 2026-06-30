import { describe, it, expect, vi, beforeEach } from "vitest";
import type { SSEEvent } from "../models/index.js";

vi.mock("../lib/logger.js", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

vi.mock("../services/webhookDispatcher.js", () => ({
  dispatchWebhooks: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/notificationService.js", () => ({
  processEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../services/chatService.js", () => ({
  processEvent: vi.fn().mockResolvedValue(undefined),
}));

import { logger } from "../lib/logger.js";
import * as notificationService from "../services/notificationService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

describe("SSEBroadcaster notifySafe (via triggerNotifications)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls notificationService.processEvent with correct args for task.claimed", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.claimed",
      data: { taskId: "t-1", agentId: "a-1" },
    });

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith("task.assigned", "habitat-1", {
        taskId: "t-1",
        actorId: "a-1",
      });
    });
  });

  it("calls processEvent for task.submitted", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.submitted",
      data: { taskId: "t-1", agentId: "a-1" },
    });

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith("task.submitted", "habitat-1", {
        taskId: "t-1",
        actorId: "a-1",
      });
    });
  });

  it("calls processEvent for task.approved", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.approved",
      data: { taskId: "t-1", reviewerId: "r-1" },
    });

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith("task.approved", "habitat-1", {
        taskId: "t-1",
        actorId: "r-1",
      });
    });
  });

  it("calls processEvent for task.rejected", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.rejected",
      data: { taskId: "t-1", reason: "bad code", reviewerId: "rev-1" },
    });

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith("task.rejected", "habitat-1", {
        taskId: "t-1",
        actorId: "rev-1",
        reason: "bad code",
      });
    });
  });

  it("calls processEvent for task.overdue", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.overdue",
      data: { taskId: "t-1", habitatId: "habitat-1", detectedAt: new Date().toISOString() },
    } as SSEEvent);

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith("task.overdue", "habitat-1", {
        taskId: "t-1",
      });
    });
  });

  it("calls processEvent for task.mentioned when mentionedType is human", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.mentioned",
      data: {
        taskId: "t-1",
        commentId: "c-1",
        mentionedType: "human",
        mentionedId: "u-1",
        mentionedName: "Alice",
        habitatId: "habitat-1",
      },
    } as SSEEvent);

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith(
        "comment.mentioned",
        "habitat-1",
        { taskId: "t-1", mentionedUserId: "u-1", mentionedByName: "Alice" },
      );
    });
  });

  it("does not call processEvent for task.mentioned when mentionedType is agent", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.mentioned",
      data: {
        taskId: "t-1",
        commentId: "c-1",
        mentionedType: "agent",
        mentionedId: "a-1",
        mentionedName: "Bot",
        habitatId: "habitat-1",
      },
    } as SSEEvent);

    expect(notificationService.processEvent).not.toHaveBeenCalled();
  });

  it("calls processEvent for task.watcher_notify", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.watcher_notify",
      data: {
        taskId: "t-1",
        taskTitle: "Test",
        eventType: "updated",
        watcherUserIds: [],
        habitatId: "habitat-1",
      },
    } as SSEEvent);

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith("task.watching", "habitat-1", {
        taskId: "t-1",
      });
    });
  });

  it("logs error via logger.error when processEvent rejects", async () => {
    const error = new Error("notify failed");
    vi.mocked(notificationService.processEvent).mockRejectedValueOnce(error);

    sseBroadcaster.publish("habitat-1", {
      type: "task.claimed",
      data: { taskId: "t-1", agentId: "a-1" },
    });

    await vi.waitFor(() => {
      expect(logger.error).toHaveBeenCalledWith(
        { err: error, eventType: "task.assigned", label: "task.assigned" },
        "[notifications] task.assigned error",
      );
    });
  });

  it("does not throw when processEvent rejects (fire-and-forget)", () => {
    vi.mocked(notificationService.processEvent).mockRejectedValueOnce(new Error("boom"));

    expect(() => {
      sseBroadcaster.publish("habitat-1", {
        type: "task.claimed",
        data: { taskId: "t-1", agentId: "a-1" },
      });
    }).not.toThrow();
  });

  it("calls processEvent for task.review_assigned", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.review_assigned",
      data: { taskId: "t-1", reviewerId: "r-1", reviewerType: "human", actorId: "a-1" },
    });

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith(
        "task.review_assigned",
        "habitat-1",
        { taskId: "t-1", reviewerId: "r-1", actorId: "a-1" },
      );
    });
  });

  it("calls processEvent for task.priority_changed", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "task.priority_changed",
      data: {
        taskId: "t-1",
        oldPriority: "medium",
        newPriority: "critical",
        ruleName: "overdue",
        score: 95,
      },
    });

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith(
        "task.priority_changed",
        "habitat-1",
        { taskId: "t-1", oldPriority: "medium", newPriority: "critical" },
      );
    });
  });

  it("calls processEvent for mission.mentioned when mentionedType is human", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "mission.mentioned",
      data: {
        missionId: "m-1",
        commentId: "c-1",
        mentionedType: "human",
        mentionedId: "u-1",
        mentionedName: "Alice",
      },
    } as SSEEvent);

    await vi.waitFor(() => {
      expect(notificationService.processEvent).toHaveBeenCalledWith(
        "comment.mentioned",
        "habitat-1",
        { missionId: "m-1", mentionedUserId: "u-1", mentionedByName: "Alice" },
      );
    });
  });

  it("does not call processEvent for mission.mentioned when mentionedType is agent", async () => {
    sseBroadcaster.publish("habitat-1", {
      type: "mission.mentioned",
      data: {
        missionId: "m-1",
        commentId: "c-1",
        mentionedType: "agent",
        mentionedId: "a-1",
        mentionedName: "Bot",
      },
    } as SSEEvent);

    expect(notificationService.processEvent).not.toHaveBeenCalled();
  });
});
