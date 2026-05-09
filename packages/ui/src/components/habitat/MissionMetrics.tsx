import React from 'react';
import type { Task } from '../../types/index.js';

export interface FeatureMetricsProps {
  progress: {
    completed: number;
    total: number;
    percentage: number;
    byStatus: Record<string, number>;
  };
  tasks: Task[];
  dependencies: { dependsOn: string[]; blocks: string[] };
}

function CompletionCard({
  progress,
}: {
  progress: FeatureMetricsProps['progress'];
}) {
  return (
    <div className="glass-card p-4">
      <div className="text-[10px] font-bold text-[var(--on-surface-variant)] uppercase mb-2">
        Completion
      </div>
      <div className="text-2xl font-bold font-headline text-[var(--primary)]">
        {progress.percentage}%
      </div>
      <div className="text-xs text-[var(--on-surface-variant)] mt-1">
        {progress.completed} / {progress.total} tasks
      </div>
      <div className="mt-2 h-1 bg-[var(--surface-container-high)] rounded-full overflow-hidden">
        <div
          className="h-full bg-[var(--primary)] transition-all duration-300"
          style={{ width: `${progress.percentage}%` }}
        />
      </div>
    </div>
  );
}

function TaskHealthCard({ tasks, progress }: { tasks: Task[]; progress: FeatureMetricsProps['progress'] }) {
  const pending = (progress.byStatus['pending'] ?? 0) + (progress.byStatus['claimed'] ?? 0);
  const inProgress = progress.byStatus['in_progress'] ?? 0;
  const review =
    (progress.byStatus['submitted'] ?? 0) +
    (progress.byStatus['approved'] ?? 0) +
    (progress.byStatus['rejected'] ?? 0);
  const done = (progress.byStatus['done'] ?? 0) + (progress.byStatus['failed'] ?? 0);

  return (
    <div className="glass-card p-4">
      <div className="text-[10px] font-bold text-[var(--on-surface-variant)] uppercase mb-2">
        Task Health
      </div>
      <div className="text-2xl font-bold font-headline text-[var(--on-surface)]">
        {tasks.length}
      </div>
      <div className="flex gap-3 mt-1 text-[10px] text-[var(--on-surface-variant)]">
        <span>Todo: {pending}</span>
        <span>Active: {inProgress}</span>
        <span>Review: {review}</span>
        <span>Done: {done}</span>
      </div>
      <div className="mt-2 flex gap-1">
        {tasks.slice(0, 20).map((t) => (
          <div
            key={t.id}
            className="w-2 h-2 rounded-full"
            style={{
              backgroundColor:
                t.status === 'done'
                  ? 'var(--primary)'
                  : t.status === 'failed'
                    ? 'var(--error)'
                    : t.status === 'in_progress'
                      ? 'var(--primary-container)'
                      : 'var(--outline-variant)',
            }}
          />
        ))}
      </div>
    </div>
  );
}

function DependenciesCard({
  dependencies,
}: {
  dependencies: FeatureMetricsProps['dependencies'];
}) {
  const isHealthy = dependencies.dependsOn.length === 0;

  return (
    <div
      className={`glass-card p-4 ${
        !isHealthy ? 'border-[var(--error)]/30' : ''
      }`}
    >
      <div className="text-[10px] font-bold text-[var(--on-surface-variant)] uppercase mb-2">
        Dependencies
      </div>
      <div
        className={`text-2xl font-bold font-headline ${
          !isHealthy ? 'text-[var(--error)]' : 'text-[var(--primary)]'
        }`}
      >
        {dependencies.dependsOn.length} blocked
      </div>
      <div className="text-xs text-[var(--on-surface-variant)] mt-1">
        Blocking {dependencies.blocks.length} others
      </div>
      <div className="mt-2 h-1 bg-[var(--surface-container-high)] rounded-full overflow-hidden">
        <div
          className="h-full transition-all duration-300"
          style={{
            width: `${
              !isHealthy
                ? (dependencies.dependsOn.length /
                    (dependencies.dependsOn.length +
                      dependencies.blocks.length +
                      1)) *
                  100
                : 100
            }%`,
            backgroundColor: !isHealthy
              ? 'var(--error)'
              : 'var(--primary)',
          }}
        />
      </div>
    </div>
  );
}

function TimeTrackingCard({ tasks }: { tasks: Task[] }) {
  const tasksWithEstimate = tasks.filter((t) => t.estimatedMinutes != null);
  const totalEstimated = tasksWithEstimate.reduce(
    (sum, t) => sum + (t.estimatedMinutes ?? 0),
    0
  );
  const totalActual = tasks.reduce(
    (sum, t) => sum + (t.actualMinutes ?? 0),
    0
  );

  if (tasksWithEstimate.length === 0 && totalActual === 0) return null;

  const fmtHours = (mins: number) => {
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  };

  return (
    <div className="glass-card p-4">
      <div className="text-[10px] font-bold text-[var(--on-surface-variant)] uppercase mb-2">
        Time Tracking
      </div>
      <div className="flex gap-4 items-baseline">
        {totalEstimated > 0 && (
          <div>
            <span className="text-2xl font-bold font-headline text-[var(--on-surface)]">
              {fmtHours(totalEstimated)}
            </span>
            <span className="text-[10px] text-[var(--on-surface-variant)] ml-1">
              est
            </span>
          </div>
        )}
        {totalActual > 0 && (
          <div>
            <span className="text-2xl font-bold font-headline text-[var(--on-surface)]">
              {fmtHours(totalActual)}
            </span>
            <span className="text-[10px] text-[var(--on-surface-variant)] ml-1">
              actual
            </span>
          </div>
        )}
      </div>
      {totalEstimated > 0 && totalActual > 0 && (
        <div className="mt-2 h-1 bg-[var(--surface-container-high)] rounded-full overflow-hidden">
          <div
            className="h-full transition-all duration-300"
            style={{
              width: `${Math.min((totalActual / totalEstimated) * 100, 100)}%`,
              backgroundColor:
                totalActual > totalEstimated
                  ? 'var(--error)'
                  : 'var(--primary)',
            }}
          />
        </div>
      )}
    </div>
  );
}

export function FeatureMetrics({
  progress,
  tasks,
  dependencies,
}: FeatureMetricsProps) {
  return (
    <div className="grid grid-cols-3 gap-4">
      <CompletionCard progress={progress} />
      <TaskHealthCard tasks={tasks} progress={progress} />
      <DependenciesCard dependencies={dependencies} />
      <TimeTrackingCard tasks={tasks} />
    </div>
  );
}
