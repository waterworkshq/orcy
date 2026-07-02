import React from "react";
import type { FindingTriageView } from "../../types/index.js";
import { useFindingTriage, usePromoteFinding } from "../../hooks/useTriage.js";

interface DeferredBacklogProps {
  habitatId: string;
  onPromoted?: (finding: FindingTriageView, missionId: string) => void;
}

interface BacklogGroup {
  targetRelease: string;
  findings: FindingTriageView[];
}

/**
 * View of deferred findings (bucket = defer_to_patch or defer_to_release),
 * grouped by `targetRelease`. Each item exposes a "Promote" action that calls
 * {@link usePromoteFinding} to spin up a corrective mission.
 */
export function DeferredBacklog({ habitatId, onPromoted }: DeferredBacklogProps) {
  const promote = usePromoteFinding();

  // Fetch all deferred findings; we filter both defer buckets client-side so a
  // single query backs the grouped view (the API filters on a single bucket).
  const [patchFindings, setPatchFilters] = useDeferQuery(habitatId, "defer_to_patch");
  const [releaseFindings, setReleaseFilters] = useDeferQuery(habitatId, "defer_to_release");

  const isLoading = !patchFindings || !releaseFindings;
  const combined = [...(patchFindings ?? []), ...(releaseFindings ?? [])];
  const groups = groupByRelease(combined);

  const handlePromote = (finding: FindingTriageView) => {
    promote.mutate(finding.id, {
      onSuccess: (missionId) => {
        onPromoted?.(finding, missionId);
        setPatchFilters({});
        setReleaseFilters({});
      },
    });
  };

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading deferred findings…</p>;
  }

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No deferred findings in the backlog.</p>;
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <div key={group.targetRelease}>
          <h3 className="mb-1.5 text-sm font-semibold">
            {group.targetRelease}
            <span className="ml-1.5 text-xs font-normal text-muted-foreground">
              ({group.findings.length})
            </span>
          </h3>
          <ul className="divide-y divide-border rounded-lg border border-border">
            {group.findings.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{f.clusterKey}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {f.findingKind} · bucket: {f.bucket ?? "—"}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handlePromote(f)}
                  disabled={promote.isPending}
                  className="shrink-0 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {promote.isPending ? "Promoting…" : "Promote"}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Small helper hook returning [data, refetchTriggerSetter] for a single defer bucket. */
function useDeferQuery(
  habitatId: string,
  bucket: "defer_to_patch" | "defer_to_release",
): [FindingTriageView[] | undefined, (next: Record<string, never>) => void] {
  const query = useFindingTriage(habitatId, { bucket });
  // The refetch trigger is implicit via React Query invalidation in
  // usePromoteFinding; the setter exists so callers can force a refetch.
  const noop = React.useCallback(() => {
    void query.refetch();
  }, [query]);
  return [query.data, noop];
}

function groupByRelease(findings: FindingTriageView[]): BacklogGroup[] {
  const map = new Map<string, FindingTriageView[]>();
  for (const f of findings) {
    const key = f.targetRelease ?? "Unscheduled";
    const arr = map.get(key) ?? [];
    arr.push(f);
    map.set(key, arr);
  }
  return [...map.entries()]
    .map(([targetRelease, items]) => ({ targetRelease, findings: items }))
    .sort((a, b) => a.targetRelease.localeCompare(b.targetRelease));
}
