import React from 'react';
import { useModalStore } from '../../store/modalStore.js';
import { useHabitatStore } from '../../store/habitatStore.js';
import { Badge } from '../ui/Badge.js';
import { formatStatus } from './MissionHeader.js';
import {
  Circle,
  CheckCircle2,
  XCircle,
  Timer,
  Clock,
  AlertTriangle,
} from 'lucide-react';
import type { Task, MissionWithProgress } from '../../types/index.js';

interface PipelineContextSidebarProps {
  feature: MissionWithProgress;
  tasks: Task[];
}

function statusDotColor(status: Task['status']): string {
  switch (status) {
    case 'done':
      return 'bg-[var(--primary)]';
    case 'failed':
      return 'bg-[var(--error)]';
    case 'in_progress':
      return 'bg-[var(--primary-container)]';
    case 'submitted':
    case 'approved':
    case 'rejected':
      return 'bg-[var(--badge-review)]';
    default:
      return 'bg-[var(--outline)]';
  }
}

function TaskListItem({ task }: { task: Task }) {
  const openModal = useModalStore((s) => s.openModal);
  const agents = useHabitatStore((s) => s.agents);

  const assignee = task.assignedAgentId
    ? agents.find((a) => a.id === task.assignedAgentId)
    : null;

  const statusIcon = (() => {
    switch (task.status) {
      case 'done':
        return <CheckCircle2 className="h-3 w-3 text-[var(--primary)]" />;
      case 'failed':
        return <XCircle className="h-3 w-3 text-[var(--error)]" />;
      case 'in_progress':
        return <Timer className="h-3 w-3 text-[var(--primary-container)]" />;
      case 'submitted':
      case 'approved':
        return <Clock className="h-3 w-3 text-[var(--badge-review)]" />;
      default:
        return <Circle className="h-3 w-3 text-[var(--outline)]" />;
    }
  })();

  return (
    <div
      onClick={() => openModal(task.id)}
      className="p-2.5 bg-[var(--surface-container)] border border-[var(--outline-variant)] rounded hover:border-[var(--outline)] transition-all cursor-pointer"
    >
      <div className="flex justify-between items-start mb-1.5">
        <span className="text-[10px] font-bold text-[var(--on-surface-variant)]">
          #{task.id.slice(0, 4)}
        </span>
        <Badge
          variant={task.priority as 'critical' | 'high' | 'medium' | 'low'}
        >
          {task.priority}
        </Badge>
      </div>
      <p className="text-[11px] font-medium text-[var(--on-surface)] leading-tight mb-1.5 line-clamp-2">
        {task.title}
      </p>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          {statusIcon}
          <span className="text-[9px] font-bold uppercase text-[var(--on-surface-variant)]">
            {formatStatus(task.status)}
          </span>
        </div>
        {assignee && (
          <span className="text-[9px] text-[var(--on-surface-variant)] font-medium">
            {assignee.name.slice(0, 2).toUpperCase()}
          </span>
        )}
      </div>
    </div>
  );
}

export function PipelineContextSidebar({
  feature,
  tasks,
}: PipelineContextSidebarProps) {
  const openModal = useModalStore((s) => s.openModal);

  const grouped = React.useMemo(() => {
    const groups: Record<string, Task[]> = {
      active: [],
      review: [],
      pending: [],
      done: [],
    };
    for (const t of tasks) {
      if (t.status === 'in_progress' || t.status === 'claimed') {
        groups.active.push(t);
      } else if (
        t.status === 'submitted' ||
        t.status === 'approved' ||
        t.status === 'rejected'
      ) {
        groups.review.push(t);
      } else if (t.status === 'pending') {
        groups.pending.push(t);
      } else {
        groups.done.push(t);
      }
    }
    return groups;
  }, [tasks]);

  const completedCount = tasks.filter(
    (t) => t.status === 'done' || t.status === 'failed'
  ).length;
  const healthPct =
    tasks.length > 0 ? Math.round((completedCount / tasks.length) * 100) : 0;

  return (
    <aside className="w-72 flex-shrink-0 flex flex-col h-full overflow-hidden">
      <div className="p-4 ghost-border-b bg-[var(--surface-container)]/20">
        <h3 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest mb-4">
          Pipeline Context
        </h3>
        <div className="glass-panel p-3">
          <div className="flex items-center justify-between text-[9px] font-bold text-[var(--on-surface-variant)] mb-2 border-b border-[var(--outline-variant)] pb-1">
            <span>FEATURE STATUS</span>
            <span className="text-[var(--primary)]">{healthPct}% OK</span>
          </div>
          <div className="space-y-2">
            {tasks.slice(0, 6).map((task) => (
              <div
                key={task.id}
                className="flex items-center space-x-2 group cursor-pointer"
                onClick={() => openModal(task.id)}
              >
                <div
                  className={`w-1.5 h-1.5 rounded-full ${statusDotColor(task.status)}`}
                />
                <div className="bg-[var(--surface-container)] border border-[var(--outline-variant)] p-1.5 rounded text-[10px] flex-1">
                  <div className="flex justify-between items-center">
                    <span className="font-bold text-[var(--on-surface)] truncate">
                      {task.title.slice(0, 16)}
                      {task.title.length > 16 ? '...' : ''}
                    </span>
                    {task.status === 'failed' && (
                      <AlertTriangle className="h-3 w-3 text-[var(--error)] flex-shrink-0" />
                    )}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {grouped.active.length > 0 && (
          <div>
            <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest mb-2">
              Active
            </h4>
            <div className="space-y-2">
              {grouped.active.map((task) => (
                <TaskListItem key={task.id} task={task} />
              ))}
            </div>
          </div>
        )}

        {grouped.review.length > 0 && (
          <div>
            <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest mb-2">
              Awaiting Validation
            </h4>
            <div className="space-y-2">
              {grouped.review.map((task) => (
                <TaskListItem key={task.id} task={task} />
              ))}
            </div>
          </div>
        )}

        {grouped.pending.length > 0 && (
          <div>
            <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest mb-2">
              Pending
            </h4>
            <div className="space-y-2">
              {grouped.pending.map((task) => (
                <TaskListItem key={task.id} task={task} />
              ))}
            </div>
          </div>
        )}

        {grouped.done.length > 0 && (
          <div>
            <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest mb-2">
              Completed
            </h4>
            <div className="space-y-2">
              {grouped.done.map((task) => (
                <TaskListItem key={task.id} task={task} />
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
