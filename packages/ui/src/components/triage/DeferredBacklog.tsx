import React from "react";
import type { FindingTriageView, TriageActivationView } from "../../types/index.js";
import { useQuery } from "@tanstack/react-query";
import { api } from "../../api/index.js";
import { useFindingTriage, useActivateFinding } from "../../hooks/useTriage.js";

interface DeferredBacklogProps {
  habitatId: string;
  /**
   * Called after a finding's corrective Mission is activated, with the
   * activation RESULT (post-activation Mission + every activated member of
   * the group) — never the stale pre-activation row. N:1 group activation
   * changes every member, so the full result is the only truthful payload.
   */
  onActivated?: (activation: TriageActivationView) => void;
}

interface BacklogGroup {
  key: string;
  label: string;
  findings: FindingTriageView[];
}

/**
 * View of deferred findings (bucket = defer_to_patch or defer_to_release),
 * grouped by their corrective Mission. Each item exposes an "Activate" action
 * backed by the manual-activation lifecycle command
 * (POST /triage/findings/:id/activate) on the finding's EXISTING corrective
 * Mission — it never creates or replaces the Mission. The UI supplies the
 * Mission `version` it observed (CAS); a stale version returns 409 with
 * X-Current-Version, contention returns 409 LIFECYCLE_BUSY (retry), and both
 * are rendered inline for the human instead of replacing anything.
 */
export function DeferredBacklog({ habitatId, onActivated }: DeferredBacklogProps) {
  // Fetch all deferred findings; we filter both defer buckets client-side so a
  // single query per bucket backs the grouped view.
  const patchQuery = useFindingTriage(habitatId, { bucket: "defer_to_patch" });
  const releaseQuery = useFindingTriage(habitatId, { bucket: "defer_to_release" });

  const isLoading = patchQuery.isLoading || releaseQuery.isLoading;
  // A failed bucket query must surface as an error — rendering the empty
  // state would silently hide a reachable backlog behind "No deferred
  // findings".
  const queryError = patchQuery.error ?? releaseQuery.error;
  const combined = [...(patchQuery.data ?? []), ...(releaseQuery.data ?? [])];
  const groups = groupByCorrectiveMission(combined);

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">Loading deferred findings…</p>;
  }

  if (queryError) {
    return (
      <p className="text-sm text-red-600" role="alert">
        Failed to load the deferred backlog:{" "}
        {queryError instanceof Error ? queryError.message : "unknown error"}
        <button
          type="button"
          className="ml-2 underline"
          onClick={() => {
            void patchQuery.refetch();
            void releaseQuery.refetch();
          }}
        >
          Retry
        </button>
      </p>
    );
  }

  if (groups.length === 0) {
    return <p className="text-sm text-muted-foreground">No deferred findings in the backlog.</p>;
  }

  return (
    <div className="space-y-4">
      {groups.map((group) => (
        <MissionGateGroup key={group.key} group={group} onActivated={onActivated} />
      ))}
    </div>
  );
}

/**
 * One corrective-Mission group. The Activate button supplies the Mission
 * version the UI observed from the shared missions read model, so the
 * server-side CAS has a real expected version (never a guessed 0).
 */
function MissionGateGroup({
  group,
  onActivated,
}: {
  group: BacklogGroup;
  onActivated?: (activation: TriageActivationView) => void;
}) {
  const missionId = group.findings[0]?.correctiveMissionId ?? null;
  const missionQuery = useQuery({
    queryKey: ["missions", "detail", missionId ?? ""],
    queryFn: ({ signal }) => api.missions.get(missionId!, signal),
    enabled: !!missionId,
    staleTime: 15_000,
  });
  const activate = useActivateFinding();

  const observedVersion = missionQuery.data?.mission.version;
  const busy = activate.isPending;
  const conflict = activate.isError ? (activate.error as Error) : null;
  // A failed mission read (404/403/500) must surface with a retry path —
  // otherwise Activate stays disabled forever behind "Waiting for the
  // corrective mission read model…".
  const missionLoadError = !!missionId && missionQuery.isError
    ? ((missionQuery.error as Error)?.message ?? "unknown error")
    : null;

  return (
    <div>
      <h3 className="mb-1.5 text-sm font-semibold">
        {group.label}
        <span className="ml-1.5 text-xs font-normal text-muted-foreground">
          ({group.findings.length})
        </span>
      </h3>
      <ul className="divide-y divide-border rounded-lg border border-border">
        {group.findings.map((f) => {
          const canActivate = !!f.correctiveMissionId && observedVersion !== undefined;
          return (
            <li key={f.id} className="flex items-center justify-between gap-3 px-3 py-2">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{f.clusterKey}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {f.findingKind} · bucket: {f.bucket ?? "—"}
                  {f.correctiveMissionId ? (
                    <> · mission: {f.correctiveMissionId.slice(0, 8)}…</>
                  ) : (
                    <> · no corrective mission (route first)</>
                  )}
                </p>
              </div>
              <button
                type="button"
                onClick={() => {
                  if (!f.correctiveMissionId || observedVersion === undefined) return;
                  activate.mutate(
                    { id: f.id, expectedMissionVersion: observedVersion },
                    // Surface the activation RESULT — the post-activation
                    // Mission plus every activated group member — instead of
                    // the stale pre-activation row.
                    { onSuccess: (activation) => onActivated?.(activation) },
                  );
                }}
                disabled={!canActivate || busy}
                title={
                  canActivate
                    ? `Activate the existing corrective mission (observed version ${observedVersion})`
                    : missionLoadError
                      ? "Could not load the corrective mission read model — retry below"
                      : "Waiting for the corrective mission read model…"
                }
                className="shrink-0 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {busy ? "Activating…" : "Activate"}
              </button>
            </li>
          );
        })}
      </ul>
      {missionLoadError && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          Could not load the corrective mission ({missionLoadError}). Activate
          needs the observed Mission version for the server-side CAS.
          <button type="button" className="ml-2 underline" onClick={() => missionQuery.refetch()}>
            Retry mission load
          </button>
        </p>
      )}
      {conflict && (
        <p className="mt-1 text-xs text-red-600" role="alert">
          {conflict.message}
          <button type="button" className="ml-2 underline" onClick={() => missionQuery.refetch()}>
            Refresh mission version
          </button>
        </p>
      )}
    </div>
  );
}

/** Groups deferred findings by their corrective Mission (the gate's owner). */
function groupByCorrectiveMission(findings: FindingTriageView[]): BacklogGroup[] {
  const map = new Map<string, BacklogGroup>();
  for (const f of findings) {
    const key = f.correctiveMissionId ?? "unlinked";
    const entry =
      map.get(key) ??
      ({
        key,
        label: f.correctiveMissionId
          ? `Corrective mission ${f.correctiveMissionId.slice(0, 8)}…`
          : "Unlinked (route to a work-bearing bucket first)",
        findings: [],
      } satisfies BacklogGroup);
    entry.findings.push(f);
    map.set(key, entry);
  }
  return [...map.values()];
}
