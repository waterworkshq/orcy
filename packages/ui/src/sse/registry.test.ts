import { describe, expect, it, vi } from "vitest";
import {
  applySSEStoreUpdate,
  getSSENotification,
  invalidateSSEEventCache,
  SSE_EVENT_REGISTRY,
  SSE_EVENT_TYPES,
} from "./registry.js";
import type { SSEStoreState } from "./types.js";
import type { SSEEvent, Task } from "../types/index.js";

function makeState(overrides: Partial<SSEStoreState> = {}): SSEStoreState {
  return {
    tasks: [],
    agents: [],
    features: [],
    columns: [],
    comments: {},
    presence: [],
    wipAlerts: {},
    columnPagination: {},
    selectedMissionIds: [],
    selectedMissionId: null,
    board: null,
    recentSSEEvents: [],
    ...overrides,
  } as SSEStoreState;
}

describe("SSE event registry", () => {
  it("registers every declared SSE event type", () => {
    expect(Object.keys(SSE_EVENT_REGISTRY).toSorted()).toEqual([...SSE_EVENT_TYPES].toSorted());
  });

  it("no longer mutates task store for claimed event (zustand removed)", () => {
    const task = {
      id: "t1",
      status: "pending",
      assignedAgentId: null,
    } as Task;
    const state = makeState({ tasks: [task] });
    const set = vi.fn((partial: Partial<SSEStoreState>) => Object.assign(state, partial));

    applySSEStoreUpdate(
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

    invalidateSSEEventCache(event, { invalidateQueries } as never, "h1", () => makeState());

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
});
