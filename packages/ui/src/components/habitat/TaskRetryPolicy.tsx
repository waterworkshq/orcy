import React from 'react';
import { DetailCard } from '../ui/DetailCard.js';
import { AlertCircle } from 'lucide-react';

interface TaskRetryPolicyProps {
  task: {
    retryPolicy: {
      maxRetries?: number;
      backoffBase?: number;
      backoffMultiplier?: number;
      maxBackoff?: number;
      escalateToHuman?: boolean;
    } | null;
    retryCount: number;
    nextRetryAt: string | null;
  };
}

export function TaskRetryPolicy({ task }: TaskRetryPolicyProps) {
  if (!task.retryPolicy && task.retryCount === 0 && !task.nextRetryAt) return null;

  return (
    <DetailCard icon={AlertCircle} title="Retry Policy" className="mb-4">
      {task.retryPolicy && (
        <div className="space-y-1">
          <div className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm">
            <span className="text-muted-foreground">Max Retries</span>
            <span>{task.retryPolicy.maxRetries ?? 3}</span>
            <span className="text-muted-foreground">Backoff Base</span>
            <span>{task.retryPolicy.backoffBase ?? 60}s</span>
            <span className="text-muted-foreground">Multiplier</span>
            <span>{task.retryPolicy.backoffMultiplier ?? 2}x</span>
            <span className="text-muted-foreground">Max Backoff</span>
            <span>{task.retryPolicy.maxBackoff ?? 3600}s</span>
            <span className="text-muted-foreground">Escalate</span>
            <span>{task.retryPolicy.escalateToHuman !== false ? 'Yes' : 'No'}</span>
          </div>
          {task.retryCount > 0 && (
            <div className="text-sm text-muted-foreground">
              Retry count: {task.retryCount}
            </div>
          )}
          {task.nextRetryAt && (
            <div className="text-sm text-muted-foreground">
              Next retry: {new Date(task.nextRetryAt).toLocaleString()}
            </div>
          )}
        </div>
      )}
    </DetailCard>
  );
}
