import type {
  Task,
  TaskEvent,
  TaskStatus,
  Agent,
  Habitat,
  Subtask,
  Mission,
  MissionWithProgress,
  ReviewRule,
  ReviewRuleCreateInput,
  ReviewRuleUpdateInput,
  ScheduledTask,
  TaskReviewer,
  TaskComment,
  MissionComment,
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
} from "../types.js";

export interface TaskFilters {
  status?: string;
  priority?: string;
  isArchived?: boolean;
  limit?: number;
  offset?: number;
}

export interface MissionClient {
  listMissions(habitatId: string, options?: TaskFilters): Promise<ListMissionsResponse>;
  getMission(missionId: string): Promise<{ mission: MissionWithProgress }>;
  getMissionDetails(missionId: string): Promise<MissionDetailsResponse>;
  createMission(
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
  ): Promise<{ mission: Mission }>;
  deleteMission(missionId: string): Promise<void>;
  archiveMission(missionId: string): Promise<{ mission: Mission }>;
  unarchiveMission(missionId: string): Promise<{ mission: Mission }>;
  getMissionContext(missionId: string): Promise<MissionContext>;
  getMissionProgress(missionId: string): Promise<MissionProgressResponse>;
}

export interface TaskClient {
  listTasksInMission(missionId: string): Promise<ListTasksInMissionResponse>;
  createTaskInMission(
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
  ): Promise<{ task: Task }>;
  claimTask(
    taskId: string,
    agentId: string,
  ): Promise<
    | ClaimTaskResponse
    | { success: false; reason: string; message: string; missingCapabilities?: string[] }
  >;
  startTask(taskId: string): Promise<{ task: Task }>;
  updateTaskStatus(
    taskId: string,
    status: TaskStatus,
    options?: { result?: string; artifacts?: Task["artifacts"] },
  ): Promise<{ task: Task }>;
  failTask(taskId: string, reason: string): Promise<{ task: Task }>;
  submitTask(
    taskId: string,
    result: string,
    artifacts?: Task["artifacts"],
  ): Promise<SubmitTaskResponse>;
  completeTask(
    taskId: string,
    reviewNote?: string,
    artifacts?: Task["artifacts"],
  ): Promise<CompleteTaskResponse>;
  getTaskContext(taskId: string): Promise<TaskContext>;
  releaseTask(taskId: string, reason: string): Promise<ReleaseTaskResponse>;
  retryTask(taskId: string): Promise<{ task: Task }>;
  getTask(taskId: string): Promise<{ task: Task }>;
  getTaskEvents(
    taskId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ events: TaskEvent[]; total: number }>;
  updateTask(
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
  ): Promise<{ task: Task }>;
  deleteTask(taskId: string): Promise<void>;
  delegateTask(
    taskId: string,
    fromAgentId: string,
    toAgentId: string,
    reason?: string,
  ): Promise<{ task: Task }>;
  cloneTask(
    taskId: string,
    options?: { includeSubtasks?: boolean; includeComments?: boolean },
  ): Promise<{ task: Task }>;
  listSubtasks(taskId: string): Promise<ListSubtasksResponse>;
  createSubtask(
    taskId: string,
    input: { title: string; order?: number; assigneeId?: string },
  ): Promise<{ subtask: Subtask }>;
  updateSubtask(
    taskId: string,
    subtaskId: string,
    input: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null },
  ): Promise<{ subtask: Subtask }>;
  deleteSubtask(taskId: string, subtaskId: string): Promise<void>;
  getWorktree(taskId: string): Promise<unknown>;
  batchAssignTasks(
    boardId: string,
    taskIds: string[],
    agentId: string,
  ): Promise<{ successCount: number; failureCount: number; results: unknown[] }>;
  batchSetTaskPriority(
    boardId: string,
    taskIds: string[],
    priority: string,
  ): Promise<{ successCount: number; failureCount: number; results: unknown[] }>;
  batchDeleteTasks(
    boardId: string,
    taskIds: string[],
  ): Promise<{ successCount: number; failureCount: number; results: unknown[] }>;
}

export interface HabitatClient {
  getHabitat(habitatId: string): Promise<{ habitat: { id: string; name: string; columns: { name: string }[] } }>;
  listHabitats(name?: string): Promise<{ habitats: Habitat[] }>;
  createHabitat(input: { name: string; description?: string }): Promise<{ habitat: Habitat }>;
  getHabitatSettings(boardId: string): Promise<{ habitat: HabitatSettings }>;
  updateHabitatSettings(boardId: string, settings: Partial<HabitatSettings>): Promise<{ habitat: HabitatSettings }>;
  getHabitatRepository(habitatId: string): Promise<unknown>;
  setHabitatRepository(habitatId: string, repo: unknown): Promise<unknown>;
  inferRepositoryFromWorktree(
    habitatId: string,
    input?: Record<string, unknown>,
  ): Promise<{ repository: Record<string, unknown> }>;
  getPrioritizationRules(habitatId: string): Promise<unknown>;
  updatePrioritizationRules(habitatId: string, rules: unknown): Promise<unknown>;
  evaluatePrioritizationRules(habitatId: string, options?: { dryRun?: boolean }): Promise<unknown>;
}

export interface PulseClient {
  postPulse(
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
  ): Promise<PostPulseResponse>;
  getPulses(
    missionId: string,
    filters?: {
      signalType?: string;
      isAuto?: boolean;
      since?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<ListPulsesResponse>;
  getPulseDigest(missionId: string): Promise<PulseDigest>;
  getPulseInbox(
    filters?: { signalType?: string; limit?: number; offset?: number },
  ): Promise<ListPulsesResponse>;
  deletePulse(pulseId: string): Promise<void>;
  getPulseReplies(pulseId: string): Promise<{ items: Pulse[] }>;
  postHabitatPulse(
    habitatId: string,
    input: { signalType: string; subject: string; body?: string },
  ): Promise<PostPulseResponse>;
  getHabitatPulses(
    habitatId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<ListPulsesResponse>;
  getHabitatPulseDigest(habitatId: string): Promise<PulseDigest>;
  reactToPulse(
    pulseId: string,
    reaction: string,
  ): Promise<{ added: boolean; counts: Record<string, number> }>;
}

export interface CodeEvidenceClient {
  getTaskCodeEvidence(taskId: string, includeHistory?: boolean): Promise<Record<string, unknown>>;
  linkTaskCodeEvidence(
    taskId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  correctTaskEvidenceLink(
    taskId: string,
    linkId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  markTaskEvidenceNotApplicable(
    taskId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  clearTaskEvidenceNotApplicable(taskId: string): Promise<{ success: boolean }>;
  reportTaskEvidenceGap(
    taskId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  resolveTaskEvidenceGap(
    taskId: string,
    gapId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  getMissionCodeEvidence(missionId: string, includeHistory?: boolean): Promise<Record<string, unknown>>;
  linkMissionCodeEvidence(
    missionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  correctMissionEvidenceLink(
    missionId: string,
    linkId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  markMissionEvidenceNotApplicable(
    missionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  clearMissionEvidenceNotApplicable(missionId: string): Promise<{ success: boolean }>;
  reportMissionEvidenceGap(
    missionId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
  resolveMissionEvidenceGap(
    missionId: string,
    gapId: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;
}

export interface SkillClient {
  getHabitatSkill(
    boardId: string,
  ): Promise<{
    skill: {
      id: string;
      content: string;
      signalCount: number;
      avgStrength: number;
      generationCount: number;
      lastGeneratedAt: string;
    } | null;
  }>;
  refreshHabitatSkill(
    boardId: string,
  ): Promise<{ success: boolean; message: string; signalCount: number }>;
  contributeHabitatSkill(boardId: string, input: Record<string, unknown>): Promise<unknown>;
  listSkillSignals(
    boardId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ signals: unknown[] }>;
}

export interface AgentClient {
  heartbeat(taskId?: string, progress?: string): Promise<HeartbeatResponse>;
  getAgent(): Promise<{ agent: Agent }>;
  getAgentById(agentId: string): Promise<{ agent: Agent } | null>;
  listAgents(
    options?: { status?: string; domain?: string; include?: string },
  ): Promise<{
    agents: Agent[] | { agent: Agent; currentTaskTitle: string | null }[];
  }>;
  registerAgent(input: unknown): Promise<{ agent: Agent; apiKey: string }>;
  getAgentStats(agentId: string): Promise<{ stats: AgentStats }>;
  getSuggestions(
    agentId: string,
    boardId: string,
    limit?: number,
  ): Promise<{ suggestions: unknown[]; agentWorkload: unknown }>;
}

export interface SprintClient {
  listSprints(habitatId: string): Promise<{ sprints: Sprint[] }>;
  getActiveSprint(habitatId: string): Promise<{ sprint: Sprint | null }>;
  getSprint(sprintId: string): Promise<{ sprint: Sprint }>;
  createSprint(habitatId: string, input: SprintCreateInput): Promise<{ sprint: Sprint }>;
  updateSprint(sprintId: string, input: SprintUpdateInput): Promise<{ sprint: Sprint }>;
  deleteSprint(sprintId: string): Promise<void>;
  startSprint(sprintId: string): Promise<{ sprint: Sprint }>;
  completeSprint(sprintId: string): Promise<{ sprint: Sprint }>;
  cancelSprint(sprintId: string): Promise<{ sprint: Sprint }>;
  addMissionToSprint(sprintId: string, missionId: string): Promise<{ sprint: Sprint }>;
  removeMissionFromSprint(sprintId: string, missionId: string): Promise<{ sprint: Sprint }>;
}

export interface ScheduledTaskClient {
  listScheduledTasks(habitatId: string): Promise<{ scheduledTasks: ScheduledTask[] }>;
  createScheduledTask(habitatId: string, input: unknown): Promise<{ scheduledTask: ScheduledTask }>;
  getScheduledTask(id: string): Promise<{ scheduledTask: ScheduledTask }>;
  updateScheduledTask(id: string, input: unknown): Promise<{ scheduledTask: ScheduledTask }>;
  deleteScheduledTask(id: string): Promise<void>;
  runScheduledTask(
    scheduledTaskId: string,
  ): Promise<{ success: boolean; missionId?: string; error?: string }>;
  enableScheduledTask(id: string): Promise<{ scheduledTask: ScheduledTask }>;
  disableScheduledTask(id: string): Promise<{ scheduledTask: ScheduledTask }>;
}

export interface ReviewClient {
  listReviewRules(habitatId: string): Promise<{ reviewRules: ReviewRule[] }>;
  createReviewRule(habitatId: string, input: ReviewRuleCreateInput): Promise<{ reviewRule: ReviewRule }>;
  updateReviewRule(
    ruleId: string,
    input: ReviewRuleUpdateInput,
  ): Promise<{ reviewRule: ReviewRule | null }>;
  deleteReviewRule(ruleId: string): Promise<void>;
  listTaskReviewers(taskId: string): Promise<{ reviewers: TaskReviewer[] }>;
  addTaskReviewer(taskId: string, input: unknown): Promise<{ reviewer: TaskReviewer }>;
  removeTaskReviewer(taskId: string, reviewerId: string): Promise<void>;
}

export interface EffortClient {
  logEffort(taskId: string, input: unknown): Promise<{ entry: unknown }>;
  listEffortEntries(
    taskId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ entries: unknown[] }>;
  getEffortReport(habitatId: string, options?: { days?: number }): Promise<unknown>;
  correctEffortEntry(
    taskId: string,
    entryId: string,
    minutesDelta: number,
    correctionReason: string,
    note?: string,
  ): Promise<{ entry: unknown }>;
  getMissionEffortReport(missionId: string, options?: { days?: number }): Promise<unknown>;
}

export interface MessageClient {
  sendMessage(
    toAgentId: string,
    input: {
      boardId: string;
      taskId?: string;
      subject: string;
      body: string;
      messageType?: "info" | "request" | "response" | "alert";
      priority?: "low" | "normal" | "high" | "urgent";
    },
  ): Promise<SendMessageResponse>;
  getMessages(options?: {
    limit?: number;
    offset?: number;
    unreadOnly?: boolean;
  }): Promise<ListMessagesResponse>;
  markMessageRead(messageId: string): Promise<{ message: unknown }>;
  markAllMessagesRead(): Promise<{ updated: number }>;
  deleteMessage(messageId: string): Promise<void>;
}

export interface CommentClient {
  getTaskComments(
    taskId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ comments: TaskComment[] }>;
  addComment(
    taskId: string,
    content: string,
    parentId?: string,
  ): Promise<{ comment: TaskComment }>;
  getMissionComments(
    missionId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ comments: MissionComment[] }>;
  addMissionComment(
    missionId: string,
    content: string,
    parentId?: string,
  ): Promise<{ comment: MissionComment }>;
}

export interface AuditClient {
  exportAuditLog(
    habitatId: string,
    options?: { format?: string; fromDate?: string; toDate?: string },
  ): Promise<unknown>;
  getAuditSummary(boardId: string, options?: { since?: string; until?: string }): Promise<Record<string, unknown>>;
  getTaskAuditBundle(taskId: string): Promise<unknown>;
  getMissionAuditBundle(missionId: string): Promise<unknown>;
}

export interface InsightClient {
  promoteInsight(
    boardId: string,
    input: {
      sourcePulseId: string;
      relevanceTags?: string[];
      subject?: string;
      body?: string;
    },
  ): Promise<{ insight: ProjectInsight }>;
  getInsights(
    habitatId: string,
    options?: { limit?: number; offset?: number },
  ): Promise<{ insights: ProjectInsight[] }>;
  deactivateInsight(boardId: string, insightId: string): Promise<void>;
  getRelevantInsights(habitatId: string, tags: string[]): Promise<ProjectInsight[]>;
}

export interface QualityClient {
  getTaskQualityChecklist(taskId: string): Promise<unknown>;
  updateQualityChecklistItem(
    taskId: string,
    checklistId: string,
    itemId: string,
    input: { isCompleted?: boolean; evidenceUrl?: string; notes?: string },
  ): Promise<unknown>;
  validateQualityGates(taskId: string): Promise<{ passed: boolean; failures: unknown[] }>;
  getTaskApprovalStatus(taskId: string): Promise<{
    canBeApproved: boolean;
    reasons: string[];
    requirements: unknown;
  }>;
}

export interface DependencyClient {
  addTaskDependency(taskId: string, dependsOnId: string): Promise<unknown>;
  removeTaskDependency(taskId: string, dependsOnId: string): Promise<unknown>;
  getTaskDependencies(taskId: string): Promise<{ dependsOn: unknown[]; blocking: unknown[] }>;
  getTaskBlockedStatus(taskId: string): Promise<{
    taskId: string;
    isBlocked: boolean;
    canComplete: boolean;
    blockedBy: unknown[];
    blocking: unknown[];
  }>;
}

export interface HealthClient {
  getHabitatHealth(habitatId: string): Promise<unknown>;
  getHabitatHealthHistory(boardId: string, days?: number): Promise<unknown>;
}

export interface DashboardClient {
  getHabitatSummary(habitatId: string): Promise<HabitatSummary>;
  getHabitatMetrics(habitatId: string, options?: { days?: number }): Promise<unknown>;
}

export interface WebhookClient {
  listWebhooks(habitatId: string): Promise<ListWebhooksResponse>;
  createWebhook(habitatId: string, input: unknown): Promise<CreateWebhookResponse>;
  deleteWebhook(webhookId: string): Promise<void>;
}

export interface TemplateClient {
  listTemplates(habitatId: string): Promise<ListTemplatesResponse>;
  createTemplate(habitatId: string, input: unknown): Promise<CreateTemplateResponse>;
  deleteTemplate(templateId: string): Promise<void>;
}

export interface TimeTrackingClient {
  getTaskTimeReport(taskId: string): Promise<unknown>;
}

export interface IntegrationClient {
  inferRepositoryFromIntegration(habitatId: string): Promise<unknown>;
}
