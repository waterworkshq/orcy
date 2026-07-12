import { request } from "../transport.js";
import type { Agent } from "../../types/index.js";

export const agentsApi = {
  list: () => request<{ agents: Agent[] }>("/agents").then((r) => r.agents),
  listWithTasks: () =>
    request<{ agents: { agent: Agent; currentTaskTitle: string | null }[] }>(
      "/agents?include=currentTask",
    ).then((r) => r.agents),
  get: (id: string) =>
    request<{ agent: Agent }>(`/agents/${id}`).then((r) => r.agent),
  create: (data: {
    name: string;
    type: "claude-code" | "codex" | "opencode" | "cursor" | "gemini";
    domain: string;
    capabilities?: string[];
  }) =>
    request<{ agent: Agent; apiKey: string }>("/agents", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  heartbeat: (id: string, data?: { taskId?: string; progress?: string }) =>
    request<{ status: string; nextCheckIn: number }>(`/agents/${id}/heartbeat`, {
      method: "POST",
      body: JSON.stringify(data ?? {}),
    }),
  delete: (id: string) => request<void>(`/agents/${id}`, { method: "DELETE" }),
  stats: (id: string) => request<import("../../types/index.js").AgentStats>(`/agents/${id}/stats`),
  allStats: () => request<import("../../types/index.js").AllAgentStats>("/agents/stats"),
};
