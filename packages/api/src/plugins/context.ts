import type {
  DetectedSignalInput,
  PulseReader,
  PulseWriter,
  CommentReader,
  TaskReader,
  TaskWriter,
  NotificationSender,
  WebhookCaller,
  WebhookCallResult,
  HabitatReader,
  ChatIntegrationView,
  ChatIntegrationReader,
  PluginHabitatView,
  PluginTaskCreateInput,
  PluginNotificationInput,
  ScopedComment,
  PluginCapabilityName,
} from "@orcy/shared";
import { detectedMetadataSchema } from "@orcy/shared";
import type { TaskPriority } from "@orcy/shared";
import type { PluginContext, PluginLogger, PluginAudit, AuditPayload } from "./types.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as pulseService from "../services/pulseService.js";
import * as taskRepo from "../repositories/task.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as missionRepo from "../repositories/feature.js";
import * as commentRepo from "../repositories/comment.js";
import * as habitatRepo from "../repositories/board.js";
import * as chatIntegrationRepo from "../repositories/chatIntegration.js";
import { enqueueNotificationForRecipients } from "../services/notificationCommandService.js";
import { logger as rootLogger } from "../lib/logger.js";

/**
 * Builds a per-invocation {@link PluginContext} whose capability surfaces are
 * gated by the contribution's declared `requires` list. Capabilities not listed
 * are left `undefined`. Kind-specific fields (`notificationPayload`, `transition`)
 * are populated by the respective dispatchers after construction.
 */
export function buildPluginContext(opts: {
  pluginId: string;
  contributionId: string;
  habitatId: string | null;
  runId: string;
  requires: PluginCapabilityName[];
}): PluginContext {
  const { pluginId, contributionId, habitatId, runId, requires } = opts;
  const has = (cap: PluginCapabilityName): boolean => requires.includes(cap);

  // Shared write cap counter across all write capabilities in this context (ADR-0020).
  // A single counter prevents a plugin requiring taskWriter + notificationSender + webhookCaller
  // from getting 3× the cap (150 writes instead of 50).
  const writeCap = Number(process.env.ORCY_PLUGIN_WRITE_CAP ?? "50");
  const sharedWriteCounter = { count: 0, cap: writeCap };

  const logger = buildPluginLogger(pluginId, contributionId, runId);
  const audit = buildPluginAudit(pluginId, runId);

  const ctx: PluginContext = {
    pluginId,
    contributionId,
    habitatId,
    runId,
    logger,
    audit,
  };

  if (has("pulseReader")) ctx.pulseReader = buildPulseReader(habitatId);
  if (has("pulseWriter")) ctx.pulseWriter = buildPulseWriter(pluginId, runId, habitatId);
  if (has("commentReader")) ctx.commentReader = buildCommentReader(habitatId);
  if (has("taskReader")) ctx.taskReader = buildTaskReader(habitatId);
  if (has("taskWriter")) ctx.taskWriter = buildTaskWriter(pluginId, runId, habitatId, sharedWriteCounter);
  if (has("notificationSender"))
    ctx.notificationSender = buildNotificationSender(pluginId, runId, habitatId, sharedWriteCounter);
  if (has("webhookCaller")) ctx.webhookCaller = buildWebhookCaller(pluginId, runId, habitatId, sharedWriteCounter);
  if (has("habitatReader")) ctx.habitatReader = buildHabitatReader(habitatId);
  if (has("chatIntegrationReader"))
    ctx.chatIntegrationReader = buildChatIntegrationReader(habitatId);

  return ctx;
}

function buildPluginLogger(pluginId: string, contributionId: string, runId: string): PluginLogger {
  const tags = { pluginId, contributionId, runId };
  return {
    info: (msg, meta) => rootLogger.info({ ...tags, ...meta }, msg),
    warn: (msg, meta) => rootLogger.warn({ ...tags, ...meta }, msg),
    error: (msg, meta) => rootLogger.error({ ...tags, ...meta }, msg),
  };
}

function buildPluginAudit(pluginId: string, runId: string): PluginAudit {
  return {
    log: (payload: AuditPayload) => {
      rootLogger.info(
        {
          auditSource: "plugin",
          source: `plugin:${pluginId}`,
          runId,
          action: payload.action,
          targetType: payload.targetType,
          targetId: payload.targetId,
          metadata: payload.metadata,
        },
        `plugin.audit:${payload.action}`,
      );
    },
  };
}

/** Scopes reader queries to the contribution's bound habitat — a plugin enrolled in habitat A cannot read habitat B's data. */
function buildPulseReader(habitatId: string | null): PulseReader {
  return {
    listByHabitatSince: (queryHabitatId, since) => {
      if (queryHabitatId !== habitatId) return Promise.resolve([]);
      return Promise.resolve(pulseRepo.listByHabitatSince(queryHabitatId, since));
    },
    listByHabitatBetween: (queryHabitatId, from, to) => {
      if (queryHabitatId !== habitatId) return Promise.resolve([]);
      return Promise.resolve(pulseRepo.listByHabitatBetween(queryHabitatId, from, to));
    },
    getPulse: (pulseId) => {
      const pulse = pulseRepo.getPulseById(pulseId);
      return Promise.resolve(pulse && pulse.habitatId === habitatId ? pulse : null);
    },
  };
}

function buildPulseWriter(pluginId: string, runId: string, habitatId: string | null): PulseWriter {
  return {
    createDetectedSignal: async (input: DetectedSignalInput) => {
      if (input.signalType !== "detected") {
        throw new Error(
          `PulseWriter only accepts signalType "detected"; got "${input.signalType}"`,
        );
      }
      if (!habitatId) {
        throw new Error("createDetectedSignal requires a habitat-scoped plugin context");
      }
      const merged: Record<string, unknown> = {
        ...input.metadata,
        detected: true,
        detector: pluginId,
        detectorRunId: runId,
      };
      // Validate the merged metadata against the detected-signal schema (defense-in-depth,
      // ADR-0013). The server injects detected/detector/detectorRunId, so this should always
      // pass — but if a future refactor lets caller-supplied metadata override the stamped
      // fields, this catches it.
      const metaParse = detectedMetadataSchema.safeParse(merged);
      if (!metaParse.success) {
        throw new Error(`Detected signal metadata failed validation: ${metaParse.error.message}`);
      }
      // Route through pulseService.createPulseAndNotify (not pulseRepo.createPulse directly) so
      // pulseCreatedHooks fire (skill ingestion via habitatSkillService.ingestFromPulse, detector
      // dispatch via pluginManager.registerDetectorHooks) AND broadcastPulse emits the SSE event
      // (pulse.signal_posted) so the UI invalidates its signal-surface queries. The previous
      // direct repo write bypassed both side-channels (ADR-0013, ADR-0014). The recursion guard
      // in registerDetectorHooks skips detected signals to prevent detector→detected→detector
      // infinite loops.
      const pulse = pulseService.createPulseAndNotify({
        habitatId,
        scope: "habitat",
        fromType: "system",
        fromId: pluginId,
        signalType: "detected",
        subject: input.subject,
        body: input.body,
        taskId: input.taskId,
        replyToId: input.replyToId,
        metadata: merged,
        isAuto: true,
      });
      pulseService.broadcastPulse(pulse);
      return pulse;
    },
  };
}

/** Scopes comment queries to the contribution's bound habitat. */
function buildCommentReader(habitatId: string | null): CommentReader {
  return {
    listByHabitatSince: (queryHabitatId, since) => {
      if (queryHabitatId !== habitatId) return Promise.resolve([]);
      return Promise.resolve(
        commentRepo.listByHabitatSince(queryHabitatId, since).map((c) => toScopedComment(c)),
      );
    },
  };
}

function toScopedComment(c: {
  id: string;
  scope: "task" | "mission";
  taskId: string | null;
  missionId: string | null;
  content: string;
  authorType: ScopedComment["authorType"];
  authorId: string;
  createdAt: string;
}): ScopedComment {
  return {
    id: c.id,
    scope: c.scope,
    taskId: c.taskId ?? undefined,
    missionId: c.missionId ?? undefined,
    authorType: c.authorType,
    authorId: c.authorId,
    content: c.content,
    createdAt: c.createdAt,
    updatedAt: c.createdAt,
  };
}

/** Scopes task queries to the contribution's bound habitat — getTask returns null if the task belongs to a different habitat. */
function buildTaskReader(habitatId: string | null): TaskReader {
  return {
    getTask: (taskId) => {
      const task = taskRepo.getTaskById(taskId);
      if (!task) return Promise.resolve(null);
      const mission = missionRepo.getMissionById(task.missionId);
      return Promise.resolve(mission?.habitatId === habitatId ? task : null);
    },
    listTasksByHabitat: (queryHabitatId, filter) => {
      if (queryHabitatId !== habitatId) return Promise.resolve([]);
      return Promise.resolve(taskRepo.getTasksByHabitatId(queryHabitatId, filter).tasks);
    },
  };
}

/**
 * Write surface for task mutations, scoped to the contribution's habitat (ADR-0020).
 * Every method validates habitat ownership before writing, stamps provenance
 * (`plugin:${pluginId}`) on created tasks, logs to the audit surface, and enforces
 * a per-run write cap to prevent runaway plugins.
 */
function buildTaskWriter(
  pluginId: string,
  runId: string,
  habitatId: string | null,
  writeCounter: { count: number; cap: number },
): TaskWriter {
  function checkCap(): void {
    if (writeCounter.count >= writeCounter.cap) {
      throw new Error(
        `Plugin write cap exceeded (${writeCounter.count}/${writeCounter.cap}) — too many mutations in a single run`,
      );
    }
    writeCounter.count++;
  }

  function verifyHabitat(taskId: string): { missionId: string } {
    const task = taskRepo.getTaskById(taskId);
    if (!task) throw new Error(`Task not found: ${taskId}`);
    const mission = missionRepo.getMissionById(task.missionId);
    if (!mission || mission.habitatId !== habitatId) {
      throw new Error(`Task ${taskId} does not belong to this habitat`);
    }
    return { missionId: task.missionId };
  }

  return {
    createTask: async (input: PluginTaskCreateInput) => {
      if (!habitatId) throw new Error("createTask requires a habitat-scoped plugin context");
      checkCap();
      const mission = missionRepo.getMissionById(input.missionId);
      if (!mission) throw new Error(`Mission not found: ${input.missionId}`);
      if (mission.habitatId !== habitatId) {
        throw new Error(`Mission ${input.missionId} does not belong to this habitat`);
      }
      const task = taskRepo.createTask({
        missionId: input.missionId,
        title: input.title,
        description: input.description,
        labels: input.labels,
        priority: input.priority,
        createdBy: `plugin:${pluginId}`,
      });
      rootLogger.info(
        { pluginId, runId, taskId: task.id, missionId: input.missionId, action: "task.create" },
        "plugin.taskWriter: createTask",
      );
      return task;
    },

    assignTask: async (taskId: string, agentId: string) => {
      if (!habitatId) throw new Error("assignTask requires a habitat-scoped plugin context");
      checkCap();
      verifyHabitat(taskId);
      const result = taskStateMachine.claimTask(taskId, agentId);
      if (!result.success) {
        throw new Error(`assignTask failed: ${result.reason}`);
      }
      rootLogger.info(
        { pluginId, runId, taskId, agentId, action: "task.assign" },
        "plugin.taskWriter: assignTask",
      );
    },

    releaseTask: async (taskId: string) => {
      if (!habitatId) throw new Error("releaseTask requires a habitat-scoped plugin context");
      checkCap();
      verifyHabitat(taskId);
      const released = taskStateMachine.releaseTask(taskId, `plugin:${pluginId}`);
      if (!released) {
        throw new Error(`releaseTask failed — task may not be in correct state`);
      }
      rootLogger.info(
        { pluginId, runId, taskId, action: "task.release" },
        "plugin.taskWriter: releaseTask",
      );
    },

    updatePriority: async (taskId: string, priority: TaskPriority) => {
      if (!habitatId) throw new Error("updatePriority requires a habitat-scoped plugin context");
      checkCap();
      verifyHabitat(taskId);
      const updated = taskRepo.updateTask(taskId, { priority });
      if (!updated) {
        throw new Error(`updatePriority failed — task ${taskId} not found or update rejected`);
      }
      rootLogger.info(
        { pluginId, runId, taskId, priority, action: "task.updatePriority" },
        "plugin.taskWriter: updatePriority",
      );
    },
  };
}

/** SSRF guard patterns shared with the in-tree automation executor. */
const SSRF_BLOCKED_PATTERNS = [
  /^https?:\/\/(localhost|127\.|10\.|172\.1[6-9]|172\.2\d|172\.3[0-1]|192\.168\.|0\.0\.0\.0|169\.254\.)/i,
];
const BANNED_HEADERS = new Set(["authorization", "cookie", "x-api-key", "x-token", "x-secret"]);

/**
 * Write surface for notification enqueueing, scoped to the contribution's habitat (ADR-0023).
 * Wraps notificationCommandService.enqueueNotificationForRecipients with provenance
 * stamping, rate cap, and habitat scoping.
 */
function buildNotificationSender(
  pluginId: string,
  runId: string,
  habitatId: string | null,
  writeCounter: { count: number; cap: number },
): NotificationSender {
  return {
    notify: async (input: PluginNotificationInput) => {
      if (!habitatId) throw new Error("notify requires a habitat-scoped plugin context");
      if (writeCounter.count >= writeCounter.cap) {
        throw new Error(`Plugin write cap exceeded (${writeCounter.count}/${writeCounter.cap})`);
      }
      writeCounter.count++;
      const result = enqueueNotificationForRecipients(
        habitatId,
        input.eventType as any,
        "automation",
        (input.severity ?? "info") as any,
        input.recipients,
        {
          payload: { renderedTemplate: input.template, pluginId },
          createdByType: "automation",
          createdById: `plugin:${pluginId}`,
        },
      );
      rootLogger.info(
        { pluginId, runId, eventId: result.event.id, deliveryCount: result.deliveries.length, action: "notification.send" },
        "plugin.notificationSender: notify",
      );
      return { eventId: result.event.id, deliveryCount: result.deliveries.length };
    },
  };
}

/**
 * Write surface for outbound HTTP calls with SSRF guard and banned headers (ADR-0023).
 * Every call is validated against private-network patterns and auth-header blocklist.
 */
function buildWebhookCaller(
  pluginId: string,
  runId: string,
  habitatId: string | null,
  writeCounter: { count: number; cap: number },
): WebhookCaller {
  function validateUrl(url: string): void {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new Error("Invalid URL");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("URL must use http or https");
    }
    for (const pattern of SSRF_BLOCKED_PATTERNS) {
      if (pattern.test(url)) {
        throw new Error("URL resolves to a private/internal address");
      }
    }
  }

  function validateHeaders(headers?: Record<string, string>): void {
    if (!headers) return;
    for (const key of Object.keys(headers)) {
      if (BANNED_HEADERS.has(key.toLowerCase())) {
        throw new Error(`Header "${key}" is not allowed in plugin webhook calls`);
      }
    }
  }

  return {
    call: async (url: string, body?: string, headers?: Record<string, string>) => {
      if (!habitatId) throw new Error("call requires a habitat-scoped plugin context");
      if (writeCounter.count >= writeCounter.cap) {
        throw new Error(`Plugin write cap exceeded (${writeCounter.count}/${writeCounter.cap})`);
      }
      writeCounter.count++;
      validateUrl(url);
      validateHeaders(headers);
      try {
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "User-Agent": `Orcy-Plugin/${pluginId}`, ...headers },
          body: body ?? undefined,
        });
        const responseText = await response.text().catch(() => "");
        rootLogger.info(
          { pluginId, runId, url, statusCode: response.status, action: "webhook.call" },
          "plugin.webhookCaller: call",
        );
        return { statusCode: response.status, ok: response.ok, body: responseText.slice(0, 1000) };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        rootLogger.warn({ pluginId, runId, url, err: message }, "plugin.webhookCaller: call failed");
        throw new Error(`Webhook call to ${url} failed: ${message}`);
      }
    },
  };
}

/** Scopes habitat reads to the contribution's bound habitat. */
function buildHabitatReader(habitatId: string | null): HabitatReader {
  return {
    getHabitat: (queryHabitatId) => {
      if (queryHabitatId !== habitatId) return Promise.resolve(null);
      const h = habitatRepo.getHabitatById(queryHabitatId);
      return Promise.resolve(h ? toPluginHabitatView(h) : null);
    },
  };
}

function toPluginHabitatView(h: {
  id: string;
  name: string;
  description: string;
  teamId: string | null;
  createdAt: string;
  updatedAt: string;
}): PluginHabitatView {
  return {
    id: h.id,
    name: h.name,
    description: h.description,
    teamId: h.teamId,
    createdAt: h.createdAt,
    updatedAt: h.updatedAt,
  };
}

/** Scopes chat integration reads to the contribution's bound habitat; strips botToken (ADR-0019). */
function buildChatIntegrationReader(habitatId: string | null): ChatIntegrationReader {
  return {
    getEnabledByHabitat: (queryHabitatId) => {
      if (queryHabitatId !== habitatId) return Promise.resolve([]);
      const integrations = chatIntegrationRepo.getEnabledIntegrationsByHabitat(queryHabitatId);
      const views: ChatIntegrationView[] = integrations.map((i) => ({
        provider: i.provider,
        webhookUrl: i.webhookUrl,
        channelId: i.channelId,
      }));
      return Promise.resolve(views);
    },
  };
}
