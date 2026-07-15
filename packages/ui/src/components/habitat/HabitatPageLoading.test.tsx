import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import React from "react";
import { HabitatPage } from "./HabitatPage.js";

const mocks = {
  missionsList: vi.fn(),
  habitatsGet: vi.fn(),
  agentsList: vi.fn(),
};

const mockBoard = { id: "board-1", name: "Test Board" };
let mockBoardData: any = { habitat: mockBoard, columns: [], missions: [] };
let mockUseBoardLoading = false;
let mockUseBoardError = false;
let mockUseBoardErrorMsg: string | null = null;

vi.mock("../../lib/useHabitatData.js", () => ({
  useHabitat: () => ({
    data: mockUseBoardLoading ? undefined : mockBoardData,
    isLoading: mockUseBoardLoading,
    isError: mockUseBoardError,
    error: mockUseBoardError ? new Error(mockUseBoardErrorMsg ?? "Unknown error") : null,
  }),
}));

vi.mock("../../lib/queryKeys.js", () => ({
  queryKeys: {
    habitats: {
      detail: () => ["habitats", "detail", "board-1"],
    },
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  };
});

vi.mock("../../api/index.js", () => ({
  api: {
    habitats: { get: (...args: any[]) => mocks.habitatsGet(...args) },
    agents: { list: (...args: any[]) => mocks.agentsList(...args) },
    missions: { list: (...args: any[]) => mocks.missionsList(...args) },
  },
}));

vi.mock("./HabitatPulsePanel.js", () => ({ HabitatPulsePanel: () => null }));
vi.mock("./InsightsPanel.js", () => ({ InsightsPanel: () => null }));
vi.mock("./SkillPanel.js", () => ({ SkillPanel: () => null }));
vi.mock("./HealthScoreWidget.js", () => ({ HealthScoreWidget: () => null }));
vi.mock("./SprintSelector.js", () => ({ SprintSelector: () => null }));
vi.mock("./SprintPlanningPanel.js", () => ({ SprintPlanningPanel: () => null }));
vi.mock("../../hooks/useSSE.js", () => ({ useSSE: vi.fn() }));
vi.mock("../../hooks/useSSENotifications.js", () => ({ useSSENotifications: vi.fn() }));
vi.mock("../../hooks/usePresence.js", () => ({ usePresence: vi.fn() }));
vi.mock("../../hooks/useMediaQuery.js", () => ({ useIsMobile: vi.fn(() => false) }));
vi.mock("../../components/layout/DrawerBridgeContext.js", () => ({
  useRegisterDrawerBridge: () => () => () => undefined,
  DrawerBridgeProvider: ({ children }: any) => children,
}));

vi.mock("react-router-dom", () => ({
  useParams: vi.fn(() => ({ habitatId: "board-1" })),
  useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: "/board/board-1", search: "", hash: "", state: null })),
}));

const storeActions = {
  setColumnPagination: vi.fn(),
  clearColumnPagination: vi.fn(),
  setBulkSelectMode: vi.fn(),
  clearTaskSelection: vi.fn(),
};

let mockStoreState: Record<string, any>;

const useHabitatStoreMock = vi.fn((selector?: any) => {
  if (selector) return selector(mockStoreState);
  return mockStoreState;
});

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: (...args: any[]) => useHabitatStoreMock(...args),
}));

vi.mock("../../store/modalStore.js", () => ({
  useModalStore: vi.fn(() => ({
    isOpen: false,
    selectedTaskId: null,
    modalTask: null,
    isLoading: false,
    openModal: vi.fn(),
    closeModal: vi.fn(),
    setModalTask: vi.fn(),
    getState: vi.fn(() => ({ isOpen: false })),
  })),
}));

vi.mock("./Habitat.js", () => ({
  Habitat: () => <div data-testid="habitat" />,
}));
vi.mock("./FilterBar.js", () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
}));
vi.mock("./TaskDetailModal.js", () => ({
  TaskDetailModal: () => null,
}));
vi.mock("../ui/Button.js", () => ({
  Button: ({ children, ...props }: any) => <button {...props}>{children}</button>,
}));
vi.mock("../ui/HelpDrawer.js", () => ({
  HelpDrawer: ({ children }: any) => <div>{children}</div>,
}));
vi.mock("../ui/HelpContent.js", () => ({
  HelpContent: () => <div />,
}));
vi.mock("./BulkActionBar.js", () => ({
  BulkActionBar: () => <div />,
}));
vi.mock("./MobileNav.js", () => ({
  MobileNav: () => <div />,
}));

function makeFeatures(count: number, columnId: string, startId: number = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `f${startId + i}`,
    title: `Feature ${startId + i}`,
    columnId,
    habitatId: "board-1",
  }));
}

describe("HabitatPage parallel feature loading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.missionsList.mockReset();
    mocks.habitatsGet.mockReset();
    mocks.agentsList.mockReset();
    mockBoardData = {
      habitat: { id: "board-1", name: "Test Board" },
      columns: [{ id: "col-1", name: "Todo", habitatId: "board-1" }],
      missions: [],
    };
    mockUseBoardLoading = false;
    mockUseBoardError = false;
    mockUseBoardErrorMsg = null;
    mockStoreState = {
      board: null,
      columns: [],
      agents: [],
      features: [],
      tasks: [],
      isLoading: false,
      error: null,
      wipAlerts: {},
      comments: {},
      habitatEvents: [],
      columnPagination: {},
      allFeaturesLoaded: false,
      presence: [],
      isBulkSelectMode: false,
      selectedMissionIds: [],
      ...storeActions,
    };
    mocks.agentsList.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("loads first page and renders immediately", async () => {
    const features = makeFeatures(10, "col-1");
    mockBoardData.missions = features;

    await act(async () => {
      render(<HabitatPage />);
    });

    expect(storeActions.clearColumnPagination).toHaveBeenCalled();
    expect(storeActions.setColumnPagination).toHaveBeenCalledWith("col-1", {
      features,
      total: undefined,
      offset: 0,
    });
  });

  it("distributes features from board data to a single column", async () => {
    const page1 = makeFeatures(50, "col-1", 0);
    mockBoardData.missions = page1;

    const { unmount } = await act(async () => {
      return render(<HabitatPage />);
    });

    expect(storeActions.clearColumnPagination).toHaveBeenCalled();
    expect(storeActions.setColumnPagination).toHaveBeenCalledWith("col-1", {
      features: page1,
      total: undefined,
      offset: 0,
    });

    unmount();
  });

  it("does not call setColumnPagination when column has no features", async () => {
    mockBoardData.missions = [];

    await act(async () => {
      render(<HabitatPage />);
    });

    expect(storeActions.clearColumnPagination).toHaveBeenCalled();
    expect(storeActions.setColumnPagination).toHaveBeenCalledWith("col-1", {
      features: [],
      total: undefined,
      offset: 0,
    });
  });

  it("sets loading false after first page to allow board render", async () => {
    mockBoardData.missions = makeFeatures(10, "col-1");

    await act(async () => {
      render(<HabitatPage />);
    });

    expect(storeActions.setColumnPagination).toHaveBeenCalledWith(
      "col-1",
      expect.objectContaining({
        features: expect.arrayContaining([expect.objectContaining({ columnId: "col-1" })]),
      }),
    );
  });

  it("does not fetch remaining pages when total exceeds page size", async () => {
    const page1 = makeFeatures(50, "col-1", 0);
    mockBoardData.missions = page1;

    const { unmount } = await act(async () => {
      return render(<HabitatPage />);
    });

    expect(storeActions.setColumnPagination).toHaveBeenCalledWith("col-1", {
      features: page1,
      total: undefined,
      offset: 0,
    });

    unmount();
  });

  it("loads only first page features for large datasets", async () => {
    const page1 = makeFeatures(50, "col-1", 0);
    mockBoardData.missions = page1;

    const { unmount } = await act(async () => {
      return render(<HabitatPage />);
    });

    const col1Call = storeActions.setColumnPagination.mock.calls.find(
      (c: any[]) => c[0] === "col-1",
    );
    expect(col1Call).toBeDefined();
    expect(col1Call![1].features).toHaveLength(50);

    unmount();
  });

  it("handles error from initial board/agents fetch", async () => {
    mockUseBoardError = true;
    mockUseBoardErrorMsg = "Habitat not found";
    mockBoardData = null;

    await act(async () => {
      render(<HabitatPage />);
    });

    expect(storeActions.clearColumnPagination).not.toHaveBeenCalled();
  });

  it("distributes features to correct columns", async () => {
    mockBoardData = {
      habitat: { id: "board-1", name: "Test Board" },
      columns: [
        { id: "col-1", name: "Todo", habitatId: "board-1" },
        { id: "col-2", name: "Done", habitatId: "board-1" },
      ],
      missions: [...makeFeatures(3, "col-1", 0), ...makeFeatures(2, "col-2", 3)],
    };

    await act(async () => {
      render(<HabitatPage />);
    });

    const col1Calls = storeActions.setColumnPagination.mock.calls.filter(
      (c: any[]) => c[0] === "col-1",
    );
    const col2Calls = storeActions.setColumnPagination.mock.calls.filter(
      (c: any[]) => c[0] === "col-2",
    );

    expect(col1Calls[0][1].features).toHaveLength(3);
    expect(col2Calls[0][1].features).toHaveLength(2);
  });

  it("calls clearColumnPagination before distributing features", async () => {
    mockBoardData.missions = makeFeatures(10, "col-1");

    await act(async () => {
      render(<HabitatPage />);
    });

    const clearCallOrder = storeActions.clearColumnPagination.mock.invocationCallOrder[0];
    const setCallOrder = storeActions.setColumnPagination.mock.invocationCallOrder[0];
    expect(clearCallOrder).toBeLessThan(setCallOrder);
  });

  it("renders columns with first page features immediately", async () => {
    const page1 = makeFeatures(50, "col-1", 0);
    mockBoardData.missions = page1;

    await act(async () => {
      render(<HabitatPage />);
    });

    expect(storeActions.setColumnPagination).toHaveBeenCalledWith("col-1", {
      features: page1,
      total: undefined,
      offset: 0,
    });
  });
});
