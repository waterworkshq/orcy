import { request } from "../transport.js";
import type { TaskBlockedStatus } from "../../types/index.js";

export const dependenciesApi = {
  addTaskDependency: (taskId: string, dependsOnTaskId: string) =>
    request<{ success: boolean }>(`/tasks/${taskId}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ dependsOnTaskId }),
    }),
  removeTaskDependency: (taskId: string, depId: string) =>
    request<{ success: boolean }>(`/tasks/${taskId}/dependencies/${depId}`, { method: "DELETE" }),
  getTaskDependencies: (taskId: string) =>
    request<{
      dependsOn: { taskId: string; taskTitle: string; status: string }[];
      blocking: { taskId: string; taskTitle: string; status: string }[];
    }>(`/tasks/${taskId}/dependencies`),
  getBlockedStatus: (taskId: string) =>
    request<TaskBlockedStatus>(`/tasks/${taskId}/blocked-status`),
  addMissionDependency: (missionId: string, dependsOnMissionId: string) =>
    request<{ success: boolean }>(`/missions/${missionId}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ dependsOnMissionId }),
    }),
  removeMissionDependency: (missionId: string, depId: string) =>
    request<{ success: boolean }>(`/missions/${missionId}/dependencies/${depId}`, {
      method: "DELETE",
    }),
};
