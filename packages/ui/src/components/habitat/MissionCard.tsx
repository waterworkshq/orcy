import React, { useState, useEffect } from "react";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { useNavigate } from "react-router-dom";
import { Badge } from "../ui/Badge.js";
import { Tooltip } from "../ui/Tooltip.js";
import { useHabitatStore } from "../../store/habitatStore.js";
import { useMissionTasks, useAgents } from "../../lib/useHabitatData.js";
import type { MissionWithProgress } from "../../types/index.js";
import { GripVertical, Link2, Lock } from "lucide-react";
import {
  truncateId,
  formatDueDate,
  PRIORITY_VARIANT,
  PRIORITY_BORDER_CLASS,
  FEATURE_STATUS_VARIANT,
} from "../../lib/formatting.js";

interface MissionCardProps {
  mission: MissionWithProgress;
  isDragOverlay?: boolean;
}

const priorityTooltip: Record<string, string> = {
  critical: "Critical priority",
  high: "High priority",
  medium: "Medium priority",
  low: "Low priority",
};

function MissionCardInner({ mission, isDragOverlay }: MissionCardProps) {
  const navigate = useNavigate();
  const isBulkSelectMode = useHabitatStore((s) => s.isBulkSelectMode);
  const selectedMissionIds = useHabitatStore((s) => s.selectedMissionIds);
  const toggleMissionSelection = useHabitatStore((s) => s.toggleMissionSelection);
  const { data: tasksData } = useMissionTasks(mission.id);
  const tasks = tasksData?.tasks ?? [];
  const { data: agents = [] } = useAgents();
  const featureTaskIds = new Set(tasks.map((t: any) => t.id));
  const activeAgents = agents.filter(
    (a: any) => a.currentTaskId !== null && featureTaskIds.has(a.currentTaskId),
  );
  const isSelected = selectedMissionIds.includes(mission.id);
  const [isHovered, setIsHovered] = useState(false);
  const [animKey, setAnimKey] = useState(0);
  const prevColumnId = React.useRef(mission.columnId);

  useEffect(() => {
    if (prevColumnId.current !== mission.columnId) {
      prevColumnId.current = mission.columnId;
      setAnimKey((k) => k + 1);
    }
  }, [mission.columnId]);

  const completed = mission.progress.done + mission.progress.approved;
  const total = mission.progress.total;
  const percentage = total > 0 ? Math.round((completed / total) * 100) : 0;

  const borderClass = PRIORITY_BORDER_CLASS[mission.priority] ?? PRIORITY_BORDER_CLASS.medium;

  function handleCardClick(e: React.MouseEvent) {
    if (isBulkSelectMode) {
      e.stopPropagation();
      toggleMissionSelection(mission.id);
    } else if (!isDragOverlay) {
      navigate(`/missions/${mission.id}`);
    }
  }

  return (
    <div
      key={animKey}
      onClick={handleCardClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      data-testid={`feature-card-${mission.id}`}
      className={`group glass-card ${borderClass} p-3 hover:-translate-y-0.5 transition-colors transition-shadow duration-200 ease-out ${
        isDragOverlay ? "shadow-lg ring-2 ring-primary" : "animate-card-hover"
      } ${!isDragOverlay && animKey > 0 ? "animate-task-move" : ""} ${
        isSelected ? "ring-2 ring-primary" : ""
      } cursor-pointer`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          {isBulkSelectMode && (
            <input
              type="checkbox"
              checked={isSelected}
              onChange={() => toggleMissionSelection(mission.id)}
              onClick={(e) => e.stopPropagation()}
              className="h-5 w-5 flex-shrink-0 rounded border-[var(--outline-variant)] mobile-touch-target"
            />
          )}
          <span className="text-sm font-medium leading-tight truncate text-[var(--on-surface)]">
            {mission.title}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-on-surface-variant font-label whitespace-nowrap">
            {truncateId(mission.id, "FEAT")}
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
        <Tooltip content={priorityTooltip[mission.priority] ?? ""} position="top">
          <Badge variant={PRIORITY_VARIANT[mission.priority] ?? "medium"}>{mission.priority}</Badge>
        </Tooltip>
        <Badge variant={FEATURE_STATUS_VARIANT[mission.status] ?? "pending"}>
          {mission.status.replace("_", " ")}
        </Badge>
        {mission.sprintId && (
          <span className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300">
            <span className="h-1.5 w-1.5 rounded-full bg-violet-500" />
            {truncateId(mission.sprintId, "SPR")}
          </span>
        )}
        {(mission.releaseGateType || mission.releaseGateVersion) && (
          <Tooltip
            content={`Gated — auto-promotes when target release ships${
              mission.releaseGateVersion ? ` (${mission.releaseGateVersion})` : ""
            }`}
            position="top"
          >
            <span className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] bg-amber-100 text-amber-700 dark:bg-amber-900 dark:text-amber-300">
              <Lock className="h-3 w-3" />
              {mission.releaseGateVersion
                ? `waits for ${mission.releaseGateVersion}`
                : `waits for ${mission.releaseGateType}`}
            </span>
          </Tooltip>
        )}
        {(mission.releaseDeadlineType || mission.releaseDeadlineVersion) && (
          <Tooltip
            content={`Deadline — should complete before this release ships (escalates on miss)${
              mission.releaseDeadlineVersion ? ` (${mission.releaseDeadlineVersion})` : ""
            }`}
            position="top"
          >
            <span className="inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] bg-indigo-100 text-indigo-700 dark:bg-indigo-900 dark:text-indigo-300">
              {mission.releaseDeadlineVersion
                ? `due before ${mission.releaseDeadlineVersion}`
                : `due before ${mission.releaseDeadlineType}`}
            </span>
          </Tooltip>
        )}
      </div>

      {total > 0 && (
        <div className="mt-2">
          <div className="flex items-center justify-between text-xs text-[var(--on-surface-variant)] mb-1">
            <span>
              {completed}/{total} tasks
            </span>
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

      <div
        className={`mt-2 overflow-hidden transition-[max-height,opacity] duration-200 ${
          isHovered ? "max-h-40 opacity-100" : "max-h-0 opacity-0"
        }`}
      >
        {mission.labels.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1">
            {mission.labels.slice(0, 3).map((label) => (
              <span
                key={label}
                className="rounded bg-[var(--surface-container-high)] px-1.5 py-0.5 text-xs text-[var(--on-surface-variant)]"
              >
                {label}
              </span>
            ))}
            {mission.labels.length > 3 && (
              <span className="text-xs text-[var(--on-surface-variant)]">
                +{mission.labels.length - 3}
              </span>
            )}
          </div>
        )}

        {mission.dependsOn.length > 0 && (
          <div className="mb-2 flex items-center gap-1 text-xs text-[var(--on-surface-variant)]">
            <Link2 className="h-3 w-3" />
            <span>
              {mission.dependsOn.length} dependency{mission.dependsOn.length > 1 ? "s" : ""}
            </span>
          </div>
        )}

        {(mission.dueAt || mission.slaDeadlineAt) &&
          (() => {
            const dd = formatDueDate(mission);
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

export const MissionCard = React.memo(MissionCardInner);

export function SortableMissionCard({ mission }: { mission: MissionWithProgress }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: mission.id,
  });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <MissionCard mission={mission} />
    </div>
  );
}
