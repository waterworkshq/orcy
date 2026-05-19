import React from 'react';
import type { SprintStatus } from '../../types/index.js';

interface SprintBadgeProps {
  sprintName: string;
  sprintStatus: SprintStatus;
}

const STATUS_STYLES: Record<SprintStatus, string> = {
  planning: 'bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200',
  active: 'bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200',
  completed: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400',
  cancelled: 'bg-gray-100 text-gray-500 line-through dark:bg-gray-800 dark:text-gray-500',
};

export function SprintBadge({ sprintName, sprintStatus }: SprintBadgeProps) {
  return (
    <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium ${STATUS_STYLES[sprintStatus] ?? STATUS_STYLES.planning}`}>
      {sprintStatus === 'active' && <span className="h-1.5 w-1.5 rounded-full bg-green-500" />}
      {sprintName}
    </span>
  );
}
