import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/index.js";
import { queryKeys } from "../../lib/queryKeys.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card.js";

/** Renders workflow health metrics: active count, failure rate, recovery success rate, and depth distribution. */
export function WorkflowMetricsPanel({ habitatId, days }: { habitatId: string; days: number }) {
  const { data, isLoading, isError } = useQuery({
    queryKey: queryKeys.metrics.workflow(habitatId, days),
    queryFn: () => api.metrics.workflow(habitatId, days),
  });

  if (isLoading) {
    return (
      <Card data-testid="workflow-metrics-panel">
        <CardHeader>
          <CardTitle>Workflow Health</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="workflow-metrics-loading">Loading...</p>
        </CardContent>
      </Card>
    );
  }

  if (isError) {
    return (
      <Card data-testid="workflow-metrics-panel">
        <CardHeader>
          <CardTitle>Workflow Health</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="workflow-metrics-error" className="text-red-500">
            Failed to load workflow metrics.
          </p>
        </CardContent>
      </Card>
    );
  }

  const activeCount = data?.activeWorkflowsCount ?? 0;
  const failureRate = data?.failureRate ?? 0;
  const recoveryRate = data?.recoverySuccessRate ?? 0;
  const depthData = data?.recoveryAttemptsByDepth ?? [];

  if (activeCount === 0 && depthData.length === 0) {
    return (
      <Card data-testid="workflow-metrics-panel">
        <CardHeader>
          <CardTitle>Workflow Health</CardTitle>
        </CardHeader>
        <CardContent>
          <p data-testid="workflow-metrics-empty" className="text-slate-400">
            No active workflows or recovery activity in this period.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="workflow-metrics-panel">
      <CardHeader>
        <CardTitle>Workflow Health</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <div
            data-testid="metric-active-workflows"
            className="rounded-lg border border-slate-700 p-3"
          >
            <div className="text-2xl font-bold text-cyan-400">{activeCount}</div>
            <div className="text-xs text-slate-400">Active Workflows</div>
          </div>
          <div data-testid="metric-failure-rate" className="rounded-lg border border-slate-700 p-3">
            <div className="text-2xl font-bold text-red-400">{(failureRate * 100).toFixed(0)}%</div>
            <div className="text-xs text-slate-400">Failure Rate</div>
          </div>
          <div
            data-testid="metric-recovery-rate"
            className="rounded-lg border border-slate-700 p-3"
          >
            <div className="text-2xl font-bold text-green-400">
              {(recoveryRate * 100).toFixed(0)}%
            </div>
            <div className="text-xs text-slate-400">Recovery Success</div>
          </div>
          <div
            data-testid="metric-recovery-attempts"
            className="rounded-lg border border-slate-700 p-3"
          >
            <div className="text-2xl font-bold text-purple-400">{depthData.length}</div>
            <div className="text-xs text-slate-400">Recovery Depth Levels</div>
          </div>
        </div>

        {depthData.length > 0 && (
          <div className="mt-4">
            <h4 className="mb-2 text-sm font-medium text-slate-300">Recovery Attempts by Depth</h4>
            <div className="space-y-1" data-testid="recovery-depth-list">
              {depthData.map((d) => (
                <div
                  key={d.recoveryDepth}
                  data-testid={`recovery-depth-${d.recoveryDepth}`}
                  className="flex items-center gap-2 text-sm"
                >
                  <span className="w-32 text-slate-400">
                    Depth {d.recoveryDepth}
                    {d.recoveryDepth === 0 && " (original)"}
                    {d.recoveryDepth === 1 && " (first recovery)"}
                    {d.recoveryDepth >= 2 && " (deep recovery)"}
                  </span>
                  <div className="h-4 flex-1 overflow-hidden rounded bg-slate-800">
                    <div
                      className="h-full bg-purple-500"
                      style={{ width: `${Math.min(d.total * 10, 100)}%` }}
                    />
                  </div>
                  <span className="w-8 text-right text-slate-300">{d.total}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
