import React, { useState, useMemo } from 'react';
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
} from '@dnd-kit/core';
import { SortableContext, horizontalListSortingStrategy } from '@dnd-kit/sortable';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useBoardStore } from '../../store/habitatStore.js';
import { Column } from './Column.js';
import { FeatureCard } from './MissionCard.js';
import { ColumnSwiper } from './ColumnSwiper.js';
import { useIsMobile } from '../../hooks/useMediaQuery.js';
import { useArchivedFeatures } from '../../lib/useHabitatData.js';
import type { FeatureWithProgress, Column as ColumnType, PresenceEntry } from '../../types/index.js';
import { api } from '../../api/index.js';
import { Plus, Archive, ChevronDown, ChevronRight } from 'lucide-react';

interface BoardProps {
  onColumnSettingsClick: (column: ColumnType) => void;
  onAddColumnClick: () => void;
  presence: PresenceEntry[];
}

export function Board({ onColumnSettingsClick, onAddColumnClick, presence }: BoardProps) {
  const { board, columns, features, columnPagination, setBoard, setError, isBulkSelectMode } = useBoardStore();
  const [activeFeature, setActiveFeature] = useState<FeatureWithProgress | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const [archivedExpanded, setArchivedExpanded] = useState(false);

  const { data: archivedData, isLoading: archivedLoading } = useArchivedFeatures(board?.id);
  const archivedFeatures = archivedData?.features ?? [];
  const archivedTotal = archivedData?.total ?? 0;

  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [mobileColumnIndex, setMobileColumnIndex] = useState(0);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    })
  );

  const filteredFeatures = useMemo(() => {
    const search = searchParams.get('search')?.toLowerCase() ?? '';
    const priority = searchParams.get('priority');
    const status = searchParams.get('status');

    return features.filter((f) => {
      if (search && !f.title.toLowerCase().includes(search) && !f.description.toLowerCase().includes(search)) return false;
      if (priority && f.priority !== priority) return false;
      if (status && f.status !== status) return false;
      return true;
    });
  }, [features, searchParams]);

  const featuresByColumn = useMemo(() => {
    const map: Record<string, FeatureWithProgress[]> = {};
    for (const col of columns) {
      map[col.id] = filteredFeatures
        .filter((f) => f.columnId === col.id)
        .sort((a, b) => a.displayOrder - b.displayOrder);
    }
    return map;
  }, [columns, filteredFeatures]);

  function handleDragStart(event: DragStartEvent) {
    if (isBulkSelectMode) return;
    const feature = features.find((f) => f.id === event.active.id);
    setActiveFeature(feature ?? null);
  }

  function handleDragOver(event: DragOverEvent) {
    if (isBulkSelectMode) return;
    const { active, over } = event;
    if (!over) return;

    const activeFeature = features.find((f) => f.id === active.id);
    if (!activeFeature) return;

    const overId = over.id as string;
    const overFeature = features.find((f) => f.id === overId);
    const overColumn = columns.find((c) => c.id === overId);

    const targetColumnId = overColumn?.id ?? overFeature?.columnId;
    if (!targetColumnId || targetColumnId === activeFeature.columnId) return;

    useBoardStore.getState().moveFeatureToColumn(activeFeature.id, targetColumnId);
  }

  async function handleDragEnd(event: DragEndEvent) {
    if (isBulkSelectMode) return;
    const { active, over } = event;
    setActiveFeature(null);

    if (!over) return;

    const activeFeature = features.find((f) => f.id === active.id);
    if (!activeFeature) return;

    const overId = over.id as string;
    const overColumn = columns.find((c) => c.id === overId);
    const overFeature = features.find((f) => f.id === overId);
    const targetColumnId = overColumn?.id ?? overFeature?.columnId;

    if (!targetColumnId) return;

    if (targetColumnId !== activeFeature.columnId) {
      setIsLoading(true);
      try {
        await api.features.move(activeFeature.id, { columnId: targetColumnId });
      } catch (err) {
        setError((err as Error).message);
        if (board) {
          const res = await api.boards.get(board.id);
          useBoardStore.getState().setBoard(res.board, res.columns ?? [], res.features);
        }
      } finally {
        setIsLoading(false);
      }
    }
  }

  if (!board) {
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
                  features={
                    columnPagination[activeMobileColumn.id]?.features
                      ?? featuresByColumn[activeMobileColumn.id]
                      ?? []
                  }
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
              {sortedColumns.map((column) => {
                const pagination = columnPagination[column.id];
                return (
                  <Column
                    key={column.id}
                    column={column}
                    features={pagination?.features ?? featuresByColumn[column.id] ?? []}
                    onSettingsClick={onColumnSettingsClick}
                  />
                );
              })}
              <button
                type="button"
                onClick={onAddColumnClick}
                className="flex h-full min-h-0 w-64 flex-shrink-0 flex-col items-center justify-center rounded-lg border-2 border-dashed border-muted-foreground/25 text-muted-foreground hover:border-primary hover:text-primary cursor-pointer transition-colors"
              >
                <Plus className="h-6 w-6 mb-1" />
                <span className="text-sm font-medium">Add Column</span>
              </button>
            </SortableContext>

            {/* Archived column - fixed width toggleable column */}
            {!isMobile && board && (
              <div className="flex-shrink-0 h-full min-h-0 w-72 flex flex-col">
                {/* Toggle header */}
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
                  <ChevronDown className={`h-3.5 w-3.5 text-on-surface-variant/50 transition-transform duration-200 ${archivedExpanded ? 'rotate-180' : ''}`} />
                </button>

                {/* Content area */}
                <div
                  className={`flex-1 min-h-0 overflow-hidden transition-all duration-300 ease-in-out ${
                    archivedExpanded ? 'opacity-100 mt-1' : 'opacity-0 max-h-0'
                  }`}
                >
                  <div className="h-full overflow-y-auto muted-scrollbar p-2 rounded-lg border border-outline-variant/15 bg-surface-container/20">
                    {archivedLoading && (
                      <div data-testid="archived-loading" className="flex items-center justify-center py-8 text-xs text-on-surface-variant/70">
                        Loading...
                      </div>
                    )}
                    {!archivedLoading && archivedFeatures.length === 0 && (
                      <div data-testid="archived-empty" className="flex flex-col items-center justify-center py-12 text-on-surface-variant/40 gap-2">
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
                            navigate(`/features/${feature.id}`);
                          }}
                        >
                          <div className="text-xs font-medium text-on-surface-variant truncate">{feature.title}</div>
                          <div className="flex items-center gap-1.5 mt-1.5">
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant/70">
                              {feature.status.replace('_', ' ')}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface-container-high text-on-surface-variant/70">
                              {feature.priority}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <DragOverlay>
          {activeFeature && !isBulkSelectMode && <FeatureCard feature={activeFeature} isDragOverlay />}
        </DragOverlay>
      </DndContext>

      {isLoading && (
        <div className="absolute right-4 top-4 rounded-md bg-primary px-3 py-1 text-xs text-primary-foreground">
          Saving...
        </div>
      )}
    </div>
  );
}
