import React from 'react';
import {
  PieChart,
  Pie,
  Cell,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

interface TaskDistributionProps {
  priority: { critical: number; high: number; medium: number; low: number };
  status: { pending: number; claimed: number; in_progress: number; submitted: number; done: number };
}

const PRIORITY_COLORS = ['var(--badge-critical)', 'var(--badge-high)', 'var(--badge-medium)', 'var(--badge-low)'];
const STATUS_COLORS = ['var(--on-surface-variant)', 'var(--agent-blue)', 'var(--primary)', 'var(--agent-purple)', 'var(--badge-done)'];

export function TaskDistribution({ priority, status }: TaskDistributionProps) {
  const priorityData = [
    { name: 'Critical', value: priority.critical },
    { name: 'High', value: priority.high },
    { name: 'Medium', value: priority.medium },
    { name: 'Low', value: priority.low },
  ].filter((d) => d.value > 0);

  const statusData = [
    { name: 'Pending', value: status.pending },
    { name: 'Claimed', value: status.claimed },
    { name: 'In Progress', value: status.in_progress },
    { name: 'Submitted', value: status.submitted },
    { name: 'Done', value: status.done },
  ].filter((d) => d.value > 0);

  const totalTasks = priority.critical + priority.high + priority.medium + priority.low;

  if (totalTasks === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-on-surface-variant">
        No task data available
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      <div>
        <h4 className="text-sm font-medium text-on-surface-variant mb-2 text-center">By Priority</h4>
        <ResponsiveContainer width="100%" height={180}>
          <PieChart>
            <Pie
              data={priorityData}
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={70}
              dataKey="value"
              strokeWidth={2}
            >
              {priorityData.map((_, index) => (
                <Cell key={`priority-${index}`} fill={PRIORITY_COLORS[index % PRIORITY_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--surface-container)',
                border: '1px solid var(--outline-variant)',
                borderRadius: '6px',
                fontSize: '13px',
                color: 'var(--on-surface)',
              }}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div>
        <h4 className="text-sm font-medium text-on-surface-variant mb-2 text-center">By Status</h4>
        <ResponsiveContainer width="100%" height={180}>
          <PieChart>
            <Pie
              data={statusData}
              cx="50%"
              cy="50%"
              innerRadius={40}
              outerRadius={70}
              dataKey="value"
              strokeWidth={2}
            >
              {statusData.map((_, index) => (
                <Cell key={`status-${index}`} fill={STATUS_COLORS[index % STATUS_COLORS.length]} />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--surface-container)',
                border: '1px solid var(--outline-variant)',
                borderRadius: '6px',
                fontSize: '13px',
                color: 'var(--on-surface)',
              }}
            />
            <Legend wrapperStyle={{ fontSize: '12px' }} />
          </PieChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
