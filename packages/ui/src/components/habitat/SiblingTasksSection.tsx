import React from 'react';
import { DetailCard } from '../ui/DetailCard.js';
import { Users } from 'lucide-react';

interface SiblingTask {
  id: string;
  title: string;
  status: string;
  result: string | null;
}

interface SiblingTasksSectionProps {
  siblingTasks: SiblingTask[];
  onSelectTask?: (taskId: string) => void;
}

export function SiblingTasksSection({ siblingTasks, onSelectTask }: SiblingTasksSectionProps) {
  if (!siblingTasks || siblingTasks.length === 0) return null;

  return (
    <DetailCard icon={Users} title="Sibling Tasks" className="mb-4">
      <div className="space-y-2">
        {siblingTasks.map((task) => (
          <button
            key={task.id}
            type="button"
            onClick={() => onSelectTask?.(task.id)}
            className="w-full text-left flex items-center justify-between p-2 rounded hover:bg-secondary/50 transition-colors"
          >
            <span className="text-sm truncate flex-1">{task.title}</span>
            <div className="flex items-center gap-2 ml-2">
              {task.result && (
                <span className="text-xs text-green-600" title="Has result">✓</span>
              )}
              <span className={`text-xs px-2 py-0.5 rounded ${
                task.status === 'done' ? 'glass-badge glass-badge-done' :
                task.status === 'approved' ? 'glass-badge glass-badge-done' :
                task.status === 'rejected' ? 'glass-badge glass-badge-blocked' :
                task.status === 'failed' ? 'glass-badge glass-badge-blocked' :
                task.status === 'submitted' ? 'glass-badge glass-badge-review' :
                task.status === 'in_progress' ? 'glass-badge glass-badge-active' :
                task.status === 'claimed' ? 'glass-badge glass-badge-active' :
                'glass-badge glass-badge-low'
              }`}>
                {task.status.replace('_', ' ')}
              </span>
            </div>
          </button>
        ))}
      </div>
    </DetailCard>
  );
}
