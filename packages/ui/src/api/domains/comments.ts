import { request } from "../transport.js";
import type { TaskComment } from "../../types/index.js";

export const commentsApi = {
  list: (taskId: string, filters?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return request<{ comments: TaskComment[]; total: number }>(
      `/tasks/${taskId}/comments${qs ? `?${qs}` : ""}`,
    );
  },
  create: (taskId: string, data: { content: string; parentId?: string }) =>
    request<{ comment: TaskComment }>(`/tasks/${taskId}/comments`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (taskId: string, commentId: string, data: { content: string }) =>
    request<{ comment: TaskComment }>(`/tasks/${taskId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (taskId: string, commentId: string) =>
    request<void>(`/tasks/${taskId}/comments/${commentId}`, { method: "DELETE" }),
};
