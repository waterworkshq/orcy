import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/index.js';
import { queryKeys } from './queryKeys.js';
import type { Board, FeatureWithProgress, Feature, Task, CreateFeatureInput, CreateTaskInFeatureInput } from '../types/index.js';

export function useBoards() {
  return useQuery({
    queryKey: queryKeys.boards.list(),
    queryFn: () => api.boards.list(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useMyTeams() {
  return useQuery({
    queryKey: queryKeys.teams.myTeams(),
    queryFn: () => api.myTeams(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoard(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.boards.detail(boardId ?? ''),
    queryFn: () => api.boards.get(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoardAgents(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: () => api.agents.list(),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoardStats(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.boards.stats(boardId ?? ''),
    queryFn: () => api.boards.stats(boardId!),
    enabled: !!boardId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useBoardEvents(boardId: string | undefined, params?: { limit?: number; action?: string }) {
  return useQuery({
    queryKey: [...queryKeys.boards.events(boardId ?? ''), params] as const,
    queryFn: () => api.boards.events(boardId!, params as any),
    enabled: !!boardId,
    staleTime: 30 * 1000,
  });
}

export function useFeatures(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.features.list(boardId ?? ''),
    queryFn: () => api.features.list(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useFeature(featureId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.features.detail(featureId ?? ''),
    queryFn: () => api.features.get(featureId!),
    enabled: !!featureId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useFeatureDetails(featureId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.features.details(featureId ?? ''),
    queryFn: () => api.features.details(featureId!),
    enabled: !!featureId,
    staleTime: 30 * 1000,
  });
}

export function useFeatureTasks(featureId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.features.tasks(featureId ?? ''),
    queryFn: () => api.features.tasks(featureId!),
    enabled: !!featureId,
    staleTime: 30 * 1000,
  });
}

export function useFeatureProgress(featureId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.features.progress(featureId ?? ''),
    queryFn: () => api.features.progress(featureId!),
    enabled: !!featureId,
    staleTime: 30 * 1000,
  });
}

export function useCreateFeature(boardId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateFeatureInput) => api.features.create(boardId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.features.list(boardId) });
      qc.invalidateQueries({ queryKey: queryKeys.boards.detail(boardId) });
    },
  });
}

export function useCreateTaskInFeature(featureId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data: CreateTaskInFeatureInput) => api.features.createTask(featureId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: queryKeys.features.tasks(featureId) });
      qc.invalidateQueries({ queryKey: queryKeys.features.details(featureId) });
      qc.invalidateQueries({ queryKey: queryKeys.features.progress(featureId) });
    },
  });
}

export function useAgents() {
  return useQuery({
    queryKey: queryKeys.agents.list(),
    queryFn: () => api.agents.list(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useAgent(agentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.detail(agentId ?? ''),
    queryFn: () => api.agents.get(agentId!),
    enabled: !!agentId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useDashboardStats() {
  return useQuery({
    queryKey: queryKeys.dashboard.stats(),
    queryFn: () => api.dashboard.get(),
    staleTime: 2 * 60 * 1000,
  });
}

export function useBoardPredictions(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.boards.predictions(boardId ?? ''),
    queryFn: () => api.boards.predictions(boardId!),
    enabled: !!boardId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useBoardBurndown(boardId: string | undefined, days?: number) {
  return useQuery({
    queryKey: [...queryKeys.boards.burndown(boardId ?? ''), days] as const,
    queryFn: () => api.boards.burndown(boardId!, days),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoardAnomalies(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.boards.anomalies(boardId ?? ''),
    queryFn: () => api.boards.anomalies(boardId!),
    enabled: !!boardId,
    staleTime: 60 * 1000,
  });
}

export function useBoardCapacity(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.boards.capacity(boardId ?? ''),
    queryFn: () => api.boards.capacity(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoardTimeMetrics(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.boards.metrics(boardId ?? ''),
    queryFn: () => api.timeTracking.getBoardMetrics(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAgentStats(agentId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.stats(agentId ?? ''),
    queryFn: () => api.agents.stats(agentId!),
    enabled: !!agentId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useAgentsListWithTasks(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.agents.listWithTasks(),
    queryFn: () => api.agents.listWithTasks(),
    enabled: !!boardId,
    staleTime: 30 * 1000,
  });
}

export function useOrganizations() {
  return useQuery({
    queryKey: queryKeys.organizations.list(),
    queryFn: () => api.organizations.list(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useOrganizationTeams(orgId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.organizations.teams(orgId ?? ''),
    queryFn: () => api.organizations.listTeams(orgId!),
    enabled: !!orgId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useTeamMembers(teamId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.organizations.members(teamId ?? ''),
    queryFn: () => api.teams.listMembers(teamId!),
    enabled: !!teamId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useUserProfile() {
  return useQuery({
    queryKey: queryKeys.user.profile(),
    queryFn: () => api.auth.me(),
    staleTime: 5 * 60 * 1000,
  });
}

export function useSavedFilters(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.savedFilters.list(boardId ?? ''),
    queryFn: () => api.savedFilters.list(boardId!).then((r: unknown) => r as Array<{ id: string; boardId: string; userId: string; name: string; filterConfig: Record<string, unknown>; isBuiltin: boolean; createdAt: string }>),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useBoardHealth(boardId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.health.current(boardId ?? ''),
    queryFn: () => api.health.get(boardId!),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useAuditSummary(boardId: string | undefined, params?: { since?: string; until?: string }) {
  return useQuery({
    queryKey: [...queryKeys.audit.summary(boardId ?? ''), params] as const,
    queryFn: () => api.audit.summary(boardId!, params),
    enabled: !!boardId,
    staleTime: 5 * 60 * 1000,
  });
}

export function useFeatureComments(featureId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.featureComments.list(featureId ?? ''),
    queryFn: () => api.featureComments.list(featureId!),
    enabled: !!featureId,
    staleTime: 30 * 1000,
  });
}

export function useInvalidateBoard(boardId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.boards.detail(boardId) });
    qc.invalidateQueries({ queryKey: queryKeys.boards.stats(boardId) });
    qc.invalidateQueries({ queryKey: queryKeys.boards.events(boardId) });
    qc.invalidateQueries({ queryKey: queryKeys.features.list(boardId) });
  };
}

export function useInvalidateBoards() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.boards.list() });
  };
}

export function useInvalidateAgents() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.agents.list() });
  };
}

export function useInvalidateFeature(featureId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.features.detail(featureId) });
    qc.invalidateQueries({ queryKey: queryKeys.features.details(featureId) });
    qc.invalidateQueries({ queryKey: queryKeys.features.tasks(featureId) });
    qc.invalidateQueries({ queryKey: queryKeys.features.progress(featureId) });
  };
}
