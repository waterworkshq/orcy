import { request } from "../transport.js";
import type {
  Habitat,
  Task,
  MissionWithProgress,
  EnrichedHabitatEvent,
  Anomaly,
  AnomalySettings,
  AutoAssignSettings,
  AutomationSettings,
  PrioritizationSettings,
  TriageSettings,
  RoadmapSettings,
  CapacityReport,
  PredictionResponse,
  BurndownResponse,
  CumulativeFlowResponse,
  BottleneckResponse,
  AgentQualityResponse,
} from "../../types/index.js";

export const habitatsApi = {
  list: () => request<{ boards: Habitat[] }>("/habitats").then((r) => r.boards),
  get: (id: string) =>
    request<{ board: Habitat; columns: Habitat["columns"]; features: MissionWithProgress[] }>(
      `/habitats/${id}`,
    ),
  create: (data: { name: string; description?: string; teamId?: string | null }) =>
    request<{ board: Habitat; columns: Habitat["columns"] }>("/habitats", {
      method: "POST",
      body: JSON.stringify(data),
    }),
  update: (
    id: string,
    data: {
      name?: string;
      description?: string;
      retrySettings?: import("../../types/index.js").RetryPolicy | null;
      anomalySettings?: AnomalySettings | null;
      autoAssignSettings?: AutoAssignSettings | null;
      automationSettings?: AutomationSettings | null;
      prioritizationSettings?: PrioritizationSettings | null;
      gitWorktreeSettings?: import("../../types/index.js").GitWorktreeSettings | null;
      triageSettings?: TriageSettings | null;
      roadmapSettings?: RoadmapSettings | null;
    },
  ) =>
    request<{ board: Habitat }>(`/habitats/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/habitats/${id}`, { method: "DELETE" }),
  stats: (id: string) =>
    request<import("../../types/index.js").HabitatStats>(`/habitats/${id}/stats`),
  events: (
    boardId: string,
    filters?: {
      limit?: number;
      offset?: number;
      action?: string;
      actorType?: string;
      actorId?: string;
      since?: string;
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    if (filters?.action) params.set("action", filters.action);
    if (filters?.actorType) params.set("actorType", filters.actorType);
    if (filters?.actorId) params.set("actorId", filters.actorId);
    if (filters?.since) params.set("since", filters.since);
    const qs = params.toString();
    return request<{ events: EnrichedHabitatEvent[]; total: number }>(
      `/habitats/${boardId}/events${qs ? `?${qs}` : ""}`,
    );
  },
  export: (boardId: string, params?: { include?: string; format?: string }) => {
    const queryParams = new URLSearchParams();
    if (params?.include) queryParams.set("include", params.include);
    if (params?.format) queryParams.set("format", params.format);
    const qs = queryParams.toString();
    return request<import("../../types/index.js").HabitatExport>(
      `/habitats/${boardId}/export${qs ? `?${qs}` : ""}`,
    );
  },
  import: (data: import("../../types/index.js").HabitatExport) =>
    request<{
      board: Habitat;
      columns: Habitat["columns"];
      imported: { tasks: number; comments: number; templates: number; webhooks: number };
      warnings: string[];
    }>("/boards/import", { method: "POST", body: JSON.stringify(data) }),
  importInto: (boardId: string, data: import("../../types/index.js").HabitatExport) =>
    request<{
      board: Habitat;
      columns: Habitat["columns"];
      imported: { tasks: number; comments: number; templates: number; webhooks: number };
      warnings: string[];
    }>(`/habitats/${boardId}/import`, { method: "POST", body: JSON.stringify(data) }),
  anomalies: (boardId: string) =>
    request<{ anomalies: Anomaly[] }>(`/habitats/${boardId}/anomalies`),
  getPrioritizationRules: (boardId: string) =>
    request<{ rules: PrioritizationSettings }>(`/habitats/${boardId}/rules`),
  updatePrioritizationRules: (
    boardId: string,
    data: {
      enabled?: boolean;
      rules?: PrioritizationSettings["rules"];
      evaluateIntervalMinutes?: number;
      fallbackToManual?: boolean;
    },
  ) =>
    request<{ rules: PrioritizationSettings }>(`/habitats/${boardId}/rules`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  evaluatePrioritizationRules: (boardId: string) =>
    request<{ results: unknown }>(`/habitats/${boardId}/rules/evaluate`, { method: "POST" }),
  capacity: (boardId: string) => request<CapacityReport>(`/habitats/${boardId}/capacity`),
  predictions: (boardId: string) => request<PredictionResponse>(`/habitats/${boardId}/predictions`),
  burndown: (boardId: string, days?: number) =>
    request<BurndownResponse>(`/habitats/${boardId}/burndown?days=${days ?? 30}`),
  cumulativeFlow: (boardId: string, days?: number) =>
    request<CumulativeFlowResponse>(`/habitats/${boardId}/cumulative-flow?days=${days ?? 30}`),
  bottlenecks: (boardId: string, days?: number) =>
    request<BottleneckResponse>(`/habitats/${boardId}/bottlenecks?days=${days ?? 30}`),
  agentQuality: (boardId: string) =>
    request<AgentQualityResponse>(`/habitats/${boardId}/agent-quality`),
  tasks: (
    boardId: string,
    filters?: {
      status?: string;
      priority?: string;
      search?: string;
      assignedAgentId?: string;
      isArchived?: boolean;
      hasUnmetWorkflowGates?: boolean;
      limit?: number;
      offset?: number;
      sortBy?: string;
      sortDir?: "asc" | "desc";
    },
  ) => {
    const params = new URLSearchParams();
    if (filters?.status) params.set("status", filters.status);
    if (filters?.priority) params.set("priority", filters.priority);
    if (filters?.search) params.set("search", filters.search);
    if (filters?.assignedAgentId) params.set("assignedAgentId", filters.assignedAgentId);
    if (filters?.isArchived !== undefined) params.set("isArchived", String(filters.isArchived));
    if (filters?.hasUnmetWorkflowGates !== undefined)
      params.set("hasUnmetWorkflowGates", String(filters.hasUnmetWorkflowGates));
    if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
    if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
    if (filters?.sortBy) params.set("sortBy", filters.sortBy);
    if (filters?.sortDir) params.set("sortDir", filters.sortDir);
    const qs = params.toString();
    return request<{ tasks: Task[]; total: number }>(
      `/habitats/${boardId}/tasks${qs ? `?${qs}` : ""}`,
    );
  },
};
