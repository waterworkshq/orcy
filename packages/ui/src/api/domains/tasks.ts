import { request } from "../transport.js";
import type {
  Task,
  TaskContext,
  Subtask,
  MoveTaskInput,
  Artifact,
  TaskEvent,
  TaskComment,
  TaskAttachment,
  TaskWatcher,
  PullRequest,
  PipelineEvent,
  CrossHabitatDependency,
  DecompositionResult,
  BatchTaskRequest,
  BatchTaskResponse,
} from "../../types/index.js";
import type { TaskDetailsData } from "../../lib/useTaskData.js";

export const tasksApi = {
  get: (id: string) =>
    request<{
      task: Task;
      dependencies: Task[];
      blockedBy: Task[];
      blocking: Task[];
      habitatContext: TaskContext["habitatContext"];
    }>(`/tasks/${id}`),
  update: (id: string, data: Partial<Task> & { version?: number }) =>
    request<{ task: Task }>(`/tasks/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/tasks/${id}`, { method: "DELETE" }),
  clone: (id: string, data?: { includeSubtasks?: boolean; includeComments?: boolean }) =>
    request<{ task: Task }>(`/tasks/${id}/clone`, {
      method: "POST",
      body: JSON.stringify(data ?? {}),
    }),
  claim: (id: string, agentId?: string) =>
    request<{ task: Task }>(`/tasks/${id}/claim`, {
      method: "POST",
      body: JSON.stringify({ agentId }),
    }),
  start: (id: string) => request<{ task: Task }>(`/tasks/${id}/start`, { method: "POST" }),
  move: (id: string, data: MoveTaskInput) =>
    request<{ task: Task }>(`/tasks/${id}/move`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  submit: (id: string, data: { result: string; artifacts?: Artifact[] }) =>
    request<{ success: boolean; task: Partial<Task>; message: string }>(`/tasks/${id}/submit`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  approve: (id: string, reviewerId: string) =>
    request<{ task: Task }>(`/tasks/${id}/approve`, {
      method: "POST",
      body: JSON.stringify({ reviewerId }),
    }),
  reject: (id: string, reviewerId: string, reason: string) =>
    request<{ task: Task }>(`/tasks/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reviewerId, reason }),
    }),
  release: (id: string, reason: string) =>
    request<{ task: Task }>(`/tasks/${id}/release`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  fail: (id: string, reason: string) =>
    request<{ task: Task }>(`/tasks/${id}/fail`, {
      method: "POST",
      body: JSON.stringify({ reason }),
    }),
  retry: (id: string) =>
    request<{ task: Task }>(`/tasks/${id}/retry`, {
      method: "POST",
    }),
  delegate: (id: string, toAgentId: string, reason?: string) =>
    request<{ task: Task }>(`/tasks/${id}/delegate`, {
      method: "POST",
      body: JSON.stringify({ toAgentId, reason }),
    }),
  events: (id: string, filters?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return request<{ events: TaskEvent[]; total: number }>(
      `/tasks/${id}/events${qs ? `?${qs}` : ""}`,
    );
  },
  details: (id: string) => request<TaskDetailsData>(`/tasks/${id}/details`),
  decompose: (id: string) =>
    request<DecompositionResult>(`/tasks/${id}/decompose`, {
      method: "POST",
    }),
  watch: (taskId: string) =>
    request<{ watcher: TaskWatcher }>(`/tasks/${taskId}/watch`, {
      method: "POST",
    }),
  unwatch: (taskId: string) => request<void>(`/tasks/${taskId}/watch`, { method: "DELETE" }),
  watchers: (taskId: string) =>
    request<{ watchers: TaskWatcher[]; isWatching: boolean }>(`/tasks/${taskId}/watchers`),
  batch: (habitatId: string, data: BatchTaskRequest) =>
    request<BatchTaskResponse>(`/habitats/${habitatId}/tasks/batch`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  pullRequests: (taskId: string) =>
    request<{ pullRequests: import("../../types/index.js").PullRequest[] }>(
      `/tasks/${taskId}/pull-requests`,
    ),
  pipelineEvents: (taskId: string) =>
    request<{ pipelineEvents: import("../../types/index.js").PipelineEvent[] }>(
      `/tasks/${taskId}/pipeline-events`,
    ),
};
