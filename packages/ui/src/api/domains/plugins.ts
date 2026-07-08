import { request } from "../transport.js";

export const pluginsApi = {
  listEnrollments: (habitatId: string) =>
    request<{ enrollments: unknown[] }>(`/habitats/${habitatId}/plugins/enrollments`),
  createEnrollment: (
    habitatId: string,
    data: {
      pluginId: string;
      contributionId: string;
      config?: Record<string, unknown>;
    },
  ) =>
    request<{ enrollment: unknown }>(`/habitats/${habitatId}/plugins/enrollments`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  updateEnrollment: (
    habitatId: string,
    enrollmentId: string,
    data: { enabled?: boolean; config?: Record<string, unknown> },
  ) =>
    request<{ enrollment: unknown }>(`/habitats/${habitatId}/plugins/enrollments/${enrollmentId}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  deleteEnrollment: (habitatId: string, enrollmentId: string) =>
    request<{ success: boolean }>(`/habitats/${habitatId}/plugins/enrollments/${enrollmentId}`, {
      method: "DELETE",
    }),
  listRuns: (
    habitatId: string,
    filter?: { pluginId?: string; status?: string; limit?: number },
  ) => {
    const params = new URLSearchParams();
    if (filter?.pluginId) params.set("pluginId", filter.pluginId);
    if (filter?.status) params.set("status", filter.status);
    if (filter?.limit) params.set("limit", String(filter.limit));
    const qs = params.toString() ? `?${params}` : "";
    return request<{ runs: unknown[]; total: number }>(`/habitats/${habitatId}/plugins/runs${qs}`);
  },
  listLoaded: () => request<{ plugins: unknown[] }>(`/plugins`),
};
