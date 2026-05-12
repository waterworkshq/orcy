/**
 * API client — thin wrapper around fetch that injects the auth token
 * and returns typed responses. All API calls flow through here.
 */
import type {
  Board,
  Task,
  Agent,
  TaskEvent,
  TaskContext,
  TaskComment,
  Subtask,
  CreateTaskInFeatureInput,
  MoveTaskInput,
  Artifact,
  TaskPriority,
  EnrichedBoardEvent,
  FeatureTemplate,
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
  CapacityReport,
  PredictionResponse,
  BurndownResponse,
  Organization,
  Team,
  TeamMember,
  PullRequest,
  PipelineEvent,
  CrossBoardDependency,
  Feature,
  FeatureWithProgress,
  FeatureEvent,
  CreateFeatureInput,
  MoveFeatureInput,
  FeatureDecompositionResult,
  TaskQualityReport,
  ApprovalStatus,
  TaskTimeReport,
  BoardTimeMetrics,
  TaskBlockedStatus,
  Pulse,
  PulseDigest,
  PostPulseInput,
  PulseReactionCounts,
  ProjectInsight,
} from '../types/index.js';

const BASE = '/api';
const SSE_BASE = '/sse';

function getToken(): string | null {
  return localStorage.getItem('orcy_token');
}

async function request<T>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  if (options.body && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const res = await fetch(`${path.startsWith('/sse') ? '' : BASE}${path}`, {
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
  options: RequestInit = {}
): Promise<{ blob: Blob; headers: Headers }> {
  const token = getToken();
  const headers: Record<string, string> = {
    ...(options.headers as Record<string, string>),
  };
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
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
  onProgress?: (percent: number) => void
): Promise<T> {
  const token = getToken();
  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}${path}`);
    if (token) {
      xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    }

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    });

    xhr.addEventListener('load', () => {
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

    xhr.addEventListener('error', () => reject(new Error('Upload failed')));
    xhr.addEventListener('abort', () => reject(new Error('Upload aborted')));

    const formData = new FormData();
    formData.append('file', file);
    xhr.send(formData);
  });
}

/**
 * Typed API client for all Kanban backend endpoints.
 */
export const api = {
  /**
   * Board CRUD, stats, import/export, and event history.
   */
  boards: {
    list: () =>
      request<{ boards: Board[] }>('/boards').then((r) => r.boards),
    get: (id: string) =>
      request<{ board: Board; columns: Board['columns']; features: FeatureWithProgress[] }>(
        `/boards/${id}`
      ),
    create: (data: { name: string; description?: string; teamId?: string | null }) =>
      request<{ board: Board; columns: Board['columns'] }>('/boards', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: { name?: string; description?: string; retrySettings?: import('../types/index.js').RetryPolicy | null; anomalySettings?: AnomalySettings | null; autoAssignSettings?: AutoAssignSettings | null }) =>
      request<{ board: Board }>(`/boards/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/boards/${id}`, { method: 'DELETE' }),
    stats: (id: string) =>
      request<import('../types/index.js').BoardStats>(`/boards/${id}/stats`),
    events: (
      boardId: string,
      filters?: {
        limit?: number;
        offset?: number;
        action?: string;
        actorType?: string;
        actorId?: string;
        since?: string;
      }
    ) => {
      const params = new URLSearchParams();
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      if (filters?.action) params.set('action', filters.action);
      if (filters?.actorType) params.set('actorType', filters.actorType);
      if (filters?.actorId) params.set('actorId', filters.actorId);
      if (filters?.since) params.set('since', filters.since);
      const qs = params.toString();
      return request<{ events: EnrichedBoardEvent[]; total: number }>(
        `/boards/${boardId}/events${qs ? `?${qs}` : ''}`
      );
    },
    export: (boardId: string, params?: { include?: string; format?: string }) => {
      const queryParams = new URLSearchParams();
      if (params?.include) queryParams.set('include', params.include);
      if (params?.format) queryParams.set('format', params.format);
      const qs = queryParams.toString();
      return request<import('../types/index.js').BoardExport>(
        `/boards/${boardId}/export${qs ? `?${qs}` : ''}`
      );
    },
    import: (data: import('../types/index.js').BoardExport) =>
      request<{
        board: Board;
        columns: Board['columns'];
        imported: { tasks: number; comments: number; templates: number; webhooks: number };
        warnings: string[];
      }>('/boards/import', { method: 'POST', body: JSON.stringify(data) }),
    importInto: (boardId: string, data: import('../types/index.js').BoardExport) =>
      request<{
        board: Board;
        columns: Board['columns'];
        imported: { tasks: number; comments: number; templates: number; webhooks: number };
        warnings: string[];
      }>(`/boards/${boardId}/import`, { method: 'POST', body: JSON.stringify(data) }),
    anomalies: (boardId: string) =>
      request<{ anomalies: Anomaly[] }>(`/boards/${boardId}/anomalies`),
    capacity: (boardId: string) =>
      request<CapacityReport>(`/boards/${boardId}/capacity`),
    predictions: (boardId: string) =>
      request<PredictionResponse>(`/boards/${boardId}/predictions`),
    burndown: (boardId: string, days?: number) =>
      request<BurndownResponse>(`/boards/${boardId}/burndown?days=${days ?? 30}`),
  },

  /**
   * Feature CRUD, move, progress, decompose.
   */
  features: {
    list: (
      boardId: string,
      filters?: {
        status?: string;
        priority?: string;
        limit?: number;
        offset?: number;
        isArchived?: boolean;
      }
    ) => {
      const params = new URLSearchParams();
      if (filters?.status) params.set('status', filters.status);
      if (filters?.priority) params.set('priority', filters.priority);
      if (filters?.isArchived !== undefined) params.set('isArchived', String(filters.isArchived));
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      return request<{ features: FeatureWithProgress[]; total: number }>(
        `/boards/${boardId}/features${qs ? `?${qs}` : ''}`
      );
    },
    get: (id: string) =>
      request<{ feature: FeatureWithProgress }>(`/features/${id}`),
    details: (id: string) =>
      request<{
        feature: FeatureWithProgress;
        tasks: Task[];
        events: FeatureEvent[];
        progress: { completed: number; total: number; percentage: number; byStatus: Record<string, number> };
        dependencies: { dependsOn: string[]; blocks: string[] };
      }>(`/features/${id}/details`),
    create: (boardId: string, data: CreateFeatureInput) =>
      request<{ feature: Feature }>(`/boards/${boardId}/features`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: Partial<Feature> & { version?: number }) =>
      request<{ feature: Feature }>(`/features/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/features/${id}`, { method: 'DELETE' }),
    archive: (id: string) => request<{ feature: Feature }>(`/features/${id}/archive`, { method: 'POST' }),
    unarchive: (id: string) => request<{ feature: Feature }>(`/features/${id}/unarchive`, { method: 'POST' }),
    move: (id: string, data: MoveFeatureInput) =>
      request<{ feature: Feature }>(`/features/${id}/move`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    tasks: (featureId: string) =>
      request<{ tasks: Task[]; total: number }>(`/features/${featureId}/tasks`),
    createTask: (featureId: string, data: CreateTaskInFeatureInput) =>
      request<{ task: Task }>(`/features/${featureId}/tasks`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    progress: (featureId: string) =>
      request<{ completed: number; total: number; percentage: number; byStatus: Record<string, number> }>(`/features/${featureId}/progress`),
    decompose: (featureId: string) =>
      request<FeatureDecompositionResult>(`/features/${featureId}/decompose`, {
        method: 'POST',
      }),
  },

  /**
   * Task lifecycle — get, update, claim, start, submit, approve/reject, delegation.
   */
  tasks: {
    get: (id: string) => request<{ task: Task; dependencies: Task[]; blockedBy: Task[]; blocking: Task[]; boardContext: TaskContext['boardContext'] }>(`/tasks/${id}`),
    update: (id: string, data: Partial<Task> & { version?: number }) =>
      request<{ task: Task }>(`/tasks/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/tasks/${id}`, { method: 'DELETE' }),
    clone: (id: string, data?: { includeSubtasks?: boolean; includeComments?: boolean }) =>
      request<{ task: Task }>(`/tasks/${id}/clone`, {
        method: 'POST',
        body: JSON.stringify(data ?? {}),
      }),
    claim: (id: string, agentId?: string) =>
      request<{ task: Task }>(`/tasks/${id}/claim`, {
        method: 'POST',
        body: JSON.stringify({ agentId }),
      }),
    start: (id: string) =>
      request<{ task: Task }>(`/tasks/${id}/start`, { method: 'POST' }),
    move: (id: string, data: MoveTaskInput) =>
      request<{ task: Task }>(`/tasks/${id}/move`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    submit: (
      id: string,
      data: { result: string; artifacts?: Artifact[] }
    ) =>
      request<{ success: boolean; task: Partial<Task>; message: string }>(
        `/tasks/${id}/submit`,
        { method: 'POST', body: JSON.stringify(data) }
      ),
    approve: (id: string, reviewerId: string) =>
      request<{ task: Task }>(`/tasks/${id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ reviewerId }),
      }),
    reject: (id: string, reviewerId: string, reason: string) =>
      request<{ task: Task }>(`/tasks/${id}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reviewerId, reason }),
      }),
    release: (id: string, reason: string) =>
      request<{ task: Task }>(`/tasks/${id}/release`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    fail: (id: string, reason: string) =>
      request<{ task: Task }>(`/tasks/${id}/fail`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      }),
    retry: (id: string) =>
      request<{ task: Task }>(`/tasks/${id}/retry`, {
        method: 'POST',
      }),
    delegate: (id: string, toAgentId: string, reason?: string) =>
      request<{ task: Task }>(`/tasks/${id}/delegate`, {
        method: 'POST',
        body: JSON.stringify({ toAgentId, reason }),
      }),
    events: (
      id: string,
      filters?: { limit?: number; offset?: number }
    ) => {
      const params = new URLSearchParams();
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      return request<{ events: TaskEvent[]; total: number }>(
        `/tasks/${id}/events${qs ? `?${qs}` : ''}`
      );
    },
    details: (id: string) =>
      request<{
        task: Task;
        feature: { id: string; title: string; description: string; acceptanceCriteria: string; priority: string; status: string; dueAt: string | null; slaMinutes: number | null } | null;
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
        crossBoardDependsOn: CrossBoardDependency[];
        blockedBy: Task[];
        blocking: Task[];
        boardContext: { name: string; columns: { name: string; featureCount: number }[] };
      }>(`/tasks/${id}/details`),
    decompose: (id: string) =>
      request<DecompositionResult>(`/tasks/${id}/decompose`, {
        method: 'POST',
      }),
    watch: (taskId: string) =>
      request<{ watcher: TaskWatcher }>(`/tasks/${taskId}/watch`, {
        method: 'POST',
      }),
    unwatch: (taskId: string) =>
      request<void>(`/tasks/${taskId}/watch`, { method: 'DELETE' }),
    watchers: (taskId: string) =>
      request<{ watchers: TaskWatcher[]; isWatching: boolean }>(`/tasks/${taskId}/watchers`),
    batch: (boardId: string, data: BatchTaskRequest) =>
      request<BatchTaskResponse>(`/boards/${boardId}/tasks/batch`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    pullRequests: (taskId: string) =>
      request<{ pullRequests: import('../types/index.js').PullRequest[] }>(`/tasks/${taskId}/pull-requests`),
    pipelineEvents: (taskId: string) =>
      request<{ pipelineEvents: import('../types/index.js').PipelineEvent[] }>(`/tasks/${taskId}/pipeline-events`),
  },

  /** Subtask CRUD per task. */
  subtasks: {
    list: (taskId: string) =>
      request<{ subtasks: Subtask[]; total: number; completedCount: number }>(
        `/tasks/${taskId}/subtasks`
      ),
    create: (taskId: string, data: { title: string; order?: number; assigneeId?: string }) =>
      request<{ subtask: Subtask }>(`/tasks/${taskId}/subtasks`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (taskId: string, subtaskId: string, data: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null }) =>
      request<{ subtask: Subtask }>(`/tasks/${taskId}/subtasks/${subtaskId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (taskId: string, subtaskId: string) =>
      request<void>(`/tasks/${taskId}/subtasks/${subtaskId}`, { method: 'DELETE' }),
  },

  /** Column CRUD and task reordering within a column. */
  columns: {
    create: (boardId: string, data: {
      name: string;
      order?: number;
      wipLimit?: number | null;
      autoAdvance?: boolean;
      requiresClaim?: boolean;
      nextColumnId?: string | null;
      isTerminal?: boolean;
    }) =>
      request<{ column: import('../types/index.js').Column }>(
        `/boards/${boardId}/columns`,
        { method: 'POST', body: JSON.stringify(data) }
      ),
    update: (id: string, data: {
      name?: string;
      order?: number;
      wipLimit?: number | null;
      autoAdvance?: boolean;
      requiresClaim?: boolean;
      nextColumnId?: string | null;
      isTerminal?: boolean;
    }) =>
      request<{ column: import('../types/index.js').Column }>(`/columns/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/columns/${id}`, { method: 'DELETE' }),
    reorderTask: (columnId: string, data: {
      taskId: string;
      afterTaskId?: string | null;
      beforeTaskId?: string | null;
    }) =>
      request<{ task: Task }>(`/columns/${columnId}/tasks/reorder`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },

  agents: {
    list: () => request<{ agents: Agent[] }>('/agents').then((r) => r.agents),
    listWithTasks: () =>
      request<{ agents: { agent: Agent; currentTaskTitle: string | null }[] }>(
        '/agents?include=currentTask'
      ).then((r) => r.agents),
    get: (id: string) => request<{ agent: Agent }>(`/agents/${id}`),
    create: (data: {
      name: string;
      type: 'claude-code' | 'codex' | 'opencode';
      domain: string;
      capabilities?: string[];
    }) =>
      request<{ agent: Agent; apiKey: string }>('/agents', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    heartbeat: (id: string, data?: { taskId?: string; progress?: string }) =>
      request<{ status: string; nextCheckIn: number }>(`/agents/${id}/heartbeat`, {
        method: 'POST',
        body: JSON.stringify(data ?? {}),
      }),
    delete: (id: string) => request<void>(`/agents/${id}`, { method: 'DELETE' }),
    stats: (id: string) =>
      request<import('../types/index.js').AgentStats>(`/agents/${id}/stats`),
    allStats: () =>
      request<import('../types/index.js').AllAgentStats>('/agents/stats'),
  },

  /** Auth — login, registration, profile management; token is stored in localStorage. */
  auth: {
    login: (data: { username: string; password: string }) =>
      request<{ token: string; user: { id: string; username: string; role: string } }>(
        '/auth/login',
        { method: 'POST', body: JSON.stringify(data) }
      ),
    setupStatus: () =>
      request<{ needsSetup: boolean }>('/auth/setup-status'),
    register: (data: { username: string; password: string; displayName?: string }) =>
      request<{ token: string; user: { id: string; username: string; role: string; displayName?: string } }>(
        '/auth/register',
        { method: 'POST', body: JSON.stringify(data) }
      ),
    me: () =>
      request<{ user: { id: string; username: string; role: string; displayName?: string } }>('/auth/me'),
    logout: () =>
      request<{ success: boolean }>('/auth/logout', { method: 'POST' }),
    changePassword: (data: { currentPassword: string; newPassword: string }) =>
      request<{ success: boolean }>('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    updateProfile: (data: { displayName?: string }) =>
      request<{ user: { id: string; username: string; role: string; displayName?: string } }>('/auth/me', {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
  },

  comments: {
    list: (taskId: string, filters?: { limit?: number; offset?: number }) => {
      const params = new URLSearchParams();
      if (filters?.limit) params.set('limit', String(filters.limit));
      if (filters?.offset) params.set('offset', String(filters.offset));
      const qs = params.toString();
      return request<{ comments: TaskComment[]; total: number }>(
        `/tasks/${taskId}/comments${qs ? `?${qs}` : ''}`
      );
    },
    create: (taskId: string, data: { content: string; parentId?: string }) =>
      request<{ comment: TaskComment }>(`/tasks/${taskId}/comments`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (taskId: string, commentId: string, data: { content: string }) =>
      request<{ comment: TaskComment }>(`/tasks/${taskId}/comments/${commentId}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (taskId: string, commentId: string) =>
      request<void>(`/tasks/${taskId}/comments/${commentId}`, { method: 'DELETE' }),
  },

  /** Task templates — create, apply, and track usage. */
  templates: {
    list: (boardId: string) =>
      request<{ templates: FeatureTemplate[] }>(`/boards/${boardId}/templates`),
    create: (boardId: string, data: {
      name: string;
      titlePattern: string;
      descriptionPattern?: string;
      priority?: TaskPriority;
      labels?: string[];
      requiredDomain?: string | null;
      requiredCapabilities?: string[];
    }) =>
      request<{ template: FeatureTemplate }>(`/boards/${boardId}/templates`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: {
      name?: string;
      titlePattern?: string;
      descriptionPattern?: string;
      priority?: TaskPriority;
      labels?: string[];
      requiredDomain?: string | null;
      requiredCapabilities?: string[];
    }) =>
      request<{ template: FeatureTemplate }>(`/templates/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      }),
    delete: (id: string) => request<void>(`/templates/${id}`, { method: 'DELETE' }),
    recordUsage: (id: string) =>
      request<{ success: boolean }>(`/templates/${id}/usage`, { method: 'POST' }),
  },

  dashboard: {
    get: (params?: { boardId?: string; period?: '7d' | '30d' | '90d' }) => {
      const queryParams = new URLSearchParams();
      if (params?.boardId) queryParams.set('boardId', params.boardId);
      if (params?.period) queryParams.set('period', params.period);
      const qs = queryParams.toString();
      return request<DashboardStats>(`/dashboard${qs ? `?${qs}` : ''}`);
    },
  },

  attachments: {
    list: (taskId: string) =>
      request<{ attachments: TaskAttachment[] }>(`/tasks/${taskId}/attachments`),
    upload: (taskId: string, file: File, onProgress?: (percent: number) => void) =>
      uploadFile<{ attachment: TaskAttachment }>(`/tasks/${taskId}/attachments`, file, onProgress),
    download: (id: string) =>
      requestBlob(`/attachments/${id}/download`).then(({ blob, headers }) => {
        const disposition = headers.get('Content-Disposition') || '';
        const match = disposition.match(/filename="(.+?)"/);
        const filename = match?.[1] ?? 'download';
        return { blob, filename };
      }),
    delete: (id: string) =>
      request<void>(`/attachments/${id}`, { method: 'DELETE' }),
  },

  /** Presence — join/leave/heartbeat for board viewers. */
  presence: {
    join: (data: {
      sessionId: string;
      type: 'human' | 'agent';
      boardId: string;
      userId?: string;
      userName?: string;
      agentId?: string;
      agentName?: string;
    }) =>
      request<{ success: boolean }>(`${SSE_BASE}/presence/join`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    heartbeat: (data: { sessionId: string; boardId: string; viewingTaskId?: string | null }) =>
      request<{ success: boolean }>(`${SSE_BASE}/presence/heartbeat`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    leave: (data: { sessionId: string; boardId: string }) =>
      request<{ success: boolean }>(`${SSE_BASE}/presence/leave`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    getViewers: (boardId: string) =>
      request<{ viewers: PresenceEntry[] }>(`${SSE_BASE}/presence/viewers/${boardId}`),
  },

  notifications: {
    getGlobalPrefs: () =>
      request<{ preferences: NotificationPreferences; email: string | null }>('/users/me/notification-preferences'),
    updateGlobalPrefs: (data: Partial<NotificationPreferences>) =>
      request<{ preferences: NotificationPreferences }>('/users/me/notification-preferences', {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    getBoardPrefs: (boardId: string) =>
      request<{ preferences: NotificationPreferences }>(`/boards/${boardId}/notification-preferences`),
    updateBoardPrefs: (boardId: string, data: Partial<NotificationPreferences>) =>
      request<{ preferences: NotificationPreferences }>(`/boards/${boardId}/notification-preferences`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    updateEmail: (email: string | null) =>
      request<{ success: boolean; email: string | null }>('/users/me/email', {
        method: 'PUT',
        body: JSON.stringify({ email }),
      }),
  },

  chatIntegrations: {
    list: (boardId: string) =>
      request<ChatIntegration[]>(`/boards/${boardId}/chat-integrations`),
    create: (boardId: string, data: {
      provider: 'slack' | 'discord';
      webhookUrl: string;
      channelId?: string;
      botToken?: string;
      events?: string[];
    }) =>
      request<ChatIntegration>(`/boards/${boardId}/chat-integrations`, {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    update: (id: string, data: {
      webhookUrl?: string;
      channelId?: string;
      botToken?: string;
      enabled?: boolean;
      events?: string[];
    }) =>
      request<ChatIntegration>(`/chat-integrations/${id}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    delete: (id: string) =>
      request<{ success: boolean }>(`/chat-integrations/${id}`, { method: 'DELETE' }),
    test: (id: string) =>
      request<{ success: boolean; statusCode: number; latencyMs: number }>(`/chat-integrations/${id}/test`, {
        method: 'POST',
      }),
  },

  organizations: {
    list: () =>
      request<{ organizations: Organization[] }>('/organizations').then(r => r.organizations),
    get: (id: string) =>
      request<{ organization: Organization }>(`/organizations/${id}`).then(r => r.organization),
    create: (data: { name: string; slug: string }) =>
      request<{ organization: Organization }>('/organizations', {
        method: 'POST',
        body: JSON.stringify(data),
      }).then(r => r.organization),
    listTeams: (orgId: string) =>
      request<{ teams: Team[] }>(`/organizations/${orgId}/teams`).then(r => r.teams),
    createTeam: (orgId: string, data: { name: string; slug: string }) =>
      request<{ team: Team }>(`/organizations/${orgId}/teams`, {
        method: 'POST',
        body: JSON.stringify(data),
      }).then(r => r.team),
  },

  teams: {
    get: (id: string) =>
      request<{ team: Team }>(`/teams/${id}`).then(r => r.team),
    delete: (id: string) =>
      request<void>(`/teams/${id}`, { method: 'DELETE' }),
    listMembers: (id: string) =>
      request<{ members: TeamMember[] }>(`/teams/${id}/members`).then(r => r.members),
    addMember: (id: string, data: { userId: string; role?: import('../types/index.js').TeamMemberRole }) =>
      request<{ member: TeamMember }>(`/teams/${id}/members`, {
        method: 'POST',
        body: JSON.stringify(data),
      }).then(r => r.member),
    removeMember: (id: string, userId: string) =>
      request<void>(`/teams/${id}/members/${userId}`, { method: 'DELETE' }),
    updateMemberRole: (id: string, userId: string, role: import('../types/index.js').TeamMemberRole) =>
      request<{ member: TeamMember }>(`/teams/${id}/members/${userId}`, {
        method: 'PATCH',
        body: JSON.stringify({ role }),
      }).then(r => r.member),
  },

  myTeams: () =>
    request<{ teams: Team[] }>('/users/me/teams').then(r => r.teams),

  qualityGates: {
    getReport: (taskId: string) =>
      request<TaskQualityReport>(`/tasks/${taskId}/quality-checklist`),
    updateItem: (taskId: string, checklistId: string, itemId: string, data: { isCompleted?: boolean; evidenceUrl?: string; notes?: string }) =>
      request<TaskQualityReport['checklists'][0]['items'][0]>(`/tasks/${taskId}/quality-checklist/${checklistId}/items/${itemId}`, {
        method: 'PUT',
        body: JSON.stringify(data),
      }),
    validate: (taskId: string) =>
      request<{ passed: boolean; failures: { category: string; missingItems: string[] }[] }>(`/tasks/${taskId}/quality-checklist/validate`, {
        method: 'POST',
      }),
    getApprovalStatus: (taskId: string) =>
      request<ApprovalStatus>(`/tasks/${taskId}/approval-status`),
    listTemplates: () =>
      request<{ templates: { id: string; name: string; category: string; isRequired: boolean }[] }>('/quality/templates').then(r => r.templates),
  },

  timeTracking: {
    getTaskReport: (taskId: string) =>
      request<TaskTimeReport>(`/tasks/${taskId}/time-report`),
    getBoardMetrics: (boardId: string) =>
      request<BoardTimeMetrics>(`/boards/${boardId}/metrics`),
    updateEstimate: (taskId: string, estimatedMinutes: number) =>
      request<{ task: Task }>(`/tasks/${taskId}/estimate`, {
        method: 'PUT',
        body: JSON.stringify({ estimatedMinutes }),
      }).then(r => r.task),
  },

  dependencies: {
    addTaskDependency: (taskId: string, dependsOnTaskId: string) =>
      request<{ success: boolean }>(`/tasks/${taskId}/dependencies`, {
        method: 'POST',
        body: JSON.stringify({ dependsOnTaskId }),
      }),
    removeTaskDependency: (taskId: string, depId: string) =>
      request<{ success: boolean }>(`/tasks/${taskId}/dependencies/${depId}`, { method: 'DELETE' }),
    getTaskDependencies: (taskId: string) =>
      request<{ dependsOn: { taskId: string; taskTitle: string; status: string }[]; blocking: { taskId: string; taskTitle: string; status: string }[] }>(`/tasks/${taskId}/dependencies`),
    getBlockedStatus: (taskId: string) =>
      request<TaskBlockedStatus>(`/tasks/${taskId}/blocked-status`),
    addFeatureDependency: (featureId: string, dependsOnFeatureId: string) =>
      request<{ success: boolean }>(`/features/${featureId}/dependencies`, {
        method: 'POST',
        body: JSON.stringify({ dependsOnFeatureId }),
      }),
    removeFeatureDependency: (featureId: string, depId: string) =>
      request<{ success: boolean }>(`/features/${featureId}/dependencies/${depId}`, { method: 'DELETE' }),
  },

  pulse: {
    listByMission: (missionId: string, params?: Record<string, string | number>) => {
      const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
      return request<{ pulses: Pulse[]; total: number }>(`/missions/${missionId}/pulse${qs}`);
    },
    listByBoard: (boardId: string, params?: Record<string, string | number>) => {
      const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
      return request<{ pulses: Pulse[]; total: number }>(`/boards/${boardId}/pulse${qs}`);
    },
    post: (missionId: string, body: PostPulseInput) =>
      request<{ pulse: Pulse }>(`/missions/${missionId}/pulse`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    postHabitat: (boardId: string, body: PostPulseInput) =>
      request<{ pulse: Pulse }>(`/boards/${boardId}/pulse`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    digest: (missionId: string) =>
      request<PulseDigest>(`/missions/${missionId}/pulse/digest`),
    habitatDigest: (boardId: string) =>
      request<PulseDigest>(`/boards/${boardId}/pulse/digest`),
    delete: (id: string) =>
      request<void>(`/pulse/${id}`, { method: 'DELETE' }),
    replies: (id: string) =>
      request<{ replies: Pulse[] }>(`/pulse/${id}/replies`),
    react: (id: string, reaction: string) =>
      request<{ added: boolean; counts: PulseReactionCounts }>(`/pulse/${id}/react`, {
        method: 'POST',
        body: JSON.stringify({ reaction }),
      }),
  },

  insights: {
    list: (boardId: string, params?: Record<string, string | number>) => {
      const qs = params ? '?' + new URLSearchParams(params as Record<string, string>).toString() : '';
      return request<{ insights: ProjectInsight[]; total: number }>(`/boards/${boardId}/insights${qs}`);
    },
    promote: (boardId: string, body: { sourcePulseId: string; relevanceTags?: string[]; subject?: string; body?: string }) =>
      request<{ insight: ProjectInsight }>(`/boards/${boardId}/insights`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    deactivate: (boardId: string, id: string) =>
      request<{ success: boolean }>(`/boards/${boardId}/insights/${id}`, { method: 'DELETE' }),
  },
};

export type ApiClient = typeof api;
