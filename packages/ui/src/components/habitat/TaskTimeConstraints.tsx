import React from 'react';
import { Timer } from 'lucide-react';

interface TaskTimeConstraintsProps {
  dueAt?: string | null;
  slaMinutes?: number | null;
  slaDeadlineAt?: string | null;
  estimatedMinutes?: number | null;
  actualMinutes?: number | null;
  dueDateStatus?: 'overdue' | 'approaching' | 'ok' | 'none';
}

export function TaskTimeConstraints({
  estimatedMinutes,
  actualMinutes,
}: TaskTimeConstraintsProps) {
  const hasBoth = estimatedMinutes != null && actualMinutes != null;
  const hasEither = estimatedMinutes != null || actualMinutes != null;
  if (!hasEither) return null;

  return (
    <div className="mb-4 space-y-1">
      <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Time</h4>
      {hasBoth && (
        <div className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Timer className="w-4 h-4 text-muted-foreground" />
            <span>Estimated: {estimatedMinutes}m</span>
            <span className="text-muted-foreground">|</span>
            <span>Actual: {actualMinutes}m</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                actualMinutes! <= estimatedMinutes!
                  ? 'bg-[var(--badge-done)]'
                  : actualMinutes! <= estimatedMinutes! * 1.5
                    ? 'bg-[var(--badge-review)]'
                    : 'bg-[var(--badge-blocked)]'
              }`}
              style={{ width: `${Math.min((actualMinutes! / estimatedMinutes!) * 100, 100)}%` }}
            />
          </div>
        </div>
      )}
      {!hasBoth && estimatedMinutes != null && (
        <div className="flex items-center gap-2 text-sm">
          <Timer className="w-4 h-4 text-muted-foreground" />
          <span>Estimated: {estimatedMinutes}min</span>
        </div>
      )}
      {!hasBoth && actualMinutes != null && (
        <div className="flex items-center gap-2 text-sm">
          <Timer className="w-4 h-4 text-muted-foreground" />
          <span>Actual: {actualMinutes}m</span>
        </div>
      )}
    </div>
  );
}
