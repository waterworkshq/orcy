import { request } from "../transport.js";
import type { ChatIntegration } from "../../types/index.js";

export const chatIntegrationsApi = {
  list: (habitatId: string) => request<ChatIntegration[]>(`/habitats/${habitatId}/chat-integrations`),
  create: (
    habitatId: string,
    data: {
      provider: "slack" | "discord";
      webhookUrl: string;
      channelId?: string;
      botToken?: string;
      events?: string[];
    },
  ) =>
    request<ChatIntegration>(`/habitats/${habitatId}/chat-integrations`, {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      webhookUrl?: string;
      channelId?: string;
      botToken?: string;
      enabled?: boolean;
      events?: string[];
    },
  ) =>
    request<ChatIntegration>(`/chat-integrations/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  delete: (id: string) =>
    request<{ success: boolean }>(`/chat-integrations/${id}`, { method: "DELETE" }),
  test: (id: string) =>
    request<{ success: boolean; statusCode: number; latencyMs: number }>(
      `/chat-integrations/${id}/test`,
      {
        method: "POST",
      },
    ),
};
