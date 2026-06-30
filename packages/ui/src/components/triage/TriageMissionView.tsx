import React from "react";
import type { ClusterSummaryView, TriageResolutionView } from "../../types/index.js";

interface TriageMissionViewProps {
  cluster: ClusterSummaryView;
  resolutions?: TriageResolutionView[];
  /** Optional provenance breakdown from the cluster payload (signalType → count). */
  provenanceBreakdown?: Record<string, number>;
  /** Affected entity counts, if known from the cluster payload. */
  affected?: {
    taskCount?: number;
    missionCount?: number;
    agentCount?: number;
  };
  onAdoptResolution?: (resolution: TriageResolutionView) => void;
}

const STATUS_BADGE_CLASSES: Record<string, string> = {
  under_investigation: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  awaiting_triage: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
};

/**
 * Renders the cluster context for a triage mission: subject (clusterKey), signal
 * count, provenance breakdown, affected entities, investigation status, and any
 * proactive suggestion (historical resolution) surfaced for the cluster.
 */
export function TriageMissionView({
  cluster,
  resolutions,
  provenanceBreakdown,
  affected,
  onAdoptResolution,
}: TriageMissionViewProps) {
  const statusBadge = STATUS_BADGE_CLASSES[cluster.status] ?? "bg-muted text-muted-foreground";

  return (
    <div className="rounded-lg border border-border bg-card p-4 space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 className="truncate text-sm font-semibold">{cluster.clusterKey}</h3>
          <p className="text-xs text-muted-foreground">
            {cluster.signalCount} signal{cluster.signalCount === 1 ? "" : "s"}
            {cluster.findingKinds.length > 0 && <> · {cluster.findingKinds.join(", ")}</>}
          </p>
        </div>
        <span
          className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-xs font-medium ${statusBadge}`}
        >
          {cluster.status === "under_investigation" ? "Under investigation" : "Awaiting triage"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 text-xs sm:grid-cols-4">
        <Metric label="Signals" value={cluster.signalCount} />
        <Metric label="Statuses" value={cluster.statuses.join(", ") || "—"} />
        <Metric label="Tasks" value={affected?.taskCount ?? "—"} />
        <Metric label="Agents" value={affected?.agentCount ?? "—"} />
      </div>

      {provenanceBreakdown && Object.keys(provenanceBreakdown).length > 0 && (
        <div>
          <p className="mb-1 text-xs font-medium text-muted-foreground">Provenance</p>
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(provenanceBreakdown).map(([type, count]) => (
              <span
                key={type}
                className="inline-flex items-center rounded bg-muted px-2 py-0.5 text-xs"
              >
                {type}: {count}
              </span>
            ))}
          </div>
        </div>
      )}

      {resolutions && resolutions.length > 0 && (
        <div className="rounded-md border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-900/50 dark:bg-emerald-950/30">
          <p className="mb-1 text-xs font-medium text-emerald-800 dark:text-emerald-200">
            Proactive suggestion — prior resolution for this cluster
          </p>
          <ul className="space-y-2">
            {resolutions.map((r) => (
              <li key={r.id} className="text-xs">
                <p className="text-foreground">{r.resolution ?? "—"}</p>
                {(r.rootCause || r.resolutionKind) && (
                  <p className="mt-0.5 text-muted-foreground">
                    {r.resolutionKind && <>{r.resolutionKind}</>}
                    {r.resolutionKind && r.rootCause && <> · </>}
                    {r.rootCause}
                  </p>
                )}
                {onAdoptResolution && (
                  <button
                    type="button"
                    onClick={() => onAdoptResolution(r)}
                    className="mt-1 text-xs font-medium text-primary hover:underline"
                  >
                    Adopt this resolution
                  </button>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md bg-muted/50 px-2 py-1.5">
      <p className="text-muted-foreground">{label}</p>
      <p className="truncate font-medium text-foreground">{value}</p>
    </div>
  );
}
