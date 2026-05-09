import React from 'react';
import { AlertTriangle, Clock, Lock, AlertCircle } from 'lucide-react';
import type { AtRiskTask } from '../../types/index.js';

interface AtRiskTasksProps {
  tasks: AtRiskTask[];
}

const severityColors: Record<string, string> = {
  critical: 'glass-badge glass-badge-critical',
  high: 'glass-badge glass-badge-high',
  medium: 'glass-badge glass-badge-medium',
  low: 'glass-badge glass-badge-low',
};

const reasonIcons: Record<string, React.ReactNode> = {
  overdue_prediction: <AlertTriangle className="h-4 w-4" />,
  no_activity: <Clock className="h-4 w-4" />,
  blocked_by_dependency: <Lock className="h-4 w-4" />,
  past_due: <AlertCircle className="h-4 w-4" />,
};

const reasonLabels: Record<string, string> = {
  overdue_prediction: 'Overdue Prediction',
  no_activity: 'No Activity',
  blocked_by_dependency: 'Blocked',
  past_due: 'Past Due',
};

export function AtRiskTasks({ tasks }: AtRiskTasksProps) {
  if (tasks.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400">
        No at-risk tasks detected
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {tasks.map((task) => (
        <div
          key={`${task.taskId}-${task.reason}`}
          className={`flex items-start gap-3 p-3 rounded-lg border ${severityColors[task.severity] ?? ''}`}
        >
          <div className="mt-0.5 shrink-0">
            {reasonIcons[task.reason]}
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="font-medium text-sm truncate">{task.taskTitle}</span>
              <span className="text-xs px-1.5 py-0.5 rounded bg-black/10 dark:bg-white/10">
                {reasonLabels[task.reason]}
              </span>
            </div>
            <p className="text-xs mt-0.5 opacity-80">{task.details}</p>
          </div>
          <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
            task.severity === 'critical' ? 'glass-badge glass-badge-critical' :
            task.severity === 'high' ? 'glass-badge glass-badge-high' :
            task.severity === 'medium' ? 'glass-badge glass-badge-medium' :
            'glass-badge glass-badge-low'
          }`}>
            {task.severity}
          </span>
        </div>
      ))}
    </div>
  );
}
