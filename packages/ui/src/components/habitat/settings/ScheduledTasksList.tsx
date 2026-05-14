import React from 'react';
import { Button } from '../../ui/Button.js';
import { Badge } from '../../ui/Badge.js';
import { ToggleSwitch } from '../../ui/ToggleSwitch.js';
import type { ScheduledTask } from '../../../types/index.js';

interface ScheduledTasksListProps {
  scheduledTasks: ScheduledTask[];
  loading: boolean;
  runningId: string | null;
  onToggle: (task: ScheduledTask) => void;
  onRun: (id: string) => void;
  onDelete: (id: string) => void;
  onEdit: (task: ScheduledTask) => void;
  onAdd: () => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function formatSchedule(task: ScheduledTask): string {
  switch (task.scheduleType) {
    case 'cron':
      return task.cronExpression ?? '—';
    case 'interval':
      return `Every ${task.intervalMinutes}m`;
    case 'once':
      return `Once at ${formatDate(task.scheduledAt)}`;
    default:
      return '—';
  }
}

export function ScheduledTasksList({
  scheduledTasks,
  loading,
  runningId,
  onToggle,
  onRun,
  onDelete,
  onEdit,
  onAdd,
}: ScheduledTasksListProps) {
  if (loading) {
    return (
      <div className="py-8 text-center text-sm text-muted-foreground">
        Loading scheduled tasks...
      </div>
    );
  }

  if (scheduledTasks.length === 0) {
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted-foreground">
          No scheduled tasks configured. Create one to automate recurring work.
        </p>
        <Button size="sm" onClick={onAdd} data-testid="add-scheduled-task-btn">
          Add Scheduled Task
        </Button>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {scheduledTasks.length} scheduled task{scheduledTasks.length !== 1 ? 's' : ''}
        </p>
        <Button size="sm" onClick={onAdd} data-testid="add-scheduled-task-btn">
          Add Scheduled Task
        </Button>
      </div>

      <div className="space-y-2">
        {scheduledTasks.map((task) => (
          <div
            key={task.id}
            data-testid={`scheduled-task-${task.id}`}
            className="flex items-center gap-3 rounded-md border border-border px-3 py-2"
          >
            <ToggleSwitch
              checked={task.enabled}
              onChange={() => onToggle(task)}
            />

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate" data-testid={`task-name-${task.id}`}>
                  {task.name}
                </span>
                <Badge variant={task.enabled ? 'done' : 'default'}>
                  {task.enabled ? 'Active' : 'Paused'}
                </Badge>
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                <span>{formatSchedule(task)}</span>
                <span className="mx-1">·</span>
                <span>Next: {formatDate(task.nextRunAt)}</span>
                <span className="mx-1">·</span>
                <span>Last: {formatDate(task.lastRunAt)}</span>
                {task.runCount > 0 && (
                  <>
                    <span className="mx-1">·</span>
                    <span>{task.runCount} run{task.runCount !== 1 ? 's' : ''}</span>
                  </>
                )}
              </div>
            </div>

            {task.lastCreatedFeatureId && (
              <a
                href={`/features/${task.lastCreatedFeatureId}`}
                className="text-xs text-primary hover:underline"
                data-testid={`feature-link-${task.id}`}
              >
                Last feature
              </a>
            )}

            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                onClick={() => onEdit(task)}
                data-testid={`edit-btn-${task.id}`}
              >
                Edit
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => onRun(task.id)}
                disabled={runningId === task.id}
                loading={runningId === task.id}
                data-testid={`run-btn-${task.id}`}
              >
                Run
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => onDelete(task.id)}
                data-testid={`delete-btn-${task.id}`}
              >
                Delete
              </Button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
