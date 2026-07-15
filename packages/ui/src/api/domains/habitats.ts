import { request } from "../transport.js";
import type {
  PublicHabitat,
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
  list: (signal?: AbortSignal) =>
    request<{ habitats: PublicHabitat[] }>("/habitats", { signal }).then((r) => r.habitats),
  get: (id: string, signal?: AbortSignal) =>
    request<{
      habitat: PublicHabitat;
      columns: PublicHabitat["columns"];
      missions: MissionWithProgress[];
    }>(`/habitats/${id}`, { signal }),
  create: (data: { name: string; description?: string; teamId?: string | null }) =>
    request<{ habitat: PublicHabitat; columns: NonNullable<PublicHabitat["columns"]> }>(
      "/habitats",
      {
        method: "POST",
        body: JSON.stringify(data),
      },
    ),
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
    request<{ habitat: PublicHabitat }>(`/habitats/${id}`, {
      method: "PATCH",
      body: JSON.stringify(data),
    }),
  delete: (id: string) => request<void>(`/habitats/${id}`, { method: "DELETE" }),
  stats: (id: string) =>
    request<import("../../types/index.js").HabitatStats>(`/habitats/${id}/stats`),
  events: (
    habitatId: string,
    filters?: {
      limit?: number;
      offset?: number;
      action?: string;
      actorType?: string;
      actorId?: string;
      since?: string;
    },
    signal?: AbortSignal,
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
      `/habitats/${habitatId}/events${qs ? `?${qs}` : ""}`,
      { signal },
    );
  },
  export: (habitatId: string, params?: { include?: string; format?: string }) => {
    const queryParams = new URLSearchParams();
    if (params?.include) queryParams.set("include", params.include);
    if (params?.format) queryParams.set("format", params.format);
    const qs = queryParams.toString();
    return request<import("../../types/index.js").HabitatExport>(
      `/habitats/${habitatId}/export${qs ? `?${qs}` : ""}`,
    );
  },
  import: (data: import("../../types/index.js").HabitatExport) =>
    request<{
      habitat: PublicHabitat;
      columns: NonNullable<PublicHabitat["columns"]>;
      imported: {
        missions: number;
        tasks: number;
        comments: number;
        templates: number;
        webhooks: number;
      };
      warnings: string[];
    }>("/habitats/import", { method: "POST", body: JSON.stringify(data) }),
  importInto: (habitatId: string, data: import("../../types/index.js").HabitatExport) =>
    request<{
      habitat: PublicHabitat;
      columns: NonNullable<PublicHabitat["columns"]>;
      imported: {
        missions: number;
        tasks: number;
        comments: number;
        templates: number;
        webhooks: number;
      };
      warnings: string[];
    }>(`/habitats/${habitatId}/import`, { method: "POST", body: JSON.stringify(data) }),
  anomalies: (habitatId: string) =>
    request<{ anomalies: Anomaly[] }>(`/habitats/${habitatId}/anomalies`),
  getPrioritizationRules: (habitatId: string) =>
    request<{ rules: PrioritizationSettings }>(`/habitats/${habitatId}/rules`),
  updatePrioritizationRules: (
    habitatId: string,
    data: {
      enabled?: boolean;
      rules?: PrioritizationSettings["rules"];
      evaluateIntervalMinutes?: number;
      fallbackToManual?: boolean;
    },
  ) =>
    request<{ rules: PrioritizationSettings }>(`/habitats/${habitatId}/rules`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),
  evaluatePrioritizationRules: (habitatId: string) =>
    request<{ results: unknown }>(`/habitats/${habitatId}/rules/evaluate`, { method: "POST" }),
  capacity: (habitatId: string) => request<CapacityReport>(`/habitats/${habitatId}/capacity`),
  predictions: (habitatId: string) =>
    request<PredictionResponse>(`/habitats/${habitatId}/predictions`),
  burndown: (habitatId: string, days?: number) =>
    request<BurndownResponse>(`/habitats/${habitatId}/burndown?days=${days ?? 30}`),
  cumulativeFlow: (habitatId: string, days?: number) =>
    request<CumulativeFlowResponse>(`/habitats/${habitatId}/cumulative-flow?days=${days ?? 30}`),
  bottlenecks: (habitatId: string, days?: number) =>
    request<BottleneckResponse>(`/habitats/${habitatId}/bottlenecks?days=${days ?? 30}`),
  agentQuality: (habitatId: string) =>
    request<AgentQualityResponse>(`/habitats/${habitatId}/agent-quality`),
  tasks: (
    habitatId: string,
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
      `/habitats/${habitatId}/tasks${qs ? `?${qs}` : ""}`,
    );
  },
};
