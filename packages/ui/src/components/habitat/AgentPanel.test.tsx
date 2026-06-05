import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import { AgentPanel } from "./AgentPanel.js";

const mockAgentsListWithTasks = vi.fn();
const mockAgentStats = vi.fn();
const mockAgentQuality = vi.fn();
const mockApiDelete = vi.fn();
const mockRemoveAgent = vi.fn();
const mockInvalidateQueries = vi.fn();

const mockStoreState = {
  board: { id: "board-1", name: "Test Board" },
  removeAgent: mockRemoveAgent,
};

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: (selector?: any) => {
    return selector ? selector(mockStoreState) : mockStoreState;
  },
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgentsListWithTasks: (...args: unknown[]) => mockAgentsListWithTasks(...args),
  useAgentStats: (...args: unknown[]) => mockAgentStats(...args),
  useAgentQuality: (...args: unknown[]) => mockAgentQuality(...args),
}));

vi.mock("../../api/index.js", () => ({
  api: {
    agents: {
      delete: (...args: unknown[]) => mockApiDelete(...args),
    },
  },
}));

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock("../ui/Drawer.js", () => ({
  Drawer: ({ children, open }: any) => (open ? <div data-testid="drawer">{children}</div> : null),
}));

vi.mock("../ui/Button.js", () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../ui/AgentRegistrationDialog.js", () => ({
  AgentRegistrationDialog: ({ open }: any) =>
    open ? <div data-testid="agent-registration-dialog" /> : null,
}));

vi.mock("../ui/ConfirmDialog.js", () => ({
  ConfirmDialog: ({ open, onConfirm, onCancel, title, description, confirmLabel }: any) =>
    open ? (
      <div data-testid="confirm-dialog">
        <span>{title}</span>
        <span>{description}</span>
        <button data-testid="confirm-btn" onClick={onConfirm}>
          {confirmLabel}
        </button>
        <button data-testid="cancel-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    ) : null,
}));

vi.mock("./AgentCard.js", () => ({
  AgentCard: ({ agent, currentTaskTitle, stats, expanded, onToggleExpand, onDeregister }: any) => (
    <div data-testid={`agent-card-${agent.id}`}>
      <span>{agent.name}</span>
      <span>{agent.status}</span>
      {currentTaskTitle && <span data-testid={`task-title-${agent.id}`}>{currentTaskTitle}</span>}
      {stats && <span data-testid={`stats-${agent.id}`}>has-stats</span>}
      {expanded && <span data-testid={`expanded-${agent.id}`}>expanded</span>}
      <button data-testid={`toggle-${agent.id}`} onClick={() => onToggleExpand(agent.id)}>
        Toggle
      </button>
      <button data-testid={`deregister-${agent.id}`} onClick={() => onDeregister(agent.id)}>
        Deregister
      </button>
    </div>
  ),
}));

vi.mock("./DaemonSection.js", () => ({
  DaemonSection: () => <div data-testid="daemon-section" />,
}));

vi.mock("./DaemonSetupDialog.js", () => ({
  DaemonSetupDialog: ({ open }: any) => (open ? <div data-testid="daemon-setup-dialog" /> : null),
}));

vi.mock("../../lib/queryKeys.js", () => ({
  queryKeys: {
    agents: {
      listWithTasks: () => ["agents", "listWithTasks"],
      list: () => ["agents", "list"],
    },
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockInvalidateQueries,
    }),
  };
});

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

const sampleAgents = [
  {
    agent: {
      id: "agent-1",
      name: "Agent Alpha",
      type: "claude-code",
      domain: "backend",
      status: "idle",
      capabilities: ["coding"],
      currentTaskId: "task-1",
      lastHeartbeat: new Date().toISOString(),
      createdAt: "",
      updatedAt: "",
      habitatId: "board-1",
    },
    currentTaskTitle: "Build feature",
  },
  {
    agent: {
      id: "agent-2",
      name: "Agent Beta",
      type: "opencode",
      domain: "frontend",
      status: "working",
      capabilities: [],
      currentTaskId: null,
      lastHeartbeat: new Date().toISOString(),
      createdAt: "",
      updatedAt: "",
      habitatId: "board-1",
    },
    currentTaskTitle: null,
  },
];

describe("AgentPanel", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockAgentsListWithTasks.mockReturnValue({
      data: sampleAgents,
      isLoading: false,
    });
    mockAgentStats.mockReturnValue({
      data: {
        tasks: { completed: 5, failed: 1 },
        cycleTime: { count: 1, averageMinutes: 30 },
        quality: { rejectionRate: 0.1, currentStreak: 3 },
        throughput: { last7d: 10 },
        artifacts: { total: 2 },
      },
      isLoading: false,
    });
    mockAgentQuality.mockReturnValue({ data: { signals: [] }, isLoading: false, error: null });
    mockApiDelete.mockResolvedValue(undefined);
    mockInvalidateQueries.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders agents from useAgentsListWithTasks", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(screen.getByTestId("agent-card-agent-1")).toBeTruthy();
    expect(screen.getByTestId("agent-card-agent-2")).toBeTruthy();
  });

  it("renders agent names", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(screen.getByText("Agent Alpha")).toBeTruthy();
    expect(screen.getByText("Agent Beta")).toBeTruthy();
  });

  it("shows per-agent stats from useAgentStats", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(screen.getByTestId("stats-agent-1")).toBeTruthy();
    expect(screen.getByTestId("stats-agent-2")).toBeTruthy();
  });

  it("shows current task title from useAgentsListWithTasks", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(screen.getByTestId("task-title-agent-1")).toBeTruthy();
    expect(screen.getByText("Build feature")).toBeTruthy();
  });

  it("calls useAgentsListWithTasks with board id", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(mockAgentsListWithTasks).toHaveBeenCalledWith("board-1");
    expect(mockAgentQuality).toHaveBeenCalledWith("board-1");
  });

  it("calls useAgentStats per agent", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(mockAgentStats).toHaveBeenCalledWith("agent-1");
    expect(mockAgentStats).toHaveBeenCalledWith("agent-2");
  });

  it('shows "No agents registered" when agent list is empty', () => {
    mockAgentsListWithTasks.mockReturnValue({
      data: [],
      isLoading: false,
    });
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(screen.getByText("No agents registered.")).toBeTruthy();
  });

  it("shows Register Agent button when no agents", () => {
    mockAgentsListWithTasks.mockReturnValue({
      data: [],
      isLoading: false,
    });
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(screen.getByText("Register Agent")).toBeTruthy();
  });

  it("opens confirm dialog on deregister click", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("deregister-agent-1"));
    expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
    expect(screen.getByText("Deregister Agent")).toBeTruthy();
  });

  it("calls removeAgent dispatch and invalidates RQ cache on confirm", async () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("deregister-agent-1"));
    await fireEvent.click(screen.getByTestId("confirm-btn"));
    await waitFor(() => {
      expect(mockApiDelete).toHaveBeenCalledWith("agent-1");
      expect(mockRemoveAgent).toHaveBeenCalledWith("agent-1");
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it("closes confirm dialog on cancel", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("deregister-agent-1"));
    expect(screen.getByTestId("confirm-dialog")).toBeTruthy();
    fireEvent.click(screen.getByTestId("cancel-btn"));
    expect(screen.queryByTestId("confirm-dialog")).toBeNull();
  });

  it("shows error notification on delete failure", async () => {
    const { notify } = await import("../../lib/toast.js");
    mockApiDelete.mockRejectedValue(new Error("Delete failed"));
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("deregister-agent-1"));
    await fireEvent.click(screen.getByTestId("confirm-btn"));
    await waitFor(() => {
      expect(notify.error).toHaveBeenCalledWith("Delete failed");
    });
  });

  it("calls onClose when close button clicked", () => {
    const onClose = vi.fn();
    renderWithQC(<AgentPanel onClose={onClose} />);
    const closeBtn = screen.getByRole("button", { name: "Close agents panel" });
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it("opens agent registration dialog on Add click", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(screen.queryByTestId("agent-registration-dialog")).toBeNull();
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByTestId("agent-registration-dialog")).toBeTruthy();
  });

  it("toggles agent expansion", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(screen.queryByTestId("expanded-agent-1")).toBeNull();
    fireEvent.click(screen.getByTestId("toggle-agent-1"));
    expect(screen.getByTestId("expanded-agent-1")).toBeTruthy();
    fireEvent.click(screen.getByTestId("toggle-agent-1"));
    expect(screen.queryByTestId("expanded-agent-1")).toBeNull();
  });

  it("reads board from Zustand store (not agents/tasks)", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(mockAgentsListWithTasks).toHaveBeenCalledWith("board-1");
  });

  it("does not call api.agents.stats directly (uses RQ hook)", () => {
    renderWithQC(<AgentPanel onClose={vi.fn()} />);
    expect(mockAgentStats).toHaveBeenCalled();
  });
});
