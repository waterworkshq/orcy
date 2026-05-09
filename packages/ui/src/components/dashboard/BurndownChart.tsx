import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts';

interface BurndownChartProps {
  data: import('../../types/index.js').BurndownDataPoint[];
}

export function BurndownChart({ data }: BurndownChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-gray-400">
        No burndown data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={320}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-gray-200 dark:stroke-gray-700" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 11 }}
          tickFormatter={(value) => {
            const parts = value.split('-');
            return `${parseInt(parts[1])}/${parseInt(parts[2])}`;
          }}
          className="text-gray-500 dark:text-gray-400"
        />
        <YAxis tick={{ fontSize: 12 }} className="text-gray-500 dark:text-gray-400" />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--tooltip-bg, #fff)',
            border: '1px solid var(--tooltip-border, #e5e7eb)',
            borderRadius: '6px',
            fontSize: '13px',
          }}
          labelFormatter={(value) => {
            const parts = String(value).split('-');
            return `${parts[1]}/${parts[2]}/${parts[0]}`;
          }}
        />
        <Legend />
        <Line
          type="monotone"
          dataKey="remaining"
          stroke="#ef4444"
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
          name="Remaining"
        />
        <Line
          type="monotone"
          dataKey="idealRemaining"
          stroke="#9ca3af"
          strokeWidth={1.5}
          strokeDasharray="5 5"
          dot={false}
          name="Ideal"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
