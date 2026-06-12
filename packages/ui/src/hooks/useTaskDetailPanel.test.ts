import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook } from "@testing-library/react";
import { useTaskDetailPanel } from "./useTaskDetailPanel.js";

vi.mock("../store/habitatStore.js", () => ({
  useHabitatStore: vi.fn((selector?: any) => {
    const state = {
      tasks: [
        {
          id: "task-1",
          missionId: "feat-1",
          title: "Test Task",
          status: "pending",
          priority: "medium",
          labels: [],
        },
      ],
      agents: [],
      setSelectedTask: vi.fn(),
      updateTask: vi.fn(),
      removeTask: vi.fn(),
      columns: [
        { id: "col-1", name: "To Do", nextColumnId: "col-2", autoAdvance: false },
        { id: "col-2", name: "In Progress", nextColumnId: null, autoAdvance: true },
      ],
      features: [{ id: "feat-1", columnId: "col-1" }],
    };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("../store/modalStore.js", () => ({
  useModalStore: vi.fn((selector?: any) => {
    const state = { selectedTaskId: "task-1" };
    return selector ? selector(state) : state;
  }),
}));

vi.mock("../api/index.js", () => ({
  api: {
    subtasks: {
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    tasks: {
      update: vi.fn(),
      delete: vi.fn(),
      clone: vi.fn(),
      approve: vi.fn(),
      reject: vi.fn(),
      delegate: vi.fn(),
      watch: vi.fn(),
      unwatch: vi.fn(),
      decompose: vi.fn(),
    },
    reviewers: {
      list: vi.fn().mockResolvedValue({ reviewers: [] }),
    },
    auth: {
      me: vi.fn().mockResolvedValue({ user: { id: "test-user", username: "test", role: "admin" } }),
    },
  },
}));

vi.mock("../lib/toast.js", () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
  })),
  useQuery: vi.fn(() => ({
    data: undefined,
    isLoading: false,
  })),
}));

vi.mock("../lib/queryKeys.js", () => ({
  queryKeys: {
    tasks: {
      subtasks: vi.fn(() => ["subtasks"]),
      watchers: vi.fn(() => ["watchers"]),
      detail: vi.fn(() => ["detail"]),
      details: vi.fn(() => ["details"]),
      reviewers: vi.fn(() => ["reviewers"]),
    },
    user: {
      profile: vi.fn(() => ["user", "profile"]),
    },
    agents: {
      list: vi.fn(() => ["agents", "list"]),
      detail: vi.fn(() => ["agents", "detail"]),
      listWithTasks: vi.fn(() => ["agents", "listWithTasks"]),
      stats: vi.fn(() => ["agents", "stats"]),
    },
  },
}));

vi.mock("../lib/useHabitatData.js", () => ({
  useAgents: () => ({ data: [] as any[], isLoading: false, isError: false }),
  useMission: () => ({
    data: { feature: { id: "feat-1", columnId: "col-1" } as any },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("../lib/useTaskData.js", () => ({
  useTaskDetails: vi.fn(() => ({
    data: {
      events: [],
      subtasks: [],
      pullRequests: [],
      pipelineEvents: [],
      attachments: [],
      isWatching: false,
      dependencies: [],
      crossHabitatDependsOn: [],
      blockedBy: [],
      blocking: [],
      comments: [],
    },
    isLoading: false,
  })),
}));

describe("useTaskDetailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns initial state", () => {
    const { result } = renderHook(() => useTaskDetailPanel());
    expect(result.current.submitting).toBe(false);
    expect(result.current.isEditing).toBe(false);
    expect(result.current.watchLoading).toBe(false);
    expect(result.current.deleteDialogOpen).toBe(false);
  });

  it("sets isEditing to true when editTaskId matches selectedTaskId", () => {
    const { result } = renderHook(() => useTaskDetailPanel({ editTaskId: "task-1" }));
    expect(result.current.isEditing).toBe(true);
  });

  it("returns detail data from useTaskDetails", () => {
    const { result } = renderHook(() => useTaskDetailPanel());
    expect(result.current.events).toEqual([]);
    expect(result.current.subtasks).toEqual([]);
    expect(result.current.contextLoading).toBe(false);
    expect(result.current.isWatching).toBe(false);
  });

  it("returns selectedTaskId and agents", () => {
    const { result } = renderHook(() => useTaskDetailPanel());
    expect(result.current.selectedTaskId).toBe("task-1");
    expect(result.current.agents).toEqual([]);
  });

  it("EditFormState includes requiredCapabilities field in initial state", () => {
    const { result } = renderHook(() => useTaskDetailPanel());
    expect(result.current.editForm.requiredCapabilities).toEqual([]);
  });

  it("initEditForm populates requiredCapabilities from task data", async () => {
    const { initEditForm } = await import("../lib/task-helpers.js");
    const task = {
      id: "t1",
      title: "Test",
      description: "desc",
      priority: "high" as const,
      requiredCapabilities: ["typescript", "react"],
      requiredDomain: "frontend",
      status: "pending" as const,
    };
    const form = initEditForm(task as any);
    expect(form.requiredCapabilities).toEqual(["typescript", "react"]);
  });

  it("initEditForm defaults to empty array when no requiredCapabilities", async () => {
    const { initEditForm } = await import("../lib/task-helpers.js");
    const task = {
      id: "t1",
      title: "Test",
      description: "desc",
      priority: "medium" as const,
      requiredDomain: null,
      status: "pending" as const,
    };
    const form = initEditForm(task as any);
    expect(form.requiredCapabilities).toEqual([]);
  });

  it("derives column from task feature and board columns", () => {
    const { result } = renderHook(() => useTaskDetailPanel());
    expect(result.current.column).toEqual({
      id: "col-1",
      name: "To Do",
      nextColumnId: "col-2",
      autoAdvance: false,
    });
  });

  it("derives nextColumnName from column nextColumnId", () => {
    const { result } = renderHook(() => useTaskDetailPanel());
    expect(result.current.nextColumnName).toBe("In Progress");
  });
});
