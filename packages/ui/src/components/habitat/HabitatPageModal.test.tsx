import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HabitatPage } from "./HabitatPage.js";

vi.mock("../../lib/useHabitatData.js", () => ({
  useHabitat: () => ({
    data: { habitat: { id: "board-1", name: "Test Board" }, columns: [], missions: [] },
    isLoading: false,
    error: null,
  }),
}));

vi.mock("../../api/index.js", () => ({
  api: {
    habitats: {
      get: vi.fn().mockResolvedValue({
        habitat: { id: "board-1", name: "Test Board" },
        columns: [],
        missions: [],
      }),
    },
    agents: { list: vi.fn().mockResolvedValue([]) },
    missions: { list: vi.fn().mockResolvedValue({ missions: [] }) },
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

const mockBoardStoreState: Record<string, any> = {
  board: { id: "board-1", name: "Test Board" },
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
  setBoard: vi.fn(),
  setAgents: vi.fn(),
  setLoading: vi.fn(),
  setError: vi.fn(),
  updateColumn: vi.fn(),
  updateBoard: vi.fn(),
  addColumn: vi.fn(),
  removeColumn: vi.fn(),
  setColumnPagination: vi.fn(),
  setColumnLoadingMore: vi.fn(),
  clearColumnPagination: vi.fn(),
  setBulkSelectMode: vi.fn(),
};

const useHabitatStoreMock = vi.fn((selector?: any) => {
  if (selector) return selector(mockBoardStoreState);
  return mockBoardStoreState;
});

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: (...args: any[]) => useHabitatStoreMock(...args),
}));

const mockOpenModal = vi.fn();
const mockCloseModal = vi.fn();
const mockSetModalTask = vi.fn();

let modalStoreState: Record<string, any> = {
  isOpen: false,
  selectedTaskId: null,
  modalTask: null,
  isLoading: false,
  openModal: mockOpenModal,
  closeModal: mockCloseModal,
  setModalTask: mockSetModalTask,
};

const useModalStoreMock = vi.fn((selector?: any) =>
  selector ? selector(modalStoreState) : modalStoreState,
);

vi.mock("../../store/modalStore.js", () => ({
  useModalStore: (selector?: any) => useModalStoreMock(selector),
}));

vi.mock("./TaskDetailModal.js", () => ({
  TaskDetailModal: () => <div data-testid="task-detail-modal" />,
}));

vi.mock("./TaskDetailPanel.js", () => ({
  TaskDetailPanel: () => <div data-testid="task-detail-panel" />,
}));

vi.mock("./Habitat.js", () => ({
  Habitat: () => <div data-testid="habitat" />,
}));

vi.mock("./FilterBar.js", () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
}));

vi.mock("./SideNavBar.js", () => ({
  SideNavBar: () => <div data-testid="side-nav-bar" />,
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

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("HabitatPage Modal Integration", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    modalStoreState = {
      isOpen: false,
      selectedTaskId: null,
      modalTask: null,
      isLoading: false,
      openModal: mockOpenModal,
      closeModal: mockCloseModal,
      setModalTask: mockSetModalTask,
    };
    mockBoardStoreState.isBulkSelectMode = false;
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render TaskDetailModal directly because AppShell owns the portable modal", () => {
    renderWithQC(<HabitatPage />);
    expect(screen.queryByTestId("task-detail-modal")).toBeNull();
  });

  it("does not render TaskDetailPanel", () => {
    renderWithQC(<HabitatPage />);
    expect(screen.queryByTestId("task-detail-panel")).toBeNull();
  });

  it("does not render feature drawer", () => {
    renderWithQC(<HabitatPage />);
    expect(screen.queryByTestId("feature-detail-panel")).toBeNull();
  });

  it("keeps TaskDetailModal out of the HabitatPage subtree", () => {
    modalStoreState.isOpen = false;
    renderWithQC(<HabitatPage />);
    expect(screen.queryByTestId("task-detail-modal")).toBeNull();
  });
});
