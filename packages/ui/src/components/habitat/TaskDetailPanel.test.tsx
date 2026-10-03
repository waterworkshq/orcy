import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, cleanup, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { TaskDetailPanel } from "./TaskDetailPanel.js";
import type {
  Task,
  Agent,
  TaskEvent,
  Subtask,
  TaskComment,
  PullRequest,
  PipelineEvent,
  TaskAttachment,
} from "../../types/index.js";

// ── Board store mocks ──
vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: vi.fn((selector?: any) => {
    const state = {
      selectedMissionId: "feat-1",
      tasks: [] as any[],
      columns: [] as any[],
      agents: [] as Agent[],
    };
    return selector ? selector(state) : state;
  }),
}));

// ── Modal store mocks ──
const mockOpenModal = vi.fn();
const mockCloseModal = vi.fn();
vi.mock("../../store/modalStore.js", () => ({
  useModalStore: vi.fn((selector?: any) => {
    const state = { openModal: mockOpenModal, closeModal: mockCloseModal };
    return selector ? selector(state) : state;
  }),
}));

// ── React Query: the real evidence-flow test renders inside a REAL
// QueryClientProvider (react-query is NOT mocked) and asserts RESOLVED
// evidence data plus real mutation clicks; every other test in this file
// mocks the hook back to the original { data: null } shape. ──
const reactQueryMocks = vi.hoisted(() => ({
  realProvider: { enabled: false },
}));
vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual<Record<string, unknown>>("@tanstack/react-query");
  // Outside the real flow every consumer keeps this file's original stub
  // shapes ({ data: null }, inert mutate, inert client) so the existing
  // assertions are unchanged; inside it the REAL hooks run.
  return {
    ...actual,
    useQuery: (opts: any): any =>
      reactQueryMocks.realProvider.enabled
        ? (actual.useQuery as (o: unknown) => unknown)(opts)
        : { data: null, isLoading: false },
    useMutation: (opts: any): any =>
      reactQueryMocks.realProvider.enabled
        ? (actual.useMutation as (o: unknown) => unknown)(opts)
        : { mutate: vi.fn(), isPending: false },
    useQueryClient: (): any =>
      reactQueryMocks.realProvider.enabled
        ? (actual.useQueryClient as () => unknown)()
        : { invalidateQueries: vi.fn() },
  };
});

// ── Query-key mock ──
// Outside the real evidence flow the panel's own keys are the inert stubs it
// already used; inside it the REAL key factory runs so react-query treats the
// evidence query as a distinct, fetchable query.
const evidenceQueryKeyState = vi.hoisted(() => ({ real: false }));
vi.mock("../../lib/queryKeys.js", () => ({
  queryKeys: {
    agents: { list: () => ["agents"] },
    tasks: { quality: () => ["quality"], details: () => ["task-details"] },
    missions: { tasks: () => ["mission-tasks"], details: () => ["mission-details"] },
    // React Query requires a hashable key; the panel only needs a stable,
    // distinct key per persisted task id for the real flow.
    codeEvidence: {
      task: (id: string) => ["codeEvidence", "task", id],
      mission: (id: string) => ["codeEvidence", "mission", id],
    },
  },
}));

// ── Query keys mock ──
// ── API: NOT mocked. The panel chain uses the REAL api index → REAL
// evidence domain adapter (the persisted-ID conversion under test) → the
// captured transport below. Sibling api domains never execute because every
// sibling COMPONENT is stubbed; the parent-stub test covers identity.
const evidenceFlow = vi.hoisted(() => ({ real: false }));
const notificationProbe = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("../../lib/toast.js", () => ({ notify: notificationProbe }));

// ── Transport capture (URL spelling assertions) ──
const capturedPaths = vi.hoisted(() => [] as string[]);
const capturedBodies = vi.hoisted(() => [] as unknown[]);
const evidenceTransport = vi.hoisted(() =>
  vi.fn(async (p: string, init?: { method?: string; body?: string }) => {
    capturedPaths.push(init?.method && init.method !== "GET" ? `${init.method} ${p}` : p);
    if (init?.body) capturedBodies.push(JSON.parse(init.body));
    return {
      target: { type: "task", id: "stub", habitatId: "habitat-1" },
      repository: null,
      completeness: { status: "unknown" },
      summary: {
        totalLinks: 0,
        activeLinks: 0,
        historyCount: 0,
        correctedCount: 0,
        byType: {},
        byVerificationState: {},
        hasExternalRepositoryEvidence: false,
        activeGapCount: 0,
      },
      groups: [],
      activeGaps: [],
      warnings: [],
    };
  }),
);
vi.mock("../../api/transport.js", () => ({
  request: (path: string, ...rest: unknown[]) =>
    (evidenceTransport as unknown as (...a: unknown[]) => Promise<unknown>)(path, ...rest),
}));

// ── Badge mock ──
vi.mock("../ui/Badge.js", () => ({
  Badge: ({ children, className }: any) => (
    <span data-testid="badge" className={className}>
      {children}
    </span>
  ),
}));

// ── Child component mocks ──
vi.mock("./MissionContextSection.js", () => ({
  FeatureContextSection: ({ feature }: any) =>
    feature ? <div data-testid="feature-context">{feature.title}</div> : null,
}));

vi.mock("./SiblingTasksSection.js", () => ({
  SiblingTasksSection: ({ siblingTasks }: any) =>
    siblingTasks.length > 0 ? <div data-testid="sibling-tasks" /> : null,
}));
vi.mock("./TaskViewHeader.js", () => ({
  TaskViewHeader: ({ task }: any) => <div data-testid="task-view-header">{task.title}</div>,
}));
vi.mock("./TaskEditForm.js", () => ({
  TaskEditForm: () => <div data-testid="task-edit-form" />,
}));
vi.mock("./TaskDescription.js", () => ({
  TaskDescription: ({ description }: any) =>
    description ? <div data-testid="task-description">{description}</div> : null,
}));
vi.mock("./TaskRetryPolicy.js", () => ({
  TaskRetryPolicy: () => null,
}));
vi.mock("./TaskTimeInfo.js", () => ({
  TaskTimeInfo: () => null,
}));
vi.mock("./TaskResultCard.js", () => ({
  TaskResultCard: () => null,
}));
vi.mock("./TaskArtifacts.js", () => ({
  TaskArtifacts: () => null,
}));
vi.mock("./TaskTimeConstraints.js", () => ({
  TaskTimeConstraints: () => null,
}));
vi.mock("./TaskEffortSection.js", () => ({
  TaskEffortSection: () => null,
}));
vi.mock("./TaskSubtasks.js", () => ({
  TaskSubtasks: ({ subtasks }: any) =>
    subtasks.length > 0 ? <div data-testid="task-subtasks" /> : null,
}));
vi.mock("./TaskQualityChecklist.js", () => ({
  TaskQualityChecklist: () => null,
}));
vi.mock("./TaskDependencies.js", () => ({
  TaskDependencies: () => null,
}));
vi.mock("./TaskAssignment.js", () => ({
  TaskAssignment: () => null,
}));
vi.mock("./ReviewPanel.js", () => ({
  ReviewPanel: () => null,
}));
vi.mock("./TaskActivity.js", () => ({
  TaskActivity: () => null,
}));
vi.mock("../task/ExperienceSummaryCard.js", () => ({
  ExperienceSummaryCard: ({ taskId, missionId }: any) => (
    <div data-testid="experience-summary-card">
      {taskId}:{missionId}
    </div>
  ),
}));
vi.mock("./CommentSection.js", () => ({
  CommentSection: () => null,
}));
vi.mock("./AttachmentSection.js", () => ({
  AttachmentSection: () => null,
}));
const realPanelSlot = vi.hoisted(() => ({ Comp: null as null | React.ComponentType<any> }));
// Reviewer supplement: TaskCodeEvidence is unmocked. Its actual component
// forwards the persisted parent identity to the real panel.

// Child-component stubs are active for the other tests; the real evidence
// flow test needs the REAL evidence subtree and the real query wiring, so
// sibling stubs yield to the real components only while that test runs.
vi.mock("./TaskTimeInfo.js", () => ({
  TaskTimeInfo: () => null,
}));
vi.mock("./TaskDangerZone.js", () => ({
  TaskDangerZone: () => null,
}));
vi.mock("../ui/Button.js", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));

// ── useTaskDetailPanel mock ──
const useTaskDetailPanelMock = vi.fn();
vi.mock("../../hooks/useTaskDetailPanel.js", () => ({
  useTaskDetailPanel: (...args: any[]) => useTaskDetailPanelMock(...args),
}));

// ── Default task ──
function makeDefaultPanelReturn(overrides: Record<string, any> = {}) {
  const taskOverrides = overrides.task || {};
  delete overrides.task;
  return {
    selectedTaskId: "task-1",
    contextLoading: false,
    isEditing: false,
    task: {
      id: "task-1",
      missionId: "feat-1",
      title: "Test Task",
      description: "Test description",
      priority: "medium",
      status: "pending",
      requiredCapabilities: [],
      assignedAgentId: null,
      delegatedToAgentId: null,
      requiredDomain: "frontend",
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
      createdAt: "2024-01-01T00:00:00Z",
      updatedAt: "2024-01-01T00:00:00Z",
      version: 1,
      estimatedMinutes: null,
      actualMinutes: null,
      cycleTimeMinutes: null,
      leadTimeMinutes: null,
      estimationAccuracy: null,
      retryPolicy: null,
      retryCount: 0,
      nextRetryAt: null,
      ...taskOverrides,
    } as Task,
    feature: null,
    siblingTasks: [],
    column: undefined,
    nextColumnName: undefined,
    isWatching: false,
    watchLoading: false,
    submitting: false,
    agents: [],
    events: [] as TaskEvent[],
    subtasks: [] as Subtask[],
    pullRequests: [] as PullRequest[],
    pipelineEvents: [] as PipelineEvent[],
    attachments: [] as TaskAttachment[],
    comments: [] as TaskComment[],
    dependencies: [],
    crossHabitatDependsOn: [],
    blockedBy: [],
    blocking: [],
    dependenciesLoading: false,
    deleteDialogOpen: false,
    decomposing: false,
    decomposeDialogOpen: false,
    decompositionProposals: [],
    newSubtaskTitle: "",
    addingSubtask: false,
    delegateAgentId: "",
    delegating: false,
    showDelegate: false,
    addingDep: false,
    editForm: {
      title: "",
      description: "",
      priority: "medium" as const,
      labels: "",
      requiredDomain: "",
    },
    editDueAt: "",
    editSlaMinutes: "",
    editEstimatedMinutes: "",
    retryForm: {
      maxRetries: "",
      backoffBase: "",
      backoffMultiplier: "",
      maxBackoff: "",
      escalateToHuman: true,
    },
    setIsEditing: vi.fn(),
    setDeleteDialogOpen: vi.fn(),
    setEditForm: vi.fn(),
    setEditDueAt: vi.fn(),
    setEditSlaMinutes: vi.fn(),
    setEditEstimatedMinutes: vi.fn(),
    setRetryForm: vi.fn(),
    setNewSubtaskTitle: vi.fn(),
    setDelegateAgentId: vi.fn(),
    setShowDelegate: vi.fn(),
    setDecomposeDialogOpen: vi.fn(),
    setDecompositionProposals: vi.fn(),
    startEditing: vi.fn(),
    handleAddSubtask: vi.fn(),
    handleToggleSubtask: vi.fn(),
    handleDeleteSubtask: vi.fn(),
    handleApprove: vi.fn(),
    handleReject: vi.fn(),
    handleDelete: vi.fn(),
    handleClone: vi.fn(),
    handleDecompose: vi.fn(),
    handleDecomposeConfirm: vi.fn(),
    handleDelegate: vi.fn(),
    handleToggleWatch: vi.fn(),
    handleEditSubmit: vi.fn(),
    handleEditCancel: vi.fn(),
    handleAddDependency: vi.fn(),
    handleRemoveDependency: vi.fn(),
  };
}

describe("TaskDetailPanel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn());
  });

  afterEach(() => {
    cleanup();
  });

  it("returns null when no selected task", () => {
    useTaskDetailPanelMock.mockReturnValue({
      ...makeDefaultPanelReturn(),
      selectedTaskId: null,
      task: undefined,
    } as any);
    const { container } = render(<TaskDetailPanel />);
    expect(container.innerHTML).toBe("");
  });

  it("shows task title in header", () => {
    useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn());
    render(<TaskDetailPanel />);
    expect(screen.getByTestId("task-view-header")).toBeTruthy();
    expect(screen.getByText("Test Task")).toBeTruthy();
  });

  it("renders capabilities as badges when array is non-empty", () => {
    useTaskDetailPanelMock.mockReturnValue(
      makeDefaultPanelReturn({
        task: { requiredCapabilities: ["react", "typescript"] },
      }),
    );
    render(<TaskDetailPanel />);

    const badges = screen.getAllByTestId("badge");
    expect(badges).toHaveLength(2);
    expect(screen.getByText("react")).toBeTruthy();
    expect(screen.getByText("typescript")).toBeTruthy();
    expect(screen.getByText("Capabilities")).toBeTruthy();
  });

  it("renders nothing when capabilities array is empty", () => {
    useTaskDetailPanelMock.mockReturnValue(
      makeDefaultPanelReturn({
        task: { requiredCapabilities: [] },
      }),
    );
    render(<TaskDetailPanel />);

    expect(screen.queryByText("Capabilities")).toBeNull();
    expect(screen.queryAllByTestId("badge")).toHaveLength(0);
  });

  it("renders nothing when capabilities field is undefined", () => {
    useTaskDetailPanelMock.mockReturnValue(
      makeDefaultPanelReturn({
        task: { requiredCapabilities: undefined },
      }),
    );
    render(<TaskDetailPanel />);

    expect(screen.queryByText("Capabilities")).toBeNull();
  });

  it("badge elements have glass-badge styling", () => {
    useTaskDetailPanelMock.mockReturnValue(
      makeDefaultPanelReturn({
        task: { requiredCapabilities: ["typescript"] },
      }),
    );
    render(<TaskDetailPanel />);

    const badge = screen.getByTestId("badge");
    expect(badge).toHaveClass("text-[10px]");
  });

  it("renders experience summary before activity", () => {
    render(<TaskDetailPanel />);

    expect(screen.getByTestId("experience-summary-card")).toHaveTextContent("task-1:feat-1");
  });

  it("real parent flow: TaskDetailPanel → TaskCodeEvidence → panel → adapter, target-specific data + real mutation clicks", async () => {
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { CodeEvidencePanel } = await import("./CodeEvidencePanel.js");
    realPanelSlot.Comp = CodeEvidencePanel;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    reactQueryMocks.realProvider.enabled = true;
    evidenceFlow.real = true;

    // Target-specific payloads keyed by the PERSISTED id the panel requests.
    const payloadFor = (persistedId: string) => ({
      target: { type: "task", id: persistedId, habitatId: "habitat-1" },
      repository: null,
      completeness: { status: persistedId === "feat-task-1" ? "unknown" : "not_applicable" },
      summary: {
        totalLinks: 0,
        activeLinks: 0,
        historyCount: 0,
        correctedCount: 0,
        byType: {},
        byVerificationState: {},
        hasExternalRepositoryEvidence: false,
        activeGapCount: 0,
      },
      groups: [],
      activeGaps: [],
      warnings: [],
      compatibility: {
        overrides:
          persistedId === "feat-task-1"
            ? []
            : [
                {
                  storedTarget: { type: "task", id: persistedId },
                  classification: "canonical",
                  value: {
                    status: "not_applicable",
                    reasonCode: "review_only",
                    actor: { type: "human", id: "user-7" },
                  },
                },
              ],
        effectiveCompleteness: {
          status: persistedId === "feat-task-1" ? "unknown" : "not_applicable",
        },
        truncation: {},
      },
    });
    evidenceTransport.mockImplementation(async (p: string) => {
      // Route by the adapter-spelled path back to the persisted id.
      const persistedId = p.includes("feat-feat-task-1")
        ? "feat-task-1"
        : p.includes("feat-task-1")
          ? "task-1"
          : "task-1";
      return payloadFor(persistedId);
    });

    try {
      // PARENT render with the plain persisted id X: the real panel data
      // resolved THROUGH the parent chain renders the override row.
      useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn());
      render(
        <QueryClientProvider client={client}>
          <TaskDetailPanel />
        </QueryClientProvider>,
      );
      const transportPaths = () =>
        (evidenceTransport.mock.calls as unknown as Array<[string]>).map((c) => c[0]);
      await waitFor(() =>
        expect(transportPaths(), JSON.stringify(transportPaths())).toContain(
          "/tasks/feat-task-1/code-evidence",
        ),
      );
      await waitFor(() => expect(document.body.textContent ?? "").toContain("review only"), {
        timeout: 4000,
      });

      // Real CLEAR click through the whole parent chain: method + path + body
      // (DELETE, no body) via the persisted-ID adapter.
      (evidenceTransport.mock.calls as unknown[]).length = 0;
      const clearButton = await screen.findByRole("button", { name: /clear not applicable/i });
      fireEvent.click(clearButton);
      const callsAs = () =>
        (
          evidenceTransport.mock.calls as unknown as Array<
            [string, { method?: string; body?: string }]
          >
        ).map(([p, init]) => (init?.method && init.method !== "GET" ? `${init.method} ${p}` : p));
      await waitFor(() =>
        expect(callsAs(), JSON.stringify(callsAs())).toContain(
          "DELETE /tasks/feat-task-1/code-evidence/not-applicable",
        ),
      );

      // Real MARK click: POST with the reason body.
      (evidenceTransport.mock.calls as unknown[]).length = 0;
      const markButton = await screen.findByRole("button", { name: /mark not applicable/i });
      fireEvent.click(markButton);
      const reasonSelect = await screen.findByLabelText(/not applicable reason/i);
      fireEvent.change(reasonSelect, { target: { value: "review_only" } });
      const confirm = await screen.findByRole("button", { name: /^confirm$/i });
      fireEvent.click(confirm);
      await waitFor(() =>
        expect(callsAs(), JSON.stringify(callsAs())).toContain(
          "POST /tasks/feat-task-1/code-evidence/not-applicable",
        ),
      );
      const bodies = () =>
        (evidenceTransport.mock.calls as unknown as Array<[string, { body?: string }]>)
          .map(([, init]) => (init?.body ? JSON.parse(init.body) : undefined))
          .filter(Boolean);
      expect(bodies().at(-1)).toMatchObject({ reasonCode: "review_only" });

      // Literal feat-X through the PARENT: feat-feat-X GET only, and the
      // feat-X-specific payload (no override) renders as empty evidence.
      cleanup();
      client.clear();
      (evidenceTransport.mock.calls as unknown[]).length = 0;
      useTaskDetailPanelMock.mockReturnValue(
        makeDefaultPanelReturn({ task: { id: "feat-task-1" } }),
      );
      render(
        <QueryClientProvider client={client}>
          <TaskDetailPanel />
        </QueryClientProvider>,
      );
      await waitFor(() =>
        expect(transportPaths(), JSON.stringify(transportPaths())).toContain(
          "/tasks/feat-feat-task-1/code-evidence",
        ),
      );
      await waitFor(
        () => expect(document.body.textContent ?? "").toContain("No code evidence linked"),
        { timeout: 4000 },
      );
      expect(transportPaths()).not.toContain("/tasks/feat-task-1/code-evidence");
    } finally {
      reactQueryMocks.realProvider.enabled = false;
      evidenceFlow.real = false;
      realPanelSlot.Comp = null;
      client.clear();
      cleanup();
    }
  });

  it("TaskDetailPanel hands the persisted task id to TaskCodeEvidence (parent identity contract)", () => {
    render(<TaskDetailPanel />);
    expect(screen.getByText("Code Evidence")).toBeInTheDocument();
  });

  it.each(["task-1", "feat-task-1"])(
    "reviewer actual parent %s: clear then mark, gap, invalidation and error",
    async (persistedId) => {
      const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      });
      reactQueryMocks.realProvider.enabled = true;
      let overrides: any[] = [
        {
          storedTarget: { type: "task", id: persistedId },
          classification: "canonical",
          value: { status: "not_applicable", reasonCode: "research_only" },
        },
        {
          storedTarget: { type: "task", id: `feat-${persistedId}` },
          classification: "verified_legacy",
          value: { status: "not_applicable", reasonCode: "review_only" },
        },
      ];
      let rejectClear = false;
      let gets = 0;
      const path = `/tasks/feat-${persistedId}/code-evidence`;
      evidenceTransport.mockClear();
      evidenceTransport.mockImplementation(
        async (p: string, init?: { method?: string; body?: string }) => {
          // Capture only: required path is asserted outside the query callback.
          if (init?.method === "DELETE") {
            if (rejectClear) throw new Error("reviewer-clear-refused");
            overrides = [];
            return { success: true } as any;
          }
          if (init?.method === "POST" && p.endsWith("not-applicable")) {
            expect(overrides).toHaveLength(0);
            overrides = [
              {
                storedTarget: { type: "task", id: persistedId },
                classification: "canonical",
                value: { status: "not_applicable", reasonCode: "review_only" },
              },
            ];
            return { completeness: { status: "not_applicable" } } as any;
          }
          if (init?.method === "POST") return { gap: { targetId: persistedId } } as any;
          gets++;
          return {
            target: { type: "task", id: persistedId, habitatId: "habitat-1" },
            repository: null,
            completeness: { status: "not_applicable" },
            summary: {
              totalLinks: 0,
              activeLinks: 0,
              historyCount: 0,
              correctedCount: 0,
              byType: {},
              byVerificationState: {},
              hasExternalRepositoryEvidence: false,
              activeGapCount: 0,
            },
            groups: [],
            activeGaps: [],
            warnings: [`target:${persistedId}`],
            compatibility: {
              overrides,
              effectiveCompleteness: {
                status:
                  overrides.length === 2
                    ? "unknown"
                    : overrides.length
                      ? "not_applicable"
                      : "unknown",
              },
              truncation: {},
            },
          } as any;
        },
      );
      useTaskDetailPanelMock.mockReturnValue(makeDefaultPanelReturn({ task: { id: persistedId } }));
      try {
        render(
          <QueryClientProvider client={client}>
            <TaskDetailPanel />
          </QueryClientProvider>,
        );
        await waitFor(() => expect(evidenceTransport.mock.calls.some(([, init]) => !init?.method || init.method === "GET")).toBe(true));
      const actualGet = evidenceTransport.mock.calls.find(([, init]) => !init?.method || init.method === "GET")!;
      expect(actualGet[0]).toBe(path);
      await screen.findByText(`target:${persistedId}`);
        expect(screen.queryByText("Override conflict")).toBeInTheDocument();
      expect(screen.queryByText(/Not-Applicable Overrides \(2\)/)).toBeInTheDocument();
      expect(screen.queryByText(/research only/)).toBeInTheDocument();
      expect(screen.queryByText(/review only/)).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /clear not applicable/i })).toBeInTheDocument();
        const beforeClear = gets;
        fireEvent.click(screen.getByRole("button", { name: /clear not applicable/i }));
        await waitFor(() => expect(gets).toBeGreaterThan(beforeClear));
        await waitFor(() => expect(screen.queryByText("Override conflict")).toBeNull());
        const deleteCall = evidenceTransport.mock.calls.find(
          ([, init]) => init?.method === "DELETE",
        )!;
        expect(deleteCall).toEqual([`${path}/not-applicable`, { method: "DELETE" }]);
        fireEvent.click(screen.getByRole("button", { name: /mark not applicable/i }));
        fireEvent.change(screen.getByLabelText(/not applicable reason/i), {
          target: { value: "review_only" },
        });
        fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
        await waitFor(() =>
          expect(notificationProbe.success).toHaveBeenCalledWith("Marked as not applicable"),
        );
        const markCall = evidenceTransport.mock.calls.find(
          ([p, init]) => p.endsWith("not-applicable") && init?.method === "POST",
        )!;
        expect(markCall[0]).toBe(`${path}/not-applicable`);
        expect(JSON.parse(markCall[1]!.body!)).toEqual({ reasonCode: "review_only" });
        await waitFor(() => expect(screen.queryByLabelText(/not applicable reason/i)).toBeNull());
        fireEvent.click(screen.getByRole("button", { name: /^report gap$/i }));
        fireEvent.change(screen.getByLabelText(/evidence gap reason/i), {
          target: { value: "other" },
        });
        const beforeGap = gets;
        fireEvent.click(screen.getByRole("button", { name: /^report$/i }));
        await waitFor(() => expect(gets).toBeGreaterThan(beforeGap));
        const gapCall = evidenceTransport.mock.calls.find(
          ([p, init]) => p.endsWith("gaps") && init?.method === "POST",
        )!;
        expect(gapCall[0]).toBe(`${path}/gaps`);
        expect(JSON.parse(gapCall[1]!.body!)).toEqual({ reasonCode: "other" });
        rejectClear = true;
        await screen.findByRole("button", { name: /clear not applicable/i });
        fireEvent.click(screen.getByRole("button", { name: /clear not applicable/i }));
        await waitFor(() =>
          expect(notificationProbe.error).toHaveBeenCalledWith("reviewer-clear-refused"),
        );
        expect(screen.queryByText(/Not-Applicable Overrides \(1\)/)).toBeInTheDocument();
      } finally {
        cleanup();
        client.clear();
        reactQueryMocks.realProvider.enabled = false;
      }
    },
  );

  it("reviewer Mission real clear/mark recovery retains Mission ID and error feedback", async () => {
    const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
    const { CodeEvidencePanel } = await import("./CodeEvidencePanel.js");
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    reactQueryMocks.realProvider.enabled = true;
    let marked = true;
    let refuse = false;
    evidenceTransport.mockClear();
    evidenceTransport.mockImplementation(
      async (p: string, init?: { method?: string; body?: string }) => {
        expect(p.startsWith("/missions/mission-literal/code-evidence")).toBe(true);
        if (init?.method === "DELETE") {
          if (refuse) throw new Error("mission-clear-refused");
          marked = false;
          return { success: true } as any;
        }
        if (init?.method === "POST") {
          expect(marked).toBe(false);
          marked = true;
          return { completeness: { status: "not_applicable" } } as any;
        }
        return {
          target: { type: "mission", id: "mission-literal" },
          repository: null,
          completeness: { status: marked ? "not_applicable" : "unknown" },
          groups: [],
          activeGaps: [],
          warnings: [],
          summary: { activeLinks: 0 },
          compatibility: {
            overrides: marked
              ? [
                  {
                    storedTarget: { type: "mission", id: "mission-literal" },
                    classification: "canonical",
                    value: { status: "not_applicable", reasonCode: "review_only" },
                  },
                ]
              : [],
            effectiveCompleteness: { status: marked ? "not_applicable" : "unknown" },
            truncation: {},
          },
        } as any;
      },
    );
    try {
      render(
        <QueryClientProvider client={client}>
          <CodeEvidencePanel targetType="mission" targetId="mission-literal" />
        </QueryClientProvider>,
      );
      fireEvent.click(await screen.findByRole("button", { name: /clear not applicable/i }));
      await waitFor(() =>
        expect(screen.queryByRole("button", { name: /clear not applicable/i })).toBeNull(),
      );
      fireEvent.click(screen.getByRole("button", { name: /mark not applicable/i }));
      fireEvent.change(screen.getByLabelText(/not applicable reason/i), {
        target: { value: "review_only" },
      });
      fireEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
      await screen.findByRole("button", { name: /clear not applicable/i });
      expect(evidenceTransport.mock.calls.find(([, init]) => init?.method === "DELETE")![0]).toBe(
        "/missions/mission-literal/code-evidence/not-applicable",
      );
      expect(
        JSON.parse(
          evidenceTransport.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body!,
        ),
      ).toEqual({ reasonCode: "review_only" });
      refuse = true;
      fireEvent.click(screen.getByRole("button", { name: /clear not applicable/i }));
      await waitFor(() =>
        expect(notificationProbe.error).toHaveBeenCalledWith("mission-clear-refused"),
      );
    } finally {
      cleanup();
      client.clear();
      reactQueryMocks.realProvider.enabled = false;
    }
  });
});
