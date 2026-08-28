import type {
  PluginManifest,
  DetectedSignalInput,
  PulseReader,
  PulseWriter,
  CommentReader,
  TaskReader,
  TaskWriter,
  NotificationSender,
  WebhookCaller,
  HabitatReader,
  ChatIntegrationReader,
  PluginEvaluationContext,
  InterceptorEvent,
  NotificationDelivery,
  NotificationEvent,
} from "@orcy/shared";
import type { TransitionContext } from "../services/tasks/transition-emitter.js";
import type { IssueProviderAdapter } from "../services/integrations/types.js";

/** Runtime object exported by a plugin module; pairs a manifest with its handler maps. */
export interface PluginModule {
  manifest: PluginManifest;
  channels?: Record<string, ChannelHandler>;
  detectors?: Record<string, DetectorHandler>;
  interceptors?: Record<string, InterceptorHandler>;
  mcpHandlers?: Record<string, McpToolHandler>;
  formatters?: Record<string, FormatterHandler>;
  conditions?: Record<string, ConditionHandler>;
  actions?: Record<string, ActionListener>;
  providers?: Record<string, ProviderHandler>;
  /**
   * Keyed request handlers for declared `customHttpRoute` contributions
   * (ADR-0050). Each key MUST be a declared contribution's `routeId`; keys
   * without a matching declaration reject the whole plugin at load. A handler
   * receives only bounded request-scoped inputs — never a Fastify instance,
   * registration capability, or reply object. Core alone registers the route.
   */
  httpHandlers?: Record<string, PluginHttpHandler>;
}

/** Issue-provider adapter handler that lists and fetches external issues (ADR-0028). Mirrors the in-tree `IssueProviderAdapter` minus the self-identifying `provider` field (the registry is keyed by provider). */
export type ProviderHandler = Omit<IssueProviderAdapter, "provider">;

/**
 * Authenticated local actor resolved by the fixed `local_actor` policy guard
 * before a plugin HTTP handler runs (ADR-0050). Derived from the verified
 * credential — a plugin can neither forge nor choose it.
 */
export interface PluginHttpActor {
  type: "human" | "agent";
  id: string;
  /** Human username or agent name when the credential carries one. */
  name: string | null;
}

/**
 * Bounded request-scoped input handed to a plugin HTTP handler (ADR-0050).
 * Deliberately carries no Fastify request/reply objects and no registration
 * capability. `headers`/`query`/`body` are the request's parsed values as
 * the server received them — plain top-level records, NOT deep copies
 * (nested body values are shared with the request); handlers must treat
 * them as read-only.
 */
export interface PluginHttpRequest {
  /** Uppercase HTTP method of the matched route. */
  method: string;
  /** Normalized declared path, relative to the plugin's namespace. */
  path: string;
  /** Static path parameters (empty while declarations are static-only). */
  params: Readonly<Record<string, string>>;
  /** Parsed query string. */
  query: Record<string, unknown>;
  /** Parsed request body (`undefined` when absent). */
  body: unknown;
  /** Raw request headers. */
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /**
   * Authenticated local actor. `null` is defensive at the type boundary:
   * under the fixed `local_actor` policy the guard rejects absent
   * credentials before the handler runs, so a normally installed route
   * always resolves a principal.
   */
  actor: PluginHttpActor | null;
}

/** Bounded response a plugin HTTP handler may return. */
export interface PluginHttpResponse {
  /** HTTP status code (default 200; a `void` return maps to 204). */
  status?: number;
  /** Serialized response body. */
  body?: unknown;
}

/**
 * Request handler for a declared `customHttpRoute` contribution, keyed by its
 * `routeId` in {@link PluginModule.httpHandlers}. Faults are contained to the
 * request: they flow through the global error envelope with plugin/route
 * identity logging — never into quarantine counters or process shutdown
 * (ADR-0050 supersedes ADR-0041's mount-time crash-loud contract).
 */
export type PluginHttpHandler = (
  request: PluginHttpRequest,
) => Promise<PluginHttpResponse | void> | PluginHttpResponse | void;

/** Delivers a notification through a channel; invoked by the channel dispatcher. */
export type ChannelHandler = (
  ctx: PluginContext,
  payload: NotificationPayload,
) => Promise<ChannelHandlerResult>;

/** Observes a source event and returns detected signals for the server to persist. */
export type DetectorHandler = (
  ctx: PluginContext,
  source: EventSourceRef,
) => Promise<DetectedSignalInput[]>;

/**
 * Intercepts a task lifecycle transition (pre or post phase).
 *
 * Pre-phase handlers MUST be synchronous (return `InterceptorResult` directly, not a Promise) —
 * pre-hooks are gate functions and must complete fast so the transition DB transaction is not
 * delayed. The Plugin Invocation Runtime detects thenable returns and treats them as a bounded
 * fail-closed runtime fault: a failure veto that counts toward quarantine (ADR-0039 Q1).
 * Post-phase handlers SHOULD be async (the runtime `invokePostInterceptorThroughRuntime` awaits
 * them via `invokeManaged`).
 */
export type InterceptorHandler = (
  ctx: PluginContext,
  transition: TransitionRef,
) => InterceptorResult | Promise<InterceptorResult>;

/** MCP tool handler (validated-only in v0.22.0; dispatch not wired per ADR-0018). */
export type McpToolHandler = (args: Record<string, unknown>) => Promise<unknown>;

/** Webhook payload formatter handler — pure function transforming enriched event data (ADR-0021). */
export type FormatterHandler = (
  enrichment: unknown,
  eventType: string,
  deliveryId: string,
) => object;

/** Automation condition handler — synchronous evaluation returning match result (ADR-0022). */
export type ConditionHandler = (
  evaluationCtx: PluginEvaluationContext,
  params: Record<string, unknown>,
) => { matched: boolean; reason: string };

/** Automation action handler — async execution with write capabilities (ADR-0023). */
export type ActionListener = (
  ctx: PluginContext,
  evaluationCtx: PluginEvaluationContext,
  params: Record<string, unknown>,
) => Promise<{ status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string }>;

/** Per-invocation context handed to every plugin handler. */
export interface PluginContext {
  pluginId: string;
  contributionId: string;
  habitatId: string | null;
  runId: string;
  logger: PluginLogger;
  audit: PluginAudit;
  notificationPayload?: NotificationPayload;
  transition?: TransitionRef;
  pulseReader?: PulseReader;
  pulseWriter?: PulseWriter;
  commentReader?: CommentReader;
  taskReader?: TaskReader;
  taskWriter?: TaskWriter;
  notificationSender?: NotificationSender;
  webhookCaller?: WebhookCaller;
  habitatReader?: HabitatReader;
  chatIntegrationReader?: ChatIntegrationReader;
}

/** Structured logger scoped to a single plugin invocation. */
export interface PluginLogger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

/** Write-only audit sink; plugin handlers cannot read audit rows. */
export interface PluginAudit {
  log(payload: AuditPayload): void;
}

/** Payload accepted by {@link PluginAudit.log}. */
export interface AuditPayload {
  action: string;
  targetType?: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Identifies the transition an interceptor is reacting to. */
export interface TransitionRef {
  taskId: string;
  action: InterceptorEvent;
  habitatId: string;
  context: TransitionContext;
}

/** Notification delivery + event handed to channel handlers. */
export interface NotificationPayload {
  delivery: NotificationDelivery;
  event: NotificationEvent;
}

/** Outcome of a channel delivery attempt. */
export interface ChannelHandlerResult {
  success: boolean;
  attemptId?: string;
  error?: string;
  statusCode?: number;
}

/** Discriminated result of an interceptor (pre-veto or post-signals). */
export type InterceptorResult = InterceptorPreResult | InterceptorPostResult;

/** Pre-phase result: allow the transition or veto it. */
export type InterceptorPreResult =
  | { allow: true }
  | { allow: false; reason: string; details?: string };

/** Post-phase result: optional detected signals for the server to persist. */
export interface InterceptorPostResult {
  signals?: DetectedSignalInput[];
}

/** Reference to the source event that triggered a detector invocation. */
export interface EventSourceRef {
  kind: "pulseCreated" | "taskEvent" | "commentCreated" | "taskSubmitted";
  sourceId: string;
  habitatId: string;
  occurredAt: string;
}

/** REST view of a loaded plugin (returned by `GET /plugins`). */
export interface PluginManifestView {
  id: string;
  version: string;
  description: string;
  error?: string;
}
