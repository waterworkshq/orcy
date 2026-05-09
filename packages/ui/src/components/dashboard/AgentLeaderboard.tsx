import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';

interface AgentLeaderboardProps {
  data: Array<{
    agentId: string;
    agentName: string;
    completed: number;
    failed: number;
    avgCycleMinutes: number;
    approvalRate: number;
  }>;
}

export function AgentLeaderboard({ data }: AgentLeaderboardProps) {
  if (data.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-on-surface-variant">
        No agent data available
      </div>
    );
  }

  const chartData = data.slice(0, 10).map((agent) => ({
    name: agent.agentName.length > 15 ? agent.agentName.slice(0, 15) + '...' : agent.agentName,
    completed: agent.completed,
    failed: agent.failed,
    avgCycle: agent.avgCycleMinutes,
    approvalRate: agent.approvalRate * 100,
  }));

  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart
        data={chartData}
        layout="vertical"
        margin={{ top: 5, right: 30, left: 80, bottom: 5 }}
      >
        <CartesianGrid strokeDasharray="3 3" className="stroke-outline-variant/30" />
        <XAxis type="number" tick={{ fontSize: 12 }} className="text-on-surface-variant" />
        <YAxis dataKey="name" type="category" tick={{ fontSize: 12 }} width={80} className="text-on-surface-variant" />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--surface-container)',
            border: '1px solid var(--outline-variant)',
            borderRadius: '6px',
            fontSize: '13px',
            color: 'var(--on-surface)',
          }}
        />
        <Bar dataKey="completed" fill="var(--badge-done)" name="Completed" radius={[0, 4, 4, 0]} />
        <Bar dataKey="failed" fill="var(--error)" name="Failed" radius={[0, 4, 4, 0]} />
      </BarChart>
    </ResponsiveContainer>
  );
}
