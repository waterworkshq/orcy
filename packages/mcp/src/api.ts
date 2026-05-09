import type {
  Task,
  Agent,
  Board,
  ClaimTaskResponse,
  SubmitTaskResponse,
  CompleteTaskResponse,
  ReleaseTaskResponse,
  HeartbeatResponse,
  AgentStatusResponse,
  TaskContext,
  TaskStatus,
  TaskEvent,
  TaskComment,
  Subtask,
  ListSubtasksResponse,
  SendMessageResponse,
  ListMessagesResponse,
  Webhook,
  ListWebhooksResponse,
  CreateWebhookResponse,
  FeatureTemplate,
  ListTemplatesResponse,
  CreateTemplateResponse,
  BoardSettings,
  AgentStats,
  BoardSummary,
  Feature,
  FeatureWithProgress,
  FeatureContext,
  FeatureProgressResponse,
  FeatureDetailsResponse,
  ListFeaturesResponse,
  ListTasksInFeatureResponse,
} from './types.js';
import { logger } from './logger.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BASE_DELAY = 1000;
const DEFAULT_MAX_DELAY = 30_000;

export class KanbanApiClient {
  private baseUrl: string;
  private timeoutMs: number;
  private maxRetries: number;
  private baseDelay: number;
  private maxDelay: number;

  constructor(baseUrl: string, timeoutMs?: number, options?: { maxRetries?: number; baseDelay?: number; maxDelay?: number }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.baseDelay = options?.baseDelay ?? DEFAULT_BASE_DELAY;
    this.maxDelay = options?.maxDelay ?? DEFAULT_MAX_DELAY;
  }

  getBaseUrl(): string {
    return this.baseUrl;
  }

  private normalizeTaskId(id: string): string {
    return id.startsWith('feat-') ? id.slice(5) : id;
  }

  private getCredentials(): { apiKey: string; agentId: string } {
    return {
      apiKey: process.env.ORCY_API_KEY ?? '',
      agentId: process.env.ORCY_AGENT_ID ?? '',
    };
  }

  private isRetryable(err: unknown): boolean {
    if (err instanceof DOMException && err.name === 'AbortError') return false;
    if (err instanceof TypeError && err.message.includes('fetch')) return true;
    if (err instanceof KanbanApiError) {
      const status = err.status;
      if (status === 429 || status === 502 || status === 503) return true;
      if (status >= 400 && status < 500) return false;
      if (status >= 500) return true;
    }
    if (err instanceof Error && !(err instanceof KanbanApiError)) return true;
    return false;
  }

  private getRetryDelay(attempt: number, response?: Response): number {
    if (response) {
      const retryAfter = response.headers.get('Retry-After');
      if (retryAfter) {
        const seconds = Number(retryAfter);
        if (!isNaN(seconds) && seconds > 0) return Math.min(seconds * 1000, this.maxDelay);
        const date = new Date(retryAfter);
        if (!isNaN(date.getTime())) {
          const diff = date.getTime() - Date.now();
          if (diff > 0) return Math.min(diff, this.maxDelay);
        }
      }
    }
    const delay = this.baseDelay * Math.pow(2, attempt);
    const jitter = delay * (0.5 + Math.random() * 0.5);
    return Math.min(jitter, this.maxDelay);
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const { apiKey, agentId } = this.getCredentials();
    const url = `${this.baseUrl}${path}`;
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const headers: Record<string, string> = {
        'X-Agent-API-Key': apiKey,
      };
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
      }
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);
      const startTime = Date.now();
      logger.debug('http_request', { method, url, attempt });
      try {
        const response = await fetch(url, {
          method,
          headers,
          body: body !== undefined ? JSON.stringify(body) : undefined,
          signal: controller.signal,
        });
        const duration = Date.now() - startTime;

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          logger.error('http_error', { method, url, status: response.status, duration, error: errorText || response.statusText, attempt });
          const error = new KanbanApiError(response.status, errorText || response.statusText);
          if (attempt < this.maxRetries && this.isRetryable(error)) {
            const delay = this.getRetryDelay(attempt, response);
            logger.info('http_retry', { method, url, attempt, delay });
            clearTimeout(timeoutId);
            await new Promise(resolve => setTimeout(resolve, delay));
            lastError = error;
            continue;
          }
          throw error;
        }

        logger.info('http_response', { method, url, status: response.status, duration, attempt });
        return response.json() as Promise<T>;
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          const duration = Date.now() - startTime;
          logger.error('http_timeout', { method, url, duration, attempt });
          const timeoutError = new KanbanApiError(408, `Request to ${path} timed out after ${this.timeoutMs}ms`);
          if (attempt < this.maxRetries && this.isRetryable(timeoutError)) {
            const delay = this.getRetryDelay(attempt);
            logger.info('http_retry', { method, url, attempt, delay });
            clearTimeout(timeoutId);
            await new Promise(resolve => setTimeout(resolve, delay));
            lastError = timeoutError;
            continue;
          }
          throw timeoutError;
        }
        if (err instanceof KanbanApiError) {
          throw err;
        }
        if (attempt < this.maxRetries && this.isRetryable(err)) {
          const delay = this.getRetryDelay(attempt);
          logger.info('http_retry', { method, url, attempt, delay });
          clearTimeout(timeoutId);
          await new Promise(resolve => setTimeout(resolve, delay));
          lastError = err;
          continue;
        }
        throw err;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    throw lastError;
  }

  async listFeatures(
    boardId: string,
    options?: {
      status?: string;
      priority?: string;
      limit?: number;
      offset?: number;
      isArchived?: boolean;
    }
  ): Promise<ListFeaturesResponse> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.priority) params.set('priority', options.priority);
    if (options?.isArchived !== undefined) params.set('isArchived', String(options.isArchived));
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<ListFeaturesResponse>(
      'GET',
      `/api/boards/${boardId}/features${query ? `?${query}` : ''}`
    );
  }

  async getFeature(featureId: string): Promise<{ feature: FeatureWithProgress }> {
    return this.request<{ feature: FeatureWithProgress }>('GET', `/api/features/${featureId}`);
  }

  async getFeatureDetails(featureId: string): Promise<FeatureDetailsResponse> {
    return this.request<FeatureDetailsResponse>('GET', `/api/features/${featureId}/details`);
  }

  async createFeature(
    boardId: string,
    input: {
      title: string;
      description?: string;
      acceptanceCriteria?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      labels?: string[];
      dependsOn?: string[];
      blocks?: string[];
      dueAt?: string;
      slaMinutes?: number;
    }
  ): Promise<{ feature: Feature }> {
    return this.request<{ feature: Feature }>('POST', `/api/boards/${boardId}/features`, {
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

  async deleteFeature(featureId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/features/${featureId}`);
  }

  async archiveFeature(featureId: string): Promise<{ feature: Feature }> {
    return this.request<{ feature: Feature }>('POST', `/api/features/${featureId}/archive`);
  }

  async unarchiveFeature(featureId: string): Promise<{ feature: Feature }> {
    return this.request<{ feature: Feature }>('POST', `/api/features/${featureId}/unarchive`);
  }

  async listTasksInFeature(featureId: string): Promise<ListTasksInFeatureResponse> {
    return this.request<ListTasksInFeatureResponse>('GET', `/api/features/${featureId}/tasks`);
  }

  async createTaskInFeature(
    featureId: string,
    input: {
      title: string;
      description?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      requiredDomain?: string | null;
      requiredCapabilities?: string[];
      estimatedMinutes?: number;
      order?: number;
    }
  ): Promise<{ task: Task }> {
    return this.request<{ task: Task }>('POST', `/api/features/${featureId}/tasks`, {
      title: input.title,
      description: input.description,
      priority: input.priority,
      requiredDomain: input.requiredDomain,
      requiredCapabilities: input.requiredCapabilities,
      estimatedMinutes: input.estimatedMinutes,
      order: input.order,
    });
  }

  async getFeatureContext(featureId: string): Promise<FeatureContext> {
    const details = await this.getFeatureDetails(featureId);

    // Resolve dependency/blocking feature IDs into full Feature objects
    const depIds = details.dependencies?.dependsOn ?? [];
    const blockIds = details.dependencies?.blocks ?? [];

    const dependencies: Feature[] = [];
    for (const id of depIds) {
      try {
        const res = await this.getFeature(id);
        if (res.feature) dependencies.push(res.feature);
      } catch { /* dependency may have been deleted */ }
    }

    const blocking: Feature[] = [];
    for (const id of blockIds) {
      try {
        const res = await this.getFeature(id);
        if (res.feature) blocking.push(res.feature);
      } catch { /* blocked feature may have been deleted */ }
    }

    return {
      feature: details.feature,
      tasks: details.tasks.map(t => ({
        id: t.id,
        title: t.title,
        status: t.status,
        result: t.result,
        artifacts: t.artifacts,
        assignedAgentId: t.assignedAgentId,
      })),
      dependencies,
      blocking,
    };
  }

  async getFeatureProgress(featureId: string): Promise<FeatureProgressResponse> {
    return this.request<FeatureProgressResponse>('GET', `/api/features/${featureId}/progress`);
  }

  async claimTask(
    taskId: string
  ): Promise<ClaimTaskResponse | { success: false; reason: string; message: string; missingCapabilities?: string[] }> {
    taskId = this.normalizeTaskId(taskId);
    const { apiKey, agentId: _agentId } = this.getCredentials();
    const url = `${this.baseUrl}/api/tasks/${taskId}/claim`;
    const headers: Record<string, string> = {
      'X-Agent-API-Key': apiKey,
    };
    const startTime = Date.now();
    logger.debug('http_request', { method: 'POST', url });
    const response = await globalThis.fetch(url, {
      method: 'POST',
      headers,
    });
    const duration = Date.now() - startTime;

    if (response.ok) {
      logger.info('http_response', { method: 'POST', url, status: response.status, duration });
      return response.json() as Promise<ClaimTaskResponse>;
    }

    const errorData = await response.text().catch(() => '');
    logger.error('http_error', { method: 'POST', url, status: response.status, duration, error: errorData });
    if (response.status === 403) {
      try {
        const parsed = JSON.parse(errorData);
        if (parsed.missingCapabilities) {
          return {
            success: false,
            reason: 'capability_mismatch',
            message: `Missing capabilities: ${parsed.missingCapabilities.join(', ')}`,
            missingCapabilities: parsed.missingCapabilities,
          };
        }
      } catch { /* fall through */ }
    }

    try {
      const parsed = JSON.parse(errorData);
      return { success: false, reason: parsed.error || 'unknown', message: errorData };
    } catch {
      return { success: false, reason: 'unknown', message: errorData || response.statusText };
    }
  }

  async startTask(taskId: string): Promise<{ task: Task }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ task: Task }>('POST', `/api/tasks/${taskId}/start`);
  }

  async updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    options?: { result?: string; artifacts?: Task['artifacts'] }
  ): Promise<{ task: Task }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ task: Task }>('PATCH', `/api/tasks/${taskId}`, {
      status,
      ...(options?.result !== undefined && { result: options.result }),
      ...(options?.artifacts !== undefined && { artifacts: options.artifacts }),
    });
  }

  async failTask(taskId: string, reason: string): Promise<{ task: Task }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ task: Task }>('POST', `/api/tasks/${taskId}/fail`, {
      reason,
    });
  }

  async submitTask(
    taskId: string,
    result: string,
    artifacts?: Task['artifacts']
  ): Promise<SubmitTaskResponse> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<SubmitTaskResponse>('POST', `/api/tasks/${taskId}/submit`, {
      result,
      artifacts: artifacts ?? [],
    });
  }

  async completeTask(
    taskId: string,
    reviewNote?: string,
    artifacts?: Task['artifacts']
  ): Promise<CompleteTaskResponse> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<CompleteTaskResponse>('POST', `/api/tasks/${taskId}/complete`, {
      reviewNote,
      artifacts: artifacts ?? [],
    });
  }

  async getTaskContext(taskId: string): Promise<TaskContext> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<TaskContext>('GET', `/api/tasks/${taskId}`);
  }

  async releaseTask(taskId: string, reason: string): Promise<ReleaseTaskResponse> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<ReleaseTaskResponse>('POST', `/api/tasks/${taskId}/release`, {
      reason,
    });
  }

  async retryTask(taskId: string): Promise<{ task: Task }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ task: Task }>('POST', `/api/tasks/${taskId}/retry`);
  }

  async heartbeat(
    taskId?: string,
    progress?: string
  ): Promise<HeartbeatResponse> {
    const { agentId } = this.getCredentials();
    const result = await this.request<{ status: 'idle' | 'working' | 'offline'; nextCheckIn: number; taskStatus: string | null }>(
      'POST',
      `/api/agents/${agentId}/heartbeat`,
      { taskId, progress }
    );
    return {
      success: true,
      agentStatus: result.status,
      nextCheckIn: result.nextCheckIn,
      taskStatus: result.taskStatus as TaskStatus | null,
    };
  }

  async getAgent(): Promise<{ agent: Agent }> {
    const { agentId } = this.getCredentials();
    return this.request<{ agent: Agent }>('GET', `/api/agents/${agentId}`);
  }

  async getAgentById(agentId: string): Promise<{ agent: Agent } | null> {
    try {
      return await this.request<{ agent: Agent }>('GET', `/api/agents/${agentId}`);
    } catch {
      return null;
    }
  }

  async listAgents(options?: { status?: string; domain?: string; include?: string }): Promise<{ agents: Agent[] | { agent: Agent; currentTaskTitle: string | null }[] }> {
    const params = new URLSearchParams();
    if (options?.status) params.set('status', options.status);
    if (options?.domain) params.set('domain', options.domain);
    if (options?.include) params.set('include', options.include);
    const query = params.toString();
    return this.request<{ agents: Agent[] | { agent: Agent; currentTaskTitle: string | null }[] }>('GET', `/api/agents${query ? `?${query}` : ''}`);
  }

  async getTask(taskId: string): Promise<{ task: Task }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ task: Task }>('GET', `/api/tasks/${taskId}`);
  }

  async getBoard(boardId: string): Promise<{ board: { id: string; name: string; columns: { name: string }[] } }> {
    return this.request<{ board: { id: string; name: string; columns: { name: string }[] } }>(
      'GET',
      `/api/boards/${boardId}`
    );
  }

  async listBoards(name?: string): Promise<{ boards: Board[] }> {
    const params = new URLSearchParams();
    if (name) params.set('name', name);
    const query = params.toString();
    return this.request<{ boards: Board[] }>('GET', `/api/boards${query ? `?${query}` : ''}`);
  }

  async getTaskEvents(
    taskId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ events: TaskEvent[]; total: number }> {
    taskId = this.normalizeTaskId(taskId);
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<{ events: TaskEvent[]; total: number }>(
      'GET',
      `/api/tasks/${taskId}/events${query}`
    );
  }

  async updateTask(
    taskId: string,
    input: {
      title?: string;
      description?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      requiredDomain?: string | null;
      requiredCapabilities?: string[];
      version?: number;
      estimatedMinutes?: number | null;
    }
  ): Promise<{ task: Task }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ task: Task }>('PATCH', `/api/tasks/${taskId}`, {
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
    taskId = this.normalizeTaskId(taskId);
    await this.request<void>('DELETE', `/api/tasks/${taskId}`);
  }

  async registerAgent(input: {
    name: string;
    type: 'claude-code' | 'codex' | 'opencode';
    domain: string;
    capabilities?: string[];
  }): Promise<{ agent: Agent; apiKey: string }> {
    const registrationToken = process.env.ORCY_REGISTRATION_TOKEN ?? '';
    const url = `${this.baseUrl}/api/agents`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (registrationToken) {
      headers['X-Registration-Token'] = registrationToken;
    }
    const startTime = Date.now();
    logger.debug('http_request', { method: 'POST', url });
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(input),
    });
    const duration = Date.now() - startTime;
    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      logger.error('http_error', { method: 'POST', url, status: response.status, duration, error: errorText || response.statusText });
      throw new KanbanApiError(response.status, errorText || response.statusText);
    }
    logger.info('http_response', { method: 'POST', url, status: response.status, duration });
    return response.json() as Promise<{ agent: Agent; apiKey: string }>;
  }

  async createBoard(input: {
    name: string;
    description?: string;
    defaultColumns?: boolean;
  }): Promise<{ success: true; board: Board; columns: Board['columns'] }> {
    return this.request<{ success: true; board: Board; columns: Board['columns'] }>(
      'POST',
      '/api/boards/agent',
      input
    );
  }

  async delegateTask(
    taskId: string,
    toAgentId: string,
    reason?: string
  ): Promise<{ task: Task }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ task: Task }>('POST', `/api/tasks/${taskId}/delegate`, {
      toAgentId,
      reason,
    });
  }

  async cloneTask(
    taskId: string,
    options?: { includeSubtasks?: boolean; includeComments?: boolean }
  ): Promise<{ task: Task }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ task: Task }>('POST', `/api/tasks/${taskId}/clone`, {
      includeSubtasks: options?.includeSubtasks ?? false,
      includeComments: options?.includeComments ?? false,
    });
  }

  async getTaskComments(
    taskId: string,
    options?: { limit?: number; offset?: number }
  ): Promise<{ comments: TaskComment[]; total: number }> {
    taskId = this.normalizeTaskId(taskId);
    const params = new URLSearchParams();
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<{ comments: TaskComment[]; total: number }>(
      'GET',
      `/api/tasks/${taskId}/comments${query}`
    );
  }

  async addComment(
    taskId: string,
    content: string,
    parentId?: string
  ): Promise<{ comment: TaskComment }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ comment: TaskComment }>(
      'POST',
      `/api/tasks/${taskId}/comments`,
      {
        content,
        ...(parentId !== undefined && { parentId }),
      }
    );
  }

  async listSubtasks(taskId: string): Promise<ListSubtasksResponse> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<ListSubtasksResponse>('GET', `/api/tasks/${taskId}/subtasks`);
  }

  async createSubtask(
    taskId: string,
    input: { title: string; order?: number; assigneeId?: string }
  ): Promise<{ subtask: Subtask }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ subtask: Subtask }>('POST', `/api/tasks/${taskId}/subtasks`, {
      title: input.title,
      ...(input.order !== undefined && { order: input.order }),
      ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
    });
  }

  async updateSubtask(
    taskId: string,
    subtaskId: string,
    input: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null }
  ): Promise<{ subtask: Subtask }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request<{ subtask: Subtask }>(
      'PATCH',
      `/api/tasks/${taskId}/subtasks/${subtaskId}`,
      {
        ...(input.title !== undefined && { title: input.title }),
        ...(input.completed !== undefined && { completed: input.completed }),
        ...(input.order !== undefined && { order: input.order }),
        ...(input.assigneeId !== undefined && { assigneeId: input.assigneeId }),
      }
    );
  }

  async deleteSubtask(taskId: string, subtaskId: string): Promise<void> {
    taskId = this.normalizeTaskId(taskId);
    await this.request<void>('DELETE', `/api/tasks/${taskId}/subtasks/${subtaskId}`);
  }

  async sendMessage(
    toAgentId: string,
    input: {
      boardId: string;
      taskId?: string;
      subject: string;
      body: string;
      messageType?: 'info' | 'request' | 'response' | 'alert';
      priority?: 'low' | 'normal' | 'high' | 'urgent';
    }
  ): Promise<SendMessageResponse> {
    const { agentId } = this.getCredentials();
    return this.request<SendMessageResponse>(
      'POST',
      `/api/agents/${agentId}/messages`,
      {
        boardId: input.boardId,
        toAgentId,
        taskId: input.taskId,
        subject: input.subject,
        body: input.body,
        messageType: input.messageType,
        priority: input.priority,
      }
    );
  }

  async getMessages(
    options?: { unreadOnly?: boolean; taskId?: string; limit?: number; offset?: number }
  ): Promise<ListMessagesResponse> {
    const { agentId } = this.getCredentials();
    const params = new URLSearchParams();
    if (options?.unreadOnly) params.set('unreadOnly', 'true');
    if (options?.taskId) params.set('taskId', options.taskId);
    if (options?.limit) params.set('limit', String(options.limit));
    if (options?.offset) params.set('offset', String(options.offset));
    const query = params.toString();
    return this.request<ListMessagesResponse>(
      'GET',
      `/api/agents/${agentId}/messages${query ? `?${query}` : ''}`
    );
  }

  async markMessageRead(messageId: string): Promise<{ message: import('./types.js').AgentMessage }> {
    return this.request<{ message: import('./types.js').AgentMessage }>(
      'PUT',
      `/api/agents/messages/${messageId}/read`
    );
  }

  async markAllMessagesRead(): Promise<{ updated: number }> {
    const { agentId } = this.getCredentials();
    return this.request<{ updated: number }>(
      'PUT',
      `/api/agents/${agentId}/messages/read-all`
    );
  }

  async deleteMessage(messageId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/agents/messages/${messageId}`);
  }

  async getSuggestions(agentId: string, boardId: string, limit: number = 5): Promise<{
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
    params.set('boardId', boardId);
    params.set('limit', String(limit));
    return this.request('GET', `/api/agents/${agentId}/suggestions?${params.toString()}`);
  }

  async listWebhooks(boardId: string): Promise<ListWebhooksResponse> {
    return this.request<ListWebhooksResponse>('GET', `/api/boards/${boardId}/webhooks`);
  }

  async createWebhook(
    boardId: string,
    input: {
      name: string;
      url: string;
      events: string[];
      format?: 'standard' | 'slack' | 'discord';
    }
  ): Promise<CreateWebhookResponse> {
    return this.request<CreateWebhookResponse>('POST', `/api/boards/${boardId}/webhooks`, input);
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/webhooks/${webhookId}`);
  }

  async listTemplates(boardId: string): Promise<ListTemplatesResponse> {
    return this.request<ListTemplatesResponse>('GET', `/api/boards/${boardId}/templates`);
  }

  async createTemplate(
    boardId: string,
    input: {
      name: string;
      titlePattern?: string;
      descriptionPattern?: string;
      priority?: 'low' | 'medium' | 'high' | 'critical';
      labels?: string[];
      domain?: string;
    }
  ): Promise<CreateTemplateResponse> {
    return this.request<CreateTemplateResponse>('POST', `/api/boards/${boardId}/templates`, input);
  }

  async deleteTemplate(templateId: string): Promise<void> {
    await this.request<void>('DELETE', `/api/templates/${templateId}`);
  }

  async getBoardSettings(boardId: string): Promise<{ board: BoardSettings }> {
    return this.request<{ board: BoardSettings }>('GET', `/api/boards/${boardId}`);
  }

  async updateBoardSettings(
    boardId: string,
    input: { name?: string; description?: string }
  ): Promise<{ board: BoardSettings }> {
    return this.request<{ board: BoardSettings }>('PATCH', `/api/boards/${boardId}`, input);
  }

  async getAgentStats(agentId: string): Promise<{ stats: AgentStats }> {
    return this.request<{ stats: AgentStats }>('GET', `/api/agents/${agentId}/stats`);
  }

  async getBoardSummary(
    boardId: string,
    options?: { since?: string; maxTasks?: number; includeDigest?: boolean }
  ): Promise<BoardSummary> {
    const params = new URLSearchParams();
    if (options?.since) params.set('since', options.since);
    if (options?.maxTasks) params.set('maxTasks', String(options.maxTasks));
    if (options?.includeDigest === false) params.set('includeDigest', 'false');
    const query = params.toString() ? `?${params.toString()}` : '';
    return this.request<BoardSummary>('GET', `/api/boards/${boardId}/summary${query}`);
  }

  async getWorktree(taskId: string): Promise<{ worktree: { path: string; branch: string; repoRoot: string } | null; enabled: boolean }> {
    taskId = this.normalizeTaskId(taskId);
    try {
      return await this.request<{ worktree: { path: string; branch: string; repoRoot: string } | null; enabled: boolean }>(
        'GET',
        `/api/tasks/${taskId}/worktree`
      );
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
    heartbeatHistory: { id: string; taskId: string; agentId: string | null; minutesSpent: number; recordedAt: string; statusDuringWork: string }[];
  }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request('GET', `/api/tasks/${taskId}/time-report`);
  }

  async getBoardMetrics(boardId: string): Promise<{
    averageCycleTime: number;
    averageLeadTime: number;
    averageEstimationAccuracy: number;
    totalPlannedMinutes: number;
    totalActualMinutes: number;
    overdueTasks: number;
    onTimeCompletionRate: number;
    agentMetrics: { agentId: string; agentName: string; tasksCompleted: number; averageCycleTime: number; averageEstimationAccuracy: number; totalTimeTracked: number }[];
  }> {
    return this.request('GET', `/api/boards/${boardId}/metrics`);
  }

  async addTaskDependency(taskId: string, dependsOnTaskId: string): Promise<{ success: boolean }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request('POST', `/api/tasks/${taskId}/dependencies`, { dependsOnTaskId });
  }

  async removeTaskDependency(taskId: string, depId: string): Promise<{ success: boolean }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request('DELETE', `/api/tasks/${taskId}/dependencies/${depId}`);
  }

  async getTaskDependencies(taskId: string): Promise<{
    dependsOn: { taskId: string; title: string; status: string; completedAt: string | null }[];
    blocking: { taskId: string; title: string; status: string }[];
  }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request('GET', `/api/tasks/${taskId}/dependencies`);
  }

  async getTaskBlockedStatus(taskId: string): Promise<{
    taskId: string;
    isBlocked: boolean;
    canComplete: boolean;
    blockedBy: { taskId: string; title: string; status: string }[];
    blocking: { taskId: string; title: string; status: string }[];
  }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request('GET', `/api/tasks/${taskId}/blocked-status`);
  }

  async getTaskQualityChecklist(taskId: string): Promise<{
    taskId: string;
    overallStatus: string;
    canApprove: boolean;
    checklists: { id: string; templateId: string; templateName: string; category: string; required: boolean; status: string; progress: { total: number; completed: number }; items: { id: string; title: string; required: boolean; isCompleted: boolean; completedBy: string | null; completedAt: string | null; evidenceUrl: string | null; notes: string }[] }[];
    missingRequirements: { category: string; missingItems: string[] }[];
  }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request('GET', `/api/tasks/${taskId}/quality-checklist`);
  }

  async updateQualityChecklistItem(
    taskId: string,
    checklistId: string,
    itemId: string,
    input: { isCompleted?: boolean; evidenceUrl?: string; notes?: string }
  ): Promise<{ id: string; checklistId: string; itemId: string; isCompleted: boolean; completedBy: string | null; completedAt: string | null; evidenceUrl: string | null; notes: string }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request('PUT', `/api/tasks/${taskId}/quality-checklist/${checklistId}/items/${itemId}`, input);
  }

  async validateQualityGates(taskId: string): Promise<{ passed: boolean; failures: { category: string; missingItems: string[] }[] }> {
    taskId = this.normalizeTaskId(taskId);
    return this.request('POST', `/api/tasks/${taskId}/quality-checklist/validate`);
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
    taskId = this.normalizeTaskId(taskId);
    return this.request('GET', `/api/tasks/${taskId}/approval-status`);
  }

  async batchAssignTasks(
    boardId: string,
    taskIds: string[],
    agentId: string
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{ taskId: string; success: boolean; error?: string }>;
  }> {
    return this.request('POST', `/api/boards/${boardId}/tasks/batch`, {
      taskIds,
      operation: 'assign',
      payload: { assignedAgentId: agentId },
    });
  }

  async batchSetTaskPriority(
    boardId: string,
    taskIds: string[],
    priority: string
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{ taskId: string; success: boolean; error?: string }>;
  }> {
    return this.request('POST', `/api/boards/${boardId}/tasks/batch`, {
      taskIds,
      operation: 'priority',
      payload: { priority },
    });
  }

  async batchDeleteTasks(
    boardId: string,
    taskIds: string[]
  ): Promise<{
    successCount: number;
    failureCount: number;
    results: Array<{ taskId: string; success: boolean; error?: string }>;
  }> {
    return this.request('POST', `/api/boards/${boardId}/tasks/batch`, {
      taskIds,
      operation: 'delete',
      payload: {},
    });
  }
}

export class KanbanApiError extends Error {
  constructor(
    public status: number,
    public message: string
  ) {
    super(`Kanban API error ${status}: ${message}`);
    this.name = 'KanbanApiError';
  }
}