import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { FeatureTaskKanban, KANBAN_COLUMNS } from "./MissionTaskKanban.js";
import type { Task } from "../../types/index.js";

const mockOpenModal = vi.fn();

vi.mock("../../store/modalStore.js", () => ({
  useModalStore: (selector: any) => selector({ openModal: mockOpenModal }),
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgents: () => ({ data: [] as any[], isLoading: false, isError: false }),
}));

vi.mock("../ui/Badge.js", () => ({
  Badge: ({ children }: any) => <span data-testid="badge">{children}</span>,
}));

vi.mock("../habitat/MissionHeader.js", () => ({
  formatStatus: (s: string) =>
    s.replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase()),
}));

vi.mock("lucide-react", () => ({
  BarChart3: () => <span data-testid="icon-barchart">BarChart3</span>,
  CheckCircle2: () => <span data-testid="icon-check">Check</span>,
  XCircle: () => <span data-testid="icon-x">X</span>,
  Circle: () => <span data-testid="icon-circle">Circle</span>,
  Timer: () => <span data-testid="icon-timer">Timer</span>,
}));

function makeTask(overrides: Partial<Task> & { id: string }): Task {
  return {
    missionId: "feat-1",
    title: "Task",
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

describe("FeatureTaskKanban", () => {
  afterEach(() => {
    cleanup();
    mockOpenModal.mockClear();
  });

  it("renders all 4 column headers", () => {
    render(<FeatureTaskKanban tasks={[]} />);
    expect(screen.getByText("Pending")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
  });

  it('renders "Task Kanban" header with task count', () => {
    const tasks = [
      makeTask({ id: "t1", status: "pending" }),
      makeTask({ id: "t2", status: "in_progress" }),
    ];
    render(<FeatureTaskKanban tasks={tasks} />);
    expect(screen.getByText("Task Kanban")).toBeTruthy();
    expect(screen.getByText("2 tasks")).toBeTruthy();
  });

  it("groups tasks by correct status columns", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Pending Task", status: "pending" }),
      makeTask({ id: "t2", title: "Claimed Task", status: "claimed" }),
      makeTask({ id: "t3", title: "Active Task", status: "in_progress" }),
      makeTask({ id: "t4", title: "Review Task", status: "submitted" }),
      makeTask({ id: "t5", title: "Done Task", status: "done" }),
      makeTask({ id: "t6", title: "Failed Task", status: "failed" }),
    ];
    render(<FeatureTaskKanban tasks={tasks} />);

    expect(screen.getByText("Pending Task")).toBeTruthy();
    expect(screen.getByText("Claimed Task")).toBeTruthy();
    expect(screen.getByText("Active Task")).toBeTruthy();
    expect(screen.getByText("Review Task")).toBeTruthy();
    expect(screen.getByText("Done Task")).toBeTruthy();
    expect(screen.getByText("Failed Task")).toBeTruthy();
  });

  it("shows correct task count per column", () => {
    const tasks = [
      makeTask({ id: "t1", status: "pending" }),
      makeTask({ id: "t2", status: "claimed" }),
      makeTask({ id: "t3", status: "in_progress" }),
      makeTask({ id: "t4", status: "done" }),
      makeTask({ id: "t5", status: "done" }),
    ];
    render(<FeatureTaskKanban tasks={tasks} />);

    const counts = screen.getAllByText(/^[0-9]+$/).map((el) => el.textContent);
    expect(counts).toContain("2");
    expect(counts).toContain("1");
    expect(counts).toContain("2");
  });

  it('shows "No tasks" for empty columns', () => {
    const tasks = [makeTask({ id: "t1", status: "done" })];
    render(<FeatureTaskKanban tasks={tasks} />);

    const noTasksMessages = screen.getAllByText("No tasks");
    expect(noTasksMessages.length).toBe(3);
  });

  it("renders task titles and priority badges", () => {
    const tasks = [
      makeTask({
        id: "task-abc123",
        title: "My Important Task",
        priority: "high",
        status: "pending",
      }),
    ];
    render(<FeatureTaskKanban tasks={tasks} />);

    expect(screen.getByText("My Important Task")).toBeTruthy();
    expect(screen.getByText("#task")).toBeTruthy();
    const badges = screen.getAllByTestId("badge");
    expect(badges.some((b) => b.textContent === "high")).toBe(true);
  });

  it("renders estimated time when present", () => {
    const tasks = [makeTask({ id: "t1", status: "pending", estimatedMinutes: 45 })];
    render(<FeatureTaskKanban tasks={tasks} />);
    expect(screen.getByText("~45m")).toBeTruthy();
  });

  it("calls openModal on task card click", () => {
    const tasks = [makeTask({ id: "t1", title: "Clickable Task", status: "pending" })];
    render(<FeatureTaskKanban tasks={tasks} />);

    fireEvent.click(screen.getByText("Clickable Task"));
    expect(mockOpenModal).toHaveBeenCalledWith("t1");
  });

  it("is read-only — no drag handles or drag attributes", () => {
    const tasks = [makeTask({ id: "t1", title: "Task A", status: "pending" })];
    const { container } = render(<FeatureTaskKanban tasks={tasks} />);

    expect(container.querySelector('[data-testid="drag-handle"]')).toBeNull();
    expect(container.querySelector(".cursor-grab")).toBeNull();
    expect(container.querySelector("[draggable]")).toBeNull();
  });

  it("renders task with approved status in Review column", () => {
    const tasks = [makeTask({ id: "t1", title: "Approved Task", status: "approved" })];
    render(<FeatureTaskKanban tasks={tasks} />);
    expect(screen.getByText("Approved Task")).toBeTruthy();
  });

  it("renders task with rejected status in Review column", () => {
    const tasks = [makeTask({ id: "t1", title: "Rejected Task", status: "rejected" })];
    render(<FeatureTaskKanban tasks={tasks} />);
    expect(screen.getByText("Rejected Task")).toBeTruthy();
  });

  it("renders 0 tasks count in header for empty tasks", () => {
    render(<FeatureTaskKanban tasks={[]} />);
    expect(screen.getByText("0 tasks")).toBeTruthy();
  });

  it("applies grid-cols-4 layout", () => {
    const { container } = render(<FeatureTaskKanban tasks={[]} />);
    const grid = container.querySelector(".grid-cols-4");
    expect(grid).toBeTruthy();
  });

  it("renders multiple tasks per column", () => {
    const tasks = [
      makeTask({ id: "t1", title: "Task One", status: "pending" }),
      makeTask({ id: "t2", title: "Task Two", status: "pending" }),
      makeTask({ id: "t3", title: "Task Three", status: "pending" }),
    ];
    render(<FeatureTaskKanban tasks={tasks} />);

    expect(screen.getByText("Task One")).toBeTruthy();
    expect(screen.getByText("Task Two")).toBeTruthy();
    expect(screen.getByText("Task Three")).toBeTruthy();
  });
});

describe("KANBAN_COLUMNS", () => {
  it("has 4 columns", () => {
    expect(KANBAN_COLUMNS.length).toBe(4);
  });

  it("maps pending and claimed to Pending column", () => {
    expect(KANBAN_COLUMNS[0].statuses).toEqual(["pending", "claimed"]);
    expect(KANBAN_COLUMNS[0].label).toBe("Pending");
  });

  it("maps in_progress to In Progress column", () => {
    expect(KANBAN_COLUMNS[1].statuses).toEqual(["in_progress"]);
    expect(KANBAN_COLUMNS[1].label).toBe("In Progress");
  });

  it("maps submitted/approved/rejected to Review column", () => {
    expect(KANBAN_COLUMNS[2].statuses).toEqual(["submitted", "approved", "rejected"]);
    expect(KANBAN_COLUMNS[2].label).toBe("Review");
  });

  it("maps done/failed to Done column", () => {
    expect(KANBAN_COLUMNS[3].statuses).toEqual(["done", "failed"]);
    expect(KANBAN_COLUMNS[3].label).toBe("Done");
  });
});
