import { request } from "../transport.js";
import type {
  Mission,
  MissionWithProgress,
  MissionEvent,
  Task,
  CreateMissionInput,
  CreateTaskInMissionInput,
  MoveMissionInput,
  DecompositionResult,
} from "../../types/index.js";

export const missionsApi = {
  list: (
    boardId: string,
    filters?: {
      status?: string;
      priority?: string;
      limit?: number;
      offset?: number;
      isArchived?: boolean;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.priority) params.set("priority", filters.priority);
    if (filters?.isArchived !== undefined) params.set("isArchived", String(filters.isArchived));
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return request<{ features: MissionWithProgress[]; total: number }>(
      `/habitats/${boardId}/missions${qs ? `?${qs}` : ""}`,
    );
  },
  get: (id: string) => request<{ feature: MissionWithProgress }>(`/missions/${id}`),
  details: (id: string) =>
    request<{
      feature: MissionWithProgress;
      tasks: Task[];
      events: MissionEvent[];
      progress: {
        completed: number;
        total: number;
        percentage: number;
        byStatus: Record<string, number>;
      };
      dependencies: { dependsOn: string[]; blocks: string[] };
    }>(`/missions/${id}/details`),
  create: (boardId: string, data: CreateMissionInput) =>
    request<{ feature: Mission }>(`/habitats/${boardId}/missions`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<Mission> & { version?: number }) =>
    request<{ feature: Mission }>(`/missions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/missions/${id}`, { method: "DELETE" }),
  archive: (id: string) =>
    request<{ feature: Mission }>(`/missions/${id}/archive`, { method: "POST" }),
  unarchive: (id: string) =>
    request<{ feature: Mission }>(`/missions/${id}/unarchive`, { method: "POST" }),
  move: (id: string, data: MoveMissionInput) =>
    request<{ feature: Mission }>(`/missions/${id}/move`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  tasks: (featureId: string) =>
    request<{ tasks: Task[]; total: number }>(`/missions/${featureId}/tasks`),
  createTask: (featureId: string, data: CreateTaskInMissionInput) =>
    request<{ task: Task }>(`/missions/${featureId}/tasks`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  progress: (featureId: string) =>
    request<{
      completed: number;
      total: number;
      percentage: number;
      byStatus: Record<string, number>;
    }>(`/missions/${featureId}/progress`),
  decompose: (featureId: string) =>
    request<DecompositionResult>(`/missions/${featureId}/decompose`, {
      method: "POST",
    }),
};
