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

interface ThroughputChartProps {
  data: Array<{ date: string; count: number }>;
}

export function ThroughputChart({ data }: ThroughputChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-on-surface-variant">
        No throughput data available
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
        <YAxis tick={{ fontSize: 12 }} className="text-on-surface-variant" />
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
        />
        <Line
          type="monotone"
          dataKey="count"
          stroke="var(--primary)"
          strokeWidth={2}
          dot={{ fill: 'var(--primary)', strokeWidth: 0 }}
          activeDot={{ r: 5 }}
          name="Tasks Completed"
        />
      </LineChart>
    </ResponsiveContainer>
  );
}
