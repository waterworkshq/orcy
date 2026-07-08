import { request } from "../transport.js";
import type {
  Sprint,
  SprintCreateInput,
  SprintMetricsV2,
  BurndownResponse,
  SprintCarryOverReport,
} from "../../types/index.js";

export const sprintsApi = {
  list: (habitatId: string) => request<{ sprints: Sprint[] }>(`/habitats/${habitatId}/sprints`),
  getActive: (habitatId: string) =>
    request<{ sprint: Sprint | null }>(`/habitats/${habitatId}/sprints/active`),
  create: (habitatId: string, body: SprintCreateInput) =>
    request<{ sprint: Sprint }>(`/habitats/${habitatId}/sprints`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  start: (sprintId: string) =>
    request<{ sprint: Sprint }>(`/sprints/${sprintId}/start`, { method: "POST" }),
  complete: (sprintId: string) =>
    request<{ sprint: Sprint }>(`/sprints/${sprintId}/complete`, { method: "POST" }),
  cancel: (sprintId: string) =>
    request<{ sprint: Sprint }>(`/sprints/${sprintId}/cancel`, { method: "POST" }),
  metrics: (sprintId: string) => request<SprintMetricsV2>(`/sprints/${sprintId}/metrics`),
  burndown: (sprintId: string) => request<BurndownResponse>(`/sprints/${sprintId}/burndown`),
  carryOver: (sprintId: string) =>
    request<SprintCarryOverReport>(`/sprints/${sprintId}/carry-over`),
  addMission: (sprintId: string, missionId: string) =>
    request<{ sprint: Sprint }>(`/sprints/${sprintId}/missions`, {
      method: "POST",
      body: JSON.stringify({ missionId }),
    }),
  removeMission: (sprintId: string, missionId: string) =>
    request<{ sprint: Sprint }>(`/sprints/${sprintId}/missions/${missionId}`, {
      method: "DELETE",
    }),
};
