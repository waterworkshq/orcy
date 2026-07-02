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
    queryFn: () => api.triage.listFindings(habitatId, filters),
    enabled: !!habitatId,
    staleTime: 30_000,
  });
}

export function useFindingTriageDetail(id: string | undefined) {
  return useQuery({
    queryKey: queryKeys.triage.finding(id ?? ""),
    queryFn: () => api.triage.getFinding(id!),
    enabled: !!id,
    staleTime: 30_000,
  });
}

export function useTriageResolutions(habitatId: string, clusterKey: string | undefined) {
  return useQuery({
    queryKey: queryKeys.triage.resolutions(habitatId, clusterKey ?? ""),
    queryFn: () => api.triage.lookupResolutions(habitatId, clusterKey!),
    enabled: !!habitatId && !!clusterKey,
    staleTime: 60_000,
  });
}

export function useTopTriageClusters(habitatId: string, limit?: number) {
  return useQuery({
    queryKey: queryKeys.triage.top(habitatId, limit),
    queryFn: () => api.triage.topIssues(habitatId, limit),
    enabled: !!habitatId,
    staleTime: 60_000,
  });
}

export function useTransitionFinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      id: string;
      body: { status?: string; bucket?: string; targetRelease?: string | null };
    }) => api.triage.transitionFinding(input.id, input.body),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triage.all });
    },
    onError: (err) => {
      notify.error(err instanceof Error ? err.message : "Failed to update finding");
    },
  });
}

export function usePromoteFinding() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.triage.promoteFinding(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triage.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.all });
      notify.success("Finding promoted to corrective mission");
    },
    onError: (err) => {
      notify.error(err instanceof Error ? err.message : "Failed to promote finding");
    },
  });
}
