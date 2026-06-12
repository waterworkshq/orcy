import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { FilterBar } from "./FilterBar.js";

const mockStoreState = {
  agents: [
    { id: "a1", name: "Agent-1" },
    { id: "a2", name: "Agent-2" },
  ],
  board: { id: "board-1" },
};

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: (selector?: any) => {
    return selector ? selector(mockStoreState) : mockStoreState;
  },
}));

vi.mock("../../hooks/useMediaQuery.js", () => ({
  useIsMobile: () => false,
}));

const mockSavedFiltersList = vi.fn().mockResolvedValue([]);
const mockSavedFiltersCreate = vi.fn();
const mockSavedFiltersDelete = vi.fn();

vi.mock("../../api/index.js", () => ({
  api: {
    savedFilters: {
      list: (...args: unknown[]) => mockSavedFiltersList(...args),
      create: (...args: unknown[]) => mockSavedFiltersCreate(...args),
      delete: (...args: unknown[]) => mockSavedFiltersDelete(...args),
    },
  },
}));

const mockUseSavedFilters = vi.fn();

vi.mock("../../lib/useHabitatData.js", () => ({
  useSavedFilters: (...args: unknown[]) => mockUseSavedFilters(...args),
  useAgents: () => ({ data: mockStoreState.agents as any[], isLoading: false, isError: false }),
  useBoard: () => ({
    data: { board: mockStoreState.board, columns: [] },
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("../../lib/queryKeys.js", () => ({
  queryKeys: {
    savedFilters: {
      list: (habitatId: string) => ["savedFilters", habitatId],
    },
  },
}));

function renderWithProviders(ui: React.ReactElement, initialEntries?: string[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={initialEntries ?? ["/"]}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  );
}

const savedFilter1 = {
  id: "sf1",
  habitatId: "board-1",
  userId: "u1",
  name: "My Filter",
  filterConfig: { priority: "high" },
  isBuiltin: false,
  createdAt: "2024-01-01T00:00:00Z",
};

const builtinFilter = {
  id: "sf2",
  habitatId: "board-1",
  userId: "u1",
  name: "Built-in Filter",
  filterConfig: { status: "done" },
  isBuiltin: true,
  createdAt: "2024-01-01T00:00:00Z",
};

const fullFilter = {
  id: "sf3",
  habitatId: "board-1",
  userId: "u1",
  name: "Full Filter",
  filterConfig: {
    search: "test",
    priority: "high",
    status: "in_progress",
    assignedAgentId: "a1",
    columnId: "col-1",
  },
  isBuiltin: false,
  createdAt: "2024-01-01T00:00:00Z",
};

describe("FilterBar", () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    mockUseSavedFilters.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockSavedFiltersList.mockResolvedValue([]);
    mockSavedFiltersCreate.mockResolvedValue({ id: "new-sf", name: "Test", filterConfig: {} });
    mockSavedFiltersDelete.mockResolvedValue({ success: true });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders search input", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    expect(screen.getByPlaceholderText("Search features...")).toBeTruthy();
  });

  it("renders agent filter dropdown", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    expect(screen.getByText("All Agents")).toBeTruthy();
  });

  it("renders priority filter buttons", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    expect(screen.getByText("critical")).toBeTruthy();
    expect(screen.getByText("high")).toBeTruthy();
    expect(screen.getByText("medium")).toBeTruthy();
    expect(screen.getByText("low")).toBeTruthy();
  });

  it("renders status filter buttons", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    expect(screen.getByText("not started")).toBeTruthy();
    expect(screen.getByText("in progress")).toBeTruthy();
    expect(screen.getByText("review")).toBeTruthy();
    expect(screen.getByText("done")).toBeTruthy();
    expect(screen.getByText("failed")).toBeTruthy();
  });

  it("renders Views button", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    expect(screen.getByText("Views")).toBeTruthy();
  });

  it("renders view toggle with Board and Table buttons", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    expect(screen.getByTestId("view-toggle-board")).toBeTruthy();
    expect(screen.getByTestId("view-toggle-table")).toBeTruthy();
  });

  it("defaults to board view when no view param", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    const boardBtn = screen.getByTestId("view-toggle-board");
    expect(boardBtn.className).toContain("bg-primary");
  });

  it("highlights table toggle when ?view=table", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?view=table"]);
    const tableBtn = screen.getByTestId("view-toggle-table");
    expect(tableBtn.className).toContain("bg-primary");
  });

  it("does not show Clear button when only view param is set", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?view=table"]);
    expect(screen.queryByText("Clear")).toBeNull();
  });

  it("calls useSavedFilters with habitatId from store", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    expect(mockUseSavedFilters).toHaveBeenCalledWith("board-1");
  });

  it("renders saved filters from useSavedFilters", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [savedFilter1, builtinFilter],
      isLoading: false,
    });

    renderWithProviders(<FilterBar habitatId="board-1" />);

    const viewsBtn = screen.getByText("Views");
    fireEvent.click(viewsBtn);

    expect(await screen.findByText("My Filter")).toBeTruthy();
    expect(screen.getByText("Built-in Filter")).toBeTruthy();
  });

  it("shows No saved views when no filters", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderWithProviders(<FilterBar habitatId="board-1" />);

    const viewsBtn = screen.getByText("Views");
    fireEvent.click(viewsBtn);

    expect(await screen.findByText("No saved views")).toBeTruthy();
  });

  it("shows built-in tag for builtin filters", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [builtinFilter],
      isLoading: false,
    });

    renderWithProviders(<FilterBar habitatId="board-1" />);

    fireEvent.click(screen.getByText("Views"));
    expect(await screen.findByText("built-in")).toBeTruthy();
  });

  it("preserves view param when applying a saved filter", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [savedFilter1],
      isLoading: false,
    });

    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?view=table"]);

    const viewsBtn = await screen.findByText("Views");
    fireEvent.click(viewsBtn);

    const filterBtn = await screen.findByText("My Filter");
    fireEvent.click(filterBtn);

    const tableBtn = screen.getByTestId("view-toggle-table");
    expect(tableBtn.className).toContain("bg-primary");
    const boardBtn = screen.getByTestId("view-toggle-board");
    expect(boardBtn.className).not.toContain("bg-primary");
  });

  it("applies full saved filter with all config keys", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [fullFilter],
      isLoading: false,
    });

    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?view=table"]);

    fireEvent.click(screen.getByText("Views"));
    const filterBtn = await screen.findByText("Full Filter");
    fireEvent.click(filterBtn);

    await waitFor(() => {
      const searchInput = screen.getByPlaceholderText("Search features...") as HTMLInputElement;
      expect(searchInput.value).toBe("test");
    });
  });

  it("calls create mutation when saving a filter via Enter key", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockSavedFiltersCreate.mockResolvedValue({ id: "new-sf", name: "Test View", filterConfig: {} });

    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?priority=high"]);

    fireEvent.click(screen.getByText("Views"));
    fireEvent.click(await screen.findByText("+ Save Current View"));

    const input = screen.getByPlaceholderText("View name...");
    fireEvent.change(input, { target: { value: "Test View" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockSavedFiltersCreate).toHaveBeenCalledWith("board-1", {
        name: "Test View",
        filterConfig: { priority: "high" },
      });
    });
  });

  it("calls create mutation when clicking Save button", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockSavedFiltersCreate.mockResolvedValue({ id: "new-sf", name: "Test", filterConfig: {} });

    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?status=done"]);

    fireEvent.click(screen.getByText("Views"));
    fireEvent.click(await screen.findByText("+ Save Current View"));

    const input = screen.getByPlaceholderText("View name...");
    fireEvent.change(input, { target: { value: "Test" } });

    const allButtons = screen.getAllByRole("button");
    const saveButtons = allButtons.filter((b) => {
      const svg = b.querySelector("svg");
      return svg && b.closest(".border-t");
    });
    if (saveButtons.length > 0) {
      fireEvent.click(saveButtons[saveButtons.length - 1]);
    }

    await waitFor(() => {
      expect(mockSavedFiltersCreate).toHaveBeenCalledWith("board-1", {
        name: "Test",
        filterConfig: { status: "done" },
      });
    });
  });

  it("does not save when name is empty", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [],
      isLoading: false,
    });

    renderWithProviders(<FilterBar habitatId="board-1" />);

    fireEvent.click(screen.getByText("Views"));
    fireEvent.click(await screen.findByText("+ Save Current View"));

    const input = screen.getByPlaceholderText("View name...");
    fireEvent.change(input, { target: { value: "   " } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockSavedFiltersCreate).not.toHaveBeenCalled();
    });
  });

  it("handles create mutation error gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockUseSavedFilters.mockReturnValue({
      data: [],
      isLoading: false,
    });
    mockSavedFiltersCreate.mockRejectedValue(new Error("Network error"));

    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?priority=high"]);

    fireEvent.click(screen.getByText("Views"));
    fireEvent.click(await screen.findByText("+ Save Current View"));

    const input = screen.getByPlaceholderText("View name...");
    fireEvent.change(input, { target: { value: "Test" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => {
      expect(mockSavedFiltersCreate).toHaveBeenCalled();
    });

    warnSpy.mockRestore();
  });

  it("calls delete mutation when deleting a filter", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [savedFilter1],
      isLoading: false,
    });
    mockSavedFiltersDelete.mockResolvedValue({ success: true });

    const { container } = renderWithProviders(<FilterBar habitatId="board-1" />);

    fireEvent.click(screen.getByText("Views"));
    await screen.findByText("My Filter");

    const trashButtons = container.querySelectorAll(
      "button.text-muted-foreground.hover\\:text-destructive",
    );
    expect(trashButtons.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(trashButtons[0]);

    await waitFor(() => {
      expect(mockSavedFiltersDelete).toHaveBeenCalledWith("sf1");
    });
  });

  it("handles delete mutation error gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    mockUseSavedFilters.mockReturnValue({
      data: [savedFilter1],
      isLoading: false,
    });
    mockSavedFiltersDelete.mockRejectedValue(new Error("Delete failed"));

    const { container } = renderWithProviders(<FilterBar habitatId="board-1" />);

    fireEvent.click(screen.getByText("Views"));
    await screen.findByText("My Filter");

    const trashButtons = container.querySelectorAll(
      "button.text-muted-foreground.hover\\:text-destructive",
    );
    fireEvent.click(trashButtons[0]);

    await waitFor(() => {
      expect(mockSavedFiltersDelete).toHaveBeenCalledWith("sf1");
    });

    warnSpy.mockRestore();
  });

  it("does not show delete button for builtin filters", async () => {
    mockUseSavedFilters.mockReturnValue({
      data: [builtinFilter],
      isLoading: false,
    });

    const { container } = renderWithProviders(<FilterBar habitatId="board-1" />);

    fireEvent.click(screen.getByText("Views"));
    await screen.findByText("Built-in Filter");

    const trashButtons = container.querySelectorAll(
      "button.text-muted-foreground.hover\\:text-destructive",
    );
    expect(trashButtons.length).toBe(0);
  });

  it("still reads agents and board from Zustand store", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);

    expect(screen.getByText("Agent-1")).toBeTruthy();
    expect(screen.getByText("Agent-2")).toBeTruthy();
  });

  it("shows Clear button when filters are active", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?priority=high"]);
    expect(screen.getByText("Clear")).toBeTruthy();
  });

  it("clears all non-view filters when Clear is clicked", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />, ["/?priority=high&view=table"]);

    const clearBtn = screen.getByText("Clear");
    fireEvent.click(clearBtn);

    const tableBtn = screen.getByTestId("view-toggle-table");
    expect(tableBtn.className).toContain("bg-primary");
  });

  it("toggles priority filter on and off", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);

    const highBtn = screen.getByText("high");
    fireEvent.click(highBtn);
    expect(highBtn.className).toContain("bg-primary-container");

    fireEvent.click(highBtn);
    expect(highBtn.className).not.toContain("bg-primary-container");
  });

  it("toggles status filter on and off", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);

    const reviewBtn = screen.getByText("review");
    fireEvent.click(reviewBtn);
    expect(reviewBtn.className).toContain("bg-primary-container");

    fireEvent.click(reviewBtn);
    expect(reviewBtn.className).not.toContain("bg-primary-container");
  });

  it("toggles view between board and table", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);

    const boardBtn = screen.getByTestId("view-toggle-board");
    const tableBtn = screen.getByTestId("view-toggle-table");

    expect(boardBtn.className).toContain("bg-primary");

    fireEvent.click(tableBtn);
    expect(tableBtn.className).toContain("bg-primary");
  });

  it("uses default search input when no focusSearchRef provided", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);
    const input = screen.getByPlaceholderText("Search features...");
    expect(input).toBeTruthy();
  });

  it("uses provided focusSearchRef when passed", () => {
    const ref = React.createRef<HTMLInputElement>();
    renderWithProviders(<FilterBar habitatId="board-1" focusSearchRef={ref} />);
    expect(ref.current).toBeTruthy();
  });

  it("updates search filter on input change", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);

    const input = screen.getByPlaceholderText("Search features...");
    fireEvent.change(input, { target: { value: "hello" } });
    expect((input as HTMLInputElement).value).toBe("hello");
  });

  it("selects agent filter", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);

    const select = screen.getByDisplayValue("All Agents");
    fireEvent.change(select, { target: { value: "a1" } });
    expect((select as HTMLSelectElement).value).toBe("a1");
  });

  it("selects unassigned filter", () => {
    renderWithProviders(<FilterBar habitatId="board-1" />);

    const select = screen.getByDisplayValue("All Agents");
    fireEvent.change(select, { target: { value: "unassigned" } });
    expect((select as HTMLSelectElement).value).toBe("unassigned");
  });

  describe("React.memo wrapping", () => {
    it("FilterBar is wrapped in React.memo", () => {
      expect((FilterBar as any).$$typeof).toBe(Symbol.for("react.memo"));
      expect(typeof (FilterBar as any).type).toBe("function");
    });
  });
});
