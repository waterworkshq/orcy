import { request } from "../transport.js";
import type { MissionComment } from "../../types/index.js";

export const missionCommentsApi = {
  list: (missionId: string, filters?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return request<{ comments: MissionComment[]; total: number }>(
      `/missions/${missionId}/comments${qs ? `?${qs}` : ""}`,
    );
  },
  create: (missionId: string, data: { content: string; parentId?: string }) =>
    request<{ comment: MissionComment }>(`/missions/${missionId}/comments`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (missionId: string, commentId: string, data: { content: string }) =>
    request<{ comment: MissionComment }>(`/missions/${missionId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (missionId: string, commentId: string) =>
    request<void>(`/missions/${missionId}/comments/${commentId}`, { method: "DELETE" }),
};
