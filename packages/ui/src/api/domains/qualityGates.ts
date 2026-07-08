import { request } from "../transport.js";
import type { TaskQualityReport, ApprovalStatus } from "../../types/index.js";

export const qualityGatesApi = {
  getReport: (taskId: string) => request<TaskQualityReport>(`/tasks/${taskId}/quality-checklist`),
  updateItem: (
    taskId: string,
    checklistId: string,
    itemId: string,
    data: { isCompleted?: boolean; evidenceUrl?: string; notes?: string },
  ) =>
    request<TaskQualityReport["checklists"][0]["items"][0]>(
      `/tasks/${taskId}/quality-checklist/${checklistId}/items/${itemId}`,
      {
        method: "PUT",
        body: JSON.stringify(data),
      },
    ),
  validate: (taskId: string) =>
    request<{ passed: boolean; failures: { category: string; missingItems: string[] }[] }>(
      `/tasks/${taskId}/quality-checklist/validate`,
      {
        method: "POST",
      },
    ),
  getApprovalStatus: (taskId: string) =>
    request<ApprovalStatus>(`/tasks/${taskId}/approval-status`),
  listTemplates: () =>
    request<{ templates: { id: string; name: string; category: string; isRequired: boolean }[] }>(
      "/quality/templates",
    ).then((r) => r.templates),
};
