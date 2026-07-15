import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { PipelineContextSidebar } from "./PipelineContextSidebar.js";
import type { Task, MissionWithProgress } from "../../types/index.js";

function makeFeature(
  overrides: Partial<MissionWithProgress> & { id: string },
): MissionWithProgress {
  return {
    habitatId: "board-1",
    columnId: "col-1",
    title: "Test Feature",
    description: "",
    acceptanceCriteria: "",
    priority: "high",
    labels: [],
    status: "in_progress",
    displayOrder: 0,
    dependsOn: [],
    blocks: [],
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    sprintId: null,
    progress: {
      total: 0,
      pending: 0,
      claimed: 0,
      inProgress: 0,
      submitted: 0,
      approved: 0,
      done: 0,
      failed: 0,
      rejected: 0,
      percentage: 0,
    },
    ...overrides,
    releaseGateType: overrides.releaseGateType ?? null,
    releaseGateVersion: overrides.releaseGateVersion ?? null,
    releaseDeadlineType: overrides.releaseDeadlineType ?? null,
    releaseDeadlineVersion: overrides.releaseDeadlineVersion ?? null,
  };
}

function makeTask(overrides: Partial<Task> & { id: string; missionId: string }): Task {
  return {
    title: "Test Task",
    description: "",
    priority: "medium",
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: "pending",
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [],
    order: 0,
    createdBy: "user-1",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    estimatedMinutes: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    labels: [],
    ...overrides,
  };
}

const { mockOpenModal } = vi.hoisted(() => ({
  mockOpenModal: vi.fn(),
}));

vi.mock("../../store/modalStore.js", () => ({
  useModalStore: (selector: any) => selector({ openModal: mockOpenModal }),
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgents: () => ({ data: [] as any[], isLoading: false, isError: false }),
}));

vi.mock("../ui/Badge.js", () => ({
  Badge: ({ children, variant }: any) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}));

vi.mock("lucide-react", () => ({
  Circle: () => <span data-testid="icon-circle">○</span>,
  CheckCircle2: () => <span data-testid="icon-check">✓</span>,
  XCircle: () => <span data-testid="icon-x">✗</span>,
  Timer: () => <span data-testid="icon-timer">⏱</span>,
  Clock: () => <span data-testid="icon-clock">◷</span>,
  AlertTriangle: () => <span data-testid="icon-alert-triangle">⚠</span>,
}));

describe("PipelineContextSidebar", () => {
  afterEach(() => {
    cleanup();
    mockOpenModal.mockReset();
  });

  it("renders pipeline context header", () => {
    const feature = makeFeature({ id: "feat-1" });
    render(<PipelineContextSidebar feature={feature} tasks={[]} />);
    expect(screen.getByText("Pipeline Context")).toBeTruthy();
  });

  it("renders feature status with health percentage", () => {
    const feature = makeFeature({ id: "feat-1" });
    const tasks = [
      makeTask({ id: "t1", missionId: "feat-1", status: "done" }),
      makeTask({ id: "t2", missionId: "feat-1", status: "pending" }),
    ];
    render(<PipelineContextSidebar feature={feature} tasks={tasks} />);
    expect(screen.getByText("50% OK")).toBeTruthy();
  });

  it("groups tasks by status sections", () => {
    const feature = makeFeature({ id: "feat-1" });
    const tasks = [
      makeTask({ id: "t1", missionId: "feat-1", status: "in_progress", title: "Active One" }),
      makeTask({ id: "t2", missionId: "feat-1", status: "submitted", title: "Review One" }),
      makeTask({ id: "t3", missionId: "feat-1", status: "pending", title: "Pending One" }),
      makeTask({ id: "t4", missionId: "feat-1", status: "done", title: "Done One" }),
    ];
    render(<PipelineContextSidebar feature={feature} tasks={tasks} />);
    expect(screen.getAllByText("Active").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Awaiting Validation")).toBeTruthy();
    expect(screen.getAllByText("Pending").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(1);
  });

  it("opens modal when task is clicked", () => {
    const feature = makeFeature({ id: "feat-1" });
    const tasks = [
      makeTask({ id: "task-click", missionId: "feat-1", status: "pending", title: "Clickable" }),
    ];
    render(<PipelineContextSidebar feature={feature} tasks={tasks} />);
    fireEvent.click(screen.getAllByText("Clickable")[0]);
    expect(mockOpenModal).toHaveBeenCalledWith("task-click");
  });

  it("renders task priority badges", () => {
    const feature = makeFeature({ id: "feat-1" });
    const tasks = [
      makeTask({ id: "t1", missionId: "feat-1", status: "pending", priority: "critical" }),
    ];
    render(<PipelineContextSidebar feature={feature} tasks={tasks} />);
    expect(screen.getByText("critical")).toBeTruthy();
  });

  it("renders task ID prefix", () => {
    const feature = makeFeature({ id: "feat-1" });
    const tasks = [makeTask({ id: "task-abc123", missionId: "feat-1", status: "pending" })];
    render(<PipelineContextSidebar feature={feature} tasks={tasks} />);
    expect(screen.getByText("#task")).toBeTruthy();
  });
});
