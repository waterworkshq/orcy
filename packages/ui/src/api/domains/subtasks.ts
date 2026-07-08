import { request } from "../transport.js";
import type { Subtask } from "../../types/index.js";

export const subtasksApi = {
  list: (taskId: string) =>
    request<{ subtasks: Subtask[]; total: number; completedCount: number }>(
      `/tasks/${taskId}/subtasks`,
    ),
  create: (taskId: string, data: { title: string; order?: number; assigneeId?: string }) =>
    request<{ subtask: Subtask }>(`/tasks/${taskId}/subtasks`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    taskId: string,
    subtaskId: string,
    data: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null },
  ) =>
    request<{ subtask: Subtask }>(`/tasks/${taskId}/subtasks/${subtaskId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (taskId: string, subtaskId: string) =>
    request<void>(`/tasks/${taskId}/subtasks/${subtaskId}`, { method: "DELETE" }),
};
