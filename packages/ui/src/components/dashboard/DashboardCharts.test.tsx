import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

vi.mock('./KPICard.js', () => ({
  KPICard: ({ title }: { title: string }) => (
    <div data-testid="kpi-card">{title}</div>
  ),
}));

vi.mock('../ui/SkeletonCard.js', () => ({
  SkeletonCard: () => <div data-testid="skeleton-card">Loading...</div>,
}));

vi.mock('./ThroughputChart.js', () => ({
  ThroughputChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="throughput-chart">Throughput:{data.length}</div>
  ),
}));

vi.mock('./CycleTimeChart.js', () => ({
  CycleTimeChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="cycle-time-chart">CycleTime:{data.length}</div>
  ),
}));

vi.mock('./AgentLeaderboard.js', () => ({
  AgentLeaderboard: ({ data }: { data: unknown[] }) => (
    <div data-testid="agent-leaderboard">Leaderboard:{data.length}</div>
  ),
}));

vi.mock('./TaskDistribution.js', () => ({
  TaskDistribution: () => (
    <div data-testid="task-distribution">TaskDistribution</div>
  ),
}));

vi.mock('./WipHealthChart.js', () => ({
  WipHealthChart: ({ data }: { data: unknown[] }) => (
    <div data-testid="wip-health-chart">WipHealth:{data.length}</div>
  ),
}));

vi.mock('./CapacityChart.js', () => ({
  CapacityChart: ({ habitatId }: { habitatId?: string }) => (
    <div data-testid="capacity-chart">Capacity:{habitatId}</div>
  ),
}));

import { DashboardCharts } from './DashboardCharts.js';
import { SkeletonCard } from '../ui/SkeletonCard.js';

const mockStats = {
  summary: {
    totalTasksCompleted: 42,
    totalTasksInProgress: 10,
    averageCycleTimeMinutes: 120,
    activeAgents: 5,
    overallRejectionRate: 0.1,
  },
  throughput: [{ date: '2024-01-01', count: 5 }],
  cycleTime: [{ date: '2024-01-01', avgMinutes: 100, medianMinutes: 90 }],
  agentLeaderboard: [{ agentId: 'a1', agentName: 'Agent1', completed: 10, failed: 1, avgCycleMinutes: 60, approvalRate: 0.9 }],
  taskByPriority: { critical: 1, high: 2, medium: 3, low: 4 },
  taskByStatus: { pending: 1, claimed: 2, in_progress: 3, submitted: 4, done: 5 },
  wipHealth: [{ columnId: 'c1', columnName: 'Todo', habitatId: 'b1', boardName: 'Board', current: 3, limit: 5, health: 'ok' as const }],
  webhookStats: { successRate: 0.95, success: 19, total: 20 },
};

describe('DashboardCharts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('renders KPI cards', () => {
    render(<DashboardCharts stats={mockStats as any} period="30d" />);
    expect(screen.getAllByTestId('kpi-card').length).toBeGreaterThan(0);
  });

  it('renders chart components after lazy-load resolves', async () => {
    render(<DashboardCharts stats={mockStats as any} period="30d" />);

    await waitFor(() => {
      expect(screen.getByTestId('throughput-chart')).toBeInTheDocument();
    });
    expect(screen.getByTestId('cycle-time-chart')).toBeInTheDocument();
    expect(screen.getByTestId('agent-leaderboard')).toBeInTheDocument();
    expect(screen.getByTestId('task-distribution')).toBeInTheDocument();
    expect(screen.getByTestId('wip-health-chart')).toBeInTheDocument();
  });

  it('renders CapacityChart when habitatId is provided', async () => {
    render(<DashboardCharts stats={mockStats as any} period="30d" habitatId="board-1" />);

    await waitFor(() => {
      expect(screen.getByTestId('capacity-chart')).toBeInTheDocument();
    });
    expect(screen.getByTestId('capacity-chart')).toHaveTextContent('Capacity:board-1');
  });

  it('does not render CapacityChart without habitatId', async () => {
    render(<DashboardCharts stats={mockStats as any} period="30d" />);

    await waitFor(() => {
      expect(screen.getByTestId('throughput-chart')).toBeInTheDocument();
    });
    expect(screen.queryByTestId('capacity-chart')).not.toBeInTheDocument();
  });

  it('uses SkeletonCard as Suspense fallback', () => {
    const NeverResolving = React.lazy(() => new Promise<never>(() => {}));
    render(
      <React.Suspense fallback={<SkeletonCard />}>
        <NeverResolving />
      </React.Suspense>
    );
    expect(screen.getByTestId('skeleton-card')).toBeInTheDocument();
  });
});
