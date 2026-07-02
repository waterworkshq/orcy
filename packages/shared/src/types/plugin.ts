import type { z } from "zod";
import type { SignalType } from "./signal.js";
import type { Task, TaskPriority } from "./task.js";
import type { IntegrationProvider, IntegrationAuthMethod } from "./integration.js";

/** Zod object constructor alias used for declarative config schemas on contributions. */
type ZodObjectAny = z.ZodType<any>;

/** Plugin manifest declaring identity, optional config schema, and contributed surfaces. */
export interface PluginManifest {
  id: string;
  version: string;
  description: string;
  configSchema?: ZodObjectAny;
  contributions: Contribution[];
}

/** Whether a contribution applies process-wide or per-habitat. */
export type PluginScope = "system" | "habitat";

/** Source events a signal detector can subscribe to (ADR-0015). */
export type DetectorSourceEvent = "pulseCreated" | "taskEvent" | "commentCreated" | "taskSubmitted";

/** Lifecycle events an interceptor can react to; subset of TaskAction (ADR-0014). */
export type InterceptorEvent =
  | "taskCreated"
  | "taskClaimed"
  | "taskSubmitted"
  | "taskApproved"
  | "taskRejected";

/** Capability names a contribution may declare in its `requires` array (ADR-0012 whitelist). */
export type PluginCapabilityName =
  | "pulseReader"
  | "pulseWriter"
  | "commentReader"
  | "taskReader"
  | "habitatReader"
  | "chatIntegrationReader"
  | "taskWriter"
  | "notificationSender"
  | "webhookCaller";

/** Discriminated union of the contribution kinds a plugin may declare (ADR-0011 + ADR-0021 + ADR-0028). */
export type Contribution =
  | NotificationChannelContribution
  | SignalDetectorContribution
  | LifecycleInterceptorContribution
  | CustomMcpToolContribution
  | CustomHttpRouteContribution
  | WebhookFormatterContribution
  | AutomationConditionContribution
  | AutomationActionContribution
  | IntegrationProviderContribution;

/** System-scoped notification delivery channel (e.g. Microsoft Teams webhook). */
export interface NotificationChannelContribution {
  kind: "notificationChannel";
  scope: "system";
  channelId: string;
  label: string;
  configSchema?: ZodObjectAny;
  timeoutMs?: number;
  requires: PluginCapabilityName[];
}

/** Habitat-scoped detector that observes source events and emits `detected` signals (ADR-0015). */
export interface SignalDetectorContribution {
  kind: "signalDetector";
  scope: "habitat";
  detectorId: string;
  label: string;
  detects: DetectorSourceEvent;
  rateLimitDefaults: { maxDetectionsPerMinute: number; maxSignalsPerHour: number };
  configSchema?: ZodObjectAny;
  timeoutMs?: number;
  requires: PluginCapabilityName[];
}

/** Habitat-scoped interceptor that runs pre or post on task lifecycle events (ADR-0014). */
export interface LifecycleInterceptorContribution {
  kind: "lifecycleInterceptor";
  scope: "habitat";
  interceptorId: string;
  phase: "pre" | "post";
  event: InterceptorEvent;
  priority: number;
  configSchema?: ZodObjectAny;
  timeoutMs?: number;
  requires: PluginCapabilityName[];
}

/** System-scoped MCP tool surfaced to agents (validated-only in v0.22.0 per ADR-0018). */
export interface CustomMcpToolContribution {
  kind: "customMcpTool";
  scope: "system";
  toolName: string;
  description: string;
  inputSchema: Record<string, unknown>;
  timeoutMs?: number;
  requires: [];
}

/** System-scoped custom HTTP route mounted on the API (ADR-0011). */
export interface CustomHttpRouteContribution {
  kind: "customHttpRoute";
  scope: "system";
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  timeoutMs?: number;
  requires: [];
}

/** System-scoped webhook payload formatter (ADR-0021). Transforms enriched event data into a provider-specific payload shape. */
export interface WebhookFormatterContribution {
  kind: "webhookFormatter";
  scope: "system";
  formatId: string;
  label: string;
  timeoutMs?: number;
  requires: [];
}

/** System-scoped automation condition evaluator (ADR-0022). Extends the automation rule condition tree with plugin-defined leaf conditions. */
export interface AutomationConditionContribution {
  kind: "automationCondition";
  scope: "system";
  conditionId: string;
  label: string;
  description: string;
  requires: [];
}

/** System-scoped automation action handler (ADR-0023). Extends the automation rule action switch with plugin-defined actions. */
export interface AutomationActionContribution {
  kind: "automationAction";
  scope: "system";
  actionId: string;
  label: string;
  description: string;
  timeoutMs?: number;
  requires: PluginCapabilityName[];
}

/** System-scoped integration provider adapter that lists and fetches external issues (ADR-0028). */
export interface IntegrationProviderContribution {
  kind: "integrationProvider";
  scope: "system";
  provider: IntegrationProvider;
  label: string;
  authMethods: readonly IntegrationAuthMethod[];
  requires: [];
}

/** Stripped evaluation context view for plugin condition handlers (ADR-0022). Agent apiKeyHash and rateLimitPerMinute are stripped. */
export interface PluginEvaluationContext {
  habitat: PluginHabitatView | null;
  task: Task | null;
  mission: {
    id: string;
    title: string;
    status: string;
    habitatId: string;
    sprintId: string | null;
  } | null;
  agent: { id: string; name: string; type: string; domain: string | null; status: string } | null;
  sprint: { id: string; name: string; status: string; habitatId: string } | null;
  raw: Record<string, unknown>;
}

/** Read-only view of a Pulse (inter-agent signal) exposed to plugin detectors. */
export interface Pulse {
  id: string;
  missionId: string | null;
  habitatId: string;
  scope: "mission" | "habitat";
  fromType: "human" | "agent" | "system" | "remote_human" | "remote_orcy";
  fromId: string;
  toType: "human" | "agent" | "remote_human" | "remote_orcy" | null;
  toId: string | null;
  signalType: SignalType;
  subject: string;
  body: string;
  taskId: string | null;
  replyToId: string | null;
  linkedTaskId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  pinned: number;
  isAuto: boolean;
}

/** Optional filter applied when listing tasks by habitat through the TaskReader capability. */
export interface TaskListFilter {
  status?: Task["status"];
  assignedAgentId?: string | null;
  missionId?: string;
  limit?: number;
}

/** Stripped projection of Habitat for plugin consumption; admin settings blobs removed. */
export interface PluginHabitatView {
  id: string;
  name: string;
  description: string;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
}

/** Unified comment shape bridging TaskComment and MissionComment for the CommentReader capability. */
export interface ScopedComment {
  id: string;
  scope: "task" | "mission";
  taskId?: string;
  missionId?: string;
  authorType: "human" | "agent" | "remote_human" | "remote_orcy";
  authorId: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

/** Input payload returned by detector handlers; server stamps provenance fields on write. */
export interface DetectedSignalInput {
  signalType: "detected";
  subject: string;
  body?: string;
  metadata?: Record<string, unknown>;
  taskId?: string;
  missionId?: string;
  replyToId?: string;
}

/** Read surface for pulses, scoped to the contribution's habitat. */
export interface PulseReader {
  listByHabitatSince(habitatId: string, since: string): Promise<Pulse[]>;
  listByHabitatBetween(habitatId: string, from: string, to: string): Promise<Pulse[]>;
  getPulse(pulseId: string): Promise<Pulse | null>;
}

/** Write surface restricted to detected-signal emission only (ADR-0012). */
export interface PulseWriter {
  createDetectedSignal(input: DetectedSignalInput): Promise<Pulse>;
}

/** Read surface for task and mission comments, scoped to the contribution's habitat. */
export interface CommentReader {
  listByHabitatSince(habitatId: string, since: string): Promise<ScopedComment[]>;
}

/** Read surface for tasks; Task carries no auth-bearing fields so it is returned as-is. */
export interface TaskReader {
  getTask(taskId: string): Promise<Task | null>;
  listTasksByHabitat(habitatId: string, filter?: TaskListFilter): Promise<Task[]>;
}

/** Restricted input for plugin-driven task creation; `createdBy` is server-stamped. */
export interface PluginTaskCreateInput {
  missionId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: TaskPriority;
}

/**
 * Write surface for task mutations, scoped to the contribution's habitat (ADR-0020).
 * Every write is habitat-scoped, audit-logged, provenance-stamped, and rate-capped.
 * No contribution kind can require `taskWriter` until the automation action extraction
 * wires it in — the capability ships dormant in v0.22.8.
 */
export interface TaskWriter {
  createTask(input: PluginTaskCreateInput): Promise<Task>;
  assignTask(taskId: string, agentId: string): Promise<void>;
  releaseTask(taskId: string): Promise<void>;
  updatePriority(taskId: string, priority: TaskPriority): Promise<void>;
}

/** Input for plugin-driven notification sending; habitat and source are server-stamped. */
export interface PluginNotificationInput {
  recipients: Array<{ recipientType: "human" | "agent"; recipientId: string }>;
  eventType: string;
  template: string;
  severity?: "info" | "warning" | "critical";
}

/**
 * Write surface for notification enqueueing, scoped to the contribution's habitat (ADR-0023).
 * Wraps notificationCommandService.enqueueNotificationForRecipients with provenance
 * stamping, rate cap, and habitat scoping.
 */
export interface NotificationSender {
  notify(input: PluginNotificationInput): Promise<{ eventId: string; deliveryCount: number }>;
}

/** Result of an outbound webhook call from a plugin. */
export interface WebhookCallResult {
  statusCode: number;
  ok: boolean;
  body?: string;
}

/**
 * Write surface for outbound HTTP calls with SSRF guard and banned headers (ADR-0023).
 * Every call is validated against private-network patterns and auth-header blocklist.
 */
export interface WebhookCaller {
  call(url: string, body?: string, headers?: Record<string, string>): Promise<WebhookCallResult>;
}

/** Read surface for the stripped habitat projection. */
export interface HabitatReader {
  getHabitat(habitatId: string): Promise<PluginHabitatView | null>;
}

/** Stripped projection of a chat integration — no botToken (ADR-0019 security boundary). */
export interface ChatIntegrationView {
  provider: "slack" | "discord";
  webhookUrl: string;
  channelId: string | null;
}

/** Read surface for habitat-scoped chat integrations (ADR-0019). Enables notification channel plugins to resolve per-habitat webhook URLs. */
export interface ChatIntegrationReader {
  getEnabledByHabitat(habitatId: string): Promise<ChatIntegrationView[]>;
}

/** Lifecycle state of a plugin run (ADR-0016 state machine). */
export type PluginRunStatus = "running" | "succeeded" | "failed" | "rate_limited" | "skipped";

/** Persisted enrollment of a habitat-scoped contribution (plugin_enrollments row, ADR-0016). */
export interface PluginEnrollment {
  id: string;
  habitatId: string;
  pluginId: string;
  contributionId: string;
  contributionKind: "signalDetector" | "lifecycleInterceptor";
  enabled: boolean;
  config: Record<string, unknown> | null;
  enrolledBy: string;
  enrolledAt: string;
  updatedAt: string;
  disabledAt: string | null;
}

/** REST create payload for a plugin enrollment. */
export interface PluginEnrollmentInput {
  habitatId: string;
  pluginId: string;
  contributionId: string;
  contributionKind: "signalDetector" | "lifecycleInterceptor";
  enabled?: boolean;
  config?: Record<string, unknown> | null;
  enrolledBy: string;
}

/** Persisted run record for a contribution invocation (plugin_runs row, ADR-0016). */
export interface PluginRun {
  id: string;
  habitatId: string;
  pluginId: string;
  contributionId: string;
  contributionKind:
    | "signalDetector"
    | "lifecycleInterceptor"
    | "notificationChannel"
    | "automationAction";
  triggerEventId: string | null;
  triggerType: string;
  status: PluginRunStatus;
  fingerprint: string;
  signalsEmitted: number | null;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}
