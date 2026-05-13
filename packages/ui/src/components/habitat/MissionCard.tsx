import React, { useState, useEffect } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useNavigate } from 'react-router-dom';
import { shallow } from 'zustand/shallow';
import { Badge } from '../ui/Badge.js';
import { Tooltip } from '../ui/Tooltip.js';
import { useBoardStore } from '../../store/habitatStore.js';
import type { FeatureWithProgress } from '../../types/index.js';
import { GripVertical, Link2 } from 'lucide-react';
import { truncateId, formatDueDate, PRIORITY_VARIANT, PRIORITY_BORDER_CLASS, FEATURE_STATUS_VARIANT } from '../../lib/formatting.js';

interface FeatureCardProps {
  feature: FeatureWithProgress;
  isDragOverlay?: boolean;
}

const priorityTooltip: Record<string, string> = {
  critical: 'Critical priority',
  high: 'High priority',
  medium: 'Medium priority',
  low: 'Low priority',
};

function FeatureCardInner({ feature, isDragOverlay }: FeatureCardProps) {
  const navigate = useNavigate();
  const isBulkSelectMode = useBoardStore((s) => s.isBulkSelectMode);
  const selectedFeatureIds = useBoardStore((s) => s.selectedFeatureIds);
  const toggleFeatureSelection = useBoardStore((s) => s.toggleFeatureSelection);
  const tasks = useBoardStore(
    (s) => s.tasks.filter((t) => t.featureId === feature.id),
    shallow
  );
  const activeAgents = useBoardStore(
    (s) => {
      const featureTaskIds = new Set(
        s.tasks.filter((t) => t.featureId === feature.id).map((t) => t.id)
      );
      return s.agents.filter(
        (a) => a.currentTaskId !== null && featureTaskIds.has(a.currentTaskId)
      );
    },
    shallow
  );
  const isSelected = selectedFeatureIds.includes(feature.id);
  const [isHovered, setIsHovered] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const prevColumnId = React.useRef(feature.columnId);

  useEffect(() => {
    if (prevColumnId.current !== feature.columnId) {
      prevColumnId.current = feature.columnId;
      setAnimKey((k) => k + 1);
    }
  }, [feature.columnId]);

  const completed = feature.progress.done + feature.progress.approved;
  const total = feature.progress.total;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  const borderClass = PRIORITY_BORDER_CLASS[feature.priority] ?? PRIORITY_BORDER_CLASS.medium;

  function handleCardClick(e: React.MouseEvent) {
    if (isBulkSelectMode) {
      e.stopPropagation();
      toggleFeatureSelection(feature.id);
    } else if (!isDragOverlay) {
      navigate(`/features/${feature.id}`);
    }
  }

  return (
    <div
      key={animKey}
      onClick={handleCardClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      data-testid={`feature-card-${feature.id}`}
      className={`group glass-card ${borderClass} p-3 hover:-translate-y-0.5 transition-colors transition-shadow duration-200 ease-out ${
        isDragOverlay ? 'shadow-lg ring-2 ring-primary' : 'animate-card-hover'
      } ${!isDragOverlay && animKey > 0 ? 'animate-task-move' : ''} ${
        isSelected ? 'ring-2 ring-primary' : ''
      } cursor-pointer`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isBulkSelectMode && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleFeatureSelection(feature.id)}
              onClick={(e) => e.stopPropagation()}
              className="h-5 w-5 flex-shrink-0 rounded border-[var(--outline-variant)] mobile-touch-target"
            />
          )}
          <span className="text-sm font-medium leading-tight truncate text-[var(--on-surface)]">{feature.title}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-on-surface-variant font-label whitespace-nowrap">
            {truncateId(feature.id, 'FEAT')}
          </span>
          {!isBulkSelectMode && !isDragOverlay && (
            <GripVertical className="h-4 w-4 cursor-grab text-[var(--on-surface-variant)] opacity-0 group-hover:opacity-100 touch-drag-handle transition-opacity" />
          )}
        </div>
      </div>

      {activeAgents.length > 0 && (
        <div className="flex items-center gap-1.5 mt-2">
          <span className="w-2 h-2 rounded-full bg-[var(--badge-active)] animate-pulse" />
          <span className="text-xs text-on-surface-variant font-label uppercase tracking-wider">
            Processing...
          </span>
        </div>
      )}

      <div className="flex items-center gap-1.5 mt-2">
        <Tooltip content={priorityTooltip[feature.priority] ?? ''} position="top">
          <Badge variant={PRIORITY_VARIANT[feature.priority] ?? 'medium'}>
            {feature.priority}
          </Badge>
        </Tooltip>
        <Badge variant={(FEATURE_STATUS_VARIANT[feature.status] ?? 'pending') as any}>
          {feature.status.replace('_', ' ')}
        </Badge>
      </div>

      {total > 0 && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-[var(--on-surface-variant)] mb-1">
            <span>{completed}/{total} tasks</span>
            <span>{percentage}%</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-[var(--surface-container-high)] overflow-hidden">
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </div>
      )}

      <div className={`mt-2 overflow-hidden transition-[max-height,opacity] duration-200 ${
          isHovered ? 'max-h-40 opacity-100' : 'max-h-0 opacity-0'
        }`}>
        {feature.labels.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {feature.labels.slice(0, 3).map((label) => (
              <span
                key={label}
                className="rounded bg-[var(--surface-container-high)] px-1.5 py-0.5 text-xs text-[var(--on-surface-variant)]"
              >
                {label}
              </span>
            ))}
            {feature.labels.length > 3 && (
              <span className="text-xs text-[var(--on-surface-variant)]">
                +{feature.labels.length - 3}
              </span>
            )}
          </div>
        )}

        {feature.dependsOn.length > 0 && (
          <div className="mb-2 flex items-center gap-1 text-xs text-[var(--on-surface-variant)]">
            <Link2 className="h-3 w-3" />
            <span>{feature.dependsOn.length} dependency{feature.dependsOn.length > 1 ? 's' : ''}</span>
          </div>
        )}

        {(feature.dueAt || feature.slaDeadlineAt) && (() => {
          const dd = formatDueDate(feature);
          return dd ? (
            <div className={`flex items-center gap-1 text-xs mt-1 ${dd.color}`}>
              {dd.icon}
              <span>{dd.text}</span>
            </div>
          ) : null;
        })()}
      </div>
    </div>
  );
}

export const FeatureCard = React.memo(FeatureCardInner);

export function SortableFeatureCard({ feature }: { feature: FeatureWithProgress }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: feature.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <FeatureCard feature={feature} />
    </div>
  );
}
