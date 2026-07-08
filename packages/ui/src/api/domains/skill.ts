import { request } from "../transport.js";
import type { HabitatSkill, SkillSignal } from "../../types/index.js";

export const skillApi = {
  get: (habitatId: string) =>
    request<{ skill: HabitatSkill | null }>(`/habitats/${habitatId}/skill`),
  refresh: (habitatId: string) =>
    request<{ skill: HabitatSkill }>(`/habitats/${habitatId}/skill/refresh`, { method: "POST" }),
  contribute: (habitatId: string, body: { insight: string; skillCategory?: string }) =>
    request<{ signal: SkillSignal }>(`/habitats/${habitatId}/skill/contribute`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  signals: (habitatId: string, params?: Record<string, string | number>) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{ signals: SkillSignal[]; total: number }>(
      `/habitats/${habitatId}/skill/signals${qs}`,
    );
  },
  deleteSignal: (habitatId: string, signalId: string) =>
    request<{ success: boolean }>(`/habitats/${habitatId}/skill/signals/${signalId}`, {
      method: "DELETE",
    }),
};
