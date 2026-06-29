import type {
  DetectedSignalInput,
  PulseReader,
  PulseWriter,
  CommentReader,
  TaskReader,
  HabitatReader,
  PluginHabitatView,
  ScopedComment,
  PluginCapabilityName,
} from "@orcy/shared";
import { detectedMetadataSchema } from "@orcy/shared";
import type { PluginContext, PluginLogger, PluginAudit, AuditPayload } from "./types.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as pulseService from "../services/pulseService.js";
import * as taskRepo from "../repositories/task.js";
import * as commentRepo from "../repositories/comment.js";
import * as habitatRepo from "../repositories/board.js";
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

  if (has("pulseReader")) ctx.pulseReader = buildPulseReader();
  if (has("pulseWriter")) ctx.pulseWriter = buildPulseWriter(pluginId, runId, habitatId);
  if (has("commentReader")) ctx.commentReader = buildCommentReader();
  if (has("taskReader")) ctx.taskReader = buildTaskReader();
  if (has("habitatReader")) ctx.habitatReader = buildHabitatReader();

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

function buildPulseReader(): PulseReader {
  return {
    listByHabitatSince: (habitatId, since) =>
      Promise.resolve(pulseRepo.listByHabitatSince(habitatId, since)),
    listByHabitatBetween: (habitatId, from, to) =>
      Promise.resolve(pulseRepo.listByHabitatBetween(habitatId, from, to)),
    getPulse: (pulseId) => Promise.resolve(pulseRepo.getPulseById(pulseId)),
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
        habitatId: habitatId ?? "",
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

function buildCommentReader(): CommentReader {
  return {
    listByHabitatSince: (habitatId, since) =>
      Promise.resolve(
        commentRepo.listByHabitatSince(habitatId, since).map((c) => toScopedComment(c)),
      ),
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

function buildTaskReader(): TaskReader {
  return {
    getTask: (taskId) => Promise.resolve(taskRepo.getTaskById(taskId) ?? null),
    listTasksByHabitat: (habitatId, filter) =>
      Promise.resolve(taskRepo.getTasksByHabitatId(habitatId, filter).tasks),
  };
}

function buildHabitatReader(): HabitatReader {
  return {
    getHabitat: (habitatId) => {
      const h = habitatRepo.getHabitatById(habitatId);
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
