import { request } from "../transport.js";
import type { MissionComment } from "../../types/index.js";

export const missionCommentsApi = {
  list: (featureId: string, filters?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const qs = params.toString();
    return request<{ comments: MissionComment[]; total: number }>(
      `/missions/${featureId}/comments${qs ? `?${qs}` : ""}`,
    );
  },
  create: (featureId: string, data: { content: string; parentId?: string }) =>
    request<{ comment: MissionComment }>(`/missions/${featureId}/comments`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (featureId: string, commentId: string, data: { content: string }) =>
    request<{ comment: MissionComment }>(`/missions/${featureId}/comments/${commentId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (featureId: string, commentId: string) =>
    request<void>(`/missions/${featureId}/comments/${commentId}`, { method: "DELETE" }),
};
