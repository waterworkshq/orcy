import React, { useState } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { SortableFeatureCard } from './MissionCard.js';
import { Tooltip } from '../ui/Tooltip.js';
import type { MissionWithProgress, Column as ColumnType } from '../../types/index.js';
import { Settings, ChevronDown, ChevronRight } from 'lucide-react';
import { useHabitatStore } from '../../store/habitatStore.js';
import { shallow } from 'zustand/shallow';

const INITIAL_VISIBLE = 10;
const LOAD_STEP = 10;

interface ColumnProps {
  column: ColumnType;
  features: MissionWithProgress[];
  onSettingsClick: (column: ColumnType) => void;
  isMobile?: boolean;
}

export const Column = React.memo(function Column({ column, features, onSettingsClick, isMobile }: ColumnProps) {
  const { setNodeRef, isOver } = useDroppable({ id: column.id });
  const wipAlert = useHabitatStore(
    (s) => s.wipAlerts[column.id] ?? null,
    shallow
  );
  const isCollapsed = useHabitatStore((s) => s.collapsedColumns[column.id] ?? false);
  const toggleColumnCollapsed = useHabitatStore((s) => s.toggleColumnCollapsed);
  const [visibleCount, setVisibleCount] = useState(INITIAL_VISIBLE);

  const wipLimit = column.wipLimit;
  const featureCount = features.length;
  const wipExceeded = wipLimit !== null && featureCount >= wipLimit;
  const wipWarning = wipLimit !== null && featureCount >= wipLimit * 0.8;
  const visibleFeatures = features.slice(0, visibleCount);
  const hasMore = visibleCount < featureCount;

  return (
      <div
        ref={setNodeRef}
        data-testid={`column-${column.id}`}
        className={`group relative flex flex-col glass-card ghost-border transition-all duration-200 ${
          isMobile
            ? 'flex-1 min-w-0 max-w-full h-full min-h-0'
            : isCollapsed
              ? 'w-80 shrink-0 h-11'
              : 'w-80 shrink-0 h-full min-h-0'
        }`}
        style={{
          opacity: isOver ? 0.8 : 1,
          border: isOver ? '2px dashed var(--primary)' : undefined,
        }}
      >
      {/* Header - always visible */}
      <div
        data-testid={`column-header-${column.id}`}
        className="sticky top-0 z-10 flex items-center justify-between px-3 py-2 bg-surface-container/90"
      >
        <div className="flex items-center gap-2 min-w-0">
          {!isMobile && (
            <button
              type="button"
              data-testid={`column-collapse-${column.id}`}
              onClick={() => toggleColumnCollapsed(column.id)}
              className="rounded p-0.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface shrink-0"
              title={isCollapsed ? "Expand column" : "Collapse column"}
            >
              {isCollapsed ? (
                <ChevronRight className="h-3.5 w-3.5" />
              ) : (
                <ChevronDown className="h-3.5 w-3.5" />
              )}
            </button>
          )}
          <h3 className="font-semibold text-sm text-on-surface truncate">{column.name}</h3>
          <Tooltip content="Max features allowed in this column" position="top">
            <span
              data-testid={`wip-count-${column.id}`}
              className={`px-2 py-0.5 text-xs font-medium shrink-0 ${
                wipExceeded
                  ? 'glass-badge-exceeded'
                  : wipWarning
                  ? 'glass-badge-warning'
                  : 'glass-badge'
              }`}
            >
              {featureCount}
              {wipLimit !== null && `/${wipLimit}`}
            </span>
          </Tooltip>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {column.requiresClaim && (
            <span className="glass-badge px-1.5 py-0.5 text-xs text-primary">
              claim
            </span>
          )}
          <button
            type="button"
            onClick={() => onSettingsClick(column)}
            className={`rounded p-1 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface ${
              isMobile ? 'opacity-100' : 'opacity-0 transition-opacity group-hover:opacity-100'
            }`}
            title="Column settings"
          >
            <Settings className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Content - hidden when collapsed */}
      {!isCollapsed && (
        <>
          {(() => {
            if (!wipAlert || Date.now() - wipAlert.timestamp > 5000) return null;
            return (
              <div
                data-testid={`wip-alert-${column.id}`}
                className="glass-warning mx-2 mt-2 px-2 py-1 text-xs"
              >
                WIP limit ({wipAlert.limit}) reached — feature cannot advance
              </div>
            );
          })()}

          <div className="flex-1 overflow-y-auto muted-scrollbar px-2 pb-2">
            <SortableContext
              items={visibleFeatures.map((f) => f.id)}
              strategy={verticalListSortingStrategy}
            >
              <div className="flex flex-col gap-2">
                {visibleFeatures.map((feature) => (
                  <SortableFeatureCard key={feature.id} feature={feature} />
                ))}
              </div>
            </SortableContext>
            {hasMore && (
              <button
                type="button"
                onClick={() => setVisibleCount((c) => c + LOAD_STEP)}
                className="mt-2 w-full rounded-md border border-dashed border-outline-variant/50 py-3 text-xs text-on-surface-variant hover:border-primary hover:text-primary transition-colors mobile-touch-target"
              >
                Load more ({Math.min(visibleCount, featureCount)}/{featureCount})
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
});
