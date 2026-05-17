import React from 'react';
import { formatRelativeTime, formatStatus } from './MissionHeader.js';
import {
  AlertTriangle,
  Info,
  Settings,
  ArrowRight,
} from 'lucide-react';
import type {
  MissionWithProgress,
  Task,
  MissionEvent,
} from '../../types/index.js';

interface RiskAnalysisSidebarProps {
  feature: MissionWithProgress;
  tasks: Task[];
  events: MissionEvent[];
  dependencies: { dependsOn: string[]; blocks: string[] };
}

function ProjectedImpactBar({
  tasks,
  dependencies,
}: {
  tasks: Task[];
  dependencies: { dependsOn: string[]; blocks: string[] };
}) {
  const doneCount = tasks.filter(
    (t) => t.status === 'done' || t.status === 'failed'
  ).length;
  const activeCount = tasks.filter(
    (t) =>
      t.status === 'in_progress' ||
      t.status === 'submitted' ||
      t.status === 'approved'
  ).length;
  const pendingCount = tasks.filter(
    (t) => t.status === 'pending' || t.status === 'claimed'
  ).length;

  const total = tasks.length || 1;
  const blockedPct = dependencies.dependsOn.length > 0 ? 33 : 0;
  const activePct = Math.round((activeCount / total) * 100);
  const donePct = Math.round((doneCount / total) * 100);
  const pendingPct = 100 - activePct - donePct - blockedPct;

  let level = 'Low';
  if (blockedPct > 0 || dependencies.dependsOn.length > 0) level = 'Medium';
  if (tasks.some((t) => t.status === 'failed')) level = 'High';

  return (
    <div className="mb-8">
      <div className="flex justify-between items-end mb-2">
        <span className="text-xs font-bold text-[var(--on-surface)]">
          Projected Impact
        </span>
        <span className="text-[10px] text-[var(--on-surface-variant)] uppercase">
          {level}
        </span>
      </div>
      <div className="h-2 bg-[var(--surface-container-high)] rounded-full flex overflow-hidden">
        {donePct > 0 && (
          <div
            className="bg-[var(--primary)]/80 transition-all"
            style={{ width: `${donePct}%` }}
          />
        )}
        {activePct > 0 && (
          <div
            className="bg-[var(--badge-review)]/80 transition-all"
            style={{ width: `${activePct}%` }}
          />
        )}
        {pendingPct > 0 && (
          <div
            className="bg-[var(--surface-container-high)] transition-all"
            style={{ width: `${Math.max(pendingPct, 0)}%` }}
          />
        )}
      </div>
      <div className="flex gap-3 mt-2 text-[9px] text-[var(--on-surface-variant)]">
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--primary)]" /> Done
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--badge-review)]" />{' '}
          Active
        </span>
        <span className="flex items-center gap-1">
          <span className="w-2 h-2 rounded-full bg-[var(--surface-container-high)]" />{' '}
          Pending
        </span>
      </div>
    </div>
  );
}

function CriticalBlockers({
  tasks,
  dependencies,
}: {
  tasks: Task[];
  dependencies: { dependsOn: string[]; blocks: string[] };
}) {
  const failedTasks = tasks.filter((t) => t.status === 'failed');
  const hasBlockedDeps = dependencies.dependsOn.length > 0;

  if (failedTasks.length === 0 && !hasBlockedDeps) {
    return (
      <div className="space-y-4">
        <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest mb-3">
          Critical Blockers
        </h4>
        <div className="glass-panel p-3 text-center">
          <p className="text-[10px] text-[var(--on-surface-variant)] italic">
            No critical blockers
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest mb-3">
        Critical Blockers
      </h4>
      {failedTasks.map((task) => (
        <div
          key={task.id}
          className="bg-[var(--badge-blocked-bg)] border border-[var(--badge-blocked)]/30 rounded-lg p-3 group hover:bg-[var(--badge-blocked-bg)]/80 transition-all cursor-pointer"
        >
          <div className="flex items-start space-x-3">
            <div className="p-1.5 bg-[var(--badge-blocked-bg)] rounded text-[var(--error)]">
              <AlertTriangle className="h-4 w-4" />
            </div>
            <div className="flex-1 min-w-0">
              <h5 className="text-xs font-bold text-[var(--on-surface)] truncate">
                {task.title}
              </h5>
              {task.rejectionReason && (
                <p className="text-[10px] text-[var(--on-surface-variant)] mt-1 leading-normal line-clamp-2">
                  {task.rejectionReason}
                </p>
              )}
              <div className="mt-2 flex items-center justify-between">
                <span className="text-[9px] font-bold text-[var(--error)] uppercase">
                  Failed
                </span>
                <ArrowRight className="h-3 w-3 text-[var(--on-surface-variant)] group-hover:text-[var(--on-surface)]" />
              </div>
            </div>
          </div>
        </div>
      ))}
      {hasBlockedDeps && (
        <div className="glass-panel p-3">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-[var(--on-surface)]">
              {dependencies.dependsOn.length} blocked{' '}
              {dependencies.dependsOn.length === 1 ? 'dependency' : 'dependencies'}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

function HistoryTimeline({ events }: { events: MissionEvent[] }) {
  const recentEvents = events.slice(0, 5);

  if (recentEvents.length === 0) {
    return (
      <div className="mt-12 space-y-4">
        <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest">
          History
        </h4>
        <p className="text-[10px] text-[var(--on-surface-variant)] italic">
          No history yet
        </p>
      </div>
    );
  }

  return (
    <div className="mt-12 space-y-4">
      <h4 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest">
        History
      </h4>
      <div className="space-y-3">
        {recentEvents.map((event) => (
          <div key={event.id} className="flex items-start space-x-3">
            <div className="w-1.5 h-1.5 rounded-full bg-[var(--outline-variant)] mt-1.5" />
            <div className="flex-1 min-w-0">
              <p className="text-[10px] text-[var(--on-surface)]">
                <span className="font-bold">
                  {event.actorType === 'system'
                    ? 'System'
                    : event.actorId.slice(0, 8)}
                </span>{' '}
                {formatStatus(event.action)}
                {event.fromStatus && event.toStatus
                  ? `: ${formatStatus(event.fromStatus)} → ${formatStatus(event.toStatus)}`
                  : ''}
              </p>
              <span className="text-[9px] text-[var(--on-surface-variant)] uppercase">
                {formatRelativeTime(event.timestamp)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function RiskAnalysisSidebar({
  feature,
  tasks,
  events,
  dependencies,
}: RiskAnalysisSidebarProps) {
  return (
    <aside className="w-80 flex-shrink-0 flex flex-col h-full overflow-hidden">
      <div className="p-6">
        <div className="flex items-center justify-between mb-6">
          <h3 className="text-[10px] font-black text-[var(--on-surface-variant)] uppercase tracking-widest">
            Risk Analysis
          </h3>
          <Info className="h-4 w-4 text-[var(--on-surface-variant)]" />
        </div>

        <ProjectedImpactBar tasks={tasks} dependencies={dependencies} />

        <CriticalBlockers tasks={tasks} dependencies={dependencies} />

        <HistoryTimeline events={events} />
      </div>

      <div className="mt-auto p-4 ghost-border-t bg-[var(--surface-container)]/20">
        <button className="w-full py-2 bg-[var(--surface-container-high)] hover:bg-[var(--surface-container)] text-[var(--on-surface)] rounded text-[10px] font-bold uppercase tracking-widest transition-colors flex items-center justify-center space-x-2 ghost-border">
          <Settings className="h-3.5 w-3.5" />
          <span>Configure Gates</span>
        </button>
      </div>
    </aside>
  );
}
