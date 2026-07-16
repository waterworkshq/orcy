import { request } from "../transport.js";

export const auditApi = {
  export: (habitatId: string, params: Record<string, string>) => {
    const qs = new URLSearchParams(params).toString();
    return request<string>(`/habitats/${habitatId}/audit/export?${qs}`);
  },
  summary: (habitatId: string, params?: { since?: string; until?: string }) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{
      totalEvents: number;
      byAction: Record<string, number>;
      byActorType: Record<string, number>;
      byDay: { date: string; count: number }[];
      topFeatures: { featureId: string; featureTitle: string; count: number }[];
    }>(`/habitats/${habitatId}/audit/summary${qs}`);
  },
  schedules: {
    list: (habitatId: string) =>
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
      }>(`/habitats/${habitatId}/audit/schedules`),
    create: (
      habitatId: string,
      data: { name: string; format: string; filters?: Record<string, unknown>; schedule: string },
    ) =>
      request<{ schedule: unknown }>(`/habitats/${habitatId}/audit/schedule`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    delete: (scheduleId: string) =>
      request<void>(`/audit/schedules/${scheduleId}`, { method: "DELETE" }),
  },
};
