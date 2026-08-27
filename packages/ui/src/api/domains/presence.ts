import { request } from "../transport.js";
import type { PresenceEntry } from "../../types/index.js";

export const presenceApi = {
  // The server derives viewer identity from the authenticated user; the join
  // body carries only the session and Habitat identifiers.
  join: (data: { sessionId: string; habitatId: string }) =>
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
