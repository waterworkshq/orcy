import { Activity, AlertTriangle, CalendarCheck, Loader2 } from "lucide-react";
import {
  useSprintBurndown,
  useSprintCarryOver,
  useSprintMetrics,
} from "../../lib/useHabitatData.js";
import { BurndownChart } from "../dashboard/BurndownChart.js";
import { WarningList } from "../ui/WarningList.js";
import type { SprintCarryOverReport, SprintMetricsV2 } from "../../types/index.js";

interface SprintAnalyticsPanelProps {
  sprintId: string;
}

function formatMinutes(minutes: number | null): string {
  if (minutes === null) return "Not estimated";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours}h ${rest}m` : `${hours}h`;
}

function MetricsSummary({ metrics }: { metrics: SprintMetricsV2 }) {
  const cards = [
    {
      label: "Completion",
      value: `${metrics.completionPercentage}%`,
      detail: `${metrics.completedTasks}/${metrics.totalTasks} tasks`,
    },
    { label: "Velocity", value: `${metrics.velocity}`, detail: "completed tasks in 30d" },
    {
      label: "Remaining",
      value: `${metrics.remainingDays}d`,
      detail: `${metrics.carryOverCount} carry-over candidates`,
    },
    {
      label: "Planned",
      value: formatMinutes(metrics.plannedMinutes),
      detail: `${formatMinutes(metrics.loggedEffortMinutes)} logged`,
    },
  ];

  return (
    <div className="grid grid-cols-2 gap-2">
      {cards.map((card) => (
        <div key={card.label} className="rounded-md border border-border p-2">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground">{card.label}</p>
          <p className="text-sm font-semibold text-foreground">{card.value}</p>
          <p className="text-[10px] text-muted-foreground">{card.detail}</p>
        </div>
      ))}
    </div>
  );
}

function CarryOverList({ report }: { report: SprintCarryOverReport }) {
  if (report.carriedOverMissions.length === 0) {
    return <p className="text-xs text-muted-foreground">No carry-over candidates right now.</p>;
  }

  return (
    <div className="space-y-2">
      {report.carriedOverMissions.slice(0, 3).map((mission) => (
        <article key={mission.missionId} className="rounded-md bg-muted/40 p-2">
          <div className="flex items-center justify-between gap-2">
            <h4 className="text-xs font-medium truncate">{mission.title}</h4>
            <span className="text-[10px] text-muted-foreground">{mission.status}</span>
          </div>
          <ul className="mt-1 space-y-1">
            {mission.reasons.slice(0, 2).map((reason) => (
              <li
                key={`${mission.missionId}:${reason.code}`}
                className="text-[11px] text-muted-foreground"
              >
                {reason.message}
              </li>
            ))}
          </ul>
        </article>
      ))}
    </div>
  );
}

export function SprintAnalyticsPanel({ sprintId }: SprintAnalyticsPanelProps) {
  const metrics = useSprintMetrics(sprintId);
  const burndown = useSprintBurndown(sprintId);
  const carryOver = useSprintCarryOver(sprintId);
  const isLoading = metrics.isLoading || burndown.isLoading || carryOver.isLoading;
  const error = metrics.error ?? burndown.error ?? carryOver.error;

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground flex items-center justify-center">
        <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" /> Loading sprint analytics...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-border p-3 text-xs text-destructive">
        {(error as Error).message}
      </div>
    );
  }

  if (!metrics.data || !burndown.data || !carryOver.data) {
    return (
      <div className="rounded-lg border border-border p-3 text-xs text-muted-foreground">
        No sprint analytics yet.
      </div>
    );
  }

  return (
    <section
      className="rounded-lg border border-border p-3 space-y-3"
      aria-label="Sprint analytics"
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <CalendarCheck className="h-4 w-4 text-primary" />
          <h3 className="text-xs font-semibold uppercase tracking-wide">Sprint Analytics</h3>
        </div>
        <span className="text-[10px] text-muted-foreground">
          {metrics.data.isOnTrack ? "On track" : "Needs attention"}
        </span>
      </div>

      <MetricsSummary metrics={metrics.data} />
      <WarningList warnings={metrics.data.warnings} variant="plain" />

      <div className="rounded-md border border-border p-2">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium">
          <Activity className="h-3.5 w-3.5 text-primary" /> Burndown
        </div>
        {burndown.data.data.length === 0 ? (
          <p className="text-xs text-muted-foreground">No sprint burndown samples yet.</p>
        ) : (
          <BurndownChart data={burndown.data.data} />
        )}
      </div>

      <div className="rounded-md border border-border p-2">
        <div className="mb-2 flex items-center gap-2 text-xs font-medium">
          <AlertTriangle className="h-3.5 w-3.5 text-[var(--agent-orange)]" /> Carry-over
        </div>
        <CarryOverList report={carryOver.data} />
        <WarningList warnings={carryOver.data.warnings} variant="plain" />
      </div>
    </section>
  );
}
