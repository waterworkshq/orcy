import type {
  DetectedSignalInput,
  PulseReader,
  PulseWriter,
  CommentReader,
  TaskReader,
  HabitatReader,
  ChatIntegrationView,
  ChatIntegrationReader,
  PluginHabitatView,
  ScopedComment,
  PluginCapabilityName,
} from "@orcy/shared";
import { detectedMetadataSchema } from "@orcy/shared";
import type { PluginContext, PluginLogger, PluginAudit, AuditPayload } from "./types.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as pulseService from "../services/pulseService.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as commentRepo from "../repositories/comment.js";
import * as habitatRepo from "../repositories/board.js";
import * as chatIntegrationRepo from "../repositories/chatIntegration.js";
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
