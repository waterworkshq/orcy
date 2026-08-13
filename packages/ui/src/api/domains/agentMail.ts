import { request } from "../transport.js";

export interface HabitatAgentMail {
  id: string;
  habitatId: string;
  fromAgentId: string;
  toAgentId: string;
  taskId: string | null;
  subject: string;
  body: string;
  messageType: "info" | "request" | "response" | "alert";
  priority: "low" | "normal" | "high" | "urgent";
  readAt: string | null;
  createdAt: string;
}

export const agentMailApi = {
  listByHabitat: (habitatId: string, params?: { limit?: number; offset?: number }) => {
    const search = new URLSearchParams();
    if (params?.limit != null) search.set("limit", String(params.limit));
    if (params?.offset != null) search.set("offset", String(params.offset));
    const qs = search.toString() ? `?${search.toString()}` : "";
    return request<{ messages: HabitatAgentMail[]; total: number }>(
      `/habitats/${habitatId}/agent-messages${qs}`,
    );
  },
};
