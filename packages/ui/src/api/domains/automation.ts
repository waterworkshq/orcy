import { request } from "../transport.js";

export const automationApi = {
  listRules: (habitatId: string) => request<unknown>(`/habitats/${habitatId}/automation-rules`),
  createRule: (habitatId: string, body: unknown) =>
    request<unknown>(`/habitats/${habitatId}/automation-rules`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  getRule: (ruleId: string) => request<unknown>(`/automation-rules/${ruleId}`),
  updateRule: (ruleId: string, body: unknown) =>
    request<unknown>(`/automation-rules/${ruleId}`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  deleteRule: (ruleId: string) =>
    request<{ deleted: boolean }>(`/automation-rules/${ruleId}`, { method: "DELETE" }),
  enable: (ruleId: string) =>
    request<unknown>(`/automation-rules/${ruleId}/enable`, { method: "POST" }),
  disable: (ruleId: string) =>
    request<unknown>(`/automation-rules/${ruleId}/disable`, { method: "POST" }),
  simulate: (ruleId: string, body: unknown) =>
    request<unknown>(`/automation-rules/${ruleId}/simulate`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  run: (ruleId: string) => request<unknown>(`/automation-rules/${ruleId}/run`, { method: "POST" }),
  listRuns: (ruleId: string, options?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return request<{ runs: unknown[]; total: number }>(
      `/automation-rules/${ruleId}/runs${qs ? `?${qs}` : ""}`,
    );
  },
  listHabitatRuns: (habitatId: string, options?: { limit?: number; offset?: number }) => {
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const qs = params.toString();
    return request<{ runs: unknown[]; total: number }>(
      `/habitats/${habitatId}/automation-runs${qs ? `?${qs}` : ""}`,
    );
  },
};
