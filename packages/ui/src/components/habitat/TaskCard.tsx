import React, { useState, useEffect, memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useQuery } from '@tanstack/react-query';
import { shallow } from 'zustand/shallow';
import { Badge } from '../ui/Badge.js';
import { Tooltip } from '../ui/Tooltip.js';
import { useBoardStore } from '../../store/habitatStore.js';
import { useModalStore } from '../../store/modalStore.js';
import { api } from '../../api/index.js';
import type { Task } from '../../types/index.js';
import { GripVertical, Link2, Eye, Calendar, Clock, AlertTriangle, Lock, ShieldCheck, ShieldAlert } from 'lucide-react';

interface TaskCardProps {
  task: Task;
  isDragOverlay?: boolean;
  blockedByDeps?: boolean;
  qualityStatus?: 'passed' | 'blocked' | null;
}

const priorityVariant: Record<string, 'critical' | 'high' | 'medium' | 'low'> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
};

const statusVariant: Record<string, 'pending' | 'claimed' | 'in_progress' | 'submitted' | 'approved' | 'rejected' | 'done' | 'failed'> = {
  pending: 'pending',
  claimed: 'claimed',
  in_progress: 'in_progress',
  submitted: 'submitted',
  approved: 'approved',
  rejected: 'rejected',
  done: 'done',
  failed: 'failed',
};

const priorityTooltip: Record<string, string> = {
  critical: 'Critical priority - claim first',
  high: 'High priority - claim after critical',
  medium: 'Medium priority',
  low: 'Low priority - claim last',
};

const priorityBorderClass: Record<string, string> = {
  critical: 'border-l-[3px] border-l-[var(--badge-critical)]',
  high: 'border-l-[3px] border-l-[var(--badge-high)]',
  medium: 'border-l-[3px] border-l-[var(--badge-medium)]',
  low: 'border-l-[3px] border-l-[var(--badge-low)]',
};

const statusTooltip: Record<string, string> = {
  claimed: 'Agent has claimed this task',
  in_progress: 'Agent is actively working',
  submitted: 'Awaiting human review',
  approved: 'Human approved - moving forward',
  rejected: 'Human rejected - needs rework',
};

function AgentAvatar({ agentId }: { agentId: string }) {
  const agent = useBoardStore(
    (s) => s.agents.find((a) => a.id === agentId) ?? null,
    shallow
  );
  if (!agent) return null;

  const initials = agent.name.slice(0, 2).toUpperCase();
  const color =
    agent.type === 'claude-code'
      ? 'bg-[var(--agent-blue)]'
      : agent.type === 'codex'
      ? 'bg-[var(--agent-purple)]'
      : 'bg-[var(--agent-green)]';

  return (
    <div
      className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold text-[var(--on-surface)] ${color}`}
      title={agent.name}
    >
      {initials}
    </div>
  );
}

function truncateId(id: string, prefix: string): string {
  const hash = id.includes('-') ? id.slice(id.indexOf('-') + 1) : id;
  return `${prefix}-${hash.slice(0, 6)}`;
}

function formatDueDate(task: { dueAt: string | null; slaDeadlineAt: string | null; dueDateStatus?: string }): { text: string; color: string; icon: React.ReactNode } | null {
  const deadline = task.slaDeadlineAt ?? task.dueAt;
  if (!deadline) return null;
  let status = task.dueDateStatus ?? 'ok';
  if (!task.dueDateStatus) {
    const ms = new Date(deadline).getTime() - Date.now();
    status = ms < 0 ? 'overdue' : ms < 3600000 ? 'approaching' : 'ok';
  }
  const date = new Date(deadline);
  const isToday = new Date().toDateString() === date.toDateString();
  const text = isToday
    ? `Today ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
    : date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  const colors: Record<string, string> = {
    overdue: 'text-[var(--badge-blocked-text)]',
    approaching: 'text-[var(--badge-review-text)]',
    ok: 'text-on-surface-variant',
  };
  const icons: Record<string, React.ReactNode> = {
    overdue: React.createElement(AlertTriangle, { className: 'w-3 h-3' }),
    approaching: React.createElement(Clock, { className: 'w-3 h-3' }),
    ok: React.createElement(Calendar, { className: 'w-3 h-3' }),
  };
  return { text, color: colors[status] ?? colors.ok, icon: icons[status] ?? icons.ok };
}

/**
 * Renders a single task card showing title, priority, status, assignee,
 * and live presence indicators. Click opens the detail panel.
 */
export const TaskCard = memo(function TaskCard({ task, isDragOverlay, blockedByDeps: blockedByDepsProp, qualityStatus: qualityStatusProp }: TaskCardProps) {
  const openModal = useModalStore((s) => s.openModal);
  const isBulkSelectMode = useBoardStore((s) => s.isBulkSelectMode);
  const taskViewers = useBoardStore(
    (s) => s.presence.filter((p) => p.viewingTaskId === task.id),
    shallow
  );
  const [animKey, setAnimKey] = useState(0);
  const borderClass = priorityBorderClass[task.priority] ?? priorityBorderClass.medium;

  const { data: qualityReport } = useQuery({
    queryKey: ['task-quality', task.id],
    queryFn: () => api.qualityGates.getReport(task.id),
    enabled: qualityStatusProp === undefined && task.status === 'submitted',
  });

  const { data: blockedStatus } = useQuery({
    queryKey: ['task-blocked', task.id],
    queryFn: () => api.dependencies.getBlockedStatus(task.id),
    enabled: blockedByDepsProp === undefined && (task.status === 'pending' || task.status === 'claimed'),
  });

  const qualityStatus = qualityStatusProp ?? qualityReport?.overallStatus ?? null;
  const blockedByDeps = blockedByDepsProp ?? blockedStatus?.isBlocked ?? false;

  function handleCardClick(e: React.MouseEvent) {
    if (!isDragOverlay) {
      openModal(task.id);
    }
  }

  return (
    <div
      key={animKey}
      onClick={handleCardClick}
      className={`group glass-card ${borderClass} p-3 hover:-translate-y-0.5 transition-colors transition-shadow duration-200 ease-out ${
        isDragOverlay ? 'shadow-lg ring-2 ring-primary' : 'animate-card-hover'
      } ${!isDragOverlay && animKey > 0 ? 'animate-task-move' : ''} cursor-pointer`}
    >
      <div className="mb-2 flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-sm font-medium leading-tight truncate">{task.title}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <span className="text-xs text-on-surface-variant font-label whitespace-nowrap">
            {truncateId(task.id, 'TASK')}
          </span>
          {!isBulkSelectMode && (
            <Tooltip content={priorityTooltip[task.priority] ?? ''} position="top">
              <Badge variant={priorityVariant[task.priority] ?? 'medium'}>
                {task.priority}
              </Badge>
            </Tooltip>
          )}
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Tooltip content={statusTooltip[task.status] ?? ''} position="top">
            <Badge variant={statusVariant[task.status] ?? 'default'}>
              {task.status.replace('_', ' ')}
            </Badge>
          </Tooltip>
          {task.rejectedCount > 0 && (
            <span className="text-xs text-[var(--badge-blocked-text)]" title={`Rejected ${task.rejectedCount}x`}>
              ↩ {task.rejectedCount}
            </span>
          )}
          {blockedByDeps && (
            <Tooltip content="Blocked by dependencies" position="top">
              <Lock className="h-3 w-3 text-[var(--badge-review-text)]" />
            </Tooltip>
          )}
          {task.status === 'submitted' && qualityStatus && (
            qualityStatus === 'passed' ? (
              <Tooltip content="Quality gates passed" position="top">
                <ShieldCheck className="h-3.5 w-3.5 text-[var(--badge-done-text)]" />
              </Tooltip>
            ) : (
              <Tooltip content="Quality gates blocked" position="top">
                <ShieldAlert className="h-3.5 w-3.5 text-[var(--badge-review-text)]" />
              </Tooltip>
            )
          )}
        </div>

        <div className="flex items-center gap-1">
          {task.assignedAgentId ? (
            <AgentAvatar agentId={task.assignedAgentId} />
          ) : (
            <span className="text-xs text-on-surface-variant">Unassigned</span>
          )}
          {taskViewers.length > 0 && (
            <Tooltip
              content={taskViewers.map((v) => v.userName ?? v.agentName ?? 'Unknown').join(', ')}
              position="top"
            >
              <div className="flex items-center gap-0.5 rounded border border-[var(--badge-active)] bg-[var(--badge-active-bg)] px-1 py-0.5 text-[10px] font-medium text-[var(--badge-active-text)]">
                <Eye className="h-3 w-3" />
                {taskViewers.length}
              </div>
            </Tooltip>
          )}
          {!isDragOverlay && (
            <GripVertical className="h-4 w-4 flex-shrink-0 cursor-grab text-on-surface-variant opacity-0 group-hover:opacity-100 touch-drag-handle transition-opacity" />
          )}
        </div>
      </div>

      {task.rejectionReason && (
        <div className="mt-2 rounded border border-[var(--badge-blocked)] bg-[var(--badge-blocked-bg)] p-2 text-xs text-[var(--badge-blocked-text)]">
          {task.rejectionReason}
        </div>
      )}
    </div>
  );
});

/** TaskCard wrapped with @dnd-kit sortable attributes for drag-and-drop. */
export function SortableTaskCard({ task }: { task: Task }) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: task.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <TaskCard task={task} />
    </div>
  );
}
