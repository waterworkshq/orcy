import { request } from "../transport.js";

export const auditApi = {
  export: (boardId: string, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<string>(`/habitats/${boardId}/audit/export?${qs}`);
  },
  summary: (boardId: string, params?: { since?: string; until?: string }) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{
      totalEvents: number;
      byAction: Record<string, number>;
      byActorType: Record<string, number>;
      byDay: { date: string; count: number }[];
      topFeatures: { featureId: string; featureTitle: string; count: number }[];
    }>(`/habitats/${boardId}/audit/summary${qs}`);
  },
  schedules: {
    list: (boardId: string) =>
      request<{
        schedules: Array<{
          id: string;
          name: string;
          format: string;
          schedule: string;
          enabled: boolean;
          lastRunAt: string | null;
          nextRunAt: string;
        }>;
      }>(`/habitats/${boardId}/audit/schedules`),
    create: (
      boardId: string,
      data: { name: string; format: string; filters?: Record<string, unknown>; schedule: string },
    ) =>
      request<{ schedule: unknown }>(`/habitats/${boardId}/audit/schedule`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    delete: (scheduleId: string) =>
      request<void>(`/audit/schedules/${scheduleId}`, { method: "DELETE" }),
  },
};
