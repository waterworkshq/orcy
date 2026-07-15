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
    habitatId: string,
    filters?: {
      status?: string;
      priority?: string;
      limit?: number;
      offset?: number;
      isArchived?: boolean;
    },
    signal?: AbortSignal,
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.priority) params.set("priority", filters.priority);
    if (filters?.isArchived !== undefined) params.set("isArchived", String(filters.isArchived));
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return request<{ missions: MissionWithProgress[]; total: number }>(
      `/habitats/${habitatId}/missions${qs ? `?${qs}` : ""}`,
      { signal },
    );
  },
  get: (id: string, signal?: AbortSignal) =>
    request<{ mission: MissionWithProgress }>(`/missions/${id}`, { signal }),
  details: (id: string, signal?: AbortSignal) =>
    request<{
      mission: MissionWithProgress;
      tasks: Task[];
      events: MissionEvent[];
      progress: {
        completed: number;
        total: number;
        percentage: number;
        byStatus: Record<string, number>;
      };
      dependencies: { dependsOn: string[]; blocks: string[] };
    }>(`/missions/${id}/details`, { signal }),
  create: (habitatId: string, data: CreateMissionInput) =>
    request<{ mission: Mission }>(`/habitats/${habitatId}/missions`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (id: string, data: Partial<Mission> & { version?: number }) =>
    request<{ mission: Mission }>(`/missions/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/missions/${id}`, { method: "DELETE" }),
  archive: (id: string) =>
    request<{ mission: Mission }>(`/missions/${id}/archive`, { method: "POST" }),
  unarchive: (id: string) =>
    request<{ mission: Mission }>(`/missions/${id}/unarchive`, { method: "POST" }),
  move: (id: string, data: MoveMissionInput, signal?: AbortSignal) =>
    request<{ mission: Mission }>(`/missions/${id}/move`, {
      method: "POST",
      body: JSON.stringify(data),
      signal,
    }),
  tasks: (missionId: string) =>
    request<{ tasks: Task[]; total: number }>(`/missions/${missionId}/tasks`),
  createTask: (missionId: string, data: CreateTaskInMissionInput) =>
    request<{ task: Task }>(`/missions/${missionId}/tasks`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  progress: (missionId: string) =>
    request<{
      completed: number;
      total: number;
      percentage: number;
      byStatus: Record<string, number>;
    }>(`/missions/${missionId}/progress`),
  decompose: (missionId: string) =>
    request<DecompositionResult>(`/missions/${missionId}/decompose`, {
      method: "POST",
    }),
};
