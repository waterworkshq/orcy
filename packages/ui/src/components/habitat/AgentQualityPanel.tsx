import { ShieldCheck, Loader2 } from "lucide-react";
import { useAgentQuality } from "../../lib/useHabitatData.js";
import type { AgentQualitySignal } from "../../types/index.js";

interface AgentQualityPanelProps {
  habitatId: string;
}

function formatPercent(value: number | null): string {
  return value === null ? "n/a" : `${Math.round(value * 100)}%`;
}

function scoreLabel(signal: AgentQualitySignal): string {
  if (signal.confidence === "insufficient_data")
    return "Low confidence: not enough completed work yet.";
  if (signal.score === null) return "Signal unavailable";
  return `${Math.round(signal.score * 100)}% signal`;
}

export function AgentQualityList({ signals }: { signals: AgentQualitySignal[] }) {
  if (signals.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">No agent quality signals are available yet.</p>
    );
  }

  return (
    <div className="space-y-2">
      {signals.map((signal) => (
        <article key={signal.agentId} className="rounded-md border border-border p-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h4 className="truncate text-xs font-medium">{signal.agentName}</h4>
              <p className="text-[10px] text-muted-foreground">
                {scoreLabel(signal)} · {signal.sampleSize} completed sample
                {signal.sampleSize === 1 ? "" : "s"}
              </p>
            </div>
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
              {signal.confidence.replaceAll("_", " ")}
            </span>
          </div>
          <dl className="mt-2 grid grid-cols-2 gap-1 text-[10px] text-muted-foreground">
            <div>
              <dt>Approval</dt>
              <dd className="text-foreground">{formatPercent(signal.dimensions.approval)}</dd>
            </div>
            <div>
              <dt>Evidence</dt>
              <dd className="text-foreground">
                {formatPercent(signal.dimensions.evidenceCompleteness)}
              </dd>
            </div>
            <div>
              <dt>Estimate accuracy</dt>
              <dd className="text-foreground">
                {formatPercent(signal.dimensions.estimateAccuracy)}
              </dd>
            </div>
            <div>
              <dt>Consistency</dt>
              <dd className="text-foreground">{formatPercent(signal.dimensions.consistency)}</dd>
            </div>
          </dl>
          {signal.warnings.length > 0 && (
            <ul className="mt-2 space-y-1">
              {signal.warnings.slice(0, 3).map((warning) => (
                <li
                  key={`${signal.agentId}:${warning}`}
                  className="text-[11px] text-muted-foreground"
                >
                  {warning}
                </li>
              ))}
            </ul>
          )}
        </article>
      ))}
    </div>
  );
}

export function AgentQualityPanel({ habitatId }: AgentQualityPanelProps) {
  const quality = useAgentQuality(habitatId);

  return (
    <section
      className="mb-5 rounded-lg border border-border bg-card p-3"
      aria-label="Agent quality signals"
    >
      <div className="mb-3 flex items-center gap-2">
        <ShieldCheck className="h-4 w-4 text-primary" />
        <div>
          <h3 className="text-sm font-semibold">Agent quality signals</h3>
          <p className="text-[11px] text-muted-foreground">
            Informational only. Does not affect assignment, review, eligibility, or permissions.
          </p>
        </div>
      </div>

      {quality.isLoading ? (
        <div className="flex items-center justify-center py-4 text-xs text-muted-foreground">
          <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> Loading quality signals...
        </div>
      ) : quality.error ? (
        <p className="text-xs text-destructive">
          Failed to load quality signals: {(quality.error as Error).message}
        </p>
      ) : (
        <AgentQualityList signals={quality.data?.signals ?? []} />
      )}
    </section>
  );
}
