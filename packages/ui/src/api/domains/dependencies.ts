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
  addFeatureDependency: (featureId: string, dependsOnFeatureId: string) =>
    request<{ success: boolean }>(`/missions/${featureId}/dependencies`, {
      method: "POST",
      body: JSON.stringify({ dependsOnFeatureId }),
    }),
  removeFeatureDependency: (featureId: string, depId: string) =>
    request<{ success: boolean }>(`/missions/${featureId}/dependencies/${depId}`, {
      method: "DELETE",
    }),
};
