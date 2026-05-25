import React, { Suspense } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '../ui/Card.js';
import { KPICard } from './KPICard.js';
import { SkeletonCard } from '../ui/SkeletonCard.js';
import { AtRiskTasks } from './AtRiskTasks.js';
import { TaskEstimates } from './TaskEstimates.js';
import { Activity, AlertTriangle, Calendar, TrendingUp } from 'lucide-react';
import type { PredictionResponse, BurndownResponse } from '../../types/index.js';

const VelocityChart = React.lazy(() =>
  import('./VelocityChart.js').then((m) => ({ default: m.VelocityChart }))
);
const BurndownChart = React.lazy(() =>
  import('./BurndownChart.js').then((m) => ({ default: m.BurndownChart }))
);

interface PredictionSectionProps {
  predictions: PredictionResponse;
  burndown: BurndownResponse;
}

function formatEta(dateStr: string | null): string {
  if (!dateStr) return 'N/A';
  const date = new Date(dateStr);
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function PredictionSection({ predictions, burndown }: PredictionSectionProps) {
  const dailyVelocity = predictions.velocity.days14 > 0
    ? (predictions.velocity.days14 / 14).toFixed(1)
    : predictions.velocity.days30 > 0
    ? (predictions.velocity.days30 / 30).toFixed(1)
    : '0.0';

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold text-on-surface">Predictive Analytics</h2>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <KPICard
          title="Daily Velocity"
          value={`${dailyVelocity}/day`}
          subtitle="Avg tasks completed"
          icon={<TrendingUp className="h-5 w-5 text-primary" />}
        />
        <KPICard
          title="At-Risk Tasks"
          value={predictions.atRiskTasks.length}
          subtitle={`${predictions.atRiskTasks.filter(t => t.severity === 'critical').length} critical`}
          icon={<AlertTriangle className="h-5 w-5 text-error" />}
        />
        <KPICard
          title="Remaining Tasks"
          value={burndown.remainingTasks}
          subtitle={`of ${burndown.totalTasks} total`}
          icon={<Activity className="h-5 w-5 text-[var(--agent-purple)]" />}
        />
        <KPICard
          title="Est. Completion"
          value={formatEta(burndown.estimatedCompletionDate)}
          subtitle={`at ${burndown.averageDailyVelocity}/day velocity`}
          icon={<Calendar className="h-5 w-5 text-[var(--badge-done-text)]" />}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <CardHeader>
            <CardTitle>Velocity</CardTitle>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<SkeletonCard />}>
              <VelocityChart velocity={predictions.velocity} />
            </Suspense>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Burndown Chart</CardTitle>
          </CardHeader>
          <CardContent>
            <Suspense fallback={<SkeletonCard />}>
              <BurndownChart data={burndown.data} />
            </Suspense>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Completion Estimates</CardTitle>
        </CardHeader>
        <CardContent>
          <TaskEstimates estimates={predictions.estimates} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>At-Risk Tasks</CardTitle>
        </CardHeader>
        <CardContent>
          <AtRiskTasks tasks={predictions.atRiskTasks} />
        </CardContent>
      </Card>
    </div>
  );
}
