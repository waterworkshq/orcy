/**
 * API client — thin wrapper around fetch that injects the auth token
 * and returns typed responses. All API calls flow through here.
 */
import type {
  Habitat,
  Task,
  Agent,
  TaskEvent,
  TaskContext,
  TaskComment,
  Subtask,
  CreateTaskInMissionInput,
  MoveTaskInput,
  Artifact,
  TaskPriority,
  EnrichedHabitatEvent,
  MissionTemplate,
  DashboardStats,
  PresenceEntry,
  DecompositionResult,
  TaskWatcher,
  BatchTaskRequest,
  BatchTaskResponse,
  TaskAttachment,
  NotificationPreferences,
  ChatIntegration,
  Anomaly,
  AnomalySettings,
  AutoAssignSettings,
  PrioritizationSettings,
  CapacityReport,
  PredictionResponse,
  BurndownResponse,
  Sprint,
  Organization,
  Team,
  TeamMember,
  PullRequest,
  PipelineEvent,
  CrossHabitatDependency,
  Mission,
  MissionWithProgress,
  MissionEvent,
  CreateMissionInput,
  MoveMissionInput,
  TaskQualityReport,
  ApprovalStatus,
  TaskTimeReport,
  HabitatTimeMetrics,
  TaskBlockedStatus,
  Pulse,
  PulseDigest,
  PostPulseInput,
  PulseReactionCounts,
  ProjectInsight,
  MissionComment,
  ScheduledTask,
  TaskTemplateEntry,
  SavedFilter,
  ReviewRule,
  ReviewRuleCreateInput,
  ReviewRuleUpdateInput,
  SprintCreateInput,
  TaskReviewer,
  IntegrationConnectionView,
  ExternalIssueLink,
  ExternalIntakeCandidate,
  IntegrationSyncRun,
  HabitatSkill,
  SkillSignal,
} from "../types/index.js";

const BASE = "/api";
const SSE_BASE = "/sse";

function getToken(): string | null {
  return localStorage.getItem("orcy_token");
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  if (options.body && !headers["Content-Type"]) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(`${path.startsWith("/sse") ? "" : BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  if (res.status === 204) return {} as T;
  return res.json() as Promise<T>;
}

async function requestBlob(
  path: string,
  options: RequestInit = {},
): Promise<{ blob: Blob; headers: Headers }> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers,
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `HTTP ${res.status}`);
  }

  const blob = await res.blob();
  return { blob, headers: res.headers };
}

async function uploadFile<T>(
  path: string,
  file: File,
  onProgress?: (percent: number) => void,
): Promise<T> {
  const token = getToken();
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}${path}`);
    if (token) {
      xhr.setRequestHeader("Authorization", `Bearer ${token}`);
    }

    xhr.upload.addEventListener("progress", (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener("load", () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText) as T);
        } catch {
          resolve({} as T);
        }
      } else {
        try {
          const body = JSON.parse(xhr.responseText);
          reject(new Error(body.error ?? `HTTP ${xhr.status}`));
        } catch {
          reject(new Error(`HTTP ${xhr.status}`));
        }
      }
    });

    xhr.addEventListener("error", () => reject(new Error("Upload failed")));
    xhr.addEventListener("abort", () => reject(new Error("Upload aborted")));

    const formData = new FormData();
    formData.append("file", file);
    xhr.send(formData);
  });
}

/**
 * Typed API client for all Kanban backend endpoints.
 */
export const api = {
  /**
   * Habitat CRUD, stats, import/export, and event history.
   */
  habitats: {
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
        retrySettings?: import("../types/index.js").RetryPolicy | null;
        anomalySettings?: AnomalySettings | null;
        autoAssignSettings?: AutoAssignSettings | null;
        prioritizationSettings?: PrioritizationSettings | null;
        gitWorktreeSettings?: import("../types/index.js").GitWorktreeSettings | null;
      },
    ) =>
      request<{ board: Habitat }>(`/habitats/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/habitats/${id}`, { method: "DELETE" }),
    stats: (id: string) =>
      request<import("../types/index.js").HabitatStats>(`/habitats/${id}/stats`),
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
      return request<import("../types/index.js").HabitatExport>(
        `/habitats/${boardId}/export${qs ? `?${qs}` : ""}`,
      );
    },
    import: (data: import("../types/index.js").HabitatExport) =>
      request<{
        board: Habitat;
        columns: Habitat["columns"];
        imported: { tasks: number; comments: number; templates: number; webhooks: number };
        warnings: string[];
      }>("/boards/import", { method: "POST", body: JSON.stringify(data) }),
    importInto: (boardId: string, data: import("../types/index.js").HabitatExport) =>
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
    predictions: (boardId: string) =>
      request<PredictionResponse>(`/habitats/${boardId}/predictions`),
    burndown: (boardId: string, days?: number) =>
      request<BurndownResponse>(`/habitats/${boardId}/burndown?days=${days ?? 30}`),
    tasks: (
      boardId: string,
      filters?: {
        status?: string;
        priority?: string;
        search?: string;
        assignedAgentId?: string;
        isArchived?: boolean;
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
      if (filters?.limit !== undefined) params.set("limit", String(filters.limit));
      if (filters?.offset !== undefined) params.set("offset", String(filters.offset));
      if (filters?.sortBy) params.set("sortBy", filters.sortBy);
      if (filters?.sortDir) params.set("sortDir", filters.sortDir);
      const qs = params.toString();
      return request<{ tasks: Task[]; total: number }>(
        `/habitats/${boardId}/tasks${qs ? `?${qs}` : ""}`,
      );
    },
  },

  /**
   * Mission CRUD, move, progress, decompose.
   */
  missions: {
    list: (
      boardId: string,
      filters?: {
        status?: string;
        priority?: string;
        limit?: number;
        offset?: number;
        isArchived?: boolean;
      },
    ) => {
      const params = new URLSearchParams();
      if (filters?.status) params.set("status", filters.status);
      if (filters?.priority) params.set("priority", filters.priority);
      if (filters?.isArchived !== undefined) params.set("isArchived", String(filters.isArchived));
      if (filters?.limit) params.set("limit", String(filters.limit));
      if (filters?.offset) params.set("offset", String(filters.offset));
      const qs = params.toString();
      return request<{ features: MissionWithProgress[]; total: number }>(
        `/habitats/${boardId}/missions${qs ? `?${qs}` : ""}`,
      );
    },
    get: (id: string) => request<{ feature: MissionWithProgress }>(`/missions/${id}`),
    details: (id: string) =>
      request<{
        feature: MissionWithProgress;
        tasks: Task[];
        events: MissionEvent[];
        progress: {
          completed: number;
          total: number;
          percentage: number;
          byStatus: Record<string, number>;
        };
        dependencies: { dependsOn: string[]; blocks: string[] };
      }>(`/missions/${id}/details`),
    create: (boardId: string, data: CreateMissionInput) =>
      request<{ feature: Mission }>(`/habitats/${boardId}/missions`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Mission> & { version?: number }) =>
      request<{ feature: Mission }>(`/missions/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/missions/${id}`, { method: "DELETE" }),
    archive: (id: string) =>
      request<{ feature: Mission }>(`/missions/${id}/archive`, { method: "POST" }),
    unarchive: (id: string) =>
      request<{ feature: Mission }>(`/missions/${id}/unarchive`, { method: "POST" }),
    move: (id: string, data: MoveMissionInput) =>
      request<{ feature: Mission }>(`/missions/${id}/move`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    tasks: (featureId: string) =>
      request<{ tasks: Task[]; total: number }>(`/missions/${featureId}/tasks`),
    createTask: (featureId: string, data: CreateTaskInMissionInput) =>
      request<{ task: Task }>(`/missions/${featureId}/tasks`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    progress: (featureId: string) =>
      request<{
        completed: number;
        total: number;
        percentage: number;
        byStatus: Record<string, number>;
      }>(`/missions/${featureId}/progress`),
    decompose: (featureId: string) =>
      request<DecompositionResult>(`/missions/${featureId}/decompose`, {
        method: "POST",
      }),
  },

  /**
   * Task lifecycle — get, update, claim, start, submit, approve/reject, delegation.
   */
  tasks: {
    get: (id: string) =>
      request<{
        task: Task;
        dependencies: Task[];
        blockedBy: Task[];
        blocking: Task[];
        habitatContext: TaskContext["habitatContext"];
      }>(`/tasks/${id}`),
    update: (id: string, data: Partial<Task> & { version?: number }) =>
      request<{ task: Task }>(`/tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/tasks/${id}`, { method: "DELETE" }),
    clone: (id: string, data?: { includeSubtasks?: boolean; includeComments?: boolean }) =>
      request<{ task: Task }>(`/tasks/${id}/clone`, {
        method: "POST",
        body: JSON.stringify(data ?? {}),
      }),
    claim: (id: string, agentId?: string) =>
      request<{ task: Task }>(`/tasks/${id}/claim`, {
        method: "POST",
        body: JSON.stringify({ agentId }),
      }),
    start: (id: string) => request<{ task: Task }>(`/tasks/${id}/start`, { method: "POST" }),
    move: (id: string, data: MoveTaskInput) =>
      request<{ task: Task }>(`/tasks/${id}/move`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    submit: (id: string, data: { result: string; artifacts?: Artifact[] }) =>
      request<{ success: boolean; task: Partial<Task>; message: string }>(`/tasks/${id}/submit`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    approve: (id: string, reviewerId: string) =>
      request<{ task: Task }>(`/tasks/${id}/approve`, {
        method: "POST",
        body: JSON.stringify({ reviewerId }),
      }),
    reject: (id: string, reviewerId: string, reason: string) =>
      request<{ task: Task }>(`/tasks/${id}/reject`, {
        method: "POST",
        body: JSON.stringify({ reviewerId, reason }),
      }),
    release: (id: string, reason: string) =>
      request<{ task: Task }>(`/tasks/${id}/release`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    fail: (id: string, reason: string) =>
      request<{ task: Task }>(`/tasks/${id}/fail`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      }),
    retry: (id: string) =>
      request<{ task: Task }>(`/tasks/${id}/retry`, {
        method: "POST",
      }),
    delegate: (id: string, toAgentId: string, reason?: string) =>
      request<{ task: Task }>(`/tasks/${id}/delegate`, {
        method: "POST",
        body: JSON.stringify({ toAgentId, reason }),
      }),
    events: (id: string, filters?: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (filters?.limit) params.set("limit", String(filters.limit));
      if (filters?.offset) params.set("offset", String(filters.offset));
      const qs = params.toString();
      return request<{ events: TaskEvent[]; total: number }>(
        `/tasks/${id}/events${qs ? `?${qs}` : ""}`,
      );
    },
    details: (id: string) =>
      request<{
        task: Task;
        feature: {
          id: string;
          title: string;
          description: string;
          acceptanceCriteria: string;
          priority: string;
          status: string;
          dueAt: string | null;
          slaMinutes: number | null;
        } | null;
        siblingTasks: { id: string; title: string; status: string; result: string | null }[];
        subtasks: Subtask[];
        pullRequests: PullRequest[];
        pipelineEvents: PipelineEvent[];
        events: TaskEvent[];
        comments: TaskComment[];
        totalComments: number;
        attachments: TaskAttachment[];
        watchers: TaskWatcher[];
        isWatching: boolean;
        dependencies: Task[];
        crossHabitatDependsOn: CrossHabitatDependency[];
        blockedBy: Task[];
        blocking: Task[];
        habitatContext: { name: string; columns: { name: string; featureCount: number }[] };
      }>(`/tasks/${id}/details`),
    decompose: (id: string) =>
      request<DecompositionResult>(`/tasks/${id}/decompose`, {
        method: "POST",
      }),
    watch: (taskId: string) =>
      request<{ watcher: TaskWatcher }>(`/tasks/${taskId}/watch`, {
        method: "POST",
      }),
    unwatch: (taskId: string) => request<void>(`/tasks/${taskId}/watch`, { method: "DELETE" }),
    watchers: (taskId: string) =>
      request<{ watchers: TaskWatcher[]; isWatching: boolean }>(`/tasks/${taskId}/watchers`),
    batch: (boardId: string, data: BatchTaskRequest) =>
      request<BatchTaskResponse>(`/habitats/${boardId}/tasks/batch`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    pullRequests: (taskId: string) =>
      request<{ pullRequests: import("../types/index.js").PullRequest[] }>(
        `/tasks/${taskId}/pull-requests`,
      ),
    pipelineEvents: (taskId: string) =>
      request<{ pipelineEvents: import("../types/index.js").PipelineEvent[] }>(
        `/tasks/${taskId}/pipeline-events`,
      ),
  },

  /** Subtask CRUD per task. */
  subtasks: {
    list: (taskId: string) =>
      request<{ subtasks: Subtask[]; total: number; completedCount: number }>(
        `/tasks/${taskId}/subtasks`,
      ),
    create: (taskId: string, data: { title: string; order?: number; assigneeId?: string }) =>
      request<{ subtask: Subtask }>(`/tasks/${taskId}/subtasks`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      taskId: string,
      subtaskId: string,
      data: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null },
    ) =>
      request<{ subtask: Subtask }>(`/tasks/${taskId}/subtasks/${subtaskId}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (taskId: string, subtaskId: string) =>
      request<void>(`/tasks/${taskId}/subtasks/${subtaskId}`, { method: "DELETE" }),
  },

  /** Column CRUD and task reordering within a column. */
  columns: {
    create: (
      boardId: string,
      data: {
        name: string;
        order?: number;
        wipLimit?: number | null;
        autoAdvance?: boolean;
        requiresClaim?: boolean;
        nextColumnId?: string | null;
        isTerminal?: boolean;
      },
    ) =>
      request<{ column: import("../types/index.js").Column }>(`/habitats/${boardId}/columns`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: {
        name?: string;
        order?: number;
        wipLimit?: number | null;
        autoAdvance?: boolean;
        requiresClaim?: boolean;
        nextColumnId?: string | null;
        isTerminal?: boolean;
      },
    ) =>
      request<{ column: import("../types/index.js").Column }>(`/columns/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/columns/${id}`, { method: "DELETE" }),
    reorderTask: (
      columnId: string,
      data: {
        taskId: string;
        afterTaskId?: string | null;
        beforeTaskId?: string | null;
      },
    ) =>
      request<{ task: Task }>(`/columns/${columnId}/tasks/reorder`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
  },

  agents: {
    list: () => request<{ agents: Agent[] }>("/agents").then((r) => r.agents),
    listWithTasks: () =>
      request<{ agents: { agent: Agent; currentTaskTitle: string | null }[] }>(
        "/agents?include=currentTask",
      ).then((r) => r.agents),
    get: (id: string) => request<{ agent: Agent }>(`/agents/${id}`),
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
    stats: (id: string) => request<import("../types/index.js").AgentStats>(`/agents/${id}/stats`),
    allStats: () => request<import("../types/index.js").AllAgentStats>("/agents/stats"),
  },

  /** Auth — login, registration, profile management; token is stored in localStorage. */
  auth: {
    login: (data: { username: string; password: string }) =>
      request<{ token: string; user: { id: string; username: string; role: string } }>(
        "/auth/login",
        { method: "POST", body: JSON.stringify(data) },
      ),
    setupStatus: () => request<{ needsSetup: boolean }>("/auth/setup-status"),
    register: (data: { username: string; password: string; displayName?: string }) =>
      request<{
        token: string;
        user: { id: string; username: string; role: string; displayName?: string };
      }>("/auth/register", { method: "POST", body: JSON.stringify(data) }),
    me: () =>
      request<{ user: { id: string; username: string; role: string; displayName?: string } }>(
        "/auth/me",
      ),
    logout: () => request<{ success: boolean }>("/auth/logout", { method: "POST" }),
    changePassword: (data: { currentPassword: string; newPassword: string }) =>
      request<{ success: boolean }>("/auth/change-password", {
        method: "POST",
        body: JSON.stringify(data),
      }),
    updateProfile: (data: { displayName?: string }) =>
      request<{ user: { id: string; username: string; role: string; displayName?: string } }>(
        "/auth/me",
        {
          method: "PATCH",
          body: JSON.stringify(data),
        },
      ),
  },

  comments: {
    list: (taskId: string, filters?: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (filters?.limit) params.set("limit", String(filters.limit));
      if (filters?.offset) params.set("offset", String(filters.offset));
      const qs = params.toString();
      return request<{ comments: TaskComment[]; total: number }>(
        `/tasks/${taskId}/comments${qs ? `?${qs}` : ""}`,
      );
    },
    create: (taskId: string, data: { content: string; parentId?: string }) =>
      request<{ comment: TaskComment }>(`/tasks/${taskId}/comments`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (taskId: string, commentId: string, data: { content: string }) =>
      request<{ comment: TaskComment }>(`/tasks/${taskId}/comments/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (taskId: string, commentId: string) =>
      request<void>(`/tasks/${taskId}/comments/${commentId}`, { method: "DELETE" }),
  },

  missionComments: {
    list: (featureId: string, filters?: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (filters?.limit) params.set("limit", String(filters.limit));
      if (filters?.offset) params.set("offset", String(filters.offset));
      const qs = params.toString();
      return request<{ comments: MissionComment[]; total: number }>(
        `/missions/${featureId}/comments${qs ? `?${qs}` : ""}`,
      );
    },
    create: (featureId: string, data: { content: string; parentId?: string }) =>
      request<{ comment: MissionComment }>(`/missions/${featureId}/comments`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (featureId: string, commentId: string, data: { content: string }) =>
      request<{ comment: MissionComment }>(`/missions/${featureId}/comments/${commentId}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (featureId: string, commentId: string) =>
      request<void>(`/missions/${featureId}/comments/${commentId}`, { method: "DELETE" }),
  },

  /** Task templates — create, apply, and track usage. */
  templates: {
    list: (boardId: string) =>
      request<{ templates: MissionTemplate[] }>(`/habitats/${boardId}/templates`),
    create: (
      boardId: string,
      data: {
        name: string;
        titlePattern: string;
        descriptionPattern?: string;
        priority?: TaskPriority;
        labels?: string[];
        requiredDomain?: string | null;
        requiredCapabilities?: string[];
      },
    ) =>
      request<{ template: MissionTemplate }>(`/habitats/${boardId}/templates`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: {
        name?: string;
        titlePattern?: string;
        descriptionPattern?: string;
        priority?: TaskPriority;
        labels?: string[];
        requiredDomain?: string | null;
        requiredCapabilities?: string[];
      },
    ) =>
      request<{ template: MissionTemplate }>(`/templates/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/templates/${id}`, { method: "DELETE" }),
    recordUsage: (id: string) =>
      request<{ success: boolean }>(`/templates/${id}/usage`, { method: "POST" }),
  },

  dashboard: {
    get: (params?: { boardId?: string; period?: "7d" | "30d" | "90d" }) => {
      const queryParams = new URLSearchParams();
      if (params?.boardId) queryParams.set("boardId", params.boardId);
      if (params?.period) queryParams.set("period", params.period);
      const qs = queryParams.toString();
      return request<DashboardStats>(`/dashboard${qs ? `?${qs}` : ""}`);
    },
  },

  attachments: {
    list: (taskId: string) =>
      request<{ attachments: TaskAttachment[] }>(`/tasks/${taskId}/attachments`),
    upload: (taskId: string, file: File, onProgress?: (percent: number) => void) =>
      uploadFile<{ attachment: TaskAttachment }>(`/tasks/${taskId}/attachments`, file, onProgress),
    download: (id: string) =>
      requestBlob(`/attachments/${id}/download`).then(({ blob, headers }) => {
        const disposition = headers.get("Content-Disposition") || "";
        const match = disposition.match(/filename="(.+?)"/);
        const filename = match?.[1] ?? "download";
        return { blob, filename };
      }),
    delete: (id: string) => request<void>(`/attachments/${id}`, { method: "DELETE" }),
  },

  /** Presence — join/leave/heartbeat for board viewers. */
  presence: {
    join: (data: {
      sessionId: string;
      type: "human" | "agent";
      boardId: string;
      userId?: string;
      userName?: string;
      agentId?: string;
      agentName?: string;
    }) =>
      request<{ success: boolean }>(`${SSE_BASE}/presence/join`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    heartbeat: (data: { sessionId: string; boardId: string; viewingTaskId?: string | null }) =>
      request<{ success: boolean }>(`${SSE_BASE}/presence/heartbeat`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    leave: (data: { sessionId: string; boardId: string }) =>
      request<{ success: boolean }>(`${SSE_BASE}/presence/leave`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    getViewers: (boardId: string) =>
      request<{ viewers: PresenceEntry[] }>(`${SSE_BASE}/presence/viewers/${boardId}`),
  },

  notifications: {
    getGlobalPrefs: () =>
      request<{ preferences: NotificationPreferences; email: string | null }>(
        "/users/me/notification-preferences",
      ),
    updateGlobalPrefs: (data: Partial<NotificationPreferences>) =>
      request<{ preferences: NotificationPreferences }>("/users/me/notification-preferences", {
        method: "PUT",
        body: JSON.stringify(data),
      }),
    getBoardPrefs: (boardId: string) =>
      request<{ preferences: NotificationPreferences }>(
        `/habitats/${boardId}/notification-preferences`,
      ),
    updateBoardPrefs: (boardId: string, data: Partial<NotificationPreferences>) =>
      request<{ preferences: NotificationPreferences }>(
        `/habitats/${boardId}/notification-preferences`,
        {
          method: "PUT",
          body: JSON.stringify(data),
        },
      ),
    updateEmail: (email: string | null) =>
      request<{ success: boolean; email: string | null }>("/users/me/email", {
        method: "PUT",
        body: JSON.stringify({ email }),
      }),
  },

  chatIntegrations: {
    list: (boardId: string) => request<ChatIntegration[]>(`/habitats/${boardId}/chat-integrations`),
    create: (
      boardId: string,
      data: {
        provider: "slack" | "discord";
        webhookUrl: string;
        channelId?: string;
        botToken?: string;
        events?: string[];
      },
    ) =>
      request<ChatIntegration>(`/habitats/${boardId}/chat-integrations`, {
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
  },

  savedFilters: {
    list: (boardId: string) =>
      request<{ savedFilters: SavedFilter[] }>(`/habitats/${boardId}/saved-filters`).then(
        (r) => r.savedFilters,
      ),
    create: (boardId: string, data: { name: string; filterConfig: Record<string, unknown> }) =>
      request<{ savedFilter: SavedFilter }>(`/habitats/${boardId}/saved-filters`, {
        method: "POST",
        body: JSON.stringify(data),
      }).then((r) => r.savedFilter),
    delete: (id: string) =>
      request<{ success: boolean }>(`/saved-filters/${id}`, { method: "DELETE" }),
  },

  organizations: {
    list: () =>
      request<{ organizations: Organization[] }>("/organizations").then((r) => r.organizations),
    get: (id: string) =>
      request<{ organization: Organization }>(`/organizations/${id}`).then((r) => r.organization),
    create: (data: { name: string; slug: string }) =>
      request<{ organization: Organization }>("/organizations", {
        method: "POST",
        body: JSON.stringify(data),
      }).then((r) => r.organization),
    listTeams: (orgId: string) =>
      request<{ teams: Team[] }>(`/organizations/${orgId}/teams`).then((r) => r.teams),
    createTeam: (orgId: string, data: { name: string; slug: string }) =>
      request<{ team: Team }>(`/organizations/${orgId}/teams`, {
        method: "POST",
        body: JSON.stringify(data),
      }).then((r) => r.team),
  },

  teams: {
    get: (id: string) => request<{ team: Team }>(`/teams/${id}`).then((r) => r.team),
    delete: (id: string) => request<void>(`/teams/${id}`, { method: "DELETE" }),
    listMembers: (id: string) =>
      request<{ members: TeamMember[] }>(`/teams/${id}/members`).then((r) => r.members),
    addMember: (
      id: string,
      data: { userId: string; role?: import("../types/index.js").TeamMemberRole },
    ) =>
      request<{ member: TeamMember }>(`/teams/${id}/members`, {
        method: "POST",
        body: JSON.stringify(data),
      }).then((r) => r.member),
    removeMember: (id: string, userId: string) =>
      request<void>(`/teams/${id}/members/${userId}`, { method: "DELETE" }),
    updateMemberRole: (
      id: string,
      userId: string,
      role: import("../types/index.js").TeamMemberRole,
    ) =>
      request<{ member: TeamMember }>(`/teams/${id}/members/${userId}`, {
        method: "PATCH",
        body: JSON.stringify({ role }),
      }).then((r) => r.member),
  },

  myTeams: () => request<{ teams: Team[] }>("/users/me/teams").then((r) => r.teams),

  qualityGates: {
    getReport: (taskId: string) => request<TaskQualityReport>(`/tasks/${taskId}/quality-checklist`),
    updateItem: (
      taskId: string,
      checklistId: string,
      itemId: string,
      data: { isCompleted?: boolean; evidenceUrl?: string; notes?: string },
    ) =>
      request<TaskQualityReport["checklists"][0]["items"][0]>(
        `/tasks/${taskId}/quality-checklist/${checklistId}/items/${itemId}`,
        {
          method: "PUT",
          body: JSON.stringify(data),
        },
      ),
    validate: (taskId: string) =>
      request<{ passed: boolean; failures: { category: string; missingItems: string[] }[] }>(
        `/tasks/${taskId}/quality-checklist/validate`,
        {
          method: "POST",
        },
      ),
    getApprovalStatus: (taskId: string) =>
      request<ApprovalStatus>(`/tasks/${taskId}/approval-status`),
    listTemplates: () =>
      request<{ templates: { id: string; name: string; category: string; isRequired: boolean }[] }>(
        "/quality/templates",
      ).then((r) => r.templates),
  },

  timeTracking: {
    getTaskReport: (taskId: string) => request<TaskTimeReport>(`/tasks/${taskId}/time-report`),
    getBoardMetrics: (boardId: string) =>
      request<HabitatTimeMetrics>(`/habitats/${boardId}/metrics`),
    updateEstimate: (taskId: string, estimatedMinutes: number) =>
      request<{ task: Task }>(`/tasks/${taskId}/estimate`, {
        method: "PUT",
        body: JSON.stringify({ estimatedMinutes }),
      }).then((r) => r.task),
  },

  dependencies: {
    addTaskDependency: (taskId: string, dependsOnTaskId: string) =>
      request<{ success: boolean }>(`/tasks/${taskId}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ dependsOnTaskId }),
      }),
    removeTaskDependency: (taskId: string, depId: string) =>
      request<{ success: boolean }>(`/tasks/${taskId}/dependencies/${depId}`, { method: "DELETE" }),
    getTaskDependencies: (taskId: string) =>
      request<{
        dependsOn: { taskId: string; taskTitle: string; status: string }[];
        blocking: { taskId: string; taskTitle: string; status: string }[];
      }>(`/tasks/${taskId}/dependencies`),
    getBlockedStatus: (taskId: string) =>
      request<TaskBlockedStatus>(`/tasks/${taskId}/blocked-status`),
    addFeatureDependency: (featureId: string, dependsOnFeatureId: string) =>
      request<{ success: boolean }>(`/missions/${featureId}/dependencies`, {
        method: "POST",
        body: JSON.stringify({ dependsOnFeatureId }),
      }),
    removeFeatureDependency: (featureId: string, depId: string) =>
      request<{ success: boolean }>(`/missions/${featureId}/dependencies/${depId}`, {
        method: "DELETE",
      }),
  },

  pulse: {
    listByMission: (missionId: string, params?: Record<string, string | number>) => {
      const qs = params
        ? "?" + new URLSearchParams(params as Record<string, string>).toString()
        : "";
      return request<{ items: Pulse[]; total: number }>(`/missions/${missionId}/pulse${qs}`);
    },
    listByBoard: (boardId: string, params?: Record<string, string | number>) => {
      const qs = params
        ? "?" + new URLSearchParams(params as Record<string, string>).toString()
        : "";
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
  },

  audit: {
    export: (boardId: string, params: Record<string, string>) => {
      const qs = new URLSearchParams(params).toString();
      return request<string>(`/habitats/${boardId}/audit/export?${qs}`);
    },
    summary: (boardId: string, params?: { since?: string; until?: string }) => {
      const qs = params
        ? "?" + new URLSearchParams(params as Record<string, string>).toString()
        : "";
      return request<{
        totalEvents: number;
        byAction: Record<string, number>;
        byActorType: Record<string, number>;
        byDay: { date: string; count: number }[];
        topFeatures: { featureId: string; featureTitle: string; count: number }[];
      }>(`/habitats/${boardId}/audit/summary${qs}`);
    },
    schedules: {
      list: (boardId: string) =>
        request<{
          schedules: Array<{
            id: string;
            name: string;
            format: string;
            schedule: string;
            enabled: boolean;
            lastRunAt: string | null;
            nextRunAt: string;
          }>;
        }>(`/habitats/${boardId}/audit/schedules`),
      create: (
        boardId: string,
        data: { name: string; format: string; filters?: Record<string, unknown>; schedule: string },
      ) =>
        request<{ schedule: unknown }>(`/habitats/${boardId}/audit/schedule`, {
          method: "POST",
          body: JSON.stringify(data),
        }),
      delete: (scheduleId: string) =>
        request<void>(`/audit/schedules/${scheduleId}`, { method: "DELETE" }),
    },
  },

  scheduledTasks: {
    list: (boardId: string) =>
      request<{ scheduledTasks: ScheduledTask[] }>(`/habitats/${boardId}/scheduled-tasks`),
    get: (id: string) => request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${id}`),
    create: (
      boardId: string,
      data: {
        name: string;
        description?: string;
        templateId?: string | null;
        scheduleType: "once" | "interval" | "cron";
        cronExpression?: string | null;
        intervalMinutes?: number | null;
        scheduledAt?: string | null;
        timezone?: string;
        missionTitle: string;
        missionDescription?: string;
        missionPriority?: import("../types/index.js").TaskPriority;
        missionLabels?: string[];
        missionDomain?: string | null;
        tasksTemplate?: TaskTemplateEntry[];
      },
    ) =>
      request<{ scheduledTask: ScheduledTask }>(`/habitats/${boardId}/scheduled-tasks`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    update: (
      id: string,
      data: {
        name?: string;
        description?: string;
        scheduleType?: "once" | "interval" | "cron";
        cronExpression?: string | null;
        intervalMinutes?: number | null;
        scheduledAt?: string | null;
        timezone?: string;
        missionTitle?: string;
        missionDescription?: string;
        missionPriority?: import("../types/index.js").TaskPriority;
        missionLabels?: string[];
        missionDomain?: string | null;
        tasksTemplate?: TaskTemplateEntry[];
        enabled?: boolean;
      },
    ) =>
      request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${id}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/scheduled-tasks/${id}`, { method: "DELETE" }),
    run: (id: string) =>
      request<{ success: boolean; featureId?: string; error?: string }>(
        `/scheduled-tasks/${id}/run`,
        {
          method: "POST",
        },
      ),
    enable: (id: string) =>
      request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${id}/enable`, {
        method: "POST",
      }),
    disable: (id: string) =>
      request<{ scheduledTask: ScheduledTask }>(`/scheduled-tasks/${id}/disable`, {
        method: "POST",
      }),
  },

  health: {
    get: (boardId: string) =>
      request<{
        boardId: string;
        score: number;
        grade: string;
        dimensions: Record<string, { score: number } & Record<string, number>>;
        recommendations: string[];
        snapshotAt: string;
      }>(`/habitats/${boardId}/health`),
    history: (boardId: string, days?: number) => {
      const params = days ? `?days=${days}` : "";
      return request<{ snapshots: Array<{ score: number; grade: string; snapshotAt: string }> }>(
        `/habitats/${boardId}/health/history${params}`,
      );
    },
  },

  insights: {
    list: (boardId: string, params?: Record<string, string | number>) => {
      const qs = params
        ? "?" + new URLSearchParams(params as Record<string, string>).toString()
        : "";
      return request<{ items: ProjectInsight[]; total: number }>(
        `/habitats/${boardId}/insights${qs}`,
      );
    },
    promote: (
      boardId: string,
      body: { sourcePulseId: string; relevanceTags?: string[]; subject?: string; body?: string },
    ) =>
      request<{ insight: ProjectInsight }>(`/habitats/${boardId}/insights`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    deactivate: (boardId: string, id: string) =>
      request<{ success: boolean }>(`/habitats/${boardId}/insights/${id}`, { method: "DELETE" }),
  },

  reviewRules: {
    list: (habitatId: string) =>
      request<{ reviewRules: ReviewRule[] }>(`/habitats/${habitatId}/review-rules`),
    create: (habitatId: string, body: ReviewRuleCreateInput) =>
      request<{ reviewRule: ReviewRule }>(`/habitats/${habitatId}/review-rules`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    update: (ruleId: string, body: ReviewRuleUpdateInput) =>
      request<{ reviewRule: ReviewRule }>(`/review-rules/${ruleId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    delete: (ruleId: string) => request<void>(`/review-rules/${ruleId}`, { method: "DELETE" }),
  },

  reviewers: {
    list: (taskId: string) => request<{ reviewers: TaskReviewer[] }>(`/tasks/${taskId}/reviewers`),
  },

  sprints: {
    list: (habitatId: string) => request<{ sprints: Sprint[] }>(`/habitats/${habitatId}/sprints`),
    getActive: (habitatId: string) =>
      request<{ sprint: Sprint | null }>(`/habitats/${habitatId}/sprints/active`),
    create: (habitatId: string, body: SprintCreateInput) =>
      request<{ sprint: Sprint }>(`/habitats/${habitatId}/sprints`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    start: (sprintId: string) =>
      request<{ sprint: Sprint }>(`/sprints/${sprintId}/start`, { method: "POST" }),
    complete: (sprintId: string) =>
      request<{ sprint: Sprint }>(`/sprints/${sprintId}/complete`, { method: "POST" }),
    cancel: (sprintId: string) =>
      request<{ sprint: Sprint }>(`/sprints/${sprintId}/cancel`, { method: "POST" }),
    addMission: (sprintId: string, missionId: string) =>
      request<{ sprint: Sprint }>(`/sprints/${sprintId}/missions`, {
        method: "POST",
        body: JSON.stringify({ missionId }),
      }),
    removeMission: (sprintId: string, missionId: string) =>
      request<{ sprint: Sprint }>(`/sprints/${sprintId}/missions/${missionId}`, {
        method: "DELETE",
      }),
  },

  integrations: {
    list: (habitatId: string) =>
      request<{ integrations: IntegrationConnectionView[] }>(`/habitats/${habitatId}/integrations`),
    createGitHubPat: (
      habitatId: string,
      data: {
        name: string;
        token: string;
        repositoryOwner: string;
        repositoryName: string;
        autoImport?: boolean;
        pullEnabled?: boolean;
      },
    ) =>
      request<{ integration: IntegrationConnectionView }>(
        `/habitats/${habitatId}/integrations/github/pat`,
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      ),
    startGitHubDeviceFlow: (habitatId: string) =>
      request<{
        deviceCode: string;
        userCode: string;
        verificationUri: string;
        expiresIn: number;
        interval: number;
      }>(`/habitats/${habitatId}/integrations/github/oauth/device/start`, { method: "POST" }),
    pollGitHubDeviceFlow: (habitatId: string, data: { deviceCode: string }) =>
      request<{ status?: string; integration?: IntegrationConnectionView }>(
        `/habitats/${habitatId}/integrations/github/oauth/device/poll`,
        { method: "POST", body: JSON.stringify(data) },
      ),
    update: (
      connectionId: string,
      data: {
        name?: string;
        enabled?: boolean;
        pullEnabled?: boolean;
        autoImport?: boolean;
      },
    ) =>
      request<{ integration: IntegrationConnectionView }>(`/integrations/${connectionId}`, {
        method: "PATCH",
        body: JSON.stringify(data),
      }),
    disable: (connectionId: string) =>
      request<void>(`/integrations/${connectionId}`, { method: "DELETE" }),
    sync: (connectionId: string) =>
      request<{ created: number; updated: number; skipped: number; failed: number }>(
        `/integrations/${connectionId}/sync`,
        {
          method: "POST",
        },
      ),
    listSyncRuns: (connectionId: string) =>
      request<{ syncRuns: IntegrationSyncRun[] }>(`/integrations/${connectionId}/sync-runs`),
    listMissionLinks: (missionId: string) =>
      request<{ externalLinks: ExternalIssueLink[] }>(`/missions/${missionId}/external-links`),
    startJiraOAuth: (habitatId: string) =>
      request<{ authUrl: string; state: string; redirectPort: number }>(
        `/habitats/${habitatId}/integrations/jira/oauth/start`,
        { method: "POST" },
      ),
    completeJiraOAuth: (
      habitatId: string,
      data: { code: string; state: string; redirectPort: number },
    ) =>
      request<{ integration: IntegrationConnectionView }>(
        `/habitats/${habitatId}/integrations/jira/oauth/complete`,
        { method: "POST", body: JSON.stringify(data) },
      ),
    createJiraApiKey: (
      habitatId: string,
      data: {
        name: string;
        email: string;
        token: string;
        siteUrl: string;
        projectKey: string;
        autoImport?: boolean;
        pullEnabled?: boolean;
      },
    ) =>
      request<{ integration: IntegrationConnectionView }>(
        `/habitats/${habitatId}/integrations/jira/api-key`,
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      ),
    startLinearOAuth: (habitatId: string) =>
      request<{ authUrl: string; state: string; redirectPort: number }>(
        `/habitats/${habitatId}/integrations/linear/oauth/start`,
        { method: "POST" },
      ),
    completeLinearOAuth: (
      habitatId: string,
      data: { code: string; state: string; redirectPort: number },
    ) =>
      request<{
        integration: IntegrationConnectionView;
        teams: Array<{ id: string; name: string; key: string }>;
      }>(`/habitats/${habitatId}/integrations/linear/oauth/complete`, {
        method: "POST",
        body: JSON.stringify(data),
      }),
    createLinearApiKey: (
      habitatId: string,
      data: {
        name: string;
        token: string;
        teamId: string;
        autoImport?: boolean;
        pullEnabled?: boolean;
      },
    ) =>
      request<{ integration: IntegrationConnectionView }>(
        `/habitats/${habitatId}/integrations/linear/api-key`,
        {
          method: "POST",
          body: JSON.stringify(data),
        },
      ),
    listIntakeCandidates: (
      habitatId: string,
      filters?: { reviewStatus?: string; provider?: string },
    ) => {
      const params = new URLSearchParams();
      if (filters?.reviewStatus) params.set("reviewStatus", filters.reviewStatus);
      if (filters?.provider) params.set("provider", filters.provider);
      const qs = params.toString();
      return request<{ candidates: ExternalIntakeCandidate[]; total: number }>(
        `/habitats/${habitatId}/intake-candidates${qs ? `?${qs}` : ""}`,
      );
    },
    getIntakeCandidate: (candidateId: string) =>
      request<{ candidate: ExternalIntakeCandidate }>(`/intake-candidates/${candidateId}`),
    promoteCandidate: (candidateId: string) =>
      request<{ mission: Mission; link: ExternalIssueLink; candidate: ExternalIntakeCandidate }>(
        `/intake-candidates/${candidateId}/promote`,
        { method: "POST" },
      ),
    ignoreCandidate: (candidateId: string) =>
      request<{ candidate: ExternalIntakeCandidate }>(`/intake-candidates/${candidateId}/ignore`, {
        method: "POST",
      }),
    markCandidateNeedsClarification: (candidateId: string) =>
      request<{ candidate: ExternalIntakeCandidate }>(
        `/intake-candidates/${candidateId}/needs-clarification`,
        { method: "POST" },
      ),
  },
  daemons: {
    list: () => request<{ daemons: import("../types/index.js").DaemonInfo[] }>("/daemons"),
    get: (id: string) => request<import("../types/index.js").DaemonDetail>(`/daemons/${id}`),
    register: (data: {
      name: string;
      habitatIds: string[];
      maxConcurrent?: number;
      cliPreferences?: string[];
    }) =>
      request<{
        daemonId: string;
        agents: Array<{ id: string; name: string; type: string; apiKey: string }>;
      }>("/daemons/register", { method: "POST", body: JSON.stringify(data) }),
    start: (id: string, dataDir?: string) =>
      request<{ status: string }>(`/daemons/${id}/start`, {
        method: "POST",
        body: JSON.stringify(dataDir ? { dataDir } : {}),
      }),
    stop: (id: string) => request<{ status: string }>(`/daemons/${id}/stop`, { method: "POST" }),
    detectClis: () =>
      request<{ clis: import("../types/index.js").DetectedCli[] }>("/daemons/detect-clis"),
  },
  skill: {
    get: (habitatId: string) =>
      request<{ skill: HabitatSkill | null }>(`/habitats/${habitatId}/skill`),
    refresh: (habitatId: string) =>
      request<{ skill: HabitatSkill }>(`/habitats/${habitatId}/skill/refresh`, { method: "POST" }),
    contribute: (habitatId: string, body: { insight: string; skillCategory?: string }) =>
      request<{ signal: SkillSignal }>(`/habitats/${habitatId}/skill/contribute`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    signals: (habitatId: string, params?: Record<string, string | number>) => {
      const qs = params
        ? "?" + new URLSearchParams(params as Record<string, string>).toString()
        : "";
      return request<{ signals: SkillSignal[]; total: number }>(
        `/habitats/${habitatId}/skill/signals${qs}`,
      );
    },
    deleteSignal: (habitatId: string, signalId: string) =>
      request<{ success: boolean }>(`/habitats/${habitatId}/skill/signals/${signalId}`, {
        method: "DELETE",
      }),
  },
};

export type ApiClient = typeof api;
