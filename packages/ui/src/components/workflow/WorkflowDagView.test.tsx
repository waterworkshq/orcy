import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import React from "react";

const mockGetForMission = vi.fn();
const mockDetach = vi.fn();
const mockUnblockGate = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();
const mockNavigate = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    workflows: {
      getForMission: (...args: unknown[]) => mockGetForMission(...args),
      detach: (...args: unknown[]) => mockDetach(...args),
      unblockGate: (...args: unknown[]) => mockUnblockGate(...args),
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock("react-router-dom", () => ({
  useNavigate: () => mockNavigate,
}));

import { WorkflowDagView } from "./WorkflowDagView.js";
import type { Task } from "../../types/index.js";

function createWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return React.createElement(QueryClientProvider, { client: qc }, children);
  };
}

const sampleTasks: Task[] = [
  {
    id: "task-a",
    title: "Build",
    status: "done",
    missionId: "m1",
    habitatId: "h1",
  } as unknown as Task,
  {
    id: "task-b",
    title: "Test",
    status: "pending",
    missionId: "m1",
    habitatId: "h1",
  } as unknown as Task,
  {
    id: "task-c",
    title: "Deploy",
    status: "pending",
    missionId: "m1",
    habitatId: "h1",
  } as unknown as Task,
];

const sampleWorkflow = {
  workflow: {
    id: "wf-1",
    missionId: "m1",
    habitatId: "h1",
    status: "active",
    version: 1,
    failureHandler: null,
    joinSpecs: null,
    createdAt: "2026-06-21T10:00:00Z",
  },
  gates: [
    {
      id: "gate-1",
      workflowId: "wf-1",
      upstreamTaskId: "task-a",
      downstreamTaskId: "task-b",
      gateType: "on_complete",
      satisfied: true,
      satisfiedAt: "2026-06-21T11:00:00Z",
      satisfiedByEventId: "evt-1",
      matchConfig: null,
      condition: null,
      recoveryTaskId: null,
      recoveryDepth: null,
    },
    {
      id: "gate-2",
      workflowId: "wf-1",
      upstreamTaskId: "task-b",
      downstreamTaskId: "task-c",
      gateType: "on_approve",
      satisfied: false,
      satisfiedAt: null,
      satisfiedByEventId: null,
      matchConfig: null,
      condition: null,
      recoveryTaskId: null,
      recoveryDepth: null,
    },
  ],
};

afterEach(() => {
  cleanup();
});

describe("WorkflowDagView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetForMission.mockResolvedValue(sampleWorkflow);
    mockDetach.mockResolvedValue({ detached: true });
    mockUnblockGate.mockResolvedValue({ satisfied: true });
  });

  it("renders loading state", async () => {
    mockGetForMission.mockReturnValue(new Promise(() => {}));

    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    expect(screen.getByText("Loading workflow...")).toBeTruthy();
  });

  it("renders empty state when no workflow attached", async () => {
    mockGetForMission.mockRejectedValue(new Error("404"));

    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-dag-empty")).toBeTruthy();
    });
  });

  it("renders DAG with gates and task nodes", async () => {
    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-dag-view")).toBeTruthy();
    });

    expect(screen.getByTestId("dag-task-task-a")).toBeTruthy();
    expect(screen.getByTestId("dag-task-task-b")).toBeTruthy();
    expect(screen.getByTestId("dag-task-task-c")).toBeTruthy();
    expect(screen.getByTestId("dag-gate-gate-1")).toBeTruthy();
    expect(screen.getByTestId("dag-gate-gate-2")).toBeTruthy();
  });

  it("opens gate panel on gate click", async () => {
    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("dag-gate-gate-1")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("dag-gate-gate-1"));

    expect(screen.getByTestId("workflow-gate-panel")).toBeTruthy();
    expect(screen.getByTestId("gate-state").textContent).toBe("Satisfied");
  });

  it("shows detach button for admin", async () => {
    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("detach-workflow-btn")).toBeTruthy();
    });
  });

  it("hides detach button for non-admin", async () => {
    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={false} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("workflow-dag-view")).toBeTruthy();
    });

    expect(screen.queryByTestId("detach-workflow-btn")).toBeNull();
  });

  it("shows confirmation dialog on detach click", async () => {
    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("detach-workflow-btn")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("detach-workflow-btn"));

    expect(screen.getByTestId("detach-confirm")).toBeTruthy();
    expect(screen.getByText(/Stop enforcing all gates/)).toBeTruthy();
  });

  it("calls detach API on confirm", async () => {
    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("detach-workflow-btn")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("detach-workflow-btn"));
    fireEvent.click(screen.getByTestId("detach-confirm"));

    await waitFor(() => {
      expect(mockDetach).toHaveBeenCalledWith("wf-1");
      expect(mockNotifySuccess).toHaveBeenCalledWith("Workflow detached");
    });
  });

  it("navigates to task on node click", async () => {
    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("dag-task-task-a")).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId("dag-task-task-a"));
    expect(mockNavigate).toHaveBeenCalledWith("/tasks/task-a");
  });

  it("shows gate count in header", async () => {
    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText(/2 gates/)).toBeTruthy();
    });
  });

  it("renders failed gate state when upstream task is failed", async () => {
    const failedTasks: Task[] = [
      {
        id: "task-a",
        title: "Build",
        status: "failed",
        missionId: "m1",
        habitatId: "h1",
      } as unknown as Task,
      ...sampleTasks.slice(1),
    ];
    const failedWorkflow = {
      ...sampleWorkflow,
      gates: [
        {
          ...sampleWorkflow.gates[0],
          satisfied: false,
          gateType: "on_fail",
        },
      ],
    };
    mockGetForMission.mockResolvedValue(failedWorkflow);

    render(<WorkflowDagView missionId="m1" tasks={failedTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByTestId("dag-gate-gate-1")).toBeTruthy();
    });

    const gateElement = screen.getByTestId("dag-gate-gate-1");
    const path = gateElement.querySelector("path");
    expect(path?.getAttribute("stroke")).toBe("#ef4444");
  });

  it("handles workflow with no gates", async () => {
    const noGateWorkflow = {
      ...sampleWorkflow,
      gates: [],
    };
    mockGetForMission.mockResolvedValue(noGateWorkflow);

    render(<WorkflowDagView missionId="m1" tasks={sampleTasks} isAdmin={true} />, {
      wrapper: createWrapper(),
    });

    await waitFor(() => {
      expect(screen.getByText(/no gates/i)).toBeTruthy();
    });
  });
});
