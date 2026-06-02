import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/index.js";
import { queryKeys } from "../lib/queryKeys.js";
import { notify } from "../lib/toast.js";

export function useTaskEffortReport(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.effort.task(taskId ?? ""),
    queryFn: () => api.effort.getReport(taskId!),
    enabled: !!taskId,
    staleTime: 30_000,
  });
}

export function useTaskEffortEntries(taskId: string | undefined, includeCorrections = true) {
  return useQuery({
    queryKey: queryKeys.effort.entries(taskId ?? "", includeCorrections),
    queryFn: () => api.effort.listEntries(taskId!, includeCorrections),
    enabled: !!taskId,
    staleTime: 30_000,
  });
}

export function useLogEffort(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { minutes: number; note?: string; startedAt?: string; endedAt?: string }) =>
      api.effort.log(taskId, input.minutes, input.note, input.startedAt, input.endedAt),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.effort.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.effort.entriesForTask(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
    },
    onError: (err) => {
      notify.error(err instanceof Error ? err.message : "Failed to log effort");
    },
  });
}

export function useCorrectEffortEntry(taskId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      entryId: string;
      minutesDelta: number;
      correctionReason: string;
      note?: string;
    }) =>
      api.effort.correct(
        taskId,
        input.entryId,
        input.minutesDelta,
        input.correctionReason,
        input.note,
      ),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.effort.task(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.effort.entriesForTask(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
    },
    onError: (err) => {
      notify.error(err instanceof Error ? err.message : "Failed to correct effort entry");
    },
  });
}
