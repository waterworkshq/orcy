import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from 'recharts';

interface WipHealthChartProps {
  data: Array<{
    columnId: string;
    columnName: string;
    habitatId: string;
    habitatName: string;
    current: number;
    limit: number | null;
    health: 'ok' | 'warning' | 'exceeded';
  }>;
}

export function WipHealthChart({ data }: WipHealthChartProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-on-surface-variant">
        No WIP data available
      </div>
    );
  }

  const chartData = data.map((col) => ({
    name: col.columnName.length > 12 ? col.columnName.slice(0, 12) + '...' : col.columnName,
    board: col.habitatName,
    current: col.current,
    limit: col.limit,
    health: col.health,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={chartData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
        <CartesianGrid strokeDasharray="3 3" className="stroke-outline-variant/30" />
        <XAxis dataKey="name" tick={{ fontSize: 11 }} className="text-on-surface-variant" />
        <YAxis tick={{ fontSize: 12 }} className="text-on-surface-variant" />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--surface-container)',
            border: '1px solid var(--outline-variant)',
            borderRadius: '6px',
            fontSize: '13px',
            color: 'var(--on-surface)',
          }}
          formatter={(value, name) => {
            if (name === 'limit' && value === 0) return ['No limit', 'Limit'];
            return [value, name === 'limit' ? 'Limit' : 'Current'];
          }}
          labelFormatter={(_, payload) => {
            if (payload && payload[0]) {
              const board = (payload[0].payload as typeof chartData[0]).board;
              const col = payload[0].payload as typeof chartData[0];
              return `${col.name} (${board})`;
            }
            return '';
          }}
        />
        <Bar dataKey="current" fill="var(--primary)" name="Current" radius={[4, 4, 0, 0]} />
        {data.some((d) => d.limit !== null) && (
          <Bar dataKey="limit" fill="var(--on-surface-variant)" name="Limit" radius={[4, 4, 0, 0]} opacity={0.5} />
        )}
      </BarChart>
    </ResponsiveContainer>
  );
}
