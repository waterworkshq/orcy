import React, { useMemo } from 'react';
import { shallow } from 'zustand/shallow';
import { BurndownChart } from '../dashboard/BurndownChart.js';
import { useHabitatStore } from '../../store/habitatStore.js';
import { useBoardBurndown } from '../../lib/useHabitatData.js';
import type { Sprint, BurndownDataPoint } from '../../types/index.js';
import { CheckCircle, Clock, TrendingUp, Target } from 'lucide-react';

const TERMINAL_STATUSES = ['done', 'approved'] as const;

interface SprintDashboardProps {
  sprint: Sprint;
  habitatId: string;
}

function MetricCard({ icon: Icon, label, value, subtitle, color }: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
  subtitle?: string;
  color: string;
}) {
  return (
    <div className="rounded-lg border border-border p-3">
      <div className="flex items-center gap-2 mb-1">
        <Icon className={`h-4 w-4 ${color}`} />
        <span className="text-xs font-medium text-muted-foreground">{label}</span>
      </div>
      <p className="text-lg font-bold">{value}</p>
      {subtitle && <p className="text-[10px] text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

export function SprintDashboard({ sprint, habitatId }: SprintDashboardProps) {
  const features = useHabitatStore((s) => s.features, shallow);
  const tasks = useHabitatStore((s) => s.tasks, shallow);

  const sprintMissions = useMemo(
    () => features.filter(f => sprint.committedMissionIds.includes(f.id)),
    [features, sprint.committedMissionIds]
  );

  const sprintTasks = useMemo(
    () => tasks.filter(t => sprintMissions.some(m => m.id === t.missionId)),
    [tasks, sprintMissions]
  );

  const totalMissions = sprint.committedMissionIds.length;
  const completedMissions = sprint.completedMissionIds.length;
  const missionPct = totalMissions > 0 ? Math.round((completedMissions / totalMissions) * 100) : 0;

  const totalTasks = sprintTasks.length;
  const completedTasks = sprintTasks.filter(t => (TERMINAL_STATUSES as readonly string[]).includes(t.status)).length;
  const taskPct = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  const daysTotal = Math.ceil((new Date(sprint.endDate).getTime() - new Date(sprint.startDate).getTime()) / (1000 * 60 * 60 * 24));
  const daysElapsed = Math.max(1, Math.floor((Date.now() - new Date(sprint.startDate).getTime()) / (1000 * 60 * 60 * 24)));
  const daysRemaining = Math.max(0, daysTotal - daysElapsed);

  const velocity = daysElapsed > 0 ? (completedTasks / daysElapsed).toFixed(1) : '0';

  const daysForBurndown = Math.max(7, daysTotal);
  const { data: burndownData } = useBoardBurndown(habitatId, daysForBurndown);

  const sprintBurndown: BurndownDataPoint[] = burndownData?.data?.filter(
    (dp: BurndownDataPoint) => dp.date >= sprint.startDate && dp.date <= sprint.endDate
  ) ?? [];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          icon={Target}
          label="Missions"
          value={`${completedMissions}/${totalMissions}`}
          subtitle={`${missionPct}% complete`}
          color="text-blue-500"
        />
        <MetricCard
          icon={CheckCircle}
          label="Tasks"
          value={`${completedTasks}/${totalTasks}`}
          subtitle={`${taskPct}% complete`}
          color="text-green-500"
        />
        <MetricCard
          icon={Clock}
          label="Days Left"
          value={daysRemaining}
          subtitle={`of ${daysTotal} total`}
          color={daysRemaining <= 2 ? 'text-red-500' : daysRemaining <= 5 ? 'text-amber-500' : 'text-violet-500'}
        />
        <MetricCard
          icon={TrendingUp}
          label="Velocity"
          value={`${velocity}/day`}
          subtitle={`${completedTasks} tasks in ${daysElapsed}d`}
          color="text-orange-500"
        />
      </div>

      {sprint.goal && (
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground mb-1">Sprint Goal</p>
          <p className="text-sm">{sprint.goal}</p>
        </div>
      )}

      {sprintBurndown.length > 0 && (
        <div className="rounded-lg border border-border p-3">
          <p className="text-xs font-medium text-muted-foreground mb-2">Burndown</p>
          <BurndownChart data={sprintBurndown} />
        </div>
      )}
    </div>
  );
}
