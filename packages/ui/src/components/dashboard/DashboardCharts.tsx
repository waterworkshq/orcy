import React, { Suspense } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { KPICard } from './KPICard.js';
import { SkeletonCard } from '../ui/SkeletonCard.js';
import { CheckCircle2, Clock, TrendingUp, Users, AlertCircle, Activity } from 'lucide-react';
import type { DashboardStats } from '../../types/index.js';

const ThroughputChart = React.lazy(() =>
  import('./ThroughputChart.js').then((m) => ({ default: m.ThroughputChart }))
);
const CycleTimeChart = React.lazy(() =>
  import('./CycleTimeChart.js').then((m) => ({ default: m.CycleTimeChart }))
);
const AgentLeaderboard = React.lazy(() =>
  import('./AgentLeaderboard.js').then((m) => ({ default: m.AgentLeaderboard }))
);
const TaskDistribution = React.lazy(() =>
  import('./TaskDistribution.js').then((m) => ({ default: m.TaskDistribution }))
);
const WipHealthChart = React.lazy(() =>
  import('./WipHealthChart.js').then((m) => ({ default: m.WipHealthChart }))
);
const CapacityChart = React.lazy(() =>
  import('./CapacityChart.js').then((m) => ({ default: m.CapacityChart }))
);

interface DashboardChartsProps {
  stats: DashboardStats;
  period: '7d' | '30d' | '90d';
  habitatId?: string;
}

export function DashboardCharts({ stats, period, habitatId }: DashboardChartsProps) {
  const formatCycleTime = (minutes: number) => {
    if (minutes === 0) return '0m';
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    const mins = minutes % 60;
    return `${hours}h ${mins}m`;
  };

  const totalTasks = stats.taskByPriority.critical + stats.taskByPriority.high +
    stats.taskByPriority.medium + stats.taskByPriority.low;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Tasks Completed"
          value={stats.summary.totalTasksCompleted}
          subtitle={`In last ${period}`}
          icon={<CheckCircle2 className="h-5 w-5 text-[var(--badge-done-text)]" />}
        />
        <KPICard
          title="In Progress"
          value={stats.summary.totalTasksInProgress}
          subtitle="Active tasks"
          icon={<Clock className="h-5 w-5 text-primary" />}
        />
        <KPICard
          title="Avg Cycle Time"
          value={formatCycleTime(stats.summary.averageCycleTimeMinutes)}
          subtitle="Claim to completion"
          icon={<TrendingUp className="h-5 w-5 text-[var(--agent-purple)]" />}
        />
        <KPICard
          title="Active Agents"
          value={stats.summary.activeAgents}
          subtitle={`${stats.agentLeaderboard.length} tracked`}
          icon={<Users className="h-5 w-5 text-[var(--agent-orange)]" />}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <KPICard
          title="Rejection Rate"
          value={`${(stats.summary.overallRejectionRate * 100).toFixed(1)}%`}
          trend={stats.summary.overallRejectionRate > 0.2 ? 'down' : 'up'}
          subtitle="Tasks sent back for rework"
          icon={<AlertCircle className="h-5 w-5 text-error" />}
        />
        <KPICard
          title="Webhook Success"
          value={`${(stats.webhookStats.successRate * 100).toFixed(1)}%`}
          trend={stats.webhookStats.successRate > 0.9 ? 'up' : 'neutral'}
          subtitle={`${stats.webhookStats.success}/${stats.webhookStats.total} delivered`}
          icon={<Activity className="h-5 w-5 text-[var(--agent-blue)]" />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Throughput (Tasks Completed per Day)</CardTitle>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<SkeletonCard />}>
              <ThroughputChart data={stats.throughput} />
            </Suspense>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cycle Time Trend</CardTitle>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<SkeletonCard />}>
              <CycleTimeChart data={stats.cycleTime} />
            </Suspense>
          </CardContent>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Agent Leaderboard</CardTitle>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<SkeletonCard />}>
              <AgentLeaderboard data={stats.agentLeaderboard} />
            </Suspense>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Task Distribution</CardTitle>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<SkeletonCard />}>
              <TaskDistribution priority={stats.taskByPriority} status={stats.taskByStatus} />
            </Suspense>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>WIP Health</CardTitle>
        </CardHeader>
        <CardContent>
          <Suspense fallback={<SkeletonCard />}>
            <WipHealthChart data={stats.wipHealth} />
          </Suspense>
        </CardContent>
      </Card>

      {habitatId && (
        <div>
          <h2 className="text-lg font-semibold text-on-surface mb-4">Agent Capacity</h2>
          <Suspense fallback={<SkeletonCard />}>
            <CapacityChart habitatId={habitatId} />
          </Suspense>
        </div>
      )}
    </div>
  );
}
