import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card.js";
import type { ExperienceCategory } from "../../types/index.js";

const CATEGORY_LABELS: Record<ExperienceCategory, string> = {
  stuck: "Stuck",
  confused: "Confused",
  backtrack: "Backtrack",
  surprised: "Surprised",
  ambiguous: "Ambiguous",
  sidetracked: "Sidetracked",
  smooth: "Smooth",
};

const CATEGORY_COLORS: Record<ExperienceCategory, string> = {
  stuck: "bg-red-500",
  confused: "bg-orange-500",
  backtrack: "bg-amber-500",
  surprised: "bg-blue-500",
  ambiguous: "bg-slate-500",
  sidetracked: "bg-purple-500",
  smooth: "bg-green-500",
};

const ALL_CATEGORIES = Object.keys(CATEGORY_LABELS) as ExperienceCategory[];

/** Renders per-agent experience signal metrics with category distribution and outlier flags. */
export function ExperienceMetricsPanel({ habitatId, days }: { habitatId: string; days: number }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.metrics.experience(habitatId, days),
    queryFn: () => api.metrics.experience(habitatId, days),
  });

  if (isLoading) {
    return (
      <Card data-testid="experience-metrics-panel">
        <CardHeader>
          <CardTitle>Experience Signals</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="experience-metrics-loading">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card data-testid="experience-metrics-panel">
        <CardHeader>
          <CardTitle>Experience Signals</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="experience-metrics-error" className="text-red-500">
            Failed to load experience metrics.
          </p>
        </CardContent>
      </Card>
    );
  }

  const agents = data?.agents ?? [];
  const median = data?.medianSignalsTaskRatio ?? 0;

  if (agents.length === 0) {
    return (
      <Card data-testid="experience-metrics-panel">
        <CardHeader>
          <CardTitle>Experience Signals</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="experience-metrics-empty" className="text-slate-400">
            No experience signals recorded in this period.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="experience-metrics-panel">
      <CardHeader>
        <CardTitle>
          Experience Signals{" "}
          <span className="text-sm font-normal text-slate-400">
            (habitat median: {median.toFixed(2)} signals/task)
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table data-testid="experience-metrics-table" className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-700 text-left text-slate-400">
                <th className="pb-2 pr-3">Agent</th>
                <th className="pb-2 pr-3">Signals/Task</th>
                <th className="pb-2 pr-3">Category Distribution</th>
                <th className="pb-2 pr-3">Mid/Completion</th>
                <th className="pb-2">Flag</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((agent) => (
                <tr
                  key={agent.agentId}
                  data-testid={`experience-agent-${agent.agentId}`}
                  className="border-b border-slate-800"
                >
                  <td className="py-2 pr-3">
                    <div className="font-medium">{agent.agentName}</div>
                    <div className="text-xs text-slate-500">{agent.agentType}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span data-testid={`ratio-${agent.agentId}`}>
                      {agent.signalsTaskRatio.toFixed(2)}
                    </span>
                    <span className="ml-1 text-xs text-slate-500">
                      ({agent.signalCount}/{agent.tasksWorked})
                    </span>
                  </td>
                  <td className="py-2 pr-3">
                    <div
                      data-testid={`categories-${agent.agentId}`}
                      className="flex h-4 w-32 overflow-hidden rounded"
                    >
                      {ALL_CATEGORIES.map((cat) => {
                        const count = agent.categoryDistribution[cat] ?? 0;
                        if (count === 0) return null;
                        return (
                          <div
                            key={cat}
                            className={CATEGORY_COLORS[cat]}
                            style={{ flexGrow: count }}
                            title={`${CATEGORY_LABELS[cat]}: ${count}`}
                            data-testid={`cat-bar-${agent.agentId}-${cat}`}
                          />
                        );
                      })}
                    </div>
                    <div className="mt-1 text-xs text-slate-500">
                      {ALL_CATEGORIES.filter((c) => agent.categoryDistribution[c])
                        .map((c) => `${CATEGORY_LABELS[c]}: ${agent.categoryDistribution[c]}`)
                        .join(", ") || "none"}
                    </div>
                  </td>
                  <td className="py-2 pr-3 text-slate-300">
                    {agent.midTaskCompletionRatio.toFixed(1)}
                  </td>
                  <td className="py-2">
                    {agent.outlierFlag === "high_reporter" && (
                      <span
                        data-testid={`flag-${agent.agentId}`}
                        className="rounded bg-yellow-500/20 px-2 py-0.5 text-xs text-yellow-400"
                      >
                        High reporter
                      </span>
                    )}
                    {agent.outlierFlag === "low_reporter" && (
                      <span
                        data-testid={`flag-${agent.agentId}`}
                        className="rounded bg-slate-500/20 px-2 py-0.5 text-xs text-slate-400"
                      >
                        Low reporter
                      </span>
                    )}
                    {!agent.outlierFlag && <span className="text-xs text-slate-600">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
