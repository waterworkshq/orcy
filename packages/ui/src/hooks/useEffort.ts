import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/index.js";

export function useTaskEffortReport(taskId: string | undefined) {
  return useQuery({
    queryKey: ["effort", "task", taskId],
    queryFn: () => api.effort.getReport(taskId!),
    enabled: !!taskId,
    staleTime: 30_000,
  });
}

export function useTaskEffortEntries(taskId: string | undefined, includeCorrections = true) {
  return useQuery({
    queryKey: ["effort", "entries", taskId, includeCorrections],
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
      queryClient.invalidateQueries({ queryKey: ["effort", "task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["effort", "entries", taskId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", taskId] });
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
      queryClient.invalidateQueries({ queryKey: ["effort", "task", taskId] });
      queryClient.invalidateQueries({ queryKey: ["effort", "entries", taskId] });
      queryClient.invalidateQueries({ queryKey: ["tasks", taskId] });
    },
  });
}
