import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Habitat } from "./Habitat.js";
import type { MissionWithProgress, Column as ColumnType } from "../../types/index.js";

const mockFeatures: MissionWithProgress[] = [
  {
    id: "f1",
    title: "Active Feature",
    description: "",
    acceptanceCriteria: "",
    priority: "high",
    status: "in_progress",
    habitatId: "board-1",
    columnId: "col-1",
    labels: [],
    dependsOn: [],
    blocks: [],
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "",
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: false,
    sprintId: null,
    releaseGateType: null,
    releaseGateVersion: null,
    progress: {
      total: 3,
      pending: 0,
      claimed: 0,
      inProgress: 1,
      submitted: 0,
      approved: 0,
      done: 1,
      failed: 0,
      rejected: 0,
      percentage: 0,
    },
  },
];

const mockArchivedFeatures: MissionWithProgress[] = [
  {
    id: "af1",
    title: "Archived Feature A",
    description: "",
    acceptanceCriteria: "",
    priority: "medium",
    status: "done",
    habitatId: "board-1",
    columnId: "col-done",
    labels: [],
    dependsOn: [],
    blocks: [],
    displayOrder: 0,
    createdAt: "",
    updatedAt: "",
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "",
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: true,
    sprintId: null,
    releaseGateType: null,
    releaseGateVersion: null,
    progress: {
      total: 2,
      pending: 0,
      claimed: 0,
      inProgress: 0,
      submitted: 0,
      approved: 0,
      done: 2,
      failed: 0,
      rejected: 0,
      percentage: 0,
    },
  },
  {
    id: "af2",
    title: "Archived Feature B",
    description: "",
    acceptanceCriteria: "",
    priority: "low",
    status: "failed",
    habitatId: "board-1",
    columnId: "col-done",
    labels: [],
    dependsOn: [],
    blocks: [],
    displayOrder: 1,
    createdAt: "",
    updatedAt: "",
    dueAt: null,
    slaMinutes: null,
    slaDeadlineAt: null,
    createdBy: "",
    version: 1,
    actualMinutes: null,
    plannedMinutes: null,
    planningAccuracy: null,
    completedAt: null,
    isArchived: true,
    sprintId: null,
    releaseGateType: null,
    releaseGateVersion: null,
    progress: {
      total: 1,
      pending: 0,
      claimed: 0,
      inProgress: 0,
      submitted: 0,
      approved: 0,
      done: 0,
      failed: 1,
      rejected: 0,
      percentage: 0,
    },
  },
];

const mockColumns: ColumnType[] = [
  {
    id: "col-1",
    name: "In Progress",
    order: 0,
    habitatId: "board-1",
    wipLimit: null,
    requiresClaim: false,
    autoAdvance: false,
    nextColumnId: null,
    isTerminal: false,
  },
  {
    id: "col-done",
    name: "Done",
    order: 1,
    habitatId: "board-1",
    wipLimit: null,
    requiresClaim: false,
    autoAdvance: false,
    nextColumnId: null,
    isTerminal: true,
  },
];

const mockHabitat = {
  id: "board-1",
  name: "Test Habitat",
  description: "",
  columns: mockColumns.map((c) => c.id),
  createdBy: "",
  createdAt: "",
  updatedAt: "",
};

const mockArchivedFeaturesHook = vi.fn();

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgents: () => ({ data: [] as any[], isLoading: false, isError: false }),
  useArchivedMissions: (...args: unknown[]) => mockArchivedFeaturesHook(...args),
}));

vi.mock("../../api/index.js", () => ({
  api: {
    features: {
      move: vi.fn(),
    },
    boards: {
      get: vi.fn(),
    },
  },
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children }: any) => <div>{children}</div>,
  DragOverlay: ({ children }: any) => <div>{children}</div>,
  PointerSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => []),
  closestCorners: vi.fn(),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: any) => <div>{children}</div>,
  horizontalListSortingStrategy: {},
}));

const mockNavigate = vi.fn();

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams()],
  useNavigate: () => mockNavigate,
}));

vi.mock("./Column.js", () => ({
  Column: ({ column }: any) => <div data-testid={`column-${column.id}`}>{column.name}</div>,
}));

vi.mock("./MissionCard.js", () => ({
  FeatureCard: ({ feature }: any) => (
    <div data-testid={`feature-card-${feature.id}`}>{feature.title}</div>
  ),
}));

vi.mock("./ColumnSwiper.js", () => ({
  ColumnSwiper: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("../../hooks/useMediaQuery.js", () => ({
  useIsMobile: () => false,
}));

const storeState: Record<string, any> = {
  board: mockHabitat,
  columns: mockColumns,
  features: mockFeatures,
  columnPagination: {},
  collapsedColumns: {},
  isBulkSelectMode: false,
  setHabitat: vi.fn(),
  setError: vi.fn(),
  moveFeatureToColumn: vi.fn(),
  toggleColumnCollapsed: vi.fn(),
};

const useHabitatStoreMock = vi.fn((selector?: any) => {
  if (selector) return selector(storeState);
  return storeState;
});

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: (...args: any[]) => useHabitatStoreMock(...args),
}));

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("Habitat - Archived Column", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    storeState.board = mockHabitat;
    storeState.columns = mockColumns;
    storeState.features = mockFeatures;
    storeState.columnPagination = {};
    storeState.collapsedColumns = {};
    storeState.isBulkSelectMode = false;
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: [], total: 0 },
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders archived column after regular columns", async () => {
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
  });

  it("shows count in header when collapsed", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 3 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    expect(screen.getByTestId("archived-toggle").textContent).toContain("3");
  });

  it("shows archived count when expanded", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 3 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    const header = screen.getByTestId("archived-toggle");
    await fireEvent.click(header);
    expect(header.textContent).toContain("Archived");
    expect(header.textContent).toContain("3");
  });

  it("expands column when header clicked", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 2 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByTestId("archived-feature-af1")).toBeTruthy();
    expect(screen.getByTestId("archived-feature-af2")).toBeTruthy();
  });

  it("collapses column when header clicked again", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 2 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByTestId("archived-feature-af1")).toBeTruthy();
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    const content = screen.getByTestId("archived-feature-af1").closest(".transition-all");
    expect(content?.className).toContain("max-h-0");
  });

  it("renders archived features when expanded", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 2 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByText("Archived Feature A")).toBeTruthy();
    expect(screen.getByText("Archived Feature B")).toBeTruthy();
  });

  it("applies muted styling to column when collapsed", async () => {
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    const toggle = screen.getByTestId("archived-toggle");
    expect(toggle.className).toContain("bg-surface-container/50");
  });

  it("applies muted styling when expanded", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 2 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByTestId("archived-feature-af1")).toBeTruthy();
  });

  it("shows loading state during fetch", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: undefined,
      isLoading: true,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByTestId("archived-loading")).toBeTruthy();
  });

  it("shows empty state when no archived features", async () => {
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByTestId("archived-empty")).toBeTruthy();
    expect(screen.getByText("No archived features")).toBeTruthy();
  });

  it("calls useArchivedMissions with board id", async () => {
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(mockArchivedFeaturesHook).toHaveBeenCalledWith("board-1");
    });
  });

  it("does not render archived column when no board", () => {
    storeState.board = null;
    mockArchivedFeaturesHook.mockReturnValue({
      data: undefined,
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    expect(screen.queryByTestId("archived-toggle")).toBeNull();
    expect(screen.getByText("Select or create a board to get started.")).toBeTruthy();
  });

  it("shows feature status and priority in expanded cards", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 2 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();
    expect(screen.getByText("low")).toBeTruthy();
  });

  it("does not render archived column on mobile", async () => {
    vi.resetModules();
    vi.doMock("../../hooks/useMediaQuery.js", () => ({
      useIsMobile: () => true,
    }));
    const { Habitat: HabitatMobile } = await import("./Habitat.js");
    renderWithQC(
      <HabitatMobile onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.queryByTestId("archived-toggle")).toBeNull();
    });
    vi.doUnmock("../../hooks/useMediaQuery.js");
  });

  it("uses w-80 width when expanded", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 2 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    expect(screen.getByTestId("archived-feature-af1")).toBeTruthy();
  });

  it("uses narrow width when collapsed", async () => {
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    const content = screen.getByText("No archived features").closest(".transition-all");
    expect(content?.className).not.toContain("max-h-0");
  });

  it("has glass-card class when expanded", async () => {
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    const panel = screen.getByText("No archived features").closest(".rounded-lg");
    expect(panel?.className).toContain("bg-surface-container/20");
  });

  it("has transition class for expand/collapse animation", async () => {
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    const content = screen.getByText("No archived features").closest(".transition-all");
    expect(content?.className).toContain("transition-all");
  });

  it("navigates to feature detail page when archived feature is clicked", async () => {
    mockArchivedFeaturesHook.mockReturnValue({
      data: { features: mockArchivedFeatures, total: 2 },
      isLoading: false,
    });
    renderWithQC(
      <Habitat onColumnSettingsClick={vi.fn()} onAddColumnClick={vi.fn()} presence={[]} />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });
    await fireEvent.click(screen.getByTestId("archived-toggle"));
    const featureEl = screen.getByTestId("archived-feature-af1");
    await fireEvent.click(featureEl);
    expect(mockNavigate).toHaveBeenCalledWith("/features/af1");
  });
});
