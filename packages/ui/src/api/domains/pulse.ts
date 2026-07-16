import { request } from "../transport.js";
import type { Pulse, PulseDigest, PostPulseInput, PulseReactionCounts } from "../../types/index.js";

export const pulseApi = {
  listByMission: (missionId: string, params?: Record<string, string | number>) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{ items: Pulse[]; total: number }>(`/missions/${missionId}/pulse${qs}`);
  },
  listByBoard: (habitatId: string, params?: Record<string, string | number>) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{ items: Pulse[]; total: number }>(`/habitats/${habitatId}/pulse${qs}`);
  },
  post: (missionId: string, body: PostPulseInput) =>
    request<{ pulse: Pulse }>(`/missions/${missionId}/pulse`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  postHabitat: (habitatId: string, body: PostPulseInput) =>
    request<{ pulse: Pulse }>(`/habitats/${habitatId}/pulse`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  digest: (missionId: string) => request<PulseDigest>(`/missions/${missionId}/pulse/digest`),
  habitatDigest: (habitatId: string) => request<PulseDigest>(`/habitats/${habitatId}/pulse/digest`),
  delete: (id: string) => request<void>(`/pulse/${id}`, { method: "DELETE" }),
  replies: (id: string) => request<{ items: Pulse[] }>(`/pulse/${id}/replies`),
  react: (id: string, reaction: string) =>
    request<{ added: boolean; counts: PulseReactionCounts }>(`/pulse/${id}/react`, {
      method: "POST",
      body: JSON.stringify({ reaction }),
    }),
};
