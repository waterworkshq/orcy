import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/index.js';
import { queryKeys } from './queryKeys.js';
import type { Task, Subtask, PullRequest, PipelineEvent, TaskEvent, TaskComment, TaskAttachment, TaskWatcher, CrossBoardDependency, FeatureStatus } from '../types/index.js';

export interface SiblingTaskData {
  id: string;
  title: string;
  status: string;
  result: string | null;
}

export interface FeatureContextData {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string;
  priority: string;
  status: FeatureStatus;
}

export interface TaskDetailsData {
  task: Task;
  feature: FeatureContextData | null;
  siblingTasks: SiblingTaskData[];
  subtasks: Subtask[];
  pullRequests: PullRequest[];
  pipelineEvents: PipelineEvent[];
  events: TaskEvent[];
  comments: TaskComment[];
  totalComments: number;
  attachments: TaskAttachment[];
  watchers: TaskWatcher[];
  isWatching: boolean;
  dependencies: Task[];
  crossBoardDependsOn: CrossBoardDependency[];
  blockedBy: Task[];
  blocking: Task[];
  boardContext: { name: string; columns: { name: string; featureCount: number }[] };
}

export function useTaskDetails(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.details(taskId ?? ''),
    queryFn: () => api.tasks.details(taskId!),
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });
}

export function useTaskContext(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.detail(taskId ?? ''),
    queryFn: () => api.tasks.get(taskId!),
    enabled: !!taskId,
    staleTime: 2 * 60 * 1000,
  });
}

export function useTaskEvents(taskId: string | undefined, limit = 50) {
  return useQuery({
    queryKey: [...queryKeys.tasks.events(taskId ?? ''), { limit }] as const,
    queryFn: () => api.tasks.events(taskId!, { limit }),
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });
}

export function useTaskWatchers(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.watchers(taskId ?? ''),
    queryFn: () => api.tasks.watchers(taskId!),
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });
}

export function useSubtasks(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.subtasks(taskId ?? ''),
    queryFn: () => api.subtasks.list(taskId!),
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });
}

export function useTaskPullRequests(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.pullRequests(taskId ?? ''),
    queryFn: () => api.tasks.pullRequests(taskId!),
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });
}

export function useTaskPipelineEvents(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.tasks.pipelineEvents(taskId ?? ''),
    queryFn: () => api.tasks.pipelineEvents(taskId!),
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });
}

export function useTaskComments(taskId: string | undefined, limit = 100) {
  return useQuery({
    queryKey: queryKeys.tasks.comments(taskId ?? ''),
    queryFn: () => api.comments.list(taskId!, { limit }),
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });
}

export function useAttachments(taskId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.attachments.list(taskId ?? ''),
    queryFn: () => api.attachments.list(taskId!),
    enabled: !!taskId,
    staleTime: 30 * 1000,
  });
}

export function useInvalidateTask(taskId: string) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.tasks.watchers(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.tasks.subtasks(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.tasks.pullRequests(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.tasks.pipelineEvents(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) });
    qc.invalidateQueries({ queryKey: queryKeys.attachments.list(taskId) });
  };
}

export function usePrefetchTask(taskId: string | undefined) {
  const qc = useQueryClient();
  if (taskId) {
    qc.prefetchQuery({
      queryKey: queryKeys.tasks.detail(taskId),
      queryFn: () => api.tasks.get(taskId),
      staleTime: 2 * 60 * 1000,
    });
  }
}
