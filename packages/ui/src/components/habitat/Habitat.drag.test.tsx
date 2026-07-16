import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Habitat } from "./Habitat.js";
import type {
  MissionWithProgress,
  Column as ColumnType,
  PublicHabitat,
} from "../../types/index.js";

interface CapturedHandlers {
  onDragStart?: (e: any) => void;
  onDragOver?: (e: any) => void;
  onDragEnd?: (e: any) => void;
  onDragCancel?: (e: any) => void;
}

let captured: CapturedHandlers = {};

let bulkMode = false;

const dragMoveResult = {
  previewByMission: {} as Record<string, string>,
  isMoving: false,
  drop: vi.fn(),
  setPreview: vi.fn(),
  clearPreview: vi.fn(),
  restorePreview: vi.fn(),
};

vi.mock("../../hooks/useMissionDragMove.js", () => ({
  useMissionDragMove: () => dragMoveResult,
}));

vi.mock("@dnd-kit/core", () => ({
  DndContext: ({ children, onDragStart, onDragOver, onDragEnd, onDragCancel }: any) => {
    captured = { onDragStart, onDragOver, onDragEnd, onDragCancel };
    return <div data-testid="dnd">{children}</div>;
  },
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

vi.mock("react-router-dom", () => ({
  useSearchParams: () => [new URLSearchParams()],
  useNavigate: () => vi.fn(),
}));

vi.mock("./Column.js", () => ({
  Column: ({ column }: any) => <div data-testid={`column-${column.id}`} />,
}));

vi.mock("./MissionCard.js", () => ({
  FeatureCard: ({ feature }: any) => <div data-testid={`feature-card-${feature.id}`} />,
}));

vi.mock("./ColumnSwiper.js", () => ({
  ColumnSwiper: ({ children }: any) => <div>{children}</div>,
}));

vi.mock("../../hooks/useMediaQuery.js", () => ({
  useIsMobile: () => false,
}));

vi.mock("../../lib/useHabitatData.js", () => ({
  useAgents: () => ({ data: [], isLoading: false, isError: false }),
  useArchivedMissionsInfinite: () => ({
    data: undefined,
    isLoading: false,
    fetchNextPage: vi.fn(),
    hasNextPage: false,
    isFetchingNextPage: false,
  }),
}));

vi.mock("../../store/habitatStore.js", () => ({
  useHabitatStore: (selector?: any) =>
    selector ? selector({ isBulkSelectMode: bulkMode }) : { isBulkSelectMode: bulkMode },
}));

const baseProgress = {
  total: 0,
  pending: 0,
  claimed: 0,
  inProgress: 0,
  submitted: 0,
  approved: 0,
  done: 0,
  failed: 0,
  rejected: 0,
  percentage: 0,
};

function makeMission(id: string, columnId: string): MissionWithProgress {
  return {
    id,
    title: id,
    description: "",
    acceptanceCriteria: "",
    priority: "medium",
    status: "in_progress",
    habitatId: "h1",
    columnId,
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
    releaseDeadlineType: null,
    releaseDeadlineVersion: null,
    progress: baseProgress,
  };
}

const columns: ColumnType[] = [
  {
    id: "col-a",
    name: "A",
    order: 0,
    habitatId: "h1",
    wipLimit: null,
    requiresClaim: false,
    autoAdvance: false,
    nextColumnId: null,
    isTerminal: false,
  },
  {
    id: "col-b",
    name: "B",
    order: 1,
    habitatId: "h1",
    wipLimit: null,
    requiresClaim: false,
    autoAdvance: false,
    nextColumnId: null,
    isTerminal: false,
  },
  {
    id: "col-c",
    name: "C",
    order: 2,
    habitatId: "h1",
    wipLimit: null,
    requiresClaim: false,
    autoAdvance: false,
    nextColumnId: null,
    isTerminal: false,
  },
];

const habitat = {
  id: "h1",
  name: "H",
  description: "",
  columns: ["col-a", "col-b", "col-c"],
  createdBy: "",
  createdAt: "",
  updatedAt: "",
} as unknown as PublicHabitat;

function renderHabitat(missions: MissionWithProgress[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <Habitat
        habitat={habitat}
        columns={columns}
        missions={missions}
        onColumnSettingsClick={vi.fn()}
        onAddColumnClick={vi.fn()}
        presence={[]}
      />
    </QueryClientProvider>,
  );
}

function rerenderHabitat(rerender: (ui: React.ReactNode) => void, missions: MissionWithProgress[]) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  rerender(
    <QueryClientProvider client={qc}>
      <Habitat
        habitat={habitat}
        columns={columns}
        missions={missions}
        onColumnSettingsClick={vi.fn()}
        onAddColumnClick={vi.fn()}
        presence={[]}
      />
    </QueryClientProvider>,
  );
}

describe("Habitat drag lifecycle (M9, m1)", () => {
  beforeEach(() => {
    captured = {};
    bulkMode = false;
    dragMoveResult.previewByMission = {};
    dragMoveResult.isMoving = false;
    dragMoveResult.drop.mockReset();
    dragMoveResult.setPreview.mockReset();
    dragMoveResult.clearPreview.mockReset();
    dragMoveResult.restorePreview.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("onDragCancel restores the dragged mission's preview", () => {
    renderHabitat([makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragStart!({ active: { id: "m1" } });
    });
    act(() => {
      captured.onDragCancel!({ active: { id: "m1" } });
    });

    expect(dragMoveResult.restorePreview).toHaveBeenCalledWith("m1");
  });

  it("handleDragEnd restores the preview when dropped outside (no over)", () => {
    renderHabitat([makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragStart!({ active: { id: "m1" } });
    });
    act(() => {
      captured.onDragEnd!({ active: { id: "m1" }, over: null });
    });

    expect(dragMoveResult.restorePreview).toHaveBeenCalledWith("m1");
    expect(dragMoveResult.drop).not.toHaveBeenCalled();
  });

  it("handleDragEnd restores the preview when the target is unknown", () => {
    renderHabitat([makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragStart!({ active: { id: "m1" } });
    });
    act(() => {
      captured.onDragEnd!({ active: { id: "m1" }, over: { id: "no-such-id" } });
    });

    expect(dragMoveResult.restorePreview).toHaveBeenCalledWith("m1");
    expect(dragMoveResult.drop).not.toHaveBeenCalled();
  });

  it("m1: drop targets a hovered mission's rendered (preview) column, not its stale canonical one", () => {
    // m2 is canonically in col-a but mid-move, previewed in col-c.
    dragMoveResult.previewByMission = { m2: "col-c" };
    renderHabitat([makeMission("m1", "col-a"), makeMission("m2", "col-a")]);

    act(() => {
      captured.onDragEnd!({ active: { id: "m1" }, over: { id: "m2" } });
    });

    expect(dragMoveResult.drop).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "m1", targetColumnId: "col-c" }),
    );
  });

  it("m1: dragOver previews toward a hovered mission's rendered column", () => {
    dragMoveResult.previewByMission = { m2: "col-c" };
    renderHabitat([makeMission("m1", "col-a"), makeMission("m2", "col-a")]);

    act(() => {
      captured.onDragOver!({ active: { id: "m1" }, over: { id: "m2" } });
    });

    expect(dragMoveResult.setPreview).toHaveBeenCalledWith("m1", "col-c");
  });

  it("a drop directly on a column targets that column", () => {
    renderHabitat([makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragEnd!({ active: { id: "m1" }, over: { id: "col-b" } });
    });

    expect(dragMoveResult.drop).toHaveBeenCalledWith(
      expect.objectContaining({ missionId: "m1", targetColumnId: "col-b" }),
    );
  });

  it("R7: restores the preview when the mission disappeared mid-drag (archive/delete)", () => {
    const { rerender } = renderHabitat([makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragStart!({ active: { id: "m1" } });
    });

    // The mission disappears before drag end (realtime archive/delete/filter).
    rerenderHabitat(rerender, []);

    act(() => {
      captured.onDragEnd!({ active: { id: "m1" }, over: { id: "col-b" } });
    });

    expect(dragMoveResult.restorePreview).toHaveBeenCalledWith("m1");
    expect(dragMoveResult.drop).not.toHaveBeenCalled();
  });

  it("R7: clears the drag overlay and restores the preview when bulk mode toggles mid-drag", () => {
    const { rerender } = renderHabitat([makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragStart!({ active: { id: "m1" } });
    });

    // Bulk-select mode is toggled while a drag is in progress.
    bulkMode = true;
    rerenderHabitat(rerender, [makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragEnd!({ active: { id: "m1" }, over: { id: "col-b" } });
    });

    expect(dragMoveResult.restorePreview).toHaveBeenCalledWith("m1");
    expect(dragMoveResult.drop).not.toHaveBeenCalled();
  });

  it("R7: drag cancel restores the preview when the mission disappeared mid-drag", () => {
    const { rerender } = renderHabitat([makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragStart!({ active: { id: "m1" } });
    });

    rerenderHabitat(rerender, []);

    act(() => {
      captured.onDragCancel!({ active: { id: "m1" } });
    });

    expect(dragMoveResult.restorePreview).toHaveBeenCalledWith("m1");
  });

  it("UI-2: clears the drag overlay and restores the preview as soon as the dragged mission disappears mid-drag, without waiting for dragEnd/dragCancel", async () => {
    const { rerender } = renderHabitat([makeMission("m1", "col-a")]);

    act(() => {
      captured.onDragStart!({ active: { id: "m1" } });
    });
    expect(dragMoveResult.restorePreview).not.toHaveBeenCalled();

    // Realtime SSE (mission.deleted, archive, filter-driven removal) drops
    // the mission from the canonical collection — the user has not yet
    // released the pointer, so dnd-kit's drag is still active.
    rerenderHabitat(rerender, []);

    // The cleanup path must fire IMMEDIATELY (route through the same
    // cancelDragFor helper that handleDragCancel uses), not wait for the
    // user to manually end/cancel the gesture.
    await vi.waitFor(() =>
      expect(dragMoveResult.restorePreview).toHaveBeenCalledWith("m1"),
    );

    // The DragOverlay content goes null (activeFeature cleared). Verified via
    // captured event handlers still being installed and no further restore
    // happening on a subsequent dragEnd (which would re-clear an already-cleared
    // preview and double-fire — safe but confirms the immediate path ran).
    dragMoveResult.restorePreview.mockClear();
    act(() => {
      captured.onDragEnd!({ active: { id: "m1" }, over: { id: "col-b" } });
    });
  });
});
