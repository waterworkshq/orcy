import { request } from "../transport.js";
import type { PresenceEntry } from "../../types/index.js";

export const presenceApi = {
  join: (data: {
    sessionId: string;
    type: "human" | "agent";
    habitatId: string;
    userId?: string;
    userName?: string;
    agentId?: string;
    agentName?: string;
  }) =>
    request<{ success: boolean }>(`/sse/presence/join`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  heartbeat: (data: { sessionId: string; habitatId: string; viewingTaskId?: string | null }) =>
    request<{ success: boolean }>(`/sse/presence/heartbeat`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  leave: (data: { sessionId: string; habitatId: string }) =>
    request<{ success: boolean }>(`/sse/presence/leave`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  getViewers: (habitatId: string) =>
    request<{ viewers: PresenceEntry[] }>(`/sse/presence/viewers/${habitatId}`),
};
