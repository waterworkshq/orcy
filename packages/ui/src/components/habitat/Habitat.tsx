import React, { useState, useMemo } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  closestCorners,
} from "@dnd-kit/core";
import { SortableContext, horizontalListSortingStrategy } from "@dnd-kit/sortable";
import { useSearchParams, useNavigate } from "react-router-dom";
import { useHabitatStore } from "../../store/habitatStore.js";
import { Column } from "./Column.js";
import { FeatureCard } from "./MissionCard.js";
import { ColumnSwiper } from "./ColumnSwiper.js";
import { useIsMobile } from "../../hooks/useMediaQuery.js";
import { useArchivedMissionsInfinite } from "../../lib/useHabitatData.js";
import { useMissionDragMove } from "../../hooks/useMissionDragMove.js";
import type {
  MissionWithProgress,
  Column as ColumnType,
  PublicHabitat,
  PresenceEntry,
} from "../../types/index.js";
import { Plus, Archive, ChevronDown } from "lucide-react";

interface HabitatProps {
  habitat: PublicHabitat | null;
  columns: ColumnType[];
  missions: MissionWithProgress[];
  onColumnSettingsClick: (column: ColumnType) => void;
  onAddColumnClick: () => void;
  presence: PresenceEntry[];
}

export function Habitat({
  habitat,
  columns,
  missions,
  onColumnSettingsClick,
  onAddColumnClick,
  presence: _presence,
}: HabitatProps) {
  const isBulkSelectMode = useHabitatStore((s) => s.isBulkSelectMode);
  const [activeFeature, setActiveFeature] = useState<MissionWithProgress | null>(null);
  const [searchParams] = useSearchParams();
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  const { previewByMission, isMoving, drop, setPreview } = useMissionDragMove(habitat?.id);

  const {
    data: archivedData,
    isLoading: archivedLoading,
    fetchNextPage: fetchArchivedNextPage,
    hasNextPage: hasNextArchivedPage,
    isFetchingNextPage: isFetchingArchivedNextPage,
  } = useArchivedMissionsInfinite(habitat?.id);
  const archivedPages = archivedData?.pages ?? [];
  const archivedTotal =
    archivedPages.length > 0 ? archivedPages[archivedPages.length - 1].total : 0;
  const archivedFeatures = useMemo(() => {
    const seen = new Set<string>();
    const flattened: (typeof archivedPages)[number]["missions"][number][] = [];
    for (const page of archivedPages) {
      for (const mission of page.missions) {
        if (seen.has(mission.id)) continue;
        seen.add(mission.id);
        flattened.push(mission);
      }
    }
    return flattened;
  }, [archivedPages]);

  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [mobileColumnIndex, setMobileColumnIndex] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  const filteredMissions = useMemo(() => {
    const search = searchParams.get("search")?.toLowerCase() ?? "";
    const priority = searchParams.get("priority");
    const status = searchParams.get("status");

    return missions.filter((f) => {
      if (
        search &&
        !f.title.toLowerCase().includes(search) &&
        !f.description.toLowerCase().includes(search)
      )
        return false;
      if (priority && f.priority !== priority) return false;
      if (status && f.status !== status) return false;
      return true;
    });
  }, [missions, searchParams]);

  const missionsByColumn = useMemo(() => {
    const map: Record<string, MissionWithProgress[]> = {};
    for (const col of columns) {
      map[col.id] = [];
    }
    for (const f of filteredMissions) {
      const colId = previewByMission[f.id] ?? f.columnId;
      const target = map[colId] ?? map[f.columnId];
      if (target) target.push(f);
    }
    for (const col of columns) {
      map[col.id]?.sort((a, b) => a.displayOrder - b.displayOrder);
    }
    return map;
  }, [columns, filteredMissions, previewByMission]);

  function handleDragStart(event: DragStartEvent) {
    if (isBulkSelectMode) return;
    const mission = missions.find((f) => f.id === event.active.id);
    setActiveFeature(mission ?? null);
  }

  function handleDragOver(event: DragOverEvent) {
    if (isBulkSelectMode) return;
    const { active, over } = event;
    if (!over) return;

    const dragged = missions.find((f) => f.id === active.id);
    if (!dragged) return;

    const overId = over.id as string;
    const overFeature = missions.find((f) => f.id === overId);
    const overColumn = columns.find((c) => c.id === overId);

    const targetColumnId = overColumn?.id ?? overFeature?.columnId;
    if (!targetColumnId) return;

    const currentPreview = previewByMission[dragged.id] ?? dragged.columnId;
    if (targetColumnId === currentPreview) return;

    setPreview(dragged.id, targetColumnId);
  }

  function handleDragEnd(event: DragEndEvent) {
    if (isBulkSelectMode) return;
    const { active, over } = event;
    setActiveFeature(null);

    if (!over) return;

    const dragged = missions.find((f) => f.id === active.id);
    if (!dragged) return;

    const overId = over.id as string;
    const overColumn = columns.find((c) => c.id === overId);
    const overFeature = missions.find((f) => f.id === overId);
    const targetColumnId = overColumn?.id ?? overFeature?.columnId;

    if (!targetColumnId) return;

    drop({
      missionId: dragged.id,
      canonicalColumnId: dragged.columnId,
      targetColumnId,
      expectedVersion: dragged.version,
    });
  }

  if (!habitat) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        Select or create a board to get started.
      </div>
    );
  }

  const sortedColumns = columns.slice().sort((a, b) => a.order - b.order);
  const activeMobileColumn = sortedColumns[mobileColumnIndex];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <DndContext
        sensors={sensors}
        collisionDetection={closestCorners}
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragEnd={handleDragEnd}
      >
        {isMobile ? (
          <ColumnSwiper
            columns={sortedColumns}
            activeIndex={mobileColumnIndex}
            onIndexChange={setMobileColumnIndex}
          >
            <div className="flex-1 overflow-y-auto px-2 pb-2">
              {activeMobileColumn && (
                <Column
                  key={activeMobileColumn.id}
                  column={activeMobileColumn}
                  features={missionsByColumn[activeMobileColumn.id] ?? []}
                  onSettingsClick={onColumnSettingsClick}
                  isMobile
                />
              )}
            </div>
          </ColumnSwiper>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4 overflow-x-auto pb-4">
            <SortableContext
              items={sortedColumns.map((c) => c.id)}
              strategy={horizontalListSortingStrategy}
            >
              {sortedColumns.map((column) => (
                <Column
                  key={column.id}
                  column={column}
                  features={missionsByColumn[column.id] ?? []}
                  onSettingsClick={onColumnSettingsClick}
                />
              ))}
              <button
                type="button"
                onClick={onAddColumnClick}
                className="flex h-full min-h-0 w-64 flex-shrink-0 flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 text-muted-foreground hover:border-primary hover:text-primary cursor-pointer transition-colors"
              >
                <Plus className="h-6 w-6 mb-1" />
                <span className="text-sm font-medium">Add Column</span>
              </button>
            </SortableContext>

            {!isMobile && habitat && (
              <div className="flex-shrink-0 h-full min-h-0 w-72 flex flex-col">
                <button
                  type="button"
                  data-testid="archived-toggle"
                  onClick={() => setArchivedExpanded((prev) => !prev)}
                  className="flex items-center gap-2 border border-outline-variant/30 transition-all duration-200 cursor-pointer flex-shrink-0 h-11 rounded-lg bg-surface-container/50 hover:bg-surface-container-high px-3"
                >
                  <Archive className="h-4 w-4 text-on-surface-variant shrink-0" />
                  <span className="text-xs font-semibold text-on-surface-variant">Archived</span>
                  {archivedTotal > 0 && (
                    <span className="ml-auto text-[10px] font-bold text-on-surface bg-surface-container-high rounded-full px-1.5 py-0.5">
                      {archivedTotal}
                    </span>
                  )}
                  <ChevronDown
                    className={`h-3.5 w-3.5 text-on-surface-variant/50 transition-transform duration-200 ${archivedExpanded ? "rotate-180" : ""}`}
                  />
                </button>

                <div
                  className={`flex-1 min-h-0 overflow-hidden transition-all duration-300 ease-in-out ${
                    archivedExpanded ? "opacity-100 mt-1" : "opacity-0 max-h-0"
                  }`}
                >
                  <div className="h-full overflow-y-auto muted-scrollbar p-2 rounded-lg border border-outline-variant/15 bg-surface-container/20">
                    {archivedLoading && (
                      <div
                        data-testid="archived-loading"
                        className="flex items-center justify-center py-8 text-xs text-on-surface-variant/70"
                      >
                        Loading...
                      </div>
                    )}
                    {!archivedLoading && archivedFeatures.length === 0 && (
                      <div
                        data-testid="archived-empty"
                        className="flex flex-col items-center justify-center py-12 text-on-surface-variant/40 gap-2"
                      >
                        <Archive className="h-8 w-8" />
                        <span className="text-xs">No archived features</span>
                      </div>
                    )}
                    <div className="flex flex-col gap-1.5">
                      {archivedFeatures.map((feature) => (
                        <div
                          key={feature.id}
                          data-testid={`archived-feature-${feature.id}`}
                          className="rounded-lg border border-outline-variant/15 bg-surface-container/40 p-2.5 cursor-pointer hover:bg-surface-container-high transition-colors"
                          onClick={() => {
                            navigate(`/missions/${feature.id}`);
                          }}
                        >
                          <div className="text-xs font-medium text-on-surface-variant truncate">
                            {feature.title}
                          </div>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant/70">
                              {feature.status.replace("_", " ")}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant/70">
                              {feature.priority}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                    {hasNextArchivedPage && (
                      <div className="flex justify-center py-2">
                        <button
                          type="button"
                          data-testid="archived-load-more"
                          className="text-[10px] font-medium text-primary hover:underline disabled:opacity-50"
                          onClick={() => {
                            if (isFetchingArchivedNextPage) return;
                            void fetchArchivedNextPage();
                          }}
                          disabled={isFetchingArchivedNextPage}
                        >
                          {isFetchingArchivedNextPage ? "Loading..." : "Load more"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <DragOverlay>
          {activeFeature && !isBulkSelectMode && (
            <FeatureCard feature={activeFeature} isDragOverlay />
          )}
        </DragOverlay>
      </DndContext>

      {isMoving && (
        <div className="absolute right-4 top-4 rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground">
          Saving...
        </div>
      )}
    </div>
  );
}
