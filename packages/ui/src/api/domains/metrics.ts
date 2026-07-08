import { request } from "../transport.js";
import type { ExperienceMetricsResult, WorkflowMetricsResult } from "../../types/index.js";

export const metricsApi = {
  experience: (habitatId: string, days = 30) =>
    request<ExperienceMetricsResult>(`/habitats/${habitatId}/experience-metrics?days=${days}`),
  workflow: (habitatId: string, days = 30) =>
    request<WorkflowMetricsResult>(`/habitats/${habitatId}/workflow-metrics?days=${days}`),
};
