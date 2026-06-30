import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, act } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { TaskTableView } from "./TaskTableView.js";
import type { Task } from "../../types/index.js";

const mockTasks: Task[] = [
  {
    id: "task-1",
    missionId: "feat-1",
    title: "Setup auth module",
    description: "",
    status: "pending",
    priority: "high",
    assignedAgentId: "agent-1",
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    estimatedMinutes: 120,
    rejectionReason: null,
    rejectedCount: 0,
    result: null,
    artifacts: [],
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    labels: [],
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    createdBy: "user-1",
    createdAt: "2024-06-01T10:00:00Z",
    updatedAt: "2024-06-01T10:00:00Z",
    version: 1,
    order: 0,
  },
  {
    id: "task-2",
    missionId: "feat-1",
    title: "Write unit tests",
    description: "",
    status: "in_progress",
    priority: "medium",
    assignedAgentId: "agent-2",
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    estimatedMinutes: 60,
    rejectionReason: null,
    rejectedCount: 0,
    result: null,
    artifacts: [],
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    labels: [],
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    createdBy: "user-1",
    createdAt: "2024-06-02T10:00:00Z",
    updatedAt: "2024-06-02T10:00:00Z",
    version: 1,
    order: 1,
  },
  {
    id: "task-3",
    missionId: "feat-2",
    title: "Fix login bug",
    description: "",
    status: "submitted",
    priority: "critical",
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    estimatedMinutes: null,
    rejectionReason: null,
    rejectedCount: 0,
    result: null,
    artifacts: [],
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    labels: [],
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    createdBy: "user-1",
    createdAt: "2024-06-03T10:00:00Z",
    updatedAt: "2024-06-03T10:00:00Z",
    version: 1,
    order: 2,
  },
];

const mockToggleTaskSelection = vi.fn();
const mockSelectTaskIds = vi.fn();
const mockClearTaskSelection = vi.fn();
const mockSetTaskBulkSelectMode = vi.fn();

const defaultStore = {
  agents: [
    { id: "agent-1", name: "Claude Agent", type: "claude-code" },
    { id: "agent-2", name: "Codex Agent", type: "codex" },
  ],
  selectedTaskIds: [] as string[],
  isTaskBulkSelectMode: false,
  toggleTaskSelection: mockToggleTaskSelection,
  selectTaskIds: mockSelectTaskIds,
  clearTaskSelection: mockClearTaskSelection,
  setTaskBulkSelectMode: mockSetTaskBulkSelectMode,
};

type StoreType = typeof defaultStore;
let currentStore: StoreType = { ...defaultStore };

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: Object.assign(
    (selectorOrNothing?: (s: StoreType) => unknown) => {
      if (typeof selectorOrNothing === "function") {
        return selectorOrNothing(currentStore);
      }
      return currentStore;
    },
    { getState: () => currentStore },
  ),
}));

const mockUseBoardTasks = vi.fn(() => ({
  data: { tasks: mockTasks, total: mockTasks.length },
  isLoading: false,
  isError: false,
  error: null as Error | null,
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgents: () => ({ data: [] as any[], isLoading: false, isError: false }),
  useBoardTasks: () => mockUseBoardTasks(),
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: vi.fn(),
    warning: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../../api/index.js", () => ({
  api: {
    tasks: {
      batch: vi.fn(),
    },
  },
}));

const mockUseIsMobile = vi.fn(() => false);

vi.mock("../../hooks/useMediaQuery.js", () => ({
  useIsMobile: () => mockUseIsMobile(),
}));

vi.mock("./TaskCardList.js", () => ({
  TaskCardList: () => <div data-testid="task-card-list-mock" />,
}));

describe("TaskTableView", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseIsMobile.mockReturnValue(false);
    cleanup();
    currentStore = { ...defaultStore, selectedTaskIds: [] };
    mockUseBoardTasks.mockReturnValue({
      data: { tasks: mockTasks, total: mockTasks.length },
      isLoading: false,
      isError: false,
      error: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders task rows from provided data", () => {
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("Setup auth module")).toBeInTheDocument();
    expect(screen.getByText("Write unit tests")).toBeInTheDocument();
    expect(screen.getByText("Fix login bug")).toBeInTheDocument();
  });

  it("renders column headers", () => {
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("Priority")).toBeInTheDocument();
    expect(screen.getByText("Title")).toBeInTheDocument();
    expect(screen.getByText("Status")).toBeInTheDocument();
    expect(screen.getByText("Assignee")).toBeInTheDocument();
    expect(screen.getByText("Effort")).toBeInTheDocument();
    expect(screen.getByText("Created")).toBeInTheDocument();
  });

  it("renders priority badges with correct text", () => {
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("high")).toBeInTheDocument();
    expect(screen.getByText("medium")).toBeInTheDocument();
    expect(screen.getByText("critical")).toBeInTheDocument();
  });

  it("renders status badges with correct text", () => {
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("pending")).toBeInTheDocument();
    expect(screen.getByText("in progress")).toBeInTheDocument();
    expect(screen.getByText("submitted")).toBeInTheDocument();
  });

  it("renders estimated effort when present", () => {
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("2h")).toBeInTheDocument();
    expect(screen.getByText("1h")).toBeInTheDocument();
  });

  it("renders dash for null estimated effort", () => {
    render(<TaskTableView habitatId="board-1" />);
    const dashes = screen.getAllByText("—");
    expect(dashes.length).toBeGreaterThanOrEqual(1);
  });

  it("renders Unassigned for null assignedAgentId", () => {
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("Unassigned")).toBeInTheDocument();
  });

  it("renders search input", () => {
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByPlaceholderText("Search tasks...")).toBeInTheDocument();
  });

  it("renders filter dropdowns", () => {
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByTestId("filter-status")).toBeInTheDocument();
    expect(screen.getByTestId("filter-priority")).toBeInTheDocument();
    expect(screen.getByTestId("filter-agent")).toBeInTheDocument();
  });

  it("debounces search input to avoid per-keystroke API calls", () => {
    vi.useFakeTimers();
    render(<TaskTableView habitatId="board-1" />);
    const input = screen.getByPlaceholderText("Search tasks...") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "security" } });
    expect(input.value).toBe("security");

    fireEvent.change(input, { target: { value: "security audit" } });
    expect(input.value).toBe("security audit");

    act(() => {
      vi.advanceTimersByTime(300);
    });
  });

  it("syncs row selection to store when a checkbox is clicked", () => {
    render(<TaskTableView habitatId="board-1" />);
    const checkbox = screen.getByTestId("select-task-1");
    expect(checkbox).not.toBeChecked();
    fireEvent.click(checkbox);
    expect(mockSelectTaskIds).toHaveBeenCalledWith(["task-1"]);
  });

  it("select-all checkbox selects all visible rows in store", () => {
    render(<TaskTableView habitatId="board-1" />);
    const selectAll = screen.getByTestId("select-all");
    fireEvent.click(selectAll);
    expect(mockSelectTaskIds).toHaveBeenCalledWith(["task-1", "task-2", "task-3"]);
  });

  it("selectTaskIds is called symmetrically on each row selection change", () => {
    render(<TaskTableView habitatId="board-1" />);
    const checkbox1 = screen.getByTestId("select-task-1");
    const checkbox2 = screen.getByTestId("select-task-2");

    fireEvent.click(checkbox1);
    expect(mockSelectTaskIds).toHaveBeenLastCalledWith(["task-1"]);

    fireEvent.click(checkbox2);
    expect(mockSelectTaskIds).toHaveBeenLastCalledWith(["task-1", "task-2"]);
  });

  it("shows error state when query fails", () => {
    mockUseBoardTasks.mockReturnValue({
      data: undefined as unknown as { tasks: Task[]; total: number },
      isLoading: false,
      isError: true,
      error: new Error("Network failure"),
    });
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("Failed to load tasks. Please try again.")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("shows loading state", () => {
    mockUseBoardTasks.mockReturnValue({
      data: undefined as unknown as { tasks: Task[]; total: number },
      isLoading: true,
      isError: false,
      error: null,
    });
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("Loading tasks...")).toBeInTheDocument();
  });

  it("shows empty state when no tasks", () => {
    mockUseBoardTasks.mockReturnValue({
      data: { tasks: [], total: 0 },
      isLoading: false,
      isError: false,
      error: null,
    });
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("No tasks found")).toBeInTheDocument();
  });

  it("shows clear filters button when filters are active", () => {
    render(<TaskTableView habitatId="board-1" />);
    const statusFilter = screen.getByTestId("filter-status");
    fireEvent.change(statusFilter, { target: { value: "pending" } });
    expect(screen.getByText("Clear filters")).toBeInTheDocument();
  });

  it("clears filters when clear button clicked", () => {
    render(<TaskTableView habitatId="board-1" />);
    const statusFilter = screen.getByTestId("filter-status") as HTMLSelectElement;
    fireEvent.change(statusFilter, { target: { value: "pending" } });
    expect(screen.getByText("Clear filters")).toBeInTheDocument();
    fireEvent.click(screen.getByText("Clear filters"));
    expect(statusFilter.value).toBe("all");
  });

  it("shows bulk action bar when tasks are selected", () => {
    currentStore = { ...defaultStore, selectedTaskIds: ["task-1"], isTaskBulkSelectMode: true };
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByText("1 task selected")).toBeInTheDocument();
  });

  it("syncs rowSelection from store selectedTaskIds on mount", () => {
    currentStore = {
      ...defaultStore,
      selectedTaskIds: ["task-1", "task-2"],
      isTaskBulkSelectMode: true,
    };
    render(<TaskTableView habitatId="board-1" />);
    expect(screen.getByTestId("select-task-1")).toBeChecked();
    expect(screen.getByTestId("select-task-2")).toBeChecked();
    expect(screen.getByTestId("select-task-3")).not.toBeChecked();
  });

  describe("mobile view", () => {
    beforeEach(() => {
      mockUseIsMobile.mockReturnValue(true);
    });

    it("renders TaskCardList instead of DataTable on mobile", () => {
      render(<TaskTableView habitatId="board-1" />);
      expect(screen.getByTestId("task-card-list-mock")).toBeInTheDocument();
      expect(screen.queryByTestId("select-all")).not.toBeInTheDocument();
    });

    it("does not render desktop table rows on mobile", () => {
      render(<TaskTableView habitatId="board-1" />);
      expect(screen.queryByText("Setup auth module")).not.toBeInTheDocument();
    });

    it("does not show sort indicator when no sorting is active", () => {
      render(<TaskTableView habitatId="board-1" />);
      expect(screen.queryByText(/Sorted by/)).not.toBeInTheDocument();
    });
  });
});
