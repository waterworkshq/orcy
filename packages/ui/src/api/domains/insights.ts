import { request } from "../transport.js";
import type { ProjectInsight } from "../../types/index.js";

export const insightsApi = {
  list: (habitatId: string, params?: Record<string, string | number>) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{ items: ProjectInsight[]; total: number }>(
      `/habitats/${habitatId}/insights${qs}`,
    );
  },
  promote: (
    habitatId: string,
    body: { sourcePulseId: string; relevanceTags?: string[]; subject?: string; body?: string },
  ) =>
    request<{ insight: ProjectInsight }>(`/habitats/${habitatId}/insights`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  deactivate: (habitatId: string, id: string) =>
    request<{ success: boolean }>(`/habitats/${habitatId}/insights/${id}`, { method: "DELETE" }),
};
