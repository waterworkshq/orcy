import { request } from "../transport.js";
import type { Pulse, PulseDigest, PostPulseInput, PulseReactionCounts } from "../../types/index.js";

export const pulseApi = {
  listByMission: (missionId: string, params?: Record<string, string | number>) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{ items: Pulse[]; total: number }>(`/missions/${missionId}/pulse${qs}`);
  },
  listByBoard: (boardId: string, params?: Record<string, string | number>) => {
    const qs = params ? "?" + new URLSearchParams(params as Record<string, string>).toString() : "";
    return request<{ items: Pulse[]; total: number }>(`/habitats/${boardId}/pulse${qs}`);
  },
  post: (missionId: string, body: PostPulseInput) =>
    request<{ pulse: Pulse }>(`/missions/${missionId}/pulse`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  postHabitat: (boardId: string, body: PostPulseInput) =>
    request<{ pulse: Pulse }>(`/habitats/${boardId}/pulse`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  digest: (missionId: string) => request<PulseDigest>(`/missions/${missionId}/pulse/digest`),
  habitatDigest: (boardId: string) => request<PulseDigest>(`/habitats/${boardId}/pulse/digest`),
  delete: (id: string) => request<void>(`/pulse/${id}`, { method: "DELETE" }),
  replies: (id: string) => request<{ items: Pulse[] }>(`/pulse/${id}/replies`),
  react: (id: string, reaction: string) =>
    request<{ added: boolean; counts: PulseReactionCounts }>(`/pulse/${id}/react`, {
      method: "POST",
      body: JSON.stringify({ reaction }),
    }),
};
