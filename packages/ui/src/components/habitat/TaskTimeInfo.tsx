import React from 'react';
import { DetailCard } from '../ui/DetailCard.js';
import { Timer } from 'lucide-react';
import { formatDuration } from '../../lib/task-helpers.js';

interface TaskTimeInfoProps {
  task: {
    status: string;
    claimedAt: string | null;
    startedAt: string | null;
    completedAt: string | null;
    estimatedMinutes: number | null;
    actualMinutes: number | null;
    cycleTimeMinutes: number | null;
    leadTimeMinutes: number | null;
    estimationAccuracy: number | null;
  };
}

function minutesLabel(m: number): string {
  return `${Math.round(m)}m`;
}

export function TaskTimeInfo({ task }: TaskTimeInfoProps) {
  if (!task.claimedAt && !task.startedAt) return null;

  return (
    <DetailCard icon={Timer} title="Time" className="mb-4">
      <div className="space-y-1">
        {task.status === 'pending' || task.status === 'claimed' ? (
          <span className="text-sm text-muted-foreground">
            Waiting {formatDuration(Date.now() - new Date(task.claimedAt!).getTime())}
          </span>
        ) : task.status === 'in_progress' ? (
          <div className="space-y-2">
            {task.actualMinutes != null ? (
              <span className="text-sm text-muted-foreground">
                Time tracked: {minutesLabel(task.actualMinutes)}
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">
                Working for {formatDuration(Date.now() - new Date(task.startedAt!).getTime())}
              </span>
            )}
            {task.estimatedMinutes != null && task.actualMinutes != null && (
              <div className="space-y-1">
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <span>{minutesLabel(task.actualMinutes)} / {minutesLabel(task.estimatedMinutes)}</span>
                </div>
                <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      task.actualMinutes <= task.estimatedMinutes
                        ? 'bg-[var(--badge-done)]'
                        : 'bg-[var(--badge-blocked)]'
                    }`}
                    style={{ width: `${Math.min((task.actualMinutes / task.estimatedMinutes) * 100, 100)}%` }}
                  />
                </div>
              </div>
            )}
            {task.estimatedMinutes != null && task.actualMinutes == null && (
              <div className="text-sm text-muted-foreground">
                Est: {task.estimatedMinutes}m
              </div>
            )}
          </div>
        ) : (task.status === 'done' || task.status === 'approved' || task.status === 'failed') && task.completedAt ? (
          <div className="space-y-1">
            <span className="text-sm text-muted-foreground">
              Cycle time: {task.cycleTimeMinutes != null
                ? minutesLabel(task.cycleTimeMinutes)
                : formatDuration(new Date(task.completedAt).getTime() - new Date(task.claimedAt!).getTime())}
            </span>
            {task.leadTimeMinutes != null && (
              <div className="text-sm text-muted-foreground">
                Lead time: {minutesLabel(task.leadTimeMinutes)}
              </div>
            )}
            {task.actualMinutes != null && (
              <div className="text-sm text-muted-foreground">
                Actual: {minutesLabel(task.actualMinutes)}
              </div>
            )}
            {task.estimationAccuracy != null && task.estimatedMinutes != null && (
              <div className={`text-sm font-medium ${
                task.actualMinutes != null && task.actualMinutes <= task.estimatedMinutes
                  ? 'text-green-600 dark:text-green-400'
                  : 'text-red-600 dark:text-red-400'
              }`}>
                Accuracy: {Math.round(task.estimationAccuracy * 100)}%
              </div>
            )}
            {!task.estimationAccuracy && task.estimatedMinutes && task.startedAt && task.actualMinutes == null && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Est: {task.estimatedMinutes}m</span>
                <span className="text-muted-foreground">|</span>
                <span className={
                  (() => {
                    const actualMin = Math.round((new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime()) / 60000);
                    const diff = actualMin - task.estimatedMinutes!;
                    if (diff > 0) return 'text-red-600 dark:text-red-400';
                    if (diff < 0) return 'text-green-600 dark:text-green-400';
                    return 'text-muted-foreground';
                  })()
                }>
                  Actual: {formatDuration(new Date(task.completedAt).getTime() - new Date(task.startedAt).getTime())}
                </span>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </DetailCard>
  );
}
