import type {
  Task,
  Agent,
  Habitat,
  TaskStatus,
  TaskEvent,
  TaskComment,
  MissionComment,
  Subtask,
  Mission,
  MissionWithProgress,
  ReviewRule,
  ReviewRuleCreateInput,
  ReviewRuleUpdateInput,
  ScheduledTask,
  TaskReviewer,
  Sprint,
  SprintCreateInput,
  SprintUpdateInput,
} from "@orcy/shared";
import type {
  ClaimTaskResponse,
  SubmitTaskResponse,
  CompleteTaskResponse,
  ReleaseTaskResponse,
  HeartbeatResponse,
  TaskContext,
  ListSubtasksResponse,
  SendMessageResponse,
  ListMessagesResponse,
  ListWebhooksResponse,
  CreateWebhookResponse,
  ListTemplatesResponse,
  CreateTemplateResponse,
  HabitatSettings,
  AgentStats,
  HabitatSummary,
  MissionContext,
  MissionProgressResponse,
  MissionDetailsResponse,
  ProjectInsight,
  ListMissionsResponse,
  ListTasksInMissionResponse,
  Pulse,
  PulseDigest,
  PostPulseResponse,
  ListPulsesResponse,
} from "./types.js";
import type {
  TaskClient as TaskClientIface,
  MissionClient as MissionClientIface,
  HabitatClient as HabitatClientIface,
  PulseClient as PulseClientIface,
  CodeEvidenceClient as CodeEvidenceClientIface,
  SkillClient as SkillClientIface,
  AgentClient as AgentClientIface,
  SprintClient as SprintClientIface,
  ScheduledTaskClient as ScheduledTaskClientIface,
  ReviewClient as ReviewClientIface,
  EffortClient as EffortClientIface,
  MessageClient as MessageClientIface,
  CommentClient as CommentClientIface,
  AuditClient as AuditClientIface,
  InsightClient as InsightClientIface,
  QualityClient as QualityClientIface,
  DependencyClient as DependencyClientIface,
  HealthClient as HealthClientIface,
  DashboardClient as DashboardClientIface,
  WebhookClient as WebhookClientIface,
  TemplateClient as TemplateClientIface,
  TimeTrackingClient as TimeTrackingClientIface,
  IntegrationClient as IntegrationClientIface,
} from "./api/interfaces.js";
import { composeMissionContext } from "./services/mission-context.js";
import { AsyncLocalStorage } from "node:async_hooks";
import { logger } from "./logger.js";
import {
  getOrcyConfig,
  getRemoteConfig,
  normalizeTaskId,
  normalizeMissionId,
  createApiClient,
  ApiClientError,
} from "@orcy/shared";

interface McpAuditToolContext {
  toolName: string;
  action?: string;
}

const mcpAuditToolStorage = new AsyncLocalStorage<McpAuditToolContext>();

export { ApiClientError as KanbanApiError } from "@orcy/shared";

export interface AnalyticsWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface SprintMetricsResponse {
  sprintId: string;
  totalMissions: number;
  completedMissions: number;
  completionPercentage: number;
  totalTasks: number;
  completedTasks: number;
  velocity: number;
  remainingDays: number;
  isOnTrack: boolean;
  plannedMinutes: number | null;
  loggedEffortMinutes: number;
  inferredPresenceMinutes: number;
  carryOverCount: number;
  forecast: unknown | null;
  warnings: AnalyticsWarning[];
}

export interface SprintBurndownResponse {
  sprintId: string;
  generatedAt: string;
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
  averageDailyVelocity: number;
  estimatedCompletionDate: string | null;
  days: unknown[];
  warnings: AnalyticsWarning[];
}

export interface SprintCarryOverResponse {
  sprintId: string;
  generatedAt: string;
  policy: string;
  carriedOverMissions: unknown[];
  warnings: AnalyticsWarning[];
}

export interface PredictionResponse {
  habitatId: string;
  velocity: unknown;
  forecasts: unknown[];
  atRiskTasks: unknown[];
  generatedAt: string;
}

export interface BottleneckResponse {
  habitatId: string;
  days: number;
  generatedAt: string;
  bottlenecks: unknown[];
  warnings: AnalyticsWarning[];
}

export interface AgentQualityResponse {
  habitatId: string;
  generatedAt: string;
  signals: unknown[];
}

export interface CumulativeFlowResponse {
  habitatId: string;
  days: number;
  generatedAt: string;
  data: unknown[];
  warnings: AnalyticsWarning[];
}

export interface HabitatHealthResponse {
  habitatId: string;
  generatedAt: string;
  score: number;
  dimensions: Record<string, unknown>;
  warnings: AnalyticsWarning[];
}

function buildRelevanceTags(mission: Mission): string[] {
  const tags: string[] = [];
  if (mission.labels) {
    for (const label of mission.labels) {
      tags.push(`label:${label}`);
    }
  }
  return tags;
}

export class KanbanApiClient
  implements
    TaskClientIface,
    MissionClientIface,
    HabitatClientIface,
    PulseClientIface,
    CodeEvidenceClientIface,
    SkillClientIface,
    AgentClientIface,
    SprintClientIface,
    ScheduledTaskClientIface,
    ReviewClientIface,
    EffortClientIface,
    MessageClientIface,
    CommentClientIface,
    AuditClientIface,
    InsightClientIface,
    QualityClientIface,
    DependencyClientIface,
    HealthClientIface,
    DashboardClientIface,
    WebhookClientIface,
    TemplateClientIface,
    TimeTrackingClientIface,
    IntegrationClientIface
{
  private transport: ReturnType<typeof createApiClient>;
  private baseUrl: string;

  constructor(
    baseUrl: string,
    timeoutMs?: number,
    options?: { maxRetries?: number; baseDelay?: number; maxDelay?: number },
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.transport = createApiClient({
      baseUrl,
      timeoutMs: timeoutMs ?? 30_000,
      maxRetries: options?.maxRetries ?? 3,
      baseDelay: options?.baseDelay ?? 1_000,
      maxDelay: options?.maxDelay ?? 30_000,
    });
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private getCredentials(): { apiKey: string; agentId: string } {
    const config = getOrcyConfig();
    return {
      apiKey: config.apiKey,
      agentId: config.agentId,
    };
  }

  /**
   * v0.19 Phase D — return the remote-mode credentials (X-Orcy-Remote-Key).
   * Used by remote-mode MCP clients configured with ORCY_REMOTE_KEY.
   */
  private getRemoteCredentials(): { remoteKey: string } {
    const config = getRemoteConfig();
    return { remoteKey: config.remoteKey };
  }

  withAuditToolContext<T>(toolName: string, action: string | undefined, callback: () => T): T {
    return mcpAuditToolStorage.run({ toolName, action }, callback);
  }

  private getAuditHeaders(): Record<string, string> {
    const context = mcpAuditToolStorage.getStore();
    if (!context) return {};
    return {
      "X-Orcy-Audit-Source": "mcp_tool",
      "X-Orcy-MCP-Tool": context.toolName,
      ...(context.action ? { "X-Orcy-MCP-Action": context.action } : {}),
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { apiKey } = this.getCredentials();
    return this.transport.request<T>(method, path, {
      body,
      headers: { "X-Agent-API-Key": apiKey, ...this.getAuditHeaders() },
    });
  }

  /**
   * v0.19 Phase D — make a request as a remote participant using
   * X-Orcy-Remote-Key instead of X-Agent-API-Key. Routes hit
   * `/api/shared/*` endpoints. The Idempotency-Key header is auto-generated
   * for write actions so retries are safe.
   */
  async requestRemote<T>(
    method: string,
    path: string,
    options?: {
      body?: unknown;
      idempotencyKey?: string;
      action?: string;
    },
  ): Promise<T> {
    const { remoteKey } = this.getRemoteCredentials();
    const idempotencyKey =
      options?.idempotencyKey ??
      (method !== "GET" && method !== "HEAD"
        ? `mcp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
        : undefined);
    return this.withAuditToolContext(`remote_${path}`, options?.action, () =>
      this.transport.request<T>(method, path, {
        body: options?.body,
        headers: {
          "X-Orcy-Remote-Key": remoteKey,
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
          ...this.getAuditHeaders(),
        },
      }),
    );
  }

  async listMissions(
    habitatId: string,
    options?: {
      status?: string;
      priority?: string;
      limit?: number;
      offset?: number;
      isArchived?: boolean;
    },
  ): Promise<ListMissionsResponse> {
    const params = new URLSearchParams();
    if (options?.status) params.set("status", options.status);
    if (options?.priority) params.set("priority", options.priority);
    if (options?.isArchived !== undefined) params.set("isArchived", String(options.isArchived));
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString();
    return this.request<ListMissionsResponse>(
      "GET",
      `/api/habitats/${habitatId}/missions${query ? `?${query}` : ""}`,
    );
  }

  async getMission(missionId: string): Promise<{ mission: MissionWithProgress }> {
    missionId = normalizeMissionId(missionId);
    return this.request<{ mission: MissionWithProgress }>("GET", `/api/missions/${missionId}`);
  }

  async getMissionDetails(missionId: string): Promise<MissionDetailsResponse> {
    missionId = normalizeMissionId(missionId);
    return this.request<MissionDetailsResponse>("GET", `/api/missions/${missionId}/details`);
  }

  async createMission(
    habitatId: string,
    input: {
      title: string;
      description?: string;
      acceptanceCriteria?: string;
      priority?: "low" | "medium" | "high" | "critical";
      labels?: string[];
      dependsOn?: string[];
      blocks?: string[];
      dueAt?: string;
      slaMinutes?: number;
    },
  ): Promise<{ mission: Mission }> {
    return this.request<{ mission: Mission }>("POST", `/api/habitats/${habitatId}/missions`, {
      title: input.title,
      description: input.description,
      acceptanceCriteria: input.acceptanceCriteria,
      priority: input.priority,
      labels: input.labels,
      dependsOn: input.dependsOn,
      blocks: input.blocks,
      dueAt: input.dueAt,
      slaMinutes: input.slaMinutes,
    });
  }

  async deleteMission(missionId: string): Promise<void> {
    missionId = normalizeMissionId(missionId);
    await this.request<void>("DELETE", `/api/missions/${missionId}`);
  }

  async archiveMission(missionId: string): Promise<{ mission: Mission }> {
    missionId = normalizeMissionId(missionId);
    return this.request<{ mission: Mission }>("POST", `/api/missions/${missionId}/archive`);
  }

  async unarchiveMission(missionId: string): Promise<{ mission: Mission }> {
    missionId = normalizeMissionId(missionId);
    return this.request<{ mission: Mission }>("POST", `/api/missions/${missionId}/unarchive`);
  }

  async listTasksInMission(missionId: string): Promise<ListTasksInMissionResponse> {
    missionId = normalizeMissionId(missionId);
    return this.request<ListTasksInMissionResponse>("GET", `/api/missions/${missionId}/tasks`);
  }

  async createTaskInMission(
    missionId: string,
    input: {
      title: string;
      description?: string;
      priority?: "low" | "medium" | "high" | "critical";
      requiredDomain?: string | null;
      requiredCapabilities?: string[];
      estimatedMinutes?: number;
      order?: number;
    },
  ): Promise<{ task: Task }> {
    missionId = normalizeMissionId(missionId);
    return this.request<{ task: Task }>("POST", `/api/missions/${missionId}/tasks`, {
      title: input.title,
      description: input.description,
      priority: input.priority,
      requiredDomain: input.requiredDomain,
      requiredCapabilities: input.requiredCapabilities,
      estimatedMinutes: input.estimatedMinutes,
      order: input.order,
    });
  }

  async getMissionContext(missionId: string): Promise<MissionContext> {
    return composeMissionContext(
      {
        mission: this,
        pulse: this,
        insight: this,
        skill: this,
      },
      missionId,
    );
  }

  async postPulse(
    missionId: string,
    input: {
      signalType: string;
      subject: string;
      body?: string;
      taskId?: string;
      toAgentName?: string;
      toAgentId?: string;
      replyToId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<PostPulseResponse> {
    missionId = normalizeMissionId(missionId);
    return this.request<PostPulseResponse>("POST", `/api/missions/${missionId}/pulse`, input);
  }

  async getPulses(
    missionId: string,
    filters?: {
      signalType?: string;
      isAuto?: boolean;
      since?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<ListPulsesResponse> {
    missionId = normalizeMissionId(missionId);
    const params = new URLSearchParams();
    if (filters?.signalType) params.set("signalType", filters.signalType);
    if (filters?.isAuto !== undefined) params.set("isAuto", String(filters.isAuto));
    if (filters?.since) params.set("since", filters.since);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const query = params.toString();
    return this.request<ListPulsesResponse>(
      "GET",
      `/api/missions/${missionId}/pulse${query ? `?${query}` : ""}`,
    );
  }

  async getPulseDigest(missionId: string): Promise<PulseDigest> {
    missionId = normalizeMissionId(missionId);
    return this.request<PulseDigest>("GET", `/api/missions/${missionId}/pulse/digest`);
  }

  async getPulseInbox(filters?: {
    signalType?: string;
    limit?: number;
    offset?: number;
  }): Promise<ListPulsesResponse> {
    const params = new URLSearchParams();
    if (filters?.signalType) params.set("signalType", filters.signalType);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const query = params.toString();
    return this.request<ListPulsesResponse>("GET", `/api/pulse/inbox${query ? `?${query}` : ""}`);
  }

  async deletePulse(pulseId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/pulse/${pulseId}`);
  }

  async getPulseReplies(pulseId: string): Promise<{ items: Pulse[] }> {
    return this.request<{ items: Pulse[] }>("GET", `/api/pulse/${pulseId}/replies`);
  }

  async postHabitatPulse(
    boardId: string,
    input: {
      signalType: string;
      subject: string;
      body?: string;
      taskId?: string;
      toAgentName?: string;
      toAgentId?: string;
      replyToId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<PostPulseResponse> {
    return this.request<PostPulseResponse>("POST", `/api/habitats/${boardId}/pulse`, input);
  }

  async getHabitatPulses(
    boardId: string,
    filters?: {
      signalType?: string;
      scope?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<ListPulsesResponse> {
    const params = new URLSearchParams();
    if (filters?.signalType) params.set("signalType", filters.signalType);
    if (filters?.scope) params.set("scope", filters.scope);
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const query = params.toString();
    return this.request<ListPulsesResponse>(
      "GET",
      `/api/habitats/${boardId}/pulse${query ? `?${query}` : ""}`,
    );
  }

  async getHabitatPulseDigest(boardId: string): Promise<PulseDigest> {
    return this.request<PulseDigest>("GET", `/api/habitats/${boardId}/pulse/digest`);
  }

  async promoteInsight(
    boardId: string,
    input: {
      sourcePulseId: string;
      relevanceTags?: string[];
      subject?: string;
      body?: string;
    },
  ): Promise<{ insight: ProjectInsight }> {
    return this.request<{ insight: ProjectInsight }>(
      "POST",
      `/api/habitats/${boardId}/insights`,
      input,
    );
  }

  async getInsights(
    boardId: string,
    filters?: {
      signalType?: string;
      isActive?: boolean;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ insights: ProjectInsight[]; total: number }> {
    const params = new URLSearchParams();
    if (filters?.signalType) params.set("signalType", filters.signalType);
    if (filters?.isActive !== undefined) params.set("isActive", String(filters.isActive));
    if (filters?.limit) params.set("limit", String(filters.limit));
    if (filters?.offset) params.set("offset", String(filters.offset));
    const query = params.toString();
    return this.request<{ insights: ProjectInsight[]; total: number }>(
      "GET",
      `/api/habitats/${boardId}/insights${query ? `?${query}` : ""}`,
    );
  }

  async deactivateInsight(boardId: string, insightId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/habitats/${boardId}/insights/${insightId}`);
  }

  async getRelevantInsights(boardId: string, tags: string[]): Promise<ProjectInsight[]> {
    const params = new URLSearchParams({ tags: tags.join(",") });
    const query = params.toString();
    const result = await this.request<{ items: ProjectInsight[]; total: number }>(
      "GET",
      `/api/habitats/${boardId}/insights?${query}`,
    );
    return result.items;
  }

  async reactToPulse(
    pulseId: string,
    reaction: string,
  ): Promise<{ added: boolean; counts: Record<string, number> }> {
    return this.request<{ added: boolean; counts: Record<string, number> }>(
      "POST",
      `/api/pulse/${pulseId}/react`,
      { reaction },
    );
  }

  async getMissionProgress(missionId: string): Promise<MissionProgressResponse> {
    missionId = normalizeMissionId(missionId);
    return this.request<MissionProgressResponse>("GET", `/api/missions/${missionId}/progress`);
  }

  async claimTask(
    taskId: string,
  ): Promise<
    | ClaimTaskResponse
    | { success: false; reason: string; message: string; missingCapabilities?: string[] }
  > {
    taskId = normalizeTaskId(taskId);
    try {
      return await this.request<ClaimTaskResponse>("POST", `/api/tasks/${taskId}/claim`);
    } catch (err) {
      if (err instanceof ApiClientError) {
        const body = err.message.replace(/^API \d+: /, "");
        if (err.status === 403) {
          try {
            const parsed = JSON.parse(body);
            if (parsed.missingCapabilities) {
              return {
                success: false,
                reason: "capability_mismatch",
                message: `Missing capabilities: ${parsed.missingCapabilities.join(", ")}`,
                missingCapabilities: parsed.missingCapabilities,
              };
            }
          } catch {
            /* fall through */
          }
        }
        try {
          const parsed = JSON.parse(body);
          return { success: false, reason: parsed.error || "unknown", message: body };
        } catch {
          return { success: false, reason: "unknown", message: body };
        }
      }
      return { success: false, reason: "unknown", message: String(err) };
    }
  }

  async startTask(taskId: string): Promise<{ task: Task }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ task: Task }>("POST", `/api/tasks/${taskId}/start`);
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    options?: { result?: string; artifacts?: Task["artifacts"] },
  ): Promise<{ task: Task }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ task: Task }>("PATCH", `/api/tasks/${taskId}`, {
      status,
      ...(options?.result !== undefined && { result: options.result }),
      ...(options?.artifacts !== undefined && { artifacts: options.artifacts }),
    });
  }

  async failTask(taskId: string, reason: string): Promise<{ task: Task }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ task: Task }>("POST", `/api/tasks/${taskId}/fail`, {
      reason,
    });
  }

  async submitTask(
    taskId: string,
    result: string,
    artifacts?: Task["artifacts"],
  ): Promise<SubmitTaskResponse> {
    taskId = normalizeTaskId(taskId);
    return this.request<SubmitTaskResponse>("POST", `/api/tasks/${taskId}/submit`, {
      result,
      artifacts: artifacts ?? [],
    });
  }

  async completeTask(
    taskId: string,
    reviewNote?: string,
    artifacts?: Task["artifacts"],
  ): Promise<CompleteTaskResponse> {
    taskId = normalizeTaskId(taskId);
    return this.request<CompleteTaskResponse>("POST", `/api/tasks/${taskId}/complete`, {
      reviewNote,
      artifacts: artifacts ?? [],
    });
  }

  async getTaskContext(taskId: string): Promise<TaskContext> {
    taskId = normalizeTaskId(taskId);
    return this.request<TaskContext>("GET", `/api/tasks/${taskId}`);
  }

  async releaseTask(taskId: string, reason: string): Promise<ReleaseTaskResponse> {
    taskId = normalizeTaskId(taskId);
    return this.request<ReleaseTaskResponse>("POST", `/api/tasks/${taskId}/release`, {
      reason,
    });
  }

  async retryTask(taskId: string): Promise<{ task: Task }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ task: Task }>("POST", `/api/tasks/${taskId}/retry`);
  }

  async heartbeat(taskId?: string, progress?: string): Promise<HeartbeatResponse> {
    const { agentId } = this.getCredentials();
    const result = await this.request<{
      status: "idle" | "working" | "offline";
      nextCheckIn: number;
      taskStatus: string | null;
    }>("POST", `/api/agents/${agentId}/heartbeat`, { taskId, progress });
    return {
      success: true,
      agentStatus: result.status,
      nextCheckIn: result.nextCheckIn,
      taskStatus: result.taskStatus as TaskStatus | null,
    };
  }

  async getAgent(): Promise<{ agent: Agent }> {
    const { agentId } = this.getCredentials();
    return this.request<{ agent: Agent }>("GET", `/api/agents/${agentId}`);
  }

  async getAgentById(agentId: string): Promise<{ agent: Agent } | null> {
    try {
      return await this.request<{ agent: Agent }>("GET", `/api/agents/${agentId}`);
    } catch (err) {
      if ((err as { status?: number }).status === 404) return null;
      throw err;
    }
  }

  async listAgents(options?: {
    status?: string;
    domain?: string;
    include?: string;
  }): Promise<{ agents: Agent[] | { agent: Agent; currentTaskTitle: string | null }[] }> {
    const params = new URLSearchParams();
    if (options?.status) params.set("status", options.status);
    if (options?.domain) params.set("domain", options.domain);
    if (options?.include) params.set("include", options.include);
    const query = params.toString();
    return this.request<{ agents: Agent[] | { agent: Agent; currentTaskTitle: string | null }[] }>(
      "GET",
      `/api/agents${query ? `?${query}` : ""}`,
    );
  }

  async getTask(taskId: string): Promise<{ task: Task }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ task: Task }>("GET", `/api/tasks/${taskId}`);
  }

  async getHabitat(
    habitatId: string,
  ): Promise<{ habitat: { id: string; name: string; columns: { name: string }[] } }> {
    return this.request<{ habitat: { id: string; name: string; columns: { name: string }[] } }>(
      "GET",
      `/api/habitats/${habitatId}`,
    );
  }

  async listHabitats(name?: string): Promise<{ habitats: Habitat[] }> {
    const params = new URLSearchParams();
    if (name) params.set("name", name);
    const query = params.toString();
    return this.request<{ habitats: Habitat[] }>("GET", `/api/habitats${query ? `?${query}` : ""}`);
  }

  async getTaskEvents(
    taskId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ events: TaskEvent[]; total: number }> {
    taskId = normalizeTaskId(taskId);
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request<{ events: TaskEvent[]; total: number }>(
      "GET",
      `/api/tasks/${taskId}/events${query}`,
    );
  }

  async updateTask(
    taskId: string,
    input: {
      title?: string;
      description?: string;
      priority?: "low" | "medium" | "high" | "critical";
      requiredDomain?: string | null;
      requiredCapabilities?: string[];
      version?: number;
      estimatedMinutes?: number | null;
    },
  ): Promise<{ task: Task }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ task: Task }>("PATCH", `/api/tasks/${taskId}`, {
      title: input.title,
      description: input.description,
      priority: input.priority,
      requiredDomain: input.requiredDomain,
      requiredCapabilities: input.requiredCapabilities,
      version: input.version,
      estimatedMinutes: input.estimatedMinutes,
    });
  }

  async deleteTask(taskId: string): Promise<void> {
    taskId = normalizeTaskId(taskId);
    await this.request<void>("DELETE", `/api/tasks/${taskId}`);
  }

  async registerAgent(input: {
    name: string;
    type: "claude-code" | "codex" | "opencode" | "cursor" | "gemini";
    domain: string;
    capabilities?: string[];
  }): Promise<{ agent: Agent; apiKey: string }> {
    const registrationToken = process.env.ORCY_REGISTRATION_TOKEN ?? "";
    const headers: Record<string, string> = {};
    if (registrationToken) {
      headers["X-Registration-Token"] = registrationToken;
    }
    return this.transport.request<{ agent: Agent; apiKey: string }>("POST", "/api/agents", {
      body: input,
      headers,
    });
  }

  async createHabitat(input: {
    name: string;
    description?: string;
    defaultColumns?: boolean;
  }): Promise<{ success: true; habitat: Habitat; columns: Habitat["columns"] }> {
    return this.request<{ success: true; habitat: Habitat; columns: Habitat["columns"] }>(
      "POST",
      "/api/habitats/agent",
      input,
    );
  }

  async delegateTask(taskId: string, toAgentId: string, reason?: string): Promise<{ task: Task }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ task: Task }>("POST", `/api/tasks/${taskId}/delegate`, {
      toAgentId,
      reason,
    });
  }

  async cloneTask(
    taskId: string,
    options?: { includeSubtasks?: boolean; includeComments?: boolean },
  ): Promise<{ task: Task }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ task: Task }>("POST", `/api/tasks/${taskId}/clone`, {
      includeSubtasks: options?.includeSubtasks ?? false,
      includeComments: options?.includeComments ?? false,
    });
  }

  async getTaskComments(
    taskId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ comments: TaskComment[]; total: number }> {
    taskId = normalizeTaskId(taskId);
    const params = new URLSearchParams();
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request<{ comments: TaskComment[]; total: number }>(
      "GET",
      `/api/tasks/${taskId}/comments${query}`,
    );
  }

  async addComment(
    taskId: string,
    content: string,
    parentId?: string,
  ): Promise<{ comment: TaskComment }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ comment: TaskComment }>("POST", `/api/tasks/${taskId}/comments`, {
      content,
      ...(parentId !== undefined && { parentId }),
    });
  }

  async getMissionComments(
    missionId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ comments: MissionComment[]; total: number }> {
    missionId = normalizeMissionId(missionId);
    const params = new URLSearchParams();
    if (options?.limit !== undefined) params.set("limit", String(options.limit));
    if (options?.offset !== undefined) params.set("offset", String(options.offset));
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request<{ comments: MissionComment[]; total: number }>(
      "GET",
      `/api/missions/${missionId}/comments${query}`,
    );
  }

  async addMissionComment(
    missionId: string,
    content: string,
    parentId?: string,
  ): Promise<{ comment: MissionComment }> {
    missionId = normalizeMissionId(missionId);
    return this.request<{ comment: MissionComment }>(
      "POST",
      `/api/missions/${missionId}/comments`,
      {
        content,
        ...(parentId !== undefined && { parentId }),
      },
    );
  }

  async exportAuditLog(
    boardId: string,
    options: {
      format: "csv" | "json" | "jsonl";
      since?: string;
      until?: string;
      actions?: string;
      actorType?: string;
      actorId?: string;
      entityTypes?: string;
      entityType?: string;
      entityId?: string;
      taskId?: string;
      missionId?: string;
      source?: string;
      provider?: string;
      preset?: string;
      includeProvenance?: boolean;
      includeIntegrity?: boolean;
      includeHealthSnapshots?: boolean;
    },
  ): Promise<string> {
    const params = new URLSearchParams({ format: options.format });
    if (options.since) params.set("since", options.since);
    if (options.until) params.set("until", options.until);
    if (options.actions) params.set("actions", options.actions);
    if (options.actorType) params.set("actorType", options.actorType);
    if (options.actorId) params.set("actorId", options.actorId);
    if (options.entityTypes) params.set("entityTypes", options.entityTypes);
    if (options.entityType) params.set("entityType", options.entityType);
    if (options.entityId) params.set("entityId", options.entityId);
    if (options.taskId) params.set("taskId", options.taskId);
    if (options.missionId) params.set("missionId", options.missionId);
    if (options.source) params.set("source", options.source);
    if (options.provider) params.set("provider", options.provider);
    if (options.preset) params.set("preset", options.preset);
    if (options.includeProvenance) params.set("includeProvenance", "true");
    if (options.includeIntegrity) params.set("includeIntegrity", "true");
    if (options.includeHealthSnapshots) params.set("includeHealthSnapshots", "true");

    return this.request<string>(
      "GET",
      `/api/habitats/${boardId}/audit/export?${params.toString()}`,
    );
  }

  async getAuditSummary(
    boardId: string,
    options?: { since?: string; until?: string },
  ): Promise<Record<string, unknown>> {
    const params = new URLSearchParams();
    if (options?.since) params.set("since", options.since);
    if (options?.until) params.set("until", options.until);
    const qs = params.toString();

    return this.request<Record<string, unknown>>(
      "GET",
      `/api/habitats/${boardId}/audit/summary${qs ? `?${qs}` : ""}`,
    );
  }

  async getTaskAuditBundle(
    taskId: string,
    options?: { includeHealthSnapshots?: boolean },
  ): Promise<Record<string, unknown>> {
    taskId = normalizeTaskId(taskId);
    const params = new URLSearchParams();
    if (options?.includeHealthSnapshots) params.set("includeHealthSnapshots", "true");
    const qs = params.toString();
    return this.request<Record<string, unknown>>(
      "GET",
      `/api/tasks/${taskId}/audit/bundle${qs ? `?${qs}` : ""}`,
    );
  }

  async getMissionAuditBundle(
    missionId: string,
    options?: { includeHealthSnapshots?: boolean },
  ): Promise<Record<string, unknown>> {
    missionId = normalizeMissionId(missionId);
    const params = new URLSearchParams();
    if (options?.includeHealthSnapshots) params.set("includeHealthSnapshots", "true");
    const qs = params.toString();
    return this.request<Record<string, unknown>>(
      "GET",
      `/api/missions/${missionId}/audit/bundle${qs ? `?${qs}` : ""}`,
    );
  }

  async getHabitatHealth(boardId: string): Promise<HabitatHealthResponse> {
    return this.request<HabitatHealthResponse>("GET", `/api/habitats/${boardId}/health`);
  }

  async getHabitatHealthHistory(boardId: string, days?: number): Promise<HabitatHealthResponse> {
    const params = new URLSearchParams();
    if (days) params.set("days", String(days));
    const qs = params.toString();
    return this.request<HabitatHealthResponse>(
      "GET",
      `/api/habitats/${boardId}/health/history${qs ? `?${qs}` : ""}`,
    );
  }

  async getHabitatPredictions(boardId: string): Promise<PredictionResponse> {
    return this.request<PredictionResponse>("GET", `/api/habitats/${boardId}/predictions`);
  }

  async getHabitatBottlenecks(boardId: string, days?: number): Promise<BottleneckResponse> {
    const params = new URLSearchParams();
    if (days) params.set("days", String(days));
    const qs = params.toString();
    return this.request<BottleneckResponse>(
      "GET",
      `/api/habitats/${boardId}/bottlenecks${qs ? `?${qs}` : ""}`,
    );
  }

  async getHabitatAgentQuality(boardId: string): Promise<AgentQualityResponse> {
    return this.request<AgentQualityResponse>("GET", `/api/habitats/${boardId}/agent-quality`);
  }

  async listSubtasks(taskId: string): Promise<ListSubtasksResponse> {
    taskId = normalizeTaskId(taskId);
    return this.request<ListSubtasksResponse>("GET", `/api/tasks/${taskId}/subtasks`);
  }

  async createSubtask(
    taskId: string,
    input: { title: string; order?: number; assigneeId?: string },
  ): Promise<{ subtask: Subtask }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ subtask: Subtask }>("POST", `/api/tasks/${taskId}/subtasks`, {
      title: input.title,
      ...(input.order !== undefined && { order: input.order }),
      ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
    });
  }

  async updateSubtask(
    taskId: string,
    subtaskId: string,
    input: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null },
  ): Promise<{ subtask: Subtask }> {
    taskId = normalizeTaskId(taskId);
    return this.request<{ subtask: Subtask }>(
      "PATCH",
      `/api/tasks/${taskId}/subtasks/${subtaskId}`,
      {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.completed !== undefined && { completed: input.completed }),
        ...(input.order !== undefined && { order: input.order }),
        ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
      },
    );
  }

  async deleteSubtask(taskId: string, subtaskId: string): Promise<void> {
    taskId = normalizeTaskId(taskId);
    await this.request<void>("DELETE", `/api/tasks/${taskId}/subtasks/${subtaskId}`);
  }

  async sendMessage(
    toAgentId: string,
    input: {
      boardId: string;
      taskId?: string;
      subject: string;
      body: string;
      messageType?: "info" | "request" | "response" | "alert";
      priority?: "low" | "normal" | "high" | "urgent";
    },
  ): Promise<SendMessageResponse> {
    const { agentId } = this.getCredentials();
    return this.request<SendMessageResponse>("POST", `/api/agents/${agentId}/messages`, {
      boardId: input.boardId,
      toAgentId,
      taskId: input.taskId,
      subject: input.subject,
      body: input.body,
      messageType: input.messageType,
      priority: input.priority,
    });
  }

  async getMessages(options?: {
    unreadOnly?: boolean;
    taskId?: string;
    limit?: number;
    offset?: number;
  }): Promise<ListMessagesResponse> {
    const { agentId } = this.getCredentials();
    const params = new URLSearchParams();
    if (options?.unreadOnly) params.set("unreadOnly", "true");
    if (options?.taskId) params.set("taskId", options.taskId);
    if (options?.limit) params.set("limit", String(options.limit));
    if (options?.offset) params.set("offset", String(options.offset));
    const query = params.toString();
    return this.request<ListMessagesResponse>(
      "GET",
      `/api/agents/${agentId}/messages${query ? `?${query}` : ""}`,
    );
  }

  async markMessageRead(
    messageId: string,
  ): Promise<{ message: import("./types.js").AgentMessage }> {
    return this.request<{ message: import("./types.js").AgentMessage }>(
      "PUT",
      `/api/agents/messages/${messageId}/read`,
    );
  }

  async markAllMessagesRead(): Promise<{ updated: number }> {
    const { agentId } = this.getCredentials();
    return this.request<{ updated: number }>("PUT", `/api/agents/${agentId}/messages/read-all`);
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/agents/messages/${messageId}`);
  }

  async getSuggestions(
    agentId: string,
    boardId: string,
    limit: number = 5,
  ): Promise<{
    suggestions: Array<{
      taskId: string;
      taskTitle: string;
      score: number;
      reasons: string[];
      factors: {
        priorityWeight: number;
        urgencyWeight: number;
        capabilityWeight: number;
        dependencyBonus: number;
        specializationBonus: number;
        workloadPenalty: number;
        stalePickupBonus: number;
      };
    }>;
    agentWorkload: { claimed: number; inProgress: number; maxRecommended: number };
  }> {
    const params = new URLSearchParams();
    params.set("boardId", boardId);
    params.set("limit", String(limit));
    return this.request("GET", `/api/agents/${agentId}/suggestions?${params.toString()}`);
  }

  async listWebhooks(boardId: string): Promise<ListWebhooksResponse> {
    return this.request<ListWebhooksResponse>("GET", `/api/habitats/${boardId}/webhooks`);
  }

  async createWebhook(
    boardId: string,
    input: {
      name: string;
      url: string;
      events: string[];
      format?: "standard" | "slack" | "discord";
    },
  ): Promise<CreateWebhookResponse> {
    return this.request<CreateWebhookResponse>("POST", `/api/habitats/${boardId}/webhooks`, input);
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/webhooks/${webhookId}`);
  }

  async listTemplates(boardId: string): Promise<ListTemplatesResponse> {
    return this.request<ListTemplatesResponse>("GET", `/api/habitats/${boardId}/templates`);
  }

  async createTemplate(
    boardId: string,
    input: {
      name: string;
      titlePattern?: string;
      descriptionPattern?: string;
      priority?: "low" | "medium" | "high" | "critical";
      labels?: string[];
      requiredDomain?: string;
    },
  ): Promise<CreateTemplateResponse> {
    return this.request<CreateTemplateResponse>(
      "POST",
      `/api/habitats/${boardId}/templates`,
      input,
    );
  }

  async deleteTemplate(templateId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/templates/${templateId}`);
  }

  async getHabitatSettings(boardId: string): Promise<{ habitat: HabitatSettings }> {
    return this.request<{ habitat: HabitatSettings }>("GET", `/api/habitats/${boardId}`);
  }

  async updateHabitatSettings(
    boardId: string,
    input: { name?: string; description?: string },
  ): Promise<{ habitat: HabitatSettings }> {
    return this.request<{ habitat: HabitatSettings }>("PATCH", `/api/habitats/${boardId}`, input);
  }

  async getAgentStats(agentId: string): Promise<{ stats: AgentStats }> {
    return this.request<{ stats: AgentStats }>("GET", `/api/agents/${agentId}/stats`);
  }

  async getHabitatSummary(
    boardId: string,
    options?: { since?: string; maxTasks?: number; includeDigest?: boolean },
  ): Promise<HabitatSummary> {
    const params = new URLSearchParams();
    if (options?.since) params.set("since", options.since);
    if (options?.maxTasks) params.set("maxTasks", String(options.maxTasks));
    if (options?.includeDigest === false) params.set("includeDigest", "false");
    const query = params.toString() ? `?${params.toString()}` : "";
    return this.request<HabitatSummary>("GET", `/api/habitats/${boardId}/summary${query}`);
  }

  async getWorktree(taskId: string): Promise<{
    worktree: { path: string; branch: string; repoRoot: string } | null;
    enabled: boolean;
  }> {
    taskId = normalizeTaskId(taskId);
    try {
      return await this.request<{
        worktree: { path: string; branch: string; repoRoot: string } | null;
        enabled: boolean;
      }>("GET", `/api/tasks/${taskId}/worktree`);
    } catch {
      return { worktree: null, enabled: false };
    }
  }

  async getTaskTimeReport(taskId: string): Promise<{
    taskId: string;
    estimatedMinutes: number | null;
    actualMinutes: number | null;
    cycleTimeMinutes: number | null;
    leadTimeMinutes: number | null;
    estimationAccuracy: number | null;
    heartbeatHistory: {
      id: string;
      taskId: string;
      agentId: string | null;
      minutesSpent: number;
      recordedAt: string;
      statusDuringWork: string;
    }[];
  }> {
    taskId = normalizeTaskId(taskId);
    return this.request("GET", `/api/tasks/${taskId}/time-report`);
  }

  async logEffort(
    taskId: string,
    minutes: number,
    note?: string,
    startedAt?: string,
    endedAt?: string,
  ): Promise<{ entry: unknown }> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/effort-entries`, {
      minutes,
      ...(note !== undefined && { note }),
      ...(startedAt !== undefined && { startedAt }),
      ...(endedAt !== undefined && { endedAt }),
    });
  }

  async listEffortEntries(
    taskId: string,
    options: { includeCorrections?: boolean; limit?: number; offset?: number } = {},
  ): Promise<{ entries: unknown[] }> {
    taskId = normalizeTaskId(taskId);
    const params = new URLSearchParams();
    if (options.includeCorrections !== undefined) {
      params.set("includeCorrections", String(options.includeCorrections));
    }
    if (options.limit !== undefined) {
      params.set("limit", String(options.limit));
    }
    if (options.offset !== undefined) {
      params.set("offset", String(options.offset));
    }
    const query = params.toString();
    return this.request("GET", `/api/tasks/${taskId}/effort-entries${query ? `?${query}` : ""}`);
  }

  async getEffortReport(taskId: string): Promise<{ report: unknown }> {
    taskId = normalizeTaskId(taskId);
    return this.request("GET", `/api/tasks/${taskId}/effort-report`);
  }

  async correctEffortEntry(
    taskId: string,
    entryId: string,
    minutesDelta: number,
    correctionReason: string,
    note?: string,
  ): Promise<{ entry: unknown }> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/effort-entries/${entryId}/correct`, {
      minutesDelta,
      correctionReason,
      ...(note !== undefined && { note }),
    });
  }

  async getMissionEffortReport(missionId: string): Promise<{ report: unknown }> {
    missionId = normalizeMissionId(missionId);
    return this.request("GET", `/api/missions/${missionId}/effort-report`);
  }

  async getHabitatMetrics(boardId: string): Promise<{
    averageCycleTime: number;
    averageLeadTime: number;
    averageEstimationAccuracy: number;
    totalPlannedMinutes: number;
    totalActualMinutes: number;
    overdueTasks: number;
    onTimeCompletionRate: number;
    agentMetrics: {
      agentId: string;
      agentName: string;
      tasksCompleted: number;
      averageCycleTime: number;
      averageEstimationAccuracy: number;
      totalTimeTracked: number;
    }[];
  }> {
    return this.request("GET", `/api/habitats/${boardId}/metrics`);
  }

  async addTaskDependency(taskId: string, dependsOnTaskId: string): Promise<{ success: boolean }> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/dependencies`, { dependsOnTaskId });
  }

  async removeTaskDependency(taskId: string, depId: string): Promise<{ success: boolean }> {
    taskId = normalizeTaskId(taskId);
    return this.request("DELETE", `/api/tasks/${taskId}/dependencies/${depId}`);
  }

  async getTaskDependencies(taskId: string): Promise<{
    dependsOn: { taskId: string; title: string; status: string; completedAt: string | null }[];
    blocking: { taskId: string; title: string; status: string }[];
  }> {
    taskId = normalizeTaskId(taskId);
    return this.request("GET", `/api/tasks/${taskId}/dependencies`);
  }

  async getTaskBlockedStatus(taskId: string): Promise<{
    taskId: string;
    isBlocked: boolean;
    canComplete: boolean;
    blockedBy: { taskId: string; title: string; status: string }[];
    blocking: { taskId: string; title: string; status: string }[];
  }> {
    taskId = normalizeTaskId(taskId);
    return this.request("GET", `/api/tasks/${taskId}/blocked-status`);
  }

  async getTaskQualityChecklist(taskId: string): Promise<{
    taskId: string;
    overallStatus: string;
    canApprove: boolean;
    checklists: {
      id: string;
      templateId: string;
      templateName: string;
      category: string;
      required: boolean;
      status: string;
      progress: { total: number; completed: number };
      items: {
        id: string;
        title: string;
        required: boolean;
        isCompleted: boolean;
        completedBy: string | null;
        completedAt: string | null;
        evidenceUrl: string | null;
        notes: string;
      }[];
    }[];
    missingRequirements: { category: string; missingItems: string[] }[];
  }> {
    taskId = normalizeTaskId(taskId);
    return this.request("GET", `/api/tasks/${taskId}/quality-checklist`);
  }

  async updateQualityChecklistItem(
    taskId: string,
    checklistId: string,
    itemId: string,
    input: { isCompleted?: boolean; evidenceUrl?: string; notes?: string },
  ): Promise<{
    id: string;
    checklistId: string;
    itemId: string;
    isCompleted: boolean;
    completedBy: string | null;
    completedAt: string | null;
    evidenceUrl: string | null;
    notes: string;
  }> {
    taskId = normalizeTaskId(taskId);
    return this.request(
      "PUT",
      `/api/tasks/${taskId}/quality-checklist/${checklistId}/items/${itemId}`,
      input,
    );
  }

  async validateQualityGates(
    taskId: string,
  ): Promise<{ passed: boolean; failures: { category: string; missingItems: string[] }[] }> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/quality-checklist/validate`);
  }

  async getTaskCodeEvidence(
    taskId: string,
    includeHistory = false,
  ): Promise<Record<string, unknown>> {
    taskId = normalizeTaskId(taskId);
    return this.request(
      "GET",
      `/api/tasks/${taskId}/code-evidence?includeHistory=${includeHistory}`,
    );
  }

  async linkTaskCodeEvidence(
    taskId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/code-evidence`, input);
  }

  async correctTaskEvidenceLink(
    taskId: string,
    linkId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/code-evidence/${linkId}/correct`, input);
  }

  async markTaskEvidenceNotApplicable(
    taskId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/code-evidence/not-applicable`, input);
  }

  async clearTaskEvidenceNotApplicable(taskId: string): Promise<{ success: boolean }> {
    taskId = normalizeTaskId(taskId);
    return this.request("DELETE", `/api/tasks/${taskId}/code-evidence/not-applicable`);
  }

  async reportTaskEvidenceGap(
    taskId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/code-evidence/gaps`, input);
  }

  async resolveTaskEvidenceGap(
    taskId: string,
    gapId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    taskId = normalizeTaskId(taskId);
    return this.request("POST", `/api/tasks/${taskId}/code-evidence/gaps/${gapId}/resolve`, input);
  }

  async getMissionCodeEvidence(
    missionId: string,
    includeHistory = false,
  ): Promise<Record<string, unknown>> {
    missionId = normalizeMissionId(missionId);
    return this.request(
      "GET",
      `/api/missions/${missionId}/code-evidence?includeHistory=${includeHistory}`,
    );
  }

  async linkMissionCodeEvidence(
    missionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    missionId = normalizeMissionId(missionId);
    return this.request("POST", `/api/missions/${missionId}/code-evidence`, input);
  }

  async correctMissionEvidenceLink(
    missionId: string,
    linkId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    missionId = normalizeMissionId(missionId);
    return this.request(
      "POST",
      `/api/missions/${missionId}/code-evidence/${linkId}/correct`,
      input,
    );
  }

  async markMissionEvidenceNotApplicable(
    missionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    missionId = normalizeMissionId(missionId);
    return this.request("POST", `/api/missions/${missionId}/code-evidence/not-applicable`, input);
  }

  async clearMissionEvidenceNotApplicable(missionId: string): Promise<{ success: boolean }> {
    missionId = normalizeMissionId(missionId);
    return this.request("DELETE", `/api/missions/${missionId}/code-evidence/not-applicable`);
  }

  async reportMissionEvidenceGap(
    missionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    missionId = normalizeMissionId(missionId);
    return this.request("POST", `/api/missions/${missionId}/code-evidence/gaps`, input);
  }

  async resolveMissionEvidenceGap(
    missionId: string,
    gapId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    missionId = normalizeMissionId(missionId);
    return this.request(
      "POST",
      `/api/missions/${missionId}/code-evidence/gaps/${gapId}/resolve`,
      input,
    );
  }

  async getHabitatRepository(
    habitatId: string,
  ): Promise<{ repository: Record<string, unknown> | null }> {
    return this.request("GET", `/api/habitats/${habitatId}/repository`);
  }

  async setHabitatRepository(
    habitatId: string,
    input: Record<string, unknown>,
  ): Promise<{ repository: Record<string, unknown> }> {
    return this.request("PUT", `/api/habitats/${habitatId}/repository`, input);
  }

  async inferRepositoryFromWorktree(
    habitatId: string,
    input?: Record<string, unknown>,
  ): Promise<{ repository: Record<string, unknown> }> {
    return this.request(
      "POST",
      `/api/habitats/${habitatId}/repository/infer-from-worktree`,
      input ?? {},
    );
  }

  async inferRepositoryFromIntegration(
    habitatId: string,
    input?: Record<string, unknown>,
  ): Promise<{ repository: Record<string, unknown> }> {
    return this.request(
      "POST",
      `/api/habitats/${habitatId}/repository/infer-from-integration`,
      input ?? {},
    );
  }

  async getTaskApprovalStatus(taskId: string): Promise<{
    canBeApproved: boolean;
    reasons: string[];
    requirements: {
      qualityChecklist: { status: string; completed: number; total: number };
      dependencies: { status: string };
      timeTracking: { status: string };
    };
  }> {
    taskId = normalizeTaskId(taskId);
    return this.request("GET", `/api/tasks/${taskId}/approval-status`);
  }

  async batchAssignTasks(
    boardId: string,
    taskIds: string[],
    agentId: string,
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{ taskId: string; success: boolean; error?: string }>;
  }> {
    return this.request("POST", `/api/habitats/${boardId}/tasks/batch`, {
      taskIds,
      operation: "assign",
      payload: { assignedAgentId: agentId },
    });
  }

  async batchSetTaskPriority(
    boardId: string,
    taskIds: string[],
    priority: string,
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{ taskId: string; success: boolean; error?: string }>;
  }> {
    return this.request("POST", `/api/habitats/${boardId}/tasks/batch`, {
      taskIds,
      operation: "priority",
      payload: { priority },
    });
  }

  async batchDeleteTasks(
    boardId: string,
    taskIds: string[],
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{ taskId: string; success: boolean; error?: string }>;
  }> {
    return this.request("POST", `/api/habitats/${boardId}/tasks/batch`, {
      taskIds,
      operation: "delete",
      payload: {},
    });
  }

  async getPrioritizationRules(boardId: string): Promise<{ rules: Record<string, unknown> }> {
    return this.request<{ rules: Record<string, unknown> }>(
      "GET",
      `/api/habitats/${boardId}/rules`,
    );
  }

  async updatePrioritizationRules(
    boardId: string,
    rules: Record<string, unknown>,
  ): Promise<{ rules: Record<string, unknown> }> {
    return this.request<{ rules: Record<string, unknown> }>(
      "PUT",
      `/api/habitats/${boardId}/rules`,
      rules,
    );
  }

  async evaluatePrioritizationRules(
    boardId: string,
  ): Promise<{ evaluation: Record<string, unknown> }> {
    return this.request<{ evaluation: Record<string, unknown> }>(
      "POST",
      `/api/habitats/${boardId}/rules/evaluate`,
    );
  }

  async listScheduledTasks(boardId: string): Promise<{ scheduledTasks: ScheduledTask[] }> {
    return this.request<{ scheduledTasks: ScheduledTask[] }>(
      "GET",
      `/api/habitats/${boardId}/scheduled-tasks`,
    );
  }

  async createScheduledTask(
    boardId: string,
    input: {
      name: string;
      description?: string;
      scheduleType: "once" | "interval" | "cron";
      cronExpression?: string;
      intervalMinutes?: number;
      timezone?: string;
      missionTitle: string;
      missionDescription?: string;
      missionPriority?: "low" | "medium" | "high" | "critical";
      missionLabels?: string[];
      missionDomain?: string;
      tasksTemplate?: Array<{
        title: string;
        description?: string;
        priority?: "low" | "medium" | "high" | "critical";
        requiredDomain?: string;
        requiredCapabilities?: string[];
        estimatedMinutes?: number;
        order?: number;
      }>;
    },
  ): Promise<{ scheduledTask: ScheduledTask }> {
    return this.request<{ scheduledTask: ScheduledTask }>(
      "POST",
      `/api/habitats/${boardId}/scheduled-tasks`,
      input,
    );
  }

  async getScheduledTask(scheduledTaskId: string): Promise<{ scheduledTask: ScheduledTask }> {
    return this.request<{ scheduledTask: ScheduledTask }>(
      "GET",
      `/api/scheduled-tasks/${scheduledTaskId}`,
    );
  }

  async updateScheduledTask(
    scheduledTaskId: string,
    input: Record<string, unknown>,
  ): Promise<{ scheduledTask: ScheduledTask }> {
    return this.request<{ scheduledTask: ScheduledTask }>(
      "PATCH",
      `/api/scheduled-tasks/${scheduledTaskId}`,
      input,
    );
  }

  async deleteScheduledTask(scheduledTaskId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/scheduled-tasks/${scheduledTaskId}`);
  }

  async runScheduledTask(
    scheduledTaskId: string,
  ): Promise<{ success: boolean; missionId?: string; error?: string }> {
    return this.request<{ success: boolean; missionId?: string; error?: string }>(
      "POST",
      `/api/scheduled-tasks/${scheduledTaskId}/run`,
    );
  }

  async enableScheduledTask(scheduledTaskId: string): Promise<{ scheduledTask: ScheduledTask }> {
    return this.request<{ scheduledTask: ScheduledTask }>(
      "POST",
      `/api/scheduled-tasks/${scheduledTaskId}/enable`,
    );
  }

  async disableScheduledTask(scheduledTaskId: string): Promise<{ scheduledTask: ScheduledTask }> {
    return this.request<{ scheduledTask: ScheduledTask }>(
      "POST",
      `/api/scheduled-tasks/${scheduledTaskId}/disable`,
    );
  }

  // -- Review Rules --

  async listReviewRules(habitatId: string): Promise<{ reviewRules: ReviewRule[] }> {
    return this.request<{ reviewRules: ReviewRule[] }>(
      "GET",
      `/api/habitats/${habitatId}/review-rules`,
    );
  }

  async createReviewRule(
    habitatId: string,
    input: ReviewRuleCreateInput,
  ): Promise<{ reviewRule: ReviewRule }> {
    return this.request<{ reviewRule: ReviewRule }>(
      "POST",
      `/api/habitats/${habitatId}/review-rules`,
      input,
    );
  }

  async updateReviewRule(
    ruleId: string,
    input: ReviewRuleUpdateInput,
  ): Promise<{ reviewRule: ReviewRule | null }> {
    return this.request<{ reviewRule: ReviewRule | null }>(
      "PATCH",
      `/api/review-rules/${ruleId}`,
      input,
    );
  }

  async deleteReviewRule(ruleId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/review-rules/${ruleId}`);
  }

  // -- Task Reviewers --

  async listTaskReviewers(taskId: string): Promise<{ reviewers: TaskReviewer[] }> {
    return this.request<{ reviewers: TaskReviewer[] }>("GET", `/api/tasks/${taskId}/reviewers`);
  }

  async addTaskReviewer(
    taskId: string,
    input: { reviewerId: string; reviewerType: "human" | "agent" },
  ): Promise<{ reviewer: TaskReviewer }> {
    return this.request<{ reviewer: TaskReviewer }>(
      "POST",
      `/api/tasks/${taskId}/reviewers`,
      input,
    );
  }

  async removeTaskReviewer(taskId: string, reviewerId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/tasks/${taskId}/reviewers/${reviewerId}`);
  }

  // -- Sprints --

  async listSprints(habitatId: string): Promise<{ sprints: Sprint[] }> {
    return this.request<{ sprints: Sprint[] }>("GET", `/api/habitats/${habitatId}/sprints`);
  }

  async getActiveSprint(habitatId: string): Promise<{ sprint: Sprint | null }> {
    return this.request<{ sprint: Sprint | null }>(
      "GET",
      `/api/habitats/${habitatId}/sprints/active`,
    );
  }

  async getSprint(sprintId: string): Promise<{ sprint: Sprint }> {
    return this.request<{ sprint: Sprint }>("GET", `/api/sprints/${sprintId}`);
  }

  async getSprintMetrics(sprintId: string): Promise<SprintMetricsResponse> {
    return this.request<SprintMetricsResponse>("GET", `/api/sprints/${sprintId}/metrics`);
  }

  async getSprintBurndown(sprintId: string): Promise<SprintBurndownResponse> {
    return this.request<SprintBurndownResponse>("GET", `/api/sprints/${sprintId}/burndown`);
  }

  async getSprintCarryOver(sprintId: string): Promise<SprintCarryOverResponse> {
    return this.request<SprintCarryOverResponse>("GET", `/api/sprints/${sprintId}/carry-over`);
  }

  async createSprint(habitatId: string, input: SprintCreateInput): Promise<{ sprint: Sprint }> {
    return this.request<{ sprint: Sprint }>("POST", `/api/habitats/${habitatId}/sprints`, input);
  }

  async updateSprint(sprintId: string, input: SprintUpdateInput): Promise<{ sprint: Sprint }> {
    return this.request<{ sprint: Sprint }>("PATCH", `/api/sprints/${sprintId}`, input);
  }

  async deleteSprint(sprintId: string): Promise<void> {
    await this.request<void>("DELETE", `/api/sprints/${sprintId}`);
  }

  async startSprint(sprintId: string): Promise<{ sprint: Sprint }> {
    return this.request<{ sprint: Sprint }>("POST", `/api/sprints/${sprintId}/start`);
  }

  async completeSprint(sprintId: string): Promise<{ sprint: Sprint }> {
    return this.request<{ sprint: Sprint }>("POST", `/api/sprints/${sprintId}/complete`);
  }

  async cancelSprint(sprintId: string): Promise<{ sprint: Sprint }> {
    return this.request<{ sprint: Sprint }>("POST", `/api/sprints/${sprintId}/cancel`);
  }

  async addMissionToSprint(sprintId: string, missionId: string): Promise<{ sprint: Sprint }> {
    return this.request<{ sprint: Sprint }>("POST", `/api/sprints/${sprintId}/missions`, {
      missionId,
    });
  }

  async removeMissionFromSprint(sprintId: string, missionId: string): Promise<{ sprint: Sprint }> {
    return this.request<{ sprint: Sprint }>(
      "DELETE",
      `/api/sprints/${sprintId}/missions/${missionId}`,
    );
  }

  async getHabitatSkill(boardId: string): Promise<{
    skill: {
      id: string;
      content: string;
      signalCount: number;
      avgStrength: number;
      generationCount: number;
      lastGeneratedAt: string;
    } | null;
  }> {
    return this.request("GET", `/api/habitats/${boardId}/skill`);
  }

  async refreshHabitatSkill(boardId: string): Promise<{
    success: boolean;
    message: string;
    signalCount: number;
  }> {
    return this.request("POST", `/api/habitats/${boardId}/skill/refresh`, {});
  }

  async contributeHabitatSkill(
    boardId: string,
    body: { insight: string; skillCategory?: string },
  ): Promise<{
    success: boolean;
    signal: { id: string; strength: number; clusterKey: string } | null;
  }> {
    return this.request("POST", `/api/habitats/${boardId}/skill/contribute`, body);
  }

  async listSkillSignals(
    boardId: string,
    params?: { minStrength?: number; skillCategory?: string; limit?: number; offset?: number },
  ): Promise<{
    signals: {
      id: string;
      clusterKey: string;
      skillCategory: string;
      sourceType: string;
      subject: string;
      summary: string | null;
      strength: number;
      frequency: number;
      corroboratingAgents: number;
      crossMissionCount: number;
      successfulTasks: number;
      failedTasks: number;
      promotedToSkill: number;
    }[];
    total: number;
  }> {
    const qs = params
      ? "?" +
        new URLSearchParams(
          Object.entries(params)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString()
      : "";
    return this.request("GET", `/api/habitats/${boardId}/skill/signals${qs}`);
  }

  // Notification V2 — MCP self-service (read-only + own attention state)
  async getInbox(
    habitatId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<unknown> {
    const qs = options
      ? "?" +
        new URLSearchParams(
          Object.entries(options)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString()
      : "";
    return this.request("GET", `/api/habitats/${habitatId}/notifications/inbox${qs}`);
  }

  async getHistory(
    habitatId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<unknown> {
    const qs = options
      ? "?" +
        new URLSearchParams(
          Object.entries(options)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString()
      : "";
    return this.request("GET", `/api/habitats/${habitatId}/notifications/history${qs}`);
  }

  async getDelivery(habitatId: string, deliveryId: string): Promise<unknown> {
    return this.request("GET", `/api/habitats/${habitatId}/notifications/deliveries/${deliveryId}`);
  }

  async acknowledgeDelivery(habitatId: string, deliveryId: string): Promise<unknown> {
    return this.request(
      "POST",
      `/api/habitats/${habitatId}/notifications/deliveries/${deliveryId}/ack`,
    );
  }

  async snoozeDelivery(
    habitatId: string,
    deliveryId: string,
    snoozedUntil: string,
  ): Promise<unknown> {
    return this.request(
      "POST",
      `/api/habitats/${habitatId}/notifications/deliveries/${deliveryId}/snooze`,
      { snoozedUntil },
    );
  }

  async clearDelivery(habitatId: string, deliveryId: string): Promise<unknown> {
    return this.request(
      "POST",
      `/api/habitats/${habitatId}/notifications/deliveries/${deliveryId}/clear`,
    );
  }

  async getSubscriptions(habitatId: string): Promise<unknown> {
    return this.request("GET", `/api/habitats/${habitatId}/notifications/subscriptions`);
  }

  // Automation — MCP read/simulate/history-only
  async listAutomationRules(habitatId: string): Promise<unknown> {
    return this.request("GET", `/api/habitats/${habitatId}/automation-rules`);
  }

  async getAutomationRule(ruleId: string): Promise<unknown> {
    return this.request("GET", `/api/automation-rules/${ruleId}`);
  }

  async simulateAutomationRule(ruleId: string, input: Record<string, unknown>): Promise<unknown> {
    return this.request("POST", `/api/automation-rules/${ruleId}/simulate`, input);
  }

  async listAutomationRuns(
    habitatId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<unknown> {
    const qs = options
      ? "?" +
        new URLSearchParams(
          Object.entries(options)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString()
      : "";
    return this.request("GET", `/api/habitats/${habitatId}/automation-runs${qs}`);
  }

  async getAutomationRuleRuns(
    ruleId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<unknown> {
    const qs = options
      ? "?" +
        new URLSearchParams(
          Object.entries(options)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => [k, String(v)] as [string, string]),
        ).toString()
      : "";
    return this.request("GET", `/api/automation-rules/${ruleId}/runs${qs}`);
  }
}
