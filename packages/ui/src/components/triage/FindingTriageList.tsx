import React, { useState } from "react";
import type { FindingTriageView } from "../../types/index.js";
import { useFindingTriage } from "../../hooks/useTriage.js";

interface FindingTriageListProps {
  habitatId: string;
  /** Initial status filter; defaults to "open". */
  initialStatus?: string;
  /** Called when a row is selected (e.g. to open the confirmation modal). */
  onSelect?: (finding: FindingTriageView) => void;
}

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "open", label: "Open" },
  { value: "triaged", label: "Triaged" },
  { value: "in_progress", label: "In progress" },
  { value: "resolved", label: "Resolved" },
  { value: "wontfix", label: "Won't fix" },
];

const BUCKET_OPTIONS = [
  { value: "", label: "All buckets" },
  { value: "fix_now", label: "Fix now" },
  { value: "defer_to_patch", label: "Defer to patch" },
  { value: "defer_to_release", label: "Defer to release" },
  { value: "document_as_known_limitation", label: "Document" },
  { value: "needs_investigation", label: "Needs investigation" },
];

const STATUS_BADGE: Record<string, string> = {
  open: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200",
  triaged: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200",
  in_progress: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  resolved: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200",
  wontfix: "bg-muted text-muted-foreground",
};

const BUCKET_BADGE: Record<string, string> = {
  fix_now: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200",
  defer_to_patch: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200",
  defer_to_release: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-200",
  document_as_known_limitation:
    "bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-200",
  needs_investigation: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-200",
};

/**
 * Filterable list of finding triage records. Filter by status and bucket; each
 * row expands to reveal corroborating pulses and triage attribution. Uses the
 * {@link useFindingTriage} hook.
 */
export function FindingTriageList({
  habitatId,
  initialStatus = "",
  onSelect,
}: FindingTriageListProps) {
  const [status, setStatus] = useState(initialStatus);
  const [bucket, setBucket] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filters: { status?: string; bucket?: string } = {};
  if (status) filters.status = status;
  if (bucket) filters.bucket = bucket;

  const { data: findings, isLoading, error } = useFindingTriage(habitatId, filters);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading findings…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-600">{(error as Error).message}</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        <select
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          className="rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {STATUS_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={bucket}
          onChange={(e) => setBucket(e.target.value)}
          className="rounded border border-input bg-background px-2 py-1 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {BUCKET_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>

      {!findings || findings.length === 0 ? (
        <p className="text-sm text-muted-foreground">No findings match these filters.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {findings.map((f) => {
            const expanded = expandedId === f.id;
            return (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => setExpandedId(expanded ? null : f.id)}
                  className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted/50"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{f.clusterKey}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {f.findingKind} · {f.corroboratingPulseIds.length + 1} pulse(s)
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-1.5">
                    {f.bucket && (
                      <span
                        className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${BUCKET_BADGE[f.bucket] ?? "bg-muted text-muted-foreground"}`}
                      >
                        {f.bucket}
                      </span>
                    )}
                    <span
                      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_BADGE[f.status] ?? "bg-muted text-muted-foreground"}`}
                    >
                      {f.status}
                    </span>
                  </div>
                </button>
                {expanded && (
                  <div className="space-y-2 border-t border-border bg-muted/20 px-3 py-2 text-xs">
                    <Detail label="Finding ID" value={f.id} />
                    <Detail label="Target release" value={f.targetRelease ?? "—"} />
                    <Detail label="Triaged by" value={f.triagedById ?? "—"} />
                    <Detail label="Triage mission" value={f.triageMissionId ?? "—"} />
                    <Detail label="Created" value={new Date(f.createdAt).toLocaleString()} />
                    {f.corroboratingPulseIds.length > 0 && (
                      <div>
                        <p className="text-muted-foreground">Corroborating pulses</p>
                        <ul className="ml-3 list-disc">
                          {f.corroboratingPulseIds.map((pid) => (
                            <li key={pid}>{pid}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {onSelect && (
                      <button
                        type="button"
                        onClick={() => onSelect(f)}
                        className="mt-1 rounded bg-primary px-3 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90"
                      >
                        Triage
                      </button>
                    )}
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <p>
      <span className="text-muted-foreground">{label}: </span>
      <span className="font-mono">{value}</span>
    </p>
  );
}
