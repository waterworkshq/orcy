import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/index.js";
import { queryKeys } from "../lib/queryKeys.js";
import { notify } from "../lib/toast.js";

export function useFindingTriage(
  habitatId: string,
  filters?: { status?: string; bucket?: string },
) {
  return useQuery({
    queryKey: queryKeys.triage.findings(habitatId, filters),
    queryFn: ({ signal }) => api.triage.listFindings(habitatId, filters, signal),
    enabled: !!habitatId,
    staleTime: 30_000,
  });
}

export function useFindingTriageDetail(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.triage.finding(id ?? ""),
    queryFn: ({ signal }) => api.triage.getFinding(id!, signal),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useTriageResolutions(habitatId: string, clusterKey: string | undefined) {
  return useQuery({
    queryKey: queryKeys.triage.resolutions(habitatId, clusterKey ?? ""),
    queryFn: ({ signal }) => api.triage.lookupResolutions(habitatId, clusterKey!, signal),
    enabled: !!habitatId && !!clusterKey,
    staleTime: 60_000,
  });
}

export function useTopTriageClusters(habitatId: string, limit?: number) {
  return useQuery({
    queryKey: queryKeys.triage.top(habitatId, limit),
    queryFn: ({ signal }) => api.triage.topIssues(habitatId, limit, signal),
    enabled: !!habitatId,
    staleTime: 60_000,
  });
}

/** Invalidate every triage projection after a successful lifecycle command. */
function useInvalidateTriage() {
  const queryClient = useQueryClient();
  return () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.triage.all });
  };
}

/**
 * POST /triage/findings/:id/route — explicit route intent. Work-bearing
 * buckets carry the complete Mission placement (title/description/gate);
 * no-work buckets are bare. Replaces the state-shaped PATCH transition.
 */
export function useRouteFinding() {
  const invalidate = useInvalidateTriage();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; route: Parameters<typeof api.triage.routeFinding>[1] }) =>
      api.triage.routeFinding(input.id, input.route),
    onSuccess: (finding) => {
      invalidate();
      // Work-bearing routes create/link a corrective Mission — refresh the
      // roadmap projections too.
      if (finding.correctiveMissionId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.missions.all });
      }
    },
    onError: (err) => {
      notify.error(err instanceof Error ? err.message : "Failed to route finding");
    },
  });
}

/**
 * POST /triage/findings/:id/resolve — terminal resolution with the COMPLETE
 * payload (resolution text + kind + optional root cause). The Resolution
 * record is written durably by the backend; this replaces the legacy
 * `{status:'resolved'}` PATCH that silently discarded the resolution data.
 */
export function useResolveFinding() {
  const invalidate = useInvalidateTriage();
  return useMutation({
    mutationFn: (input: {
      id: string;
      resolution: string;
      resolutionKind: string;
      rootCause?: string;
    }) =>
      api.triage.resolveFinding(input.id, {
        resolution: input.resolution,
        resolutionKind: input.resolutionKind,
        ...(input.rootCause !== undefined ? { rootCause: input.rootCause } : {}),
      }),
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => {
      notify.error(err instanceof Error ? err.message : "Failed to resolve finding");
    },
  });
}

/** POST /triage/findings/:id/wontfix — terminal wontfix with a required reason. */
export function useWontfixFinding() {
  const invalidate = useInvalidateTriage();
  return useMutation({
    mutationFn: (input: { id: string; reason: string }) =>
      api.triage.wontfixFinding(input.id, { reason: input.reason }),
    onSuccess: () => {
      invalidate();
    },
    onError: (err) => {
      notify.error(err instanceof Error ? err.message : "Failed to mark finding wontfix");
    },
  });
}

/**
 * POST /triage/findings/:id/activate — manual activation of the EXISTING
 * corrective Mission. The caller supplies the Mission version it observed
 * (`expectedMissionVersion`); the component renders the outcome:
 * replay (idempotent re-activation), conflict (stale version → 409 with
 * X-Current-Version / mixed group / missing link), or busy (retry after).
 * Error rendering is intentionally left to the component so the conflict
 * semantics stay visible instead of collapsing into a toast.
 */
export function useActivateFinding() {
  const invalidate = useInvalidateTriage();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; expectedMissionVersion: number }) =>
      api.triage.activateFinding(input.id, {
        expectedMissionVersion: input.expectedMissionVersion,
      }),
    onSuccess: () => {
      invalidate();
      // The Mission's gate cleared + version bumped — refresh the roadmap.
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.all });
    },
  });
}
