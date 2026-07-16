import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { HabitatPage } from "./HabitatPage.js";

vi.mock("@tanstack/react-query", () => ({
  useQueryClient: vi.fn(() => ({
    invalidateQueries: vi.fn(),
  })),
  useQuery: vi.fn(() => ({
    data: undefined,
    isLoading: false,
  })),
}));

vi.mock("../../lib/queryKeys.js", () => ({
  queryKeys: {
    habitats: {
      detail: vi.fn(() => ["habitats", "detail"]),
      list: vi.fn(() => ["habitats", "list"]),
    },
    agents: {
      list: vi.fn(() => ["agents", "list"]),
    },
    tasks: {
      detail: vi.fn(() => ["tasks", "detail"]),
    },
    missions: {
      detail: vi.fn(() => ["missions", "detail"]),
    },
  },
}));

vi.mock("../../api/index.js", () => ({
  api: {
    habitats: {
      get: vi.fn().mockResolvedValue({
        board: { id: "board-1", name: "Test Board" },
        columns: [],
        features: [],
      }),
    },
    agents: { list: vi.fn().mockResolvedValue([]) },
    missions: { list: vi.fn().mockResolvedValue({ features: [] }) },
  },
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useHabitat: () => ({
    data: {
      board: { id: "board-1", name: "Test Board" },
      columns: [],
      features: [],
    },
    isLoading: false,
    error: null,
  }),
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

let mockSearchParams = new URLSearchParams();
const mockSetSearchParams = vi.fn((updater: any) => {
  if (typeof updater === "function") {
    mockSearchParams = updater(mockSearchParams);
  } else {
    mockSearchParams = updater;
  }
});

vi.mock("react-router-dom", () => ({
  useParams: vi.fn(() => ({ habitatId: "board-1" })),
  useSearchParams: vi.fn(() => [mockSearchParams, mockSetSearchParams]),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: "/board/board-1", search: "", hash: "", state: null })),
}));

const clearTaskSelectionMock = vi.fn();

const mockBoardStoreState: Record<string, any> = {
  isLoading: false,
  error: null,
  wipAlerts: {},
  presence: [],
  isBulkSelectMode: false,
  selectedMissionIds: [],
  selectedTaskIds: [],
  setBulkSelectMode: vi.fn(),
  clearMissionSelection: vi.fn(),
  clearSelectionOnHabitatChange: vi.fn(),
  clearTaskSelection: clearTaskSelectionMock,
};

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: (...args: any[]) => {
    const selector = args[0];
    return selector ? selector(mockBoardStoreState) : mockBoardStoreState;
  },
}));

vi.mock("../../store/modalStore.js", () => ({
  useModalStore: (selector?: any) =>
    selector
      ? selector({ isOpen: false, closeModal: vi.fn() })
      : { isOpen: false, closeModal: vi.fn() },
}));

vi.mock("./Habitat.js", () => ({
  Habitat: () => <div data-testid="habitat" />,
}));

vi.mock("./FilterBar.js", () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
}));

vi.mock("./TaskTableView.js", () => ({
  TaskTableView: ({ habitatId }: { habitatId: string }) => (
    <div data-testid="task-table-view" data-board-id={habitatId} />
  ),
}));

vi.mock("./TaskDetailModal.js", () => ({
  TaskDetailModal: () => null,
}));

vi.mock("./TaskDetailPanel.js", () => ({
  TaskDetailPanel: () => null,
}));

vi.mock("./SideNavBar.js", () => ({
  SideNavBar: () => <div />,
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

describe("HabitatPage view toggle", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockSearchParams = new URLSearchParams();
    mockBoardStoreState.isLoading = false;
    clearTaskSelectionMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("defaults to board view when no view param", () => {
    render(<HabitatPage />);
    expect(screen.getByTestId("habitat")).toBeTruthy();
    expect(screen.queryByTestId("task-table-view")).toBeNull();
  });

  it("renders TaskTableView when ?view=table", () => {
    mockSearchParams = new URLSearchParams("view=table");
    render(<HabitatPage />);
    expect(screen.getByTestId("task-table-view")).toBeTruthy();
    expect(screen.getByTestId("task-table-view").getAttribute("data-board-id")).toBe("board-1");
    expect(screen.queryByTestId("habitat")).toBeNull();
  });

  it("renders kanban when ?view=board", () => {
    mockSearchParams = new URLSearchParams("view=board");
    render(<HabitatPage />);
    expect(screen.getByTestId("habitat")).toBeTruthy();
    expect(screen.queryByTestId("task-table-view")).toBeNull();
  });

  it("clears task selection when switching from table to board", () => {
    const { rerender } = render(<HabitatPage />);
    expect(clearTaskSelectionMock).not.toHaveBeenCalled();

    mockSearchParams = new URLSearchParams("view=table");
    rerender(<HabitatPage />);
    expect(clearTaskSelectionMock).toHaveBeenCalledTimes(1);

    clearTaskSelectionMock.mockClear();
    mockSearchParams = new URLSearchParams("view=board");
    rerender(<HabitatPage />);
    expect(clearTaskSelectionMock).toHaveBeenCalledTimes(1);
  });

  it("clears task selection when switching from board to table", () => {
    mockSearchParams = new URLSearchParams();
    const { rerender } = render(<HabitatPage />);

    mockSearchParams = new URLSearchParams("view=table");
    rerender(<HabitatPage />);
    expect(clearTaskSelectionMock).toHaveBeenCalled();
  });
});
