import React, { useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Badge } from "../ui/Badge.js";
import { AgentAvatar } from "./AgentAvatar.js";
import { useModalStore } from "../../store/modalStore.js";
import {
  truncateId,
  PRIORITY_VARIANT,
  PRIORITY_BORDER_CLASS,
  TASK_STATUS_VARIANT,
} from "../../lib/formatting.js";
import type { Task } from "../../types/index.js";
import { User } from "lucide-react";

const VIRTUALIZE_THRESHOLD = 100;
const ESTIMATED_CARD_HEIGHT = 88;

interface TaskCardListProps {
  tasks: Task[];
  selectedIds: string[];
  onSelectionChange: (ids: string[]) => void;
  /**
   * Optional external scroll container ref. When provided, the virtualizer
   * measures scroll against this element and the component renders only the
   * items (no own scroll container). Falls back to an internal scroll
   * container — used in isolation (e.g. tests).
   */
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}

const TaskCardItem = React.memo(function TaskCardItem({
  task,
  isSelected,
  onToggle,
}: {
  task: Task;
  isSelected: boolean;
  onToggle: () => void;
}) {
  const openModal = useModalStore((s) => s.openModal);
  const borderClass = PRIORITY_BORDER_CLASS[task.priority] ?? PRIORITY_BORDER_CLASS.medium;

  return (
    <div
      className={`glass-card ${borderClass} p-3 cursor-pointer transition-colors hover:bg-[var(--surface-container-high)]`}
      data-testid="task-card-item"
      role="listitem"
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggle}
          className="mt-0.5 h-4 w-4 rounded border-[var(--outline)] text-[var(--primary)] focus:ring-[var(--primary)] flex-shrink-0"
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${task.title}`}
        />
        <div
          className="flex-1 min-w-0"
          onClick={() => openModal(task.id)}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              openModal(task.id);
            }
          }}
          aria-label={`Open ${task.title}`}
        >
          <div className="flex items-center justify-between gap-2 mb-1">
            <span className="text-sm font-medium truncate">{task.title}</span>
            <span className="text-xs text-[var(--on-surface-variant)] flex-shrink-0">
              {truncateId(task.id, "TASK")}
            </span>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant={TASK_STATUS_VARIANT[task.status] ?? "default"}>
              {task.status.replace("_", " ")}
            </Badge>
            <Badge variant={PRIORITY_VARIANT[task.priority] ?? "medium"}>{task.priority}</Badge>
            {task.rejectedCount > 0 && (
              <span
                className="text-xs text-[var(--badge-blocked-text)]"
                title={`Rejected ${task.rejectedCount}x`}
              >
                ↩ {task.rejectedCount}
              </span>
            )}
            <div className="flex items-center gap-1 ml-auto text-xs text-[var(--on-surface-variant)]">
              {task.assignedAgentId ? (
                <AgentAvatar agentId={task.assignedAgentId} />
              ) : (
                <>
                  <User className="h-3 w-3" />
                  <span>Unassigned</span>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
});

export function TaskCardList({
  tasks,
  selectedIds,
  onSelectionChange,
  scrollRef: externalScrollRef,
}: TaskCardListProps) {
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const internalScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = externalScrollRef ?? internalScrollRef;
  const shouldVirtualize = tasks.length > VIRTUALIZE_THRESHOLD;

  const virtualizer = useVirtualizer({
    count: tasks.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ESTIMATED_CARD_HEIGHT,
    enabled: shouldVirtualize,
  });

  function handleToggle(taskId: string) {
    const next = selectedSet.has(taskId)
      ? selectedIds.filter((id) => id !== taskId)
      : [...selectedIds, taskId];
    onSelectionChange(next);
  }

  if (tasks.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-[var(--on-surface-variant)]">
        No tasks found
      </div>
    );
  }

  const virtualItems = shouldVirtualize ? virtualizer.getVirtualItems() : [];
  const paddingTop = virtualItems.length > 0 ? virtualItems[0].start : 0;
  const lastVirtualItem = virtualItems[virtualItems.length - 1];
  const paddingBottom = lastVirtualItem
    ? virtualizer.getTotalSize() - lastVirtualItem.end
    : 0;

  const list = shouldVirtualize ? (
    <>
      <div style={{ height: paddingTop }} aria-hidden="true" />
      {virtualItems.map((virtualItem) => {
        const task = tasks[virtualItem.index];
        return (
          <TaskCardItem
            key={task.id}
            task={task}
            isSelected={selectedSet.has(task.id)}
            onToggle={() => handleToggle(task.id)}
          />
        );
      })}
      <div style={{ height: paddingBottom }} aria-hidden="true" />
    </>
  ) : (
    <div className="flex flex-col gap-2">
      {tasks.map((task) => (
        <TaskCardItem
          key={task.id}
          task={task}
          isSelected={selectedSet.has(task.id)}
          onToggle={() => handleToggle(task.id)}
        />
      ))}
    </div>
  );

  // When the parent supplies a scroll container, render items directly into it
  // (no nested scroll container). Otherwise, render our own bounded-height
  // scroll container — used in isolation (e.g. unit tests).
  if (externalScrollRef) {
    return <div role="list">{list}</div>;
  }

  return (
    <div
      ref={internalScrollRef}
      className="overflow-auto"
      style={{ maxHeight: "600px", overflowY: "auto" }}
      role="list"
    >
      {list}
    </div>
  );
}
