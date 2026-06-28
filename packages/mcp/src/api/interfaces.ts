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
  WikiPage,
  WikiPageVersion,
  WikiPageLink,
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
  getHabitat(
    habitatId: string,
  ): Promise<{ habitat: { id: string; name: string; columns: { name: string }[] } }>;
  listHabitats(name?: string): Promise<{ habitats: Habitat[] }>;
  createHabitat(input: { name: string; description?: string }): Promise<{ habitat: Habitat }>;
  getHabitatSettings(boardId: string): Promise<{ habitat: HabitatSettings }>;
  updateHabitatSettings(
    boardId: string,
    settings: Partial<HabitatSettings>,
  ): Promise<{ habitat: HabitatSettings }>;
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
  getPulseInbox(filters?: {
    signalType?: string;
    limit?: number;
    offset?: number;
  }): Promise<ListPulsesResponse>;
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
  getMissionCodeEvidence(
    missionId: string,
    includeHistory?: boolean,
  ): Promise<Record<string, unknown>>;
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
  getHabitatSkill(boardId: string): Promise<{
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
  listAgents(options?: { status?: string; domain?: string; include?: string }): Promise<{
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
  createReviewRule(
    habitatId: string,
    input: ReviewRuleCreateInput,
  ): Promise<{ reviewRule: ReviewRule }>;
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
  addComment(taskId: string, content: string, parentId?: string): Promise<{ comment: TaskComment }>;
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
  getAuditSummary(
    boardId: string,
    options?: { since?: string; until?: string },
  ): Promise<Record<string, unknown>>;
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

export interface NotificationClient {
  getInbox(habitatId: string, options?: { limit?: number; offset?: number }): Promise<unknown>;
  getHistory(habitatId: string, options?: { limit?: number; offset?: number }): Promise<unknown>;
  getDelivery(habitatId: string, deliveryId: string): Promise<unknown>;
  acknowledgeDelivery(habitatId: string, deliveryId: string): Promise<unknown>;
  snoozeDelivery(habitatId: string, deliveryId: string, snoozedUntil: string): Promise<unknown>;
  clearDelivery(habitatId: string, deliveryId: string): Promise<unknown>;
  getSubscriptions(habitatId: string): Promise<unknown>;
}

export interface AutomationClient {
  listRules(habitatId: string): Promise<unknown>;
  getRule(ruleId: string): Promise<unknown>;
  simulateRule(ruleId: string, input: Record<string, unknown>): Promise<unknown>;
  listRuns(habitatId: string, options?: { limit?: number; offset?: number }): Promise<unknown>;
  getRuleRuns(ruleId: string, options?: { limit?: number; offset?: number }): Promise<unknown>;
}

/** Read-only workflow context methods used by MCP tools (orcy_get_failure_context, orcy_get_workflow_context). */
export interface WorkflowClient {
  getTaskFailureContext(taskId: string): Promise<{ failureContext: Record<string, unknown> }>;
  getTaskWorkflowContext(
    taskId: string,
  ): Promise<{ upstream: Record<string, unknown>[]; downstream: Record<string, unknown>[] }>;
}

/** Search hit row returned by {@link WikiClient.searchWiki} — BM25-ranked excerpt over published pages. */
export interface WikiSearchHit {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  rank: number;
}

/** Aggregated experience cluster projected for reader-facing surfaces (ADR-0009-adjacent privacy boundary — see ARCHITECTURE.md §11.7). Individual pulse / task / comment / agent IDs are NOT exposed. */
export interface WikiExperienceAggregate {
  id: string;
  subject: string;
  summary: string | null;
  skillCategory: string;
  sourceSignalType: string;
  strength: number;
  frequency: number;
  corroboratingAgents: number;
  successfulTasks: number;
  failedTasks: number;
  firstSeenAt: string;
  lastSeenAt: string;
}

/** Subset of the pulse shape returned by {@link WikiClient.getSignalSurface} — attribution preserved (no privacy gate on findings). */
export type WikiFindingPulse = Record<string, unknown>;

/** Parallel-array surface returned by {@link WikiClient.getSignalSurface}. Experience and findings are NOT cross-correlated (deferred to v0.23). */
export interface WikiSignalSurface {
  experiencePatterns?: WikiExperienceAggregate[];
  findings?: WikiFindingPulse[];
  unstructuredFindings?: WikiFindingPulse[];
}

/** Habitat wiki methods used by the `orcy_wiki` MCP dispatch tool (seed 10, v0.21). */
export interface WikiClient {
  listWikiPages(
    habitatId: string,
    filters?: { parentId?: string | null; tag?: string; status?: string },
  ): Promise<WikiPage[]>;
  getWikiPage(
    habitatId: string,
    pageId: string,
  ): Promise<WikiPage & { links: (WikiPageLink & { dangling?: boolean })[] }>;
  createWikiPage(
    habitatId: string,
    input: {
      title: string;
      content: string;
      parentId?: string | null;
      tags?: string[];
      coverageFrom?: string;
      coverageTo?: string;
    },
  ): Promise<WikiPage>;
  updateWikiPageMetadata(
    habitatId: string,
    pageId: string,
    patch: {
      parentId?: string | null;
      tags?: string[];
      status?: "draft" | "published";
      coverageFrom?: string;
      coverageTo?: string;
    },
  ): Promise<WikiPage>;
  deleteWikiPage(
    habitatId: string,
    pageId: string,
    opts?: { stayGone?: boolean; reason?: string },
  ): Promise<{ deleted: true }>;
  listWikiVersions(habitatId: string, pageId: string): Promise<WikiPageVersion[]>;
  getWikiVersion(
    habitatId: string,
    pageId: string,
    versionNumber: number,
  ): Promise<WikiPageVersion>;
  saveWikiVersion(
    habitatId: string,
    pageId: string,
    input: { title: string; content: string; editSummary?: string },
  ): Promise<WikiPage>;
  restoreWikiVersion(habitatId: string, pageId: string, versionNumber: number): Promise<WikiPage>;
  listWikiLinks(
    habitatId: string,
    pageId: string,
  ): Promise<(WikiPageLink & { dangling?: boolean })[]>;
  addWikiPageLink(
    habitatId: string,
    pageId: string,
    input: { targetType: string; targetId: string; note?: string },
  ): Promise<WikiPageLink>;
  removeWikiPageLink(habitatId: string, pageId: string, linkId: string): Promise<{ deleted: true }>;
  searchWiki(
    habitatId: string,
    query: string,
    opts?: { limit?: number; offset?: number },
  ): Promise<WikiSearchHit[]>;
  markNoUpdateNeeded(
    habitatId: string,
    input: { from: string; to: string; reason?: string },
  ): Promise<{ created: true }>;
  /** Returns the authoring context for an existing page (delta mode). */
  getAuthoringContextForEdit(habitatId: string, pageId: string): Promise<Record<string, unknown>>;
  /** Returns the authoring context for a date range (chunk mode). */
  getAuthoringContextForChunk(
    habitatId: string,
    input: { from: string; to: string; query?: string },
  ): Promise<Record<string, unknown>>;
  /** Triggers a one-shot refresh of the wiki coverage gap for the habitat. */
  triggerWikiRefresh(habitatId: string): Promise<Record<string, unknown>>;
  /** Returns the parallel-array signal surface for a habitat (seed 14 — experience + findings, NOT cross-correlated). */
  getSignalSurface(
    habitatId: string,
    opts?: {
      domain?: string;
      timeWindow?: string;
      signalClass?: "experience" | "finding" | "both";
    },
  ): Promise<WikiSignalSurface>;
}
