import { AlertTriangle, GitBranch, Loader2 } from "lucide-react";
import { useBottlenecks, useCumulativeFlow } from "../../lib/useHabitatData.js";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/Card.js";
import type {
  AnalyticsWarning,
  BottleneckResponse,
  CumulativeFlowResponse,
} from "../../types/index.js";

interface FlowAnalyticsPanelProps {
  habitatId: string;
  days: number;
}

function WarningList({ warnings }: { warnings: AnalyticsWarning[] }) {
  if (warnings.length === 0) return null;
  return (
    <div className="space-y-1" role="note" aria-label="Analytics caveats">
      {warnings.map((warning) => (
        <p key={`${warning.code}:${warning.message}`} className="text-xs text-on-surface-variant">
          {warning.severity === "critical" ? "Critical" : "Note"}: {warning.message}
        </p>
      ))}
    </div>
  );
}

function FlowChartPreview({ flow }: { flow: CumulativeFlowResponse }) {
  const latest = flow.data.at(-1);
  const totals = flow.columns.map((column) => ({
    ...column,
    count: latest?.countsByColumn[column.columnId] ?? 0,
  }));
  const maxCount = Math.max(1, ...totals.map((item) => item.count));

  if (flow.data.length === 0 || totals.every((item) => item.count === 0)) {
    return <p className="text-sm text-on-surface-variant">No cumulative-flow samples yet.</p>;
  }

  return (
    <div className="space-y-3" aria-label="Latest cumulative flow counts">
      {totals.map((item) => (
        <div key={item.columnId} className="space-y-1">
          <div className="flex items-center justify-between text-xs">
            <span className="font-medium text-on-surface">{item.name}</span>
            <span className="text-on-surface-variant">{item.count}</span>
          </div>
          <div className="h-2 rounded-full bg-surface-container-high overflow-hidden">
            <div
              className="h-full rounded-full bg-primary"
              style={{ width: `${Math.max(6, (item.count / maxCount) * 100)}%` }}
            />
          </div>
        </div>
      ))}
    </div>
  );
}

export function FlowAnalyticsData({
  flow,
  bottlenecks,
}: {
  flow: CumulativeFlowResponse;
  bottlenecks: BottleneckResponse;
}) {
  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <GitBranch className="h-4 w-4 text-primary" /> Cumulative Flow
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <FlowChartPreview flow={flow} />
          <WarningList warnings={flow.warnings} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-[var(--agent-orange)]" /> Bottlenecks
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {bottlenecks.findings.length === 0 ? (
            <p className="text-sm text-on-surface-variant">
              No bottleneck findings in this window.
            </p>
          ) : (
            <div className="space-y-3">
              {bottlenecks.findings.slice(0, 4).map((finding) => (
                <article
                  key={`${finding.signal}:${finding.columnId ?? finding.missionId ?? finding.summary}`}
                  className="rounded-lg border border-outline-variant/40 p-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <h3 className="text-sm font-medium text-on-surface">{finding.summary}</h3>
                    <span className="rounded-full bg-surface-container-high px-2 py-0.5 text-[10px] uppercase tracking-wide text-on-surface-variant">
                      {finding.severity}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-on-surface-variant">{finding.recommendation}</p>
                  <p className="mt-1 text-[10px] text-on-surface-variant">
                    Confidence: {finding.confidence.replace("_", " ")}
                  </p>
                </article>
              ))}
            </div>
          )}
          <WarningList warnings={bottlenecks.warnings} />
        </CardContent>
      </Card>
    </div>
  );
}

export function FlowAnalyticsPanel({ habitatId, days }: FlowAnalyticsPanelProps) {
  const flow = useCumulativeFlow(habitatId, days);
  const bottlenecks = useBottlenecks(habitatId, days);
  const isLoading = flow.isLoading || bottlenecks.isLoading;
  const error = flow.error ?? bottlenecks.error;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 flex items-center justify-center text-on-surface-variant">
          <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading flow analytics...
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-error">
          {(error as Error).message}
        </CardContent>
      </Card>
    );
  }

  if (!flow.data || !bottlenecks.data) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-on-surface-variant">
          Select a habitat to view flow analytics.
        </CardContent>
      </Card>
    );
  }

  return <FlowAnalyticsData flow={flow.data} bottlenecks={bottlenecks.data} />;
}
