import { request } from "../transport.js";
import type { ProjectInsight } from "../../types/index.js";

export const insightsApi = {
  list: (boardId: string, params?: Record<string, string | number>) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{ items: ProjectInsight[]; total: number }>(
      `/habitats/${boardId}/insights${qs}`,
    );
  },
  promote: (
    boardId: string,
    body: { sourcePulseId: string; relevanceTags?: string[]; subject?: string; body?: string },
  ) =>
    request<{ insight: ProjectInsight }>(`/habitats/${boardId}/insights`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deactivate: (boardId: string, id: string) =>
    request<{ success: boolean }>(`/habitats/${boardId}/insights/${id}`, { method: "DELETE" }),
};
