import React from "react";
import { BarChart3, CheckCircle2, XCircle, Circle, Timer } from "lucide-react";
import { useModalStore } from "../../store/modalStore.js";
import { useAgents } from "../../lib/useHabitatData.js";
import { Badge } from "../ui/Badge.js";
import { formatStatus } from "./MissionHeader.js";
import type { Task, TaskStatus } from "../../types/index.js";

const KANBAN_COLUMNS: { label: string; statuses: TaskStatus[] }[] = [
  { label: "Pending", statuses: ["pending", "claimed"] },
  { label: "In Progress", statuses: ["in_progress"] },
  { label: "Review", statuses: ["submitted", "approved", "rejected"] },
  { label: "Done", statuses: ["done", "failed"] },
];

export interface FeatureTaskKanbanProps {
  tasks: Task[];
}

function KanbanTaskCard({ task }: { task: Task }) {
  const openModal = useModalStore((s) => s.openModal);
  const { data: agents = [] } = useAgents();

  const assignee = task.assignedAgentId ? agents.find((a) => a.id === task.assignedAgentId) : null;

  const statusIcon = (() => {
    switch (task.status) {
      case "done":
        return <CheckCircle2 className="h-3.5 w-3.5 text-[var(--primary)]" />;
      case "failed":
        return <XCircle className="h-3.5 w-3.5 text-[var(--error)]" />;
      case "in_progress":
        return <Timer className="h-3.5 w-3.5 text-[var(--primary-container)]" />;
      default:
        return <Circle className="h-3.5 w-3.5 text-[var(--outline)]" />;
    }
  })();

  return (
    <div
      onClick={() => openModal(task.id)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openModal(task.id);
        }
      }}
      className="p-2.5 bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded hover:border-[var(--outline)] transition-all cursor-pointer"
    >
      <div className="flex justify-between items-start mb-1.5">
        <span className="text-[10px] font-bold text-[var(--on-surface-variant)]">
          #{task.id.slice(0, 4)}
        </span>
        <Badge variant={task.priority as "critical" | "high" | "medium" | "low"}>
          {task.priority}
        </Badge>
      </div>
      <p className="text-[11px] font-medium text-[var(--on-surface)] leading-tight mb-1.5">
        {task.title}
      </p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1 text-[var(--on-surface-variant)]">
          {statusIcon}
          <span className="text-[9px] font-bold uppercase">{formatStatus(task.status)}</span>
        </div>
        <div className="flex items-center gap-1.5">
          {assignee && (
            <span className="text-[9px] text-[var(--on-surface-variant)]">
              {assignee.name.slice(0, 2).toUpperCase()}
            </span>
          )}
          {task.estimatedMinutes && (
            <span className="text-[9px] text-[var(--on-surface-variant)]">
              ~{task.estimatedMinutes}m
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export { KANBAN_COLUMNS };

export function FeatureTaskKanban({ tasks }: FeatureTaskKanbanProps) {
  return (
    <div className="bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded-lg overflow-hidden">
      <div className="px-4 py-3 bg-[var(--surface-container-high)]/50 border-b border-[var(--outline-variant)] flex items-center gap-2">
        <BarChart3 className="h-4 w-4 text-[var(--on-surface-variant)]" />
        <span className="text-xs font-bold text-[var(--on-surface)]">Task Kanban</span>
        <span className="text-[10px] text-[var(--on-surface-variant)] ml-auto">
          {tasks.length} tasks
        </span>
      </div>
      <div className="grid grid-cols-4 gap-0">
        {KANBAN_COLUMNS.map((col) => {
          const colTasks = tasks.filter((t) => col.statuses.includes(t.status));
          return (
            <div
              key={col.label}
              className="border-r border-[var(--outline-variant)] last:border-r-0"
            >
              <div className="px-3 py-2 border-b border-[var(--outline-variant)] bg-[var(--surface-container-high)]/30 flex items-center justify-between">
                <span className="text-[10px] font-bold text-[var(--on-surface-variant)] uppercase">
                  {col.label}
                </span>
                <span className="text-[10px] text-[var(--on-surface-variant)] bg-[var(--surface-container-high)] px-1.5 py-0.5 rounded">
                  {colTasks.length}
                </span>
              </div>
              <div className="p-2 space-y-2 min-h-[120px]">
                {colTasks.map((task) => (
                  <KanbanTaskCard key={task.id} task={task} />
                ))}
                {colTasks.length === 0 && (
                  <div className="text-[10px] text-[var(--on-surface-variant)] text-center py-4 italic">
                    No tasks
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
