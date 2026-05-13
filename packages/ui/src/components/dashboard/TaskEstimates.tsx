import React from 'react';
import type { TaskEstimate } from '../../types/index.js';
import { PRIORITY_BADGE } from '../../lib/status-maps.js';

interface TaskEstimatesProps {
  estimates: TaskEstimate[];
}

const confidenceColors: Record<string, string> = {
  high: 'text-green-600 dark:text-green-400',
  medium: 'text-yellow-600 dark:text-yellow-400',
  low: 'text-red-600 dark:text-red-400',
};

export function TaskEstimates({ estimates }: TaskEstimatesProps) {
  if (estimates.length === 0) {
    return (
      <div className="flex items-center justify-center py-8 text-gray-400">
        No open tasks to estimate
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-gray-200 dark:border-gray-700">
            <th className="text-left py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Task</th>
            <th className="text-left py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Priority</th>
            <th className="text-left py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Status</th>
            <th className="text-right py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Est. Days</th>
            <th className="text-right py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Due</th>
            <th className="text-center py-2 px-3 font-medium text-gray-500 dark:text-gray-400">Confidence</th>
          </tr>
        </thead>
        <tbody>
          {estimates.map((est) => (
            <tr key={est.taskId} className="border-b border-gray-100 dark:border-gray-800">
              <td className="py-2 px-3 max-w-[200px] truncate font-medium text-gray-900 dark:text-white">
                {est.taskTitle}
              </td>
              <td className="py-2 px-3">
                <span className={`text-xs px-2 py-0.5 rounded-full ${PRIORITY_BADGE[est.priority] ?? ''}`}>
                  {est.priority}
                </span>
              </td>
              <td className="py-2 px-3 text-gray-600 dark:text-gray-400">{est.status.replace('_', ' ')}</td>
              <td className="py-2 px-3 text-right font-mono text-gray-700 dark:text-gray-300">
                {est.daysUntilEstimated !== null ? `${est.daysUntilEstimated}d` : '-'}
              </td>
              <td className="py-2 px-3 text-right">
                {est.daysUntilDue !== null ? (
                  <span className={est.daysUntilDue < 0 ? 'text-red-500 font-medium' : est.daysUntilDue < 2 ? 'text-yellow-500' : 'text-gray-600 dark:text-gray-400'}>
                    {est.daysUntilDue < 0 ? `${Math.abs(Math.round(est.daysUntilDue))}d overdue` : `${Math.round(est.daysUntilDue)}d`}
                  </span>
                ) : (
                  <span className="text-gray-400">-</span>
                )}
              </td>
              <td className="py-2 px-3 text-center">
                <span className={`text-xs font-medium ${confidenceColors[est.confidence] ?? ''}`}>
                  {est.confidence}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
