import React from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface CycleTimeChartProps {
  data: Array<{ date: string; avgMinutes: number; medianMinutes: number }>;
}

function formatMinutes(value: number): string {
  if (value < 60) return `${value}m`;
  const hours = Math.floor(value / 60);
  const mins = value % 60;
  return `${hours}h ${mins}m`;
}

export function CycleTimeChart({ data }: CycleTimeChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-on-surface-variant">
        No cycle time data available
      </div>
    );
  }

  return (
    <ResponsiveContainer width="100%" height={280}>
      <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-outline-variant/30" />
        <XAxis
          dataKey="date"
          tick={{ fontSize: 12 }}
          tickFormatter={(value) => {
            const date = new Date(value);
            return `${date.getMonth() + 1}/${date.getDate()}`;
          }}
          className="text-on-surface-variant"
        />
        <YAxis
          tick={{ fontSize: 12 }}
          tickFormatter={(value) => formatMinutes(value)}
          className="text-on-surface-variant"
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--surface-container)',
            border: '1px solid var(--outline-variant)',
            borderRadius: '6px',
            fontSize: '13px',
            color: 'var(--on-surface)',
          }}
          labelFormatter={(value) => {
            const date = new Date(value);
            return date.toLocaleDateString();
          }}
          formatter={(value) => [typeof value === 'number' ? formatMinutes(value) : value, '']}
        />
        <Line
          type="monotone"
          dataKey="avgMinutes"
          stroke="var(--agent-purple)"
          strokeWidth={2}
          dot={{ fill: 'var(--agent-purple)', strokeWidth: 0 }}
          name="Avg Cycle Time"
        />
        <Line
          type="monotone"
          dataKey="medianMinutes"
          stroke="var(--agent-blue)"
          strokeWidth={2}
          strokeDasharray="5 5"
          dot={{ fill: 'var(--agent-blue)', strokeWidth: 0 }}
          name="Median Cycle Time"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
