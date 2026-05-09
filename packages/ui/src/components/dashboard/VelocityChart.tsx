import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

interface VelocityChartProps {
  velocity: import('../../types/index.js').VelocityMetrics;
}

export function VelocityChart({ velocity }: VelocityChartProps) {
  const data = [
    { period: '7d', completed: velocity.days7 },
    { period: '14d', completed: velocity.days14 },
    { period: '30d', completed: velocity.days30 },
  ];

  const agentEntries = Object.entries(velocity.perAgent);
  const agentData = agentEntries.length > 0
    ? agentEntries.map(([id, v]) => ({
        agent: v.agentName.length > 12 ? v.agentName.slice(0, 12) + '...' : v.agentName,
        '7d': v.days7,
        '14d': v.days14,
        '30d': v.days30,
      }))
    : [];

  return (
    <div className="space-y-6">
      <div>
        <h4 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Habitat Velocity</h4>
        {data.length === 0 ? (
          <div className="flex items-center justify-center h-48 text-gray-400">No velocity data</div>
        ) : (
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
              <XAxis dataKey="period" tick={{ fontSize: 12 }} className="text-gray-500 dark:text-gray-400" />
              <YAxis tick={{ fontSize: 12 }} className="text-gray-500 dark:text-gray-400" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #fff)',
                  border: '1px solid var(--tooltip-border, #e5e7eb)',
                  borderRadius: '6px',
                  fontSize: '13px',
                }}
              />
              <Bar dataKey="completed" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Tasks Completed" />
            </BarChart>
          </ResponsiveContainer>
        )}
      </div>

      {agentData.length > 0 && (
        <div>
          <h4 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3">Per-Agent Velocity</h4>
          <ResponsiveContainer width="100%" height={Math.max(agentData.length * 35, 100)}>
            <BarChart data={agentData} layout="vertical" margin={{ top: 5, right: 20, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
              <XAxis type="number" tick={{ fontSize: 12 }} className="text-gray-500 dark:text-gray-400" />
              <YAxis type="category" dataKey="agent" width={100} tick={{ fontSize: 11 }} className="text-gray-500 dark:text-gray-400" />
              <Tooltip
                contentStyle={{
                  backgroundColor: 'var(--tooltip-bg, #fff)',
                  border: '1px solid var(--tooltip-border, #e5e7eb)',
                  borderRadius: '6px',
                  fontSize: '13px',
                }}
              />
              <Legend />
              <Bar dataKey="7d" fill="#93c5fd" radius={[0, 4, 4, 0]} name="7d" />
              <Bar dataKey="14d" fill="#3b82f6" radius={[0, 4, 4, 0]} name="14d" />
              <Bar dataKey="30d" fill="#1d4ed8" radius={[0, 4, 4, 0]} name="30d" />
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
