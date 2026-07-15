import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act, waitFor } from "@testing-library/react";
import React from "react";
import { HabitatPage } from "./HabitatPage.js";

const mocks = {
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
    missions: { list: vi.fn() },
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

let capturedHabitatProps: any = null;

vi.mock("./Habitat.js", () => ({
  Habitat: (props: any) => {
    capturedHabitatProps = props;
    return <div data-testid="habitat" />;
  },
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

describe("HabitatPage Query ownership", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    capturedHabitatProps = null;
    mockStoreState = {
      presence: [],
      isBulkSelectMode: false,
      clearTaskSelection: vi.fn(),
      setBulkSelectMode: vi.fn(),
    };
    mocks.agentsList.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
  });

  it("passes canonical habitat, columns, and missions to Habitat", async () => {
    const features = makeFeatures(10, "col-1");
    mockBoardData.missions = features;

    await act(async () => {
      render(<HabitatPage />);
    });

    expect(capturedHabitatProps).not.toBeNull();
    expect(capturedHabitatProps.habitat).toEqual(mockBoardData.habitat);
    expect(capturedHabitatProps.columns).toEqual(mockBoardData.columns);
    expect(capturedHabitatProps.missions).toEqual(features);
  });

  it("passes empty missions array when no missions exist", async () => {
    mockBoardData.missions = [];

    await act(async () => {
      render(<HabitatPage />);
    });

    expect(capturedHabitatProps.missions).toEqual([]);
  });

  it("renders loading state while Query is loading", async () => {
    mockUseBoardLoading = true;

    const { container } = await act(async () => {
      return render(<HabitatPage />);
    });

    await waitFor(() => {
      expect(container.querySelector(".animate-spin")).toBeTruthy();
    });
  });

  it("does not partition missions into columnPagination store entries", async () => {
    mockBoardData.missions = makeFeatures(50, "col-1");

    await act(async () => {
      render(<HabitatPage />);
    });

    expect(mockStoreState.setColumnPagination).toBeUndefined();
  });

  it("distributes features correctly across columns via props", async () => {
    const col1Features = makeFeatures(3, "col-1", 0);
    const col2Features = makeFeatures(2, "col-2", 3);
    mockBoardData = {
      habitat: { id: "board-1", name: "Test Board" },
      columns: [
        { id: "col-1", name: "Todo", habitatId: "board-1" },
        { id: "col-2", name: "Done", habitatId: "board-1" },
      ],
      missions: [...col1Features, ...col2Features],
    };

    await act(async () => {
      render(<HabitatPage />);
    });

    const passedMissions = capturedHabitatProps.missions;
    expect(passedMissions).toHaveLength(5);
    expect(passedMissions.filter((m: any) => m.columnId === "col-1")).toHaveLength(3);
    expect(passedMissions.filter((m: any) => m.columnId === "col-2")).toHaveLength(2);
  });
});
