import { describe, expect, it, vi } from "vitest";
import {
  applySSEEphemeralUpdate,
  getSSENotification,
  projectSSEServerEvent,
  SSE_EVENT_REGISTRY,
  SSE_EVENT_TYPES,
} from "./registry.js";
import type { SSEStoreState, ServerProjectionContext } from "./types.js";
import type { SSEEvent } from "../types/index.js";

function makeState(overrides: Partial<SSEStoreState> = {}): SSEStoreState {
  return {
    presence: [],
    wipAlerts: {},
    selectedMissionIds: [],
    selectedMissionId: null,
    recentSSEEvents: [],
    ...overrides,
  } as SSEStoreState;
}

function makeServerCtx(
  event: SSEEvent,
  overrides: Partial<ServerProjectionContext> = {},
): ServerProjectionContext {
  return {
    event,
    queryClient: { invalidateQueries: vi.fn(), removeQueries: vi.fn() } as never,
    subscriptionHabitatId: "h1",
    routeHabitatId: "h1",
    isActive: () => true,
    navigateHome: vi.fn(),
    ...overrides,
  };
}

describe("SSE event registry", () => {
  it("registers every declared SSE event type", () => {
    expect(Object.keys(SSE_EVENT_REGISTRY).toSorted()).toEqual([...SSE_EVENT_TYPES].toSorted());
  });

  it("no longer mutates zustand store for claimed event (server projection only)", () => {
    const state = makeState();
    const set = vi.fn((partial: Partial<SSEStoreState>) => Object.assign(state, partial));

    applySSEEphemeralUpdate(
      { type: "task.claimed", data: { taskId: "t1", agentId: "a1" } },
      state,
      set,
    );

    expect(set).not.toHaveBeenCalled();
  });

  it("preserves task review assigned cache invalidation", () => {
    const invalidateQueries = vi.fn();
    const event: SSEEvent = {
      type: "task.review_assigned",
      data: { taskId: "t1", reviewerId: "u1", reviewerType: "human", actorId: "system" },
    };

    projectSSEServerEvent(
      event,
      makeServerCtx(event, { queryClient: { invalidateQueries } as never }),
    );

    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: expect.arrayContaining(["reviewers", "t1"]) }),
    );
  });

  it("keeps watcher notifications gated to the current user", () => {
    const event: SSEEvent = {
      type: "task.watcher_notify",
      data: {
        taskId: "t1",
        taskTitle: "Watched task",
        eventType: "task.submitted",
        watcherUserIds: ["u1"],
        habitatId: "h1",
      },
    };

    expect(getSSENotification(event, makeState(), "u2")).toBeNull();
    expect(getSSENotification(event, makeState(), "u1")?.toast?.message).toContain("Watched task");
  });

  it("agent.message_received invalidates habitat agent mail cache without a toast", () => {
    const invalidateQueries = vi.fn();
    const event: SSEEvent = {
      type: "agent.message_received",
      data: {
        messageId: "m1",
        fromAgentId: "a1",
        fromAgentName: "Scout",
        toAgentId: "a2",
        subject: "retry failed",
        messageType: "info",
        priority: "normal",
        taskId: null,
        habitatId: "h1",
      },
    };

    projectSSEServerEvent(
      event,
      makeServerCtx(event, { queryClient: { invalidateQueries } as never }),
    );

    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ["agentMail", "list", "h1"] }),
    );
    expect(getSSENotification(event, makeState(), "u1")).toBeNull();
  });

  it("extraction.finding_proposed invalidates review queue cache", () => {
    const invalidateQueries = vi.fn();
    const event: SSEEvent = {
      type: "extraction.finding_proposed",
      data: { habitatId: "h1", findingId: "f1", findingType: "lesson", subject: "test", confidence: 0.85 },
    };

    projectSSEServerEvent(
      event,
      makeServerCtx(event, { queryClient: { invalidateQueries } as never }),
    );

    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: expect.arrayContaining(["extraction", "reviewQueue"]),
      }),
    );
  });

  it("extraction.decision_changed invalidates review queue and accepted findings", () => {
    const invalidateQueries = vi.fn();
    const event: SSEEvent = {
      type: "extraction.decision_changed",
      data: { habitatId: "h1", findingId: "f1", decision: "accept" },
    };

    projectSSEServerEvent(
      event,
      makeServerCtx(event, { queryClient: { invalidateQueries } as never }),
    );

    const keys = invalidateQueries.mock.calls.map((c) => c[0].queryKey);
    expect(keys.some((k) => k.includes("reviewQueue"))).toBe(true);
    expect(keys.some((k) => k.includes("acceptedFindings"))).toBe(true);
  });

  it("extraction.finding_withdrawn invalidates review queue cache", () => {
    const invalidateQueries = vi.fn();
    const event: SSEEvent = {
      type: "extraction.finding_withdrawn",
      data: { habitatId: "h1", findingId: "f1" },
    };

    projectSSEServerEvent(
      event,
      makeServerCtx(event, { queryClient: { invalidateQueries } as never }),
    );

    expect(invalidateQueries).toHaveBeenCalledWith(
      expect.objectContaining({
        queryKey: expect.arrayContaining(["extraction", "reviewQueue"]),
      }),
    );
  });
});
