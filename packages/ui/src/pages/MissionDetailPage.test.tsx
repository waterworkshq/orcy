import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MissionDetailPage } from "./MissionDetailPage.js";
import type { MissionWithProgress, Task, MissionEvent } from "../types/index.js";

function makeFeature(
  overrides: Partial<MissionWithProgress> & { id: string },
): MissionWithProgress {
  return {
    habitatId: "habitat-1",
    columnId: "col-1",
    title: "Test Feature",
    description: "A test feature description",
    acceptanceCriteria: "",
    priority: "high",
    labels: ["frontend", "urgent"],
    status: "in_progress",
    displayOrder: 0,
    dependsOn: [],
    blocks: [],
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "user-1",
    createdAt: new Date(Date.now() - 3600_000).toISOString(),
    updatedAt: new Date().toISOString(),
    version: 1,
    isArchived: false,
    sprintId: null,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    progress: {
      total: 4,
      pending: 1,
      claimed: 0,
      inProgress: 1,
      submitted: 1,
      approved: 0,
      done: 1,
      failed: 0,
      rejected: 0,
      percentage: 0,
    },
    ...overrides,
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

function makeEvent(
  overrides: Partial<MissionEvent> & { id: string; missionId: string },
): MissionEvent {
  return {
    actorType: "system",
    actorId: "user-1",
    action: "created",
    fromColumnId: null,
    toColumnId: null,
    fromStatus: null,
    toStatus: null,
    metadata: {},
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

const { mockFeatureDetails, mockOpenModal, mockCommentsList } = vi.hoisted(() => ({
  mockFeatureDetails: vi.fn(),
  mockOpenModal: vi.fn(),
  mockCommentsList: vi.fn(),
}));

vi.mock("../api/index.js", () => ({
  api: {
    missions: {
      details: (...args: any[]) => mockFeatureDetails(...args),
    },
    comments: {
      list: (...args: any[]) => mockCommentsList(...args),
      create: vi.fn().mockResolvedValue({}),
    },
    featureComments: {
      list: vi.fn().mockResolvedValue({ comments: [], total: 0 }),
    },
    pulse: {
      digest: vi.fn().mockResolvedValue({ pulses: [], total: 0 }),
    },
  },
}));

vi.mock("../store/modalStore.js", () => ({
  useModalStore: (selector: any) => selector({ openModal: mockOpenModal }),
}));

vi.mock("../store/habitatStore.js", () => ({
  useHabitatStore: (selector: any) => selector({ agents: [] }),
}));

vi.mock("../components/ui/Button.js", () => ({
  Button: ({ children, onClick, ...props }: any) => (
    <button onClick={onClick} {...props}>
      {children}
    </button>
  ),
}));

vi.mock("../components/ui/Badge.js", () => ({
  Badge: ({ children, variant }: any) => (
    <span data-testid="badge" data-variant={variant}>
      {children}
    </span>
  ),
}));

vi.mock("lucide-react", () => ({
  ArrowLeft: () => <span data-testid="icon-arrow-left">←</span>,
  Loader2: ({ className }: any) => (
    <span data-testid="icon-loader" className={className}>
      ⟳
    </span>
  ),
  AlertCircle: () => <span data-testid="icon-alert">!</span>,
  Clock: () => <span data-testid="icon-clock">◷</span>,
  Tag: () => <span data-testid="icon-tag">🏷</span>,
  Calendar: () => <span data-testid="icon-calendar">📅</span>,
  BarChart3: () => <span data-testid="icon-chart">📊</span>,
  CheckCircle2: () => <span data-testid="icon-check">✓</span>,
  XCircle: () => <span data-testid="icon-x">✗</span>,
  Circle: () => <span data-testid="icon-circle">○</span>,
  Timer: () => <span data-testid="icon-timer">⏱</span>,
  Send: () => <span data-testid="icon-send">→</span>,
  Code: () => <span data-testid="icon-code">&lt;/&gt;</span>,
  FileCode: () => <span data-testid="icon-file-code">📄</span>,
  Bot: () => <span data-testid="icon-bot">🤖</span>,
  CheckCircle: () => <span data-testid="icon-check-circle">✓</span>,
  AlertTriangle: () => <span data-testid="icon-alert-triangle">⚠</span>,
  Info: () => <span data-testid="icon-info">ℹ</span>,
  Settings: () => <span data-testid="icon-settings">⚙</span>,
  ArrowRight: () => <span data-testid="icon-arrow-right">→</span>,
  Radio: () => <span data-testid="icon-radio">📻</span>,
  Activity: () => <span data-testid="icon-activity">📈</span>,
  ListTodo: () => <span data-testid="icon-list-todo">☑</span>,
  MessageSquare: () => <span data-testid="icon-message-square">💬</span>,
  Search: () => <span data-testid="icon-search">🔍</span>,
  ShieldAlert: () => <span data-testid="icon-shield-alert">🛡</span>,
  Handshake: () => <span data-testid="icon-handshake">🤝</span>,
  TriangleAlert: () => <span data-testid="icon-triangle-alert">⚠</span>,
  HelpCircle: () => <span data-testid="icon-help-circle">❓</span>,
  MessageCircle: () => <span data-testid="icon-message-circle">🗨</span>,
  Command: () => <span data-testid="icon-command">⌘</span>,
  ArrowRightLeft: () => <span data-testid="icon-arrow-right-left">↔</span>,
  ExternalLink: () => <span data-testid="icon-external-link">🔗</span>,
  Plus: () => <span data-testid="icon-plus">+</span>,
  ChevronDown: () => <span data-testid="icon-chevron-down">▼</span>,
  ChevronRight: () => <span data-testid="icon-chevron-right">▶</span>,
  X: () => <span data-testid="icon-x-close">✕</span>,
  Eye: () => <span data-testid="icon-eye">👁</span>,
  EyeOff: () => <span data-testid="icon-eye-off">🚫</span>,
  Shield: () => <span data-testid="icon-shield">🛡</span>,
  ThumbsUp: () => <span data-testid="icon-thumbs-up">👍</span>,
  Reply: () => <span data-testid="icon-reply">↩</span>,
  User: () => <span data-testid="icon-user">👤</span>,
  Pencil: () => <span data-testid="icon-pencil">✏</span>,
  Trash2: () => <span data-testid="icon-trash2">🗑</span>,
  Lightbulb: () => <span data-testid="icon-lightbulb">💡</span>,
  GitBranch: () => <span data-testid="icon-git-branch">⎇</span>,
  ScanLine: () => <span data-testid="icon-scan-line">📡</span>,
}));

function renderWithProviders(
  initialPath = "/missions/feat-123",
  options: { queryClient?: QueryClient } = {},
) {
  const qc =
    options.queryClient ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <Routes>
          <Route path="/missions/:id" element={<MissionDetailPage />} />
          <Route path="/boards/:habitatId" element={<div>Board Page</div>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("MissionDetailPage", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-06-15T14:30:00Z"));
    mockCommentsList.mockResolvedValue({ comments: [], total: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    mockFeatureDetails.mockReset();
    mockOpenModal.mockReset();
    mockCommentsList.mockReset();
  });

  it("shows loading skeleton while fetching", async () => {
    mockFeatureDetails.mockReturnValue(new Promise(() => {}));

    const { container } = renderWithProviders();

    expect(container.querySelector(".animate-pulse")).toBeTruthy();
  });

  it("fetches feature details on mount with correct id", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders("/missions/feat-123");

    await waitFor(() => {
      expect(mockFeatureDetails).toHaveBeenCalledWith("feat-123");
    });
  });

  it("renders 3-panel grid layout", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    const { container } = renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("Test Feature")).toBeTruthy();
    });

    const asideElements = container.querySelectorAll("aside");
    expect(asideElements.length).toBe(2);
  });

  it("renders pipeline context sidebar with task list", async () => {
    const feature = makeFeature({ id: "feat-123" });
    const tasks = [
      makeTask({
        id: "task-1",
        missionId: "feat-123",
        status: "in_progress",
        title: "Active Task",
      }),
      makeTask({ id: "task-2", missionId: "feat-123", status: "done", title: "Done Task" }),
    ];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events: [],
      progress: { completed: 1, total: 2, percentage: 50, byStatus: { in_progress: 1, done: 1 } },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("Pipeline Context")).toBeTruthy();
      expect(screen.getAllByText("Active Task").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Done Task").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders risk analysis sidebar with projected impact", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("Risk Analysis")).toBeTruthy();
      expect(screen.getByText("Projected Impact")).toBeTruthy();
    });
  });

  it("renders code review section", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("Code Review")).toBeTruthy();
    });
  });

  it("renders agent reasoning trace section", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("Agent Reasoning Trace")).toBeTruthy();
    });
  });

  it("renders comment input bar at bottom", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByPlaceholderText("Add a review comment...")).toBeTruthy();
    });
  });

  it("renders feature header with title and status", async () => {
    const feature = makeFeature({
      id: "feat-123",
      title: "My Feature",
      status: "in_progress",
      priority: "high",
    });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("My Feature")).toBeTruthy();
    });
  });

  it("renders feature description", async () => {
    const feature = makeFeature({
      id: "feat-123",
      description: "Detailed description of the feature",
    });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("Detailed description of the feature")).toBeTruthy();
    });
  });

  it("renders labels when present", async () => {
    const feature = makeFeature({
      id: "feat-123",
      labels: ["frontend", "bug"],
    });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("frontend")).toBeTruthy();
      expect(screen.getByText("bug")).toBeTruthy();
    });
  });

  it("renders metrics with completion percentage", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 3, total: 4, percentage: 75, byStatus: { done: 3, pending: 1 } },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("75%")).toBeTruthy();
      expect(screen.getByText("3 / 4 tasks")).toBeTruthy();
    });
  });

  it("renders metrics showing blocked dependencies", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 1, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: ["feat-999"], blocks: ["feat-888"] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("1 blocked")).toBeTruthy();
    });
  });

  it("renders read-only kanban with 4 columns", async () => {
    const feature = makeFeature({ id: "feat-123" });
    const tasks = [
      makeTask({ id: "task-1", missionId: "feat-123", status: "pending", title: "Pending Task" }),
      makeTask({
        id: "task-2",
        missionId: "feat-123",
        status: "in_progress",
        title: "Active Task",
      }),
      makeTask({ id: "task-3", missionId: "feat-123", status: "submitted", title: "Review Task" }),
      makeTask({ id: "task-4", missionId: "feat-123", status: "done", title: "Done Task" }),
    ];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events: [],
      progress: {
        completed: 1,
        total: 4,
        percentage: 25,
        byStatus: { pending: 1, in_progress: 1, submitted: 1, done: 1 },
      },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getAllByText("Pending Task").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Active Task").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Review Task").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Done Task").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("opens the portable task modal from a feature task click", async () => {
    const feature = makeFeature({ id: "feat-123" });
    const tasks = [
      makeTask({
        id: "task-feature-open",
        missionId: "feat-123",
        status: "pending",
        title: "Open From Feature",
      }),
    ];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events: [],
      progress: { completed: 0, total: 1, percentage: 0, byStatus: { pending: 1 } },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getAllByText("Open From Feature").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("Open From Feature")[0]);
    expect(mockOpenModal).toHaveBeenCalledWith("task-feature-open");
  });

  it("renders total task count in kanban header", async () => {
    const feature = makeFeature({ id: "feat-123" });
    const tasks = [
      makeTask({ id: "task-1", missionId: "feat-123", status: "pending" }),
      makeTask({ id: "task-2", missionId: "feat-123", status: "done" }),
    ];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events: [],
      progress: { completed: 1, total: 2, percentage: 50, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("2 tasks")).toBeTruthy();
    });
  });

  it("renders task ID prefix in task cards", async () => {
    const feature = makeFeature({ id: "feat-123" });
    const tasks = [
      makeTask({ id: "task-abcd1234", missionId: "feat-123", status: "pending", title: "A Task" }),
    ];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events: [],
      progress: { completed: 0, total: 1, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getAllByText("#task").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders estimated minutes on tasks that have them", async () => {
    const feature = makeFeature({ id: "feat-123" });
    const tasks = [
      makeTask({
        id: "task-1",
        missionId: "feat-123",
        status: "pending",
        title: "Timed Task",
        estimatedMinutes: 30,
      }),
    ];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events: [],
      progress: { completed: 0, total: 1, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getAllByText("~30m").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders configure gates button in risk sidebar", async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("Configure Gates")).toBeTruthy();
    });
  });

  it('shows "No review comments yet" when no comments exist', async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("No review comments yet")).toBeTruthy();
    });
  });

  it('shows "No agent reasoning yet" when no agent comments exist', async () => {
    const feature = makeFeature({ id: "feat-123" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getByText("No agent reasoning yet")).toBeTruthy();
    });
  });
});

describe("MissionDetailPage integration", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date("2024-06-15T14:30:00Z"));
    mockCommentsList.mockResolvedValue({ comments: [], total: 0 });
  });

  afterEach(() => {
    vi.useRealTimers();
    cleanup();
    mockFeatureDetails.mockReset();
    mockOpenModal.mockReset();
    mockCommentsList.mockReset();
  });

  it("navigates to /missions/:id and shows feature detail", async () => {
    const feature = makeFeature({
      id: "feat-456",
      title: "Integration Feature",
      status: "review",
    });
    const tasks = [
      makeTask({
        id: "task-10",
        missionId: "feat-456",
        status: "submitted",
        title: "Integration Task",
      }),
    ];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events: [],
      progress: { completed: 0, total: 1, percentage: 0, byStatus: { submitted: 1 } },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders("/missions/feat-456");

    await waitFor(() => {
      expect(screen.getByText("Integration Feature")).toBeTruthy();
      expect(screen.getAllByText("Integration Task").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("renders complete page with all sections", async () => {
    const feature = makeFeature({
      id: "feat-789",
      title: "Full Page Feature",
      priority: "critical",
      labels: ["infra"],
    });
    const tasks = [
      makeTask({ id: "task-a", missionId: "feat-789", status: "pending", title: "Setup task" }),
      makeTask({ id: "task-b", missionId: "feat-789", status: "in_progress", title: "Build task" }),
      makeTask({ id: "task-c", missionId: "feat-789", status: "done", title: "Done task" }),
    ];
    const events = [makeEvent({ id: "evt-1", missionId: "feat-789", action: "created" })];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events,
      progress: {
        completed: 1,
        total: 3,
        percentage: 33,
        byStatus: { pending: 1, in_progress: 1, done: 1 },
      },
      dependencies: { dependsOn: ["feat-other"], blocks: [] },
    });

    renderWithProviders("/missions/feat-789");

    await waitFor(() => {
      expect(screen.getByText("Full Page Feature")).toBeTruthy();
    });

    expect(screen.getByText("33%")).toBeTruthy();
    expect(screen.getByText("1 / 3 tasks")).toBeTruthy();
    expect(screen.getAllByText("Setup task").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Build task").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("Done task").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Pipeline Context")).toBeTruthy();
    expect(screen.getByText("Risk Analysis")).toBeTruthy();
    expect(screen.getByText("Code Review")).toBeTruthy();
    expect(screen.getByText("Agent Reasoning Trace")).toBeTruthy();
  });

  it("task click in pipeline sidebar opens TaskDetailModal", async () => {
    const feature = makeFeature({ id: "feat-123" });
    const tasks = [
      makeTask({
        id: "task-sidebar",
        missionId: "feat-123",
        status: "pending",
        title: "Sidebar Task",
      }),
    ];
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks,
      events: [],
      progress: { completed: 0, total: 1, percentage: 0, byStatus: { pending: 1 } },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      expect(screen.getAllByText("Sidebar Task").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(screen.getAllByText("Sidebar Task")[0]);
    expect(mockOpenModal).toHaveBeenCalledWith("task-sidebar");
  });

  it("shows 404 error for not found mission", async () => {
    mockFeatureDetails.mockRejectedValue(new Error("Not Found"));

    renderWithProviders("/missions/nonexistent");

    await waitFor(() => {
      expect(screen.getByText("Mission not found")).toBeTruthy();
    });
  });

  it("shows generic error on fetch failure", async () => {
    mockFeatureDetails.mockRejectedValue(new Error("Network error"));

    renderWithProviders("/missions/feat-123");

    await waitFor(() => {
      expect(screen.getByText("Failed to load mission")).toBeTruthy();
    });
  });

  it("renders back to habitat link", async () => {
    const feature = makeFeature({ id: "feat-123", habitatId: "habitat-1" });
    mockFeatureDetails.mockResolvedValue({
      feature,
      tasks: [],
      events: [],
      progress: { completed: 0, total: 0, percentage: 0, byStatus: {} },
      dependencies: { dependsOn: [], blocks: [] },
    });

    renderWithProviders();

    await waitFor(() => {
      const backLink = screen.getByText("Back to Habitat").closest("a");
      expect(backLink?.getAttribute("href")).toBe("/boards/habitat-1");
    });
  });
});
