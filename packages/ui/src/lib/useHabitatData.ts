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
