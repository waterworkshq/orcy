import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HabitatPage } from "./HabitatPage.js";
import { useIsMobile } from "../../hooks/useMediaQuery.js";

const mockArchivedFeaturesHook = vi.fn();

vi.mock("../../lib/useHabitatData.js", async (importOriginal) => {
  const actual = (await importOriginal()) as any;
  return {
    ...actual,
    useHabitat: () => ({
      data: { habitat: { id: "board-1", name: "Test Board" }, columns: [], missions: [] },
      isLoading: false,
      error: null,
    }),
    useArchivedMissionsInfinite: (...args: unknown[]) => {
      const r = mockArchivedFeaturesHook(...args) as any;
      return {
        data: r?.data
          ? { pages: [{ missions: r.data.missions ?? [], total: r.data.total ?? 0 }] }
          : undefined,
        isLoading: r?.isLoading ?? false,
        fetchNextPage: vi.fn(),
        hasNextPage: false,
        isFetchingNextPage: false,
      };
    },
  };
});

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
    missions: { list: vi.fn().mockResolvedValue({ missions: [], total: 0 }) },
  },
}));

vi.mock("./HabitatPulsePanel.js", () => ({ HabitatPulsePanel: () => null }));
vi.mock("./InsightsPanel.js", () => ({ InsightsPanel: () => null }));
vi.mock("./SkillPanel.js", () => ({ SkillPanel: () => null }));
vi.mock("../../hooks/useSSE.js", () => ({ useSSE: vi.fn() }));
vi.mock("../../hooks/useSSENotifications.js", () => ({ useSSENotifications: vi.fn() }));
vi.mock("../../hooks/usePresence.js", () => ({ usePresence: vi.fn() }));
vi.mock("../../hooks/useMediaQuery.js", () => ({ useIsMobile: vi.fn(() => false) }));

vi.mock("react-router-dom", () => ({
  useParams: vi.fn(() => ({ habitatId: "board-1" })),
  useSearchParams: vi.fn(() => [new URLSearchParams(), vi.fn()]),
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  useNavigate: vi.fn(() => vi.fn()),
  useLocation: vi.fn(() => ({ pathname: "/board/board-1", search: "", hash: "", state: null })),
}));

const mockStoreState = {
  isLoading: false,
  error: null,
  wipAlerts: {},
  collapsedColumns: {},
  presence: [],
  isBulkSelectMode: false,
  selectedMissionIds: [],
  notifications: [],
  setBulkSelectMode: vi.fn(),
};

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
  })),
}));

vi.mock("./TaskDetailModal.js", () => ({
  TaskDetailModal: () => null,
}));

function renderWithQC(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("HabitatPage Archived Button Removal", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockArchivedFeaturesHook.mockReturnValue({
      data: { missions: [], total: 0 },
      isLoading: false,
    });
  });

  afterEach(() => {
    cleanup();
  });

  describe("Archived button removal", () => {
    it("renders archived column control in the board area", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getByTestId("archived-toggle")).toBeTruthy();
    });

    it("does not render ArchivedFeaturesPanel", () => {
      const { container } = renderWithQC(<HabitatPage />);
      expect(container.querySelector('[class*="ArchivedFeatures"]')).toBeNull();
    });

    it("does not render archived control in the page header", () => {
      const { container } = renderWithQC(<HabitatPage />);
      const header = container.querySelector(".glass-panel");
      expect(header?.textContent).not.toContain("Archived");
    });
  });

  describe("Other header buttons remain functional", () => {
    it("renders Stats button", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getAllByText("Stats").length).toBeGreaterThanOrEqual(1);
    });

    it("renders Agents button", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getAllByText("Agents").length).toBeGreaterThanOrEqual(1);
    });

    it("renders Activity button", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getAllByText("Activity").length).toBeGreaterThanOrEqual(1);
    });

    it("renders Dependencies button", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getAllByText("Dependencies").length).toBeGreaterThanOrEqual(1);
    });

    it("renders Bulk Select button", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getAllByText("Bulk Select").length).toBeGreaterThanOrEqual(1);
    });

    it("renders Add Mission button", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getAllByText("Add Mission").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Breadcrumb navigation", () => {
    it("renders breadcrumb with board name", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getAllByText("Habitats").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Test Board").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Board content", () => {
    it("renders the Board component", () => {
      renderWithQC(<HabitatPage />);
      expect(screen.getAllByText("Stats").length).toBeGreaterThanOrEqual(1);
    });
  });
});

describe("HabitatPage Archived Button Removal (Mobile)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it("does not render Archived option even when isMobile is true", () => {
    vi.mocked(useIsMobile).mockReturnValue(true);
    renderWithQC(<HabitatPage />);
    expect(screen.queryByTestId("archived-toggle")).toBeNull();
  });
});
