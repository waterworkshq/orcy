import React from 'react';
import { Badge } from '../ui/Badge.js';
import { Pencil, Eye, EyeOff } from 'lucide-react';

interface TaskViewHeaderProps {
  task: {
    title: string;
    status: string;
    priority: string;
    labels?: string[];
  };
  isWatching: boolean;
  watchLoading: boolean;
  onToggleWatch: () => void;
  onEdit: () => void;
  columnName?: string;
}

export function TaskViewHeader({
  task,
  isWatching,
  watchLoading,
  onToggleWatch,
  onEdit,
  columnName,
}: TaskViewHeaderProps) {
  return (
    <>
      <div className="mb-2 flex items-start justify-between gap-2">
        <h3 className="text-lg font-semibold leading-tight">{task.title}</h3>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onToggleWatch}
            disabled={watchLoading}
            className="p-1 hover:bg-accent rounded"
            title={isWatching ? 'Stop watching' : 'Watch task'}
          >
            {isWatching
              ? <Eye className="h-4 w-4 text-blue-500" />
              : <EyeOff className="h-4 w-4 text-muted-foreground" />}
          </button>
          {(task.status === 'pending' || task.status === 'claimed') && (
            <button
              onClick={onEdit}
              className="p-1 hover:bg-accent rounded"
            >
              <Pencil className="h-4 w-4" />
            </button>
          )}
          <Badge variant={task.priority as 'critical' | 'high' | 'medium' | 'low'}>
            {task.priority}
          </Badge>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant={task.status as 'pending' | 'claimed' | 'in_progress' | 'submitted' | 'approved' | 'rejected' | 'done' | 'failed'}>
          {task.status.replace('_', ' ')}
        </Badge>
        {columnName && (
          <span className="text-xs text-muted-foreground">{columnName}</span>
        )}
      </div>
    </>
  );
}
