import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup, waitFor, act } from "@testing-library/react";
import { ColumnSettingsDialog } from "./ColumnSettingsDialog.js";
import { ApiError } from "../../api/transport.js";
import type { Column } from "../../types/index.js";

const mockColumnsUpdate = vi.fn();
const mockColumnsDelete = vi.fn();
const mockColumnsReorder = vi.fn();
const mockNotifySuccess = vi.fn();
const mockNotifyError = vi.fn();
const mockInvalidateQueries = vi.fn();
const mockSetQueryData = vi.fn();
const mockResetQueries = vi.fn();

let capturedOnDragEnd: ((event: { active: { id: string }; over: { id: string } }) => void) | null =
  null;
let capturedSensors: unknown[] = [];

vi.mock("../../api/index.js", () => ({
  api: {
    columns: {
      update: (...args: unknown[]) => mockColumnsUpdate(...args),
      delete: (...args: unknown[]) => mockColumnsDelete(...args),
      reorder: (...args: unknown[]) => mockColumnsReorder(...args),
    },
  },
}));

vi.mock("@tanstack/react-query", async () => {
  const actual = await vi.importActual("@tanstack/react-query");
  return {
    ...actual,
    useQueryClient: () => ({
      invalidateQueries: mockInvalidateQueries,
      setQueryData: mockSetQueryData,
      resetQueries: mockResetQueries,
    }),
  };
});

vi.mock("../../lib/toast.js", () => ({
  notify: {
    success: (...args: unknown[]) => mockNotifySuccess(...args),
    error: (...args: unknown[]) => mockNotifyError(...args),
  },
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragEnd, sensors }: any) => {
    capturedOnDragEnd = onDragEnd ?? null;
    capturedSensors = sensors ?? [];
    return <div data-testid="dnd-context">{children}</div>;
  },
  DragOverlay: ({ children }: any) => <div>{children}</div>,
  closestCorners: {},
  PointerSensor: vi.fn(),
  TouchSensor: vi.fn(),
  useSensor: vi.fn(() => ({})),
  useSensors: vi.fn(() => ["sensor-active"]),
}));

vi.mock("@dnd-kit/sortable", () => ({
  SortableContext: ({ children }: any) => <div data-testid="sortable-context">{children}</div>,
  verticalListSortingStrategy: {},
  useSortable: vi.fn(() => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    transform: null,
    transition: null,
    isDragging: false,
  })),
}));

vi.mock("@dnd-kit/utilities", () => ({
  CSS: {
    Transform: {
      toString: () => "",
    },
  },
}));

vi.mock("lucide-react", () => ({
  GripVertical: () => <span data-testid="grip-icon" />,
}));

const makeColumn = (id: string, name: string, order: number): Column => ({
  id,
  habitatId: "board-1",
  name,
  order,
  wipLimit: null,
  autoAdvance: false,
  requiresClaim: false,
  nextColumnId: null,
  isTerminal: false,
});

const defaultColumns = [
  makeColumn("col-1", "To Do", 0),
  makeColumn("col-2", "In Progress", 1),
  makeColumn("col-3", "Done", 2),
];

const defaultProps = {
  column: defaultColumns[1],
  open: true,
  onClose: vi.fn(),
  onUpdate: vi.fn(),
  onDelete: vi.fn(),
  columns: defaultColumns,
};

describe("ColumnSettingsDialog — column reorder", () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    mockColumnsUpdate.mockReset();
    mockColumnsDelete.mockReset();
    mockColumnsReorder.mockReset();
    mockColumnsUpdate.mockResolvedValue({ column: defaultColumns[0] });
    mockColumnsDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders draggable list with all columns", () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.getByTestId("dnd-context")).toBeTruthy();
    expect(screen.getByTestId("sortable-context")).toBeTruthy();
    expect(screen.getByText("To Do")).toBeTruthy();
    expect(screen.getByText("In Progress")).toBeTruthy();
    expect(screen.getByText("Done")).toBeTruthy();
    expect(screen.getByText("Column Order")).toBeTruthy();
    expect(screen.getByText("Drag to reorder columns on the board")).toBeTruthy();
  });

  it("highlights the currently selected column", () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.getByText("(selected)")).toBeTruthy();
  });

  it("does not show reorder list when only one column", () => {
    const singleColumn = [defaultColumns[0]];
    render(
      <ColumnSettingsDialog {...defaultProps} column={singleColumn[0]} columns={singleColumn} />,
    );

    expect(screen.queryByText("Column Order")).toBeNull();
    expect(screen.queryByTestId("dnd-context")).toBeNull();
  });

  it("shows Save Order button after drag reorder", () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.queryByText("Save Order")).toBeNull();

    expect(capturedOnDragEnd).not.toBeNull();
    act(() => {
      capturedOnDragEnd!({ active: { id: "col-1" }, over: { id: "col-3" } });
    });

    expect(screen.getByText("Save Order")).toBeTruthy();
  });
});

describe("ColumnSettingsDialog — atomic save order", () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    capturedSensors = [];
    mockColumnsUpdate.mockReset();
    mockColumnsDelete.mockReset();
    mockColumnsReorder.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    mockSetQueryData.mockReset();
    mockInvalidateQueries.mockReset();
    mockResetQueries.mockReset();
    mockColumnsUpdate.mockResolvedValue({ column: defaultColumns[0] });
    mockColumnsDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("issues exactly one atomic reorder request with expected and desired order", async () => {
    // Canonical server response: committed order col-3, col-1, col-2.
    const canonical = [
      makeColumn("col-3", "Done", 0),
      makeColumn("col-1", "To Do", 1),
      makeColumn("col-2", "In Progress", 2),
    ];
    mockColumnsReorder.mockResolvedValue({ columns: canonical });

    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(capturedOnDragEnd).not.toBeNull();
    act(() => {
      capturedOnDragEnd!({ active: { id: "col-3" }, over: { id: "col-1" } });
    });

    fireEvent.click(screen.getByText("Save Order"));

    await waitFor(() => {
      expect(mockColumnsReorder).toHaveBeenCalledTimes(1);
    });

    expect(mockColumnsReorder).toHaveBeenCalledWith("board-1", {
      expectedOrder: ["col-1", "col-2", "col-3"],
      desiredOrder: ["col-3", "col-1", "col-2"],
    });
    // No sequential per-Column PATCH writes remain.
    expect(mockColumnsUpdate).not.toHaveBeenCalled();
  });

  it("installs the canonical returned columns into the habitat detail cache", async () => {
    const canonical = [
      makeColumn("col-3", "Done", 0),
      makeColumn("col-1", "To Do", 1),
      makeColumn("col-2", "In Progress", 2),
    ];
    mockColumnsReorder.mockResolvedValue({ columns: canonical });

    render(<ColumnSettingsDialog {...defaultProps} />);

    act(() => {
      capturedOnDragEnd!({ active: { id: "col-3" }, over: { id: "col-1" } });
    });

    fireEvent.click(screen.getByText("Save Order"));

    await waitFor(() => {
      expect(mockSetQueryData).toHaveBeenCalled();
    });

    // The guarded patch installs the complete canonical column set.
    const patchedColumns = mockSetQueryData.mock.calls[0][1]({
      habitat: { id: "board-1" },
      columns: defaultColumns,
      missions: [],
    }).columns;
    expect(patchedColumns).toEqual(canonical);
  });

  it("invalidates habitat detail after a successful reorder", async () => {
    mockColumnsReorder.mockResolvedValue({ columns: defaultColumns });

    render(<ColumnSettingsDialog {...defaultProps} />);

    act(() => {
      capturedOnDragEnd!({ active: { id: "col-3" }, over: { id: "col-1" } });
    });

    fireEvent.click(screen.getByText("Save Order"));

    await waitFor(() => {
      expect(mockInvalidateQueries).toHaveBeenCalled();
    });
  });

  it("shows success notification after save", async () => {
    mockColumnsReorder.mockResolvedValue({ columns: defaultColumns });

    render(<ColumnSettingsDialog {...defaultProps} />);

    act(() => {
      capturedOnDragEnd!({ active: { id: "col-3" }, over: { id: "col-1" } });
    });

    fireEvent.click(screen.getByText("Save Order"));

    await waitFor(() => {
      expect(mockNotifySuccess).toHaveBeenCalledWith("Column order saved");
    });
  });

  it("on 409 conflict: surfaces distinctly, reconciles, performs no writes", async () => {
    mockColumnsReorder.mockRejectedValue(new ApiError("VERSION_CONFLICT", 409));

    render(<ColumnSettingsDialog {...defaultProps} />);

    act(() => {
      capturedOnDragEnd!({ active: { id: "col-3" }, over: { id: "col-1" } });
    });

    fireEvent.click(screen.getByText("Save Order"));

    await waitFor(() => {
      expect(mockNotifyError).toHaveBeenCalledWith(
        expect.stringContaining("modified by someone else"),
        expect.anything(),
      );
    });

    // Conflict reconciles via invalidation; no compensation writes attempted.
    expect(mockInvalidateQueries).toHaveBeenCalled();
    expect(mockColumnsUpdate).not.toHaveBeenCalled();
    expect(mockSetQueryData).not.toHaveBeenCalled();
  });

  it("on generic error: notifies and reconciles without compensation writes", async () => {
    mockColumnsReorder.mockRejectedValue(new Error("Network error"));

    render(<ColumnSettingsDialog {...defaultProps} />);

    act(() => {
      capturedOnDragEnd!({ active: { id: "col-3" }, over: { id: "col-1" } });
    });

    fireEvent.click(screen.getByText("Save Order"));

    await waitFor(() => {
      expect(mockNotifyError).toHaveBeenCalledWith("Network error");
    });

    expect(mockColumnsUpdate).not.toHaveBeenCalled();
  });

  it("does not call API when order is unchanged", async () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.queryByText("Save Order")).toBeNull();
    expect(mockColumnsReorder).not.toHaveBeenCalled();
  });

  it("m7: disables DnD sensors while a reorder request is in flight, then restores them", async () => {
    let resolveReorder: (val: any) => void = () => {};
    mockColumnsReorder.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveReorder = resolve;
      }),
    );

    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(capturedSensors).toEqual(["sensor-active"]);

    act(() => {
      capturedOnDragEnd!({ active: { id: "col-3" }, over: { id: "col-1" } });
    });

    fireEvent.click(screen.getByText("Save Order"));

    await waitFor(() => {
      expect(mockColumnsReorder).toHaveBeenCalledTimes(1);
    });

    expect(capturedSensors).toEqual([]);

    await act(async () => {
      resolveReorder({ columns: defaultColumns });
    });

    await waitFor(() => {
      expect(capturedSensors).toEqual(["sensor-active"]);
    });
  });
});

describe("ColumnSettingsDialog — existing functionality preserved", () => {
  beforeEach(() => {
    capturedOnDragEnd = null;
    mockColumnsUpdate.mockReset();
    mockColumnsDelete.mockReset();
    mockColumnsReorder.mockReset();
    mockNotifySuccess.mockReset();
    mockNotifyError.mockReset();
    mockColumnsUpdate.mockResolvedValue({ column: defaultColumns[0] });
    mockColumnsDelete.mockResolvedValue(undefined);
  });

  afterEach(() => {
    cleanup();
  });

  it("renders column name input with current value", () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    const input = screen.getByDisplayValue("In Progress");
    expect(input).toBeTruthy();
  });

  it("renders WIP limit input", () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    const input = screen.getByPlaceholderText("No limit");
    expect(input).toBeTruthy();
  });

  it("renders auto-advance and requires-claim toggles", () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.getByText("Auto-advance")).toBeTruthy();
    expect(screen.getByText("Requires Claim")).toBeTruthy();
  });

  it("renders danger zone with delete button", () => {
    render(<ColumnSettingsDialog {...defaultProps} />);

    expect(screen.getByText("Danger Zone")).toBeTruthy();
    expect(screen.getByText("Delete Column")).toBeTruthy();
  });
});
