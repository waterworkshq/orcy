import { request } from "../transport.js";
import type { Task, TaskTimeReport, HabitatTimeMetrics } from "../../types/index.js";

export const timeTrackingApi = {
  getTaskReport: (taskId: string) => request<TaskTimeReport>(`/tasks/${taskId}/time-report`),
  getBoardMetrics: (habitatId: string) => request<HabitatTimeMetrics>(`/habitats/${habitatId}/metrics`),
  updateEstimate: (taskId: string, estimatedMinutes: number) =>
    request<{ task: Task }>(`/tasks/${taskId}/estimate`, {
      method: "PUT",
      body: JSON.stringify({ estimatedMinutes }),
    }).then((r) => r.task),
};
