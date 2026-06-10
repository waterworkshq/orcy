import * as taskRepo from "../../repositories/task.js";
import * as agentRepo from "../../repositories/agent.js";
import * as eventRepo from "../../repositories/event.js";
import { sseBroadcaster } from "../../sse/broadcaster.js";
import * as watcherService from "../watcherService.js";
import * as retryService from "../retryService.js";
import * as pluginManager from "../../plugins/pluginManager.js";
import * as missionService from "../featureService.js";
import * as pulseService from "../pulseService.js";
import { logger } from "../../lib/logger.js";
import type { Task } from "../../models/index.js";
import type { EventAction } from "@orcy/shared";

export type TaskAction =
  | "claimed"
  | "started"
  | "submitted"
  | "approved"
  | "rejected"
  | "completed"
  | "released"
  | "failed"
  | "created"
  | "updated"
  | "deleted"
  | "delegated"
  | "claimed_delegated"
  | "retry_scheduled"
  | "retry_executed"
  | "escalated";

const EVENT_ACTION_FOR: Record<TaskAction, EventAction | null> = {
  claimed: "claimed",
  started: "started",
  submitted: "submitted",
  approved: "approved",
  rejected: "rejected",
  completed: "completed",
  released: "released",
  failed: "failed",
  created: "created",
  updated: "updated",
  deleted: null,
  delegated: "delegated",
  claimed_delegated: "claimed",
  retry_scheduled: "retry_scheduled",
  retry_executed: "retry_executed",
  escalated: "escalated",
};

export interface TransitionContext {
  actorId?: string;
  actorType?: "agent" | "human" | "system";
  reason?: string;
  oldStatus?: string;
  newStatus?: string;
  assignedAgentId?: string;
  metadata?: Record<string, unknown>;
  task?: Task;
  fromAgentId?: string;
  toAgentId?: string;
  retryCount?: number;
  nextRetryAt?: string;
  reviewerId?: string;
  backoffSeconds?: number;
  changedFields?: string[];
  taskId?: string;
}

type RecalcMode = "wrapped" | "direct" | "conditional" | "none";

interface ActionConfig {
  sseSpecific?: string;
  emitTaskUpdated: boolean;
  watchers?: string;
  pluginHook?: "emitTaskCreated" | "emitTaskClaimed" | "emitTaskSubmitted" | "emitTaskApproved" | "emitTaskRejected";
  pluginAgentRequired?: boolean;
  recalc: RecalcMode;
  pulseSignal?: { type: "context" | "offer" | "warning"; subject: (ctx: TransitionContext) => string };
  pulseExtra?: { type: "context"; subjectIf: (task: Task) => boolean; subject: (task: Task) => string };
  notifyTaskEvent?: string;
  triggerUnblock?: boolean;
  triggerRetry?: boolean;
  emitEvent: boolean;
  eventToStatus?: string;
}

const ACTION_EFFECTS: Record<TaskAction, ActionConfig> = {
  claimed: {
    sseSpecific: "task.claimed",
    emitTaskUpdated: true,
    watchers: "task.claimed",
    pluginHook: "emitTaskClaimed",
    pluginAgentRequired: true,
    recalc: "wrapped",
    emitEvent: true,
    eventToStatus: "claimed",
    pulseSignal: {
      type: "context",
      subject: (ctx) => `${ctx.actorId ?? "agent"} claimed '${ctx.task?.title ?? ctx.taskId}'`,
    },
  },
  started: {
    emitTaskUpdated: true,
    recalc: "wrapped",
    emitEvent: true,
    eventToStatus: "in_progress",
  },
  submitted: {
    sseSpecific: "task.submitted",
    emitTaskUpdated: true,
    watchers: "task.submitted",
    pluginHook: "emitTaskSubmitted",
    recalc: "wrapped",
    emitEvent: true,
    eventToStatus: "submitted",
    pulseSignal: {
      type: "offer",
      subject: (ctx) => `Results for '${ctx.task?.title ?? ctx.taskId}' available for review`,
    },
  },
  completed: {
    sseSpecific: "task.completed",
    emitTaskUpdated: true,
    watchers: "task.completed",
    pluginHook: "emitTaskApproved",
    recalc: "wrapped",
    emitEvent: true,
    eventToStatus: "done",
    pulseSignal: {
      type: "context",
      subject: (ctx) => `${ctx.actorId ?? "agent"} completed '${ctx.task?.title ?? ctx.taskId}'`,
    },
    pulseExtra: {
      type: "context",
      subjectIf: (t) => t.labels?.includes("blocker-clearance") ?? false,
      subject: (t) => `Blocker cleared: ${t.title.replace(/^Clear Blocker:\s*/, "")}`,
    },
    triggerUnblock: true,
    notifyTaskEvent: "completed",
  },
  approved: {
    sseSpecific: "task.approved",
    emitTaskUpdated: true,
    watchers: "task.approved",
    pluginHook: "emitTaskApproved",
    recalc: "wrapped",
    emitEvent: true,
    eventToStatus: "approved",
    triggerUnblock: true,
    notifyTaskEvent: "approved",
  },
  rejected: {
    sseSpecific: "task.rejected",
    emitTaskUpdated: true,
    watchers: "task.rejected",
    pluginHook: "emitTaskRejected",
    recalc: "wrapped",
    emitEvent: true,
    eventToStatus: "rejected",
    triggerRetry: true,
    notifyTaskEvent: "rejected",
  },
  released: {
    sseSpecific: "task.released",
    emitTaskUpdated: true,
    watchers: "task.released",
    recalc: "wrapped",
    emitEvent: true,
    eventToStatus: "pending",
    pulseSignal: {
      type: "context",
      subject: (ctx) => `Task '${ctx.task?.title ?? ctx.taskId}' released, available for claim`,
    },
  },
  failed: {
    sseSpecific: "task.failed",
    emitTaskUpdated: true,
    watchers: "task.failed",
    recalc: "wrapped",
    emitEvent: true,
    eventToStatus: "failed",
    pulseSignal: {
      type: "warning",
      subject: (ctx) => `Task '${ctx.task?.title ?? ctx.taskId}' failed: ${ctx.reason ?? ""}`,
    },
    triggerRetry: true,
    notifyTaskEvent: "failed",
  },
  created: {
    sseSpecific: "task.created",
    emitTaskUpdated: false,
    pluginHook: "emitTaskCreated",
    recalc: "direct",
    emitEvent: true,
  },
  updated: {
    emitTaskUpdated: true,
    watchers: "task.updated",
    recalc: "conditional",
    emitEvent: true,
  },
  deleted: {
    sseSpecific: "task.deleted",
    emitTaskUpdated: false,
    watchers: "task.deleted",
    recalc: "direct",
    emitEvent: false,
  },
  delegated: {
    sseSpecific: "task.delegated",
    emitTaskUpdated: true,
    recalc: "none",
    emitEvent: true,
  },
  claimed_delegated: {
    sseSpecific: "task.claimed",
    emitTaskUpdated: true,
    watchers: "task.claimed",
    recalc: "direct",
    emitEvent: true,
    eventToStatus: "claimed",
  },
  retry_scheduled: {
    sseSpecific: "task.retry_scheduled",
    emitTaskUpdated: false,
    recalc: "none",
    emitEvent: true,
  },
  retry_executed: {
    sseSpecific: "task.retry_executed",
    emitTaskUpdated: true,
    recalc: "direct",
    emitEvent: true,
    eventToStatus: "pending",
  },
  escalated: {
    sseSpecific: "task.escalated",
    emitTaskUpdated: true,
    recalc: "direct",
    emitEvent: true,
  },
};

/**
 * Actions currently firing via the task-event hook bus (notifyTaskEvent).
 * Per the v0.17.1 plan's inconsistency #2, this list intentionally
 * does not include all transition actions. If you add a new action
 * here, audit every `onTaskEvent` consumer to confirm they handle it.
 */
export const NOTIFY_TASK_EVENT_ACTIONS: readonly TaskAction[] = [
  "completed",
  "approved",
  "rejected",
  "failed",
];

let recalcDebounceEnabled = process.env.ORCY_TRANSITION_RECALC_DEBOUNCE === "true";
const pendingRecalcs = new Map<string, NodeJS.Timeout>();

export function setRecalcDebounceEnabled(enabled: boolean): void {
  recalcDebounceEnabled = enabled;
}

export function isRecalcDebounceEnabled(): boolean {
  return recalcDebounceEnabled;
}

function scheduleMissionRecalc(missionId: string, mode: RecalcMode): void {
  if (mode === "none") return;
  if (!missionId) return;

  const run = () => {
    try {
      missionService.recalculateMissionStatus(missionId);
    } catch (err) {
      if (mode === "wrapped") {
        logger.error({ err, missionId }, "Mission recalculation failed");
      } else {
        throw err;
      }
    }
  };

  if (!recalcDebounceEnabled) {
    run();
    return;
  }

  const existing = pendingRecalcs.get(missionId);
  if (existing) clearTimeout(existing);
  pendingRecalcs.set(
    missionId,
    setTimeout(() => {
      pendingRecalcs.delete(missionId);
      run();
    }, 100),
  );
}

function publishSseForAction(
  habitatId: string,
  action: TaskAction,
  ctx: TransitionContext,
  task: Task | null | undefined,
): void {
  const cfg = ACTION_EFFECTS[action];
  const taskId = ctx.taskId ?? "";

  if (cfg.sseSpecific) {
    switch (action) {
      case "claimed":
      case "claimed_delegated":
        sseBroadcaster.publish(habitatId, {
          type: "task.claimed",
          data: { taskId, agentId: ctx.actorId ?? "" },
        });
        break;
      case "submitted":
        sseBroadcaster.publish(habitatId, {
          type: "task.submitted",
          data: { taskId, agentId: ctx.actorId ?? "" },
        });
        break;
      case "approved":
        sseBroadcaster.publish(habitatId, {
          type: "task.approved",
          data: { taskId, reviewerId: ctx.reviewerId ?? ctx.actorId ?? "" },
        });
        break;
      case "completed":
        sseBroadcaster.publish(habitatId, {
          type: "task.completed",
          data: { taskId },
        });
        break;
      case "rejected":
        sseBroadcaster.publish(habitatId, {
          type: "task.rejected",
          data: { taskId, reason: ctx.reason ?? "", reviewerId: ctx.reviewerId ?? ctx.actorId ?? "" },
        });
        break;
      case "released":
        sseBroadcaster.publish(habitatId, {
          type: "task.released",
          data: { taskId, reason: ctx.reason ?? "" },
        });
        break;
      case "failed":
        sseBroadcaster.publish(habitatId, {
          type: "task.failed",
          data: { taskId, reason: ctx.reason ?? "" },
        });
        break;
      case "delegated":
        sseBroadcaster.publish(habitatId, {
          type: "task.delegated",
          data: { taskId, fromAgentId: ctx.fromAgentId ?? "", toAgentId: ctx.toAgentId ?? "" },
        });
        break;
      case "created":
        if (task) {
          sseBroadcaster.publish(habitatId, { type: "task.created", data: task });
        }
        break;
      case "deleted":
        sseBroadcaster.publish(habitatId, { type: "task.deleted", data: { taskId } });
        break;
      case "retry_scheduled":
        sseBroadcaster.publish(habitatId, {
          type: "task.retry_scheduled",
          data: { taskId, nextRetryAt: ctx.nextRetryAt ?? "", retryCount: ctx.retryCount ?? 0 },
        });
        break;
      case "retry_executed":
        sseBroadcaster.publish(habitatId, {
          type: "task.retry_executed",
          data: { taskId, retryCount: ctx.retryCount ?? 0 },
        });
        break;
      case "escalated":
        sseBroadcaster.publish(habitatId, {
          type: "task.escalated",
          data: {
            taskId,
            retryCount: ctx.retryCount ?? 0,
            reason: ctx.reason ?? "max retries exceeded",
          },
        });
        break;
      default:
        break;
    }
  }

  if (cfg.emitTaskUpdated && task) {
    sseBroadcaster.publish(habitatId, { type: "task.updated", data: task });
  }
}

function runPluginHook(cfg: ActionConfig, task: Task, ctx: TransitionContext): void {
  if (!cfg.pluginHook) return;
  switch (cfg.pluginHook) {
    case "emitTaskCreated":
      pluginManager.emitTaskCreated(task, null).catch(() => {});
      return;
    case "emitTaskClaimed": {
      if (!cfg.pluginAgentRequired) {
        pluginManager
          .emitTaskClaimed(task, { id: ctx.actorId ?? "" } as never)
          .catch(() => {});
        return;
      }
      const agent = agentRepo.getAgentById(ctx.actorId ?? "");
      if (agent) {
        pluginManager.emitTaskClaimed(task, agent).catch(() => {});
      }
      return;
    }
    case "emitTaskSubmitted":
      pluginManager.emitTaskSubmitted(task).catch(() => {});
      return;
    case "emitTaskApproved":
      pluginManager.emitTaskApproved(task).catch(() => {});
      return;
    case "emitTaskRejected":
      pluginManager.emitTaskRejected(task, ctx.reason ?? "").catch(() => {});
      return;
  }
}

function unblockDependents(taskId: string): void {
  const dependents = taskRepo.getTasksByDependency(taskId);
  for (const dependent of dependents) {
    if (taskRepo.areAllDependenciesMet(dependent.id) && dependent.status === "pending") {
      const depHabitatId = taskRepo.getHabitatIdForTask(dependent.id) ?? "";
      eventRepo.createEvent({
        taskId: dependent.id,
        actorType: "system",
        actorId: "system",
        action: "dependency_resolved",
        metadata: { unblockedBy: taskId },
      });
      sseBroadcaster.publish(depHabitatId, { type: "task.updated", data: dependent });
    }
  }
}

type TaskEventHook = (opts: {
  taskId: string;
  habitatId: string;
  event: string;
  actorType: string;
  actorId: string;
  metadata?: Record<string, unknown>;
}) => void;
const taskEventHooks: TaskEventHook[] = [];

export function onTaskEvent(hook: TaskEventHook): () => void {
  taskEventHooks.push(hook);
  return () => {
    const idx = taskEventHooks.indexOf(hook);
    if (idx >= 0) taskEventHooks.splice(idx, 1);
  };
}

function notifyTaskEvent(opts: Parameters<TaskEventHook>[0]): void {
  for (const hook of taskEventHooks) {
    try {
      hook(opts);
    } catch (err) {
      logger.error({ err }, "Task event hook failed");
    }
  }
}

export function emitTransition(
  taskId: string,
  action: TaskAction,
  habitatId: string,
  context: TransitionContext,
): void {
  const cfg = ACTION_EFFECTS[action];
  const ctx: TransitionContext = { ...context, taskId };
  const task = context.task ?? taskRepo.getTaskById(taskId) ?? undefined;

  if (cfg.emitEvent) {
    const eventAction = EVENT_ACTION_FOR[action];
    if (eventAction) {
      eventRepo.createEvent({
        taskId,
        actorType: (context.actorType ?? "agent") as "agent" | "human" | "system",
        actorId: context.actorId ?? "",
        action: eventAction,
        fromStatus: context.oldStatus as never,
        toStatus: (cfg.eventToStatus ?? context.newStatus) as never,
        metadata: context.metadata,
      });
    }
  }

  publishSseForAction(habitatId, action, ctx, task);

  if (cfg.watchers && habitatId) {
    watcherService.notifyWatchers(taskId, habitatId, cfg.watchers);
  }

  if (task && cfg.pluginHook) {
    runPluginHook(cfg, task, ctx);
  }

  if (task && cfg.triggerUnblock) {
    unblockDependents(taskId);
  }

  if (task && cfg.triggerRetry) {
    try {
      if (retryService.shouldRetry(task)) {
        retryService.scheduleRetry(task);
      } else if (retryService.getEffectivePolicy(task)?.escalateToHuman) {
        retryService.escalateToHuman(task);
      }
    } catch (err) {
      logger.warn({ err, taskId }, "Retry/escalation trigger failed");
    }
  }

  const missionId = task?.missionId ?? "";
  if (cfg.recalc === "conditional") {
    if (
      task &&
      context.oldStatus &&
      context.newStatus &&
      context.oldStatus !== context.newStatus
    ) {
      try {
        missionService.recalculateMissionStatus(missionId);
      } catch (err) {
        logger.error({ err, missionId }, "Mission recalculation failed");
      }
    }
  } else {
    scheduleMissionRecalc(missionId, cfg.recalc);
  }

  if (task && cfg.pulseSignal) {
    pulseService.emitAutoSignal({
      missionId: task.missionId,
      signalType: cfg.pulseSignal.type,
      subject: cfg.pulseSignal.subject(ctx),
      taskId: task.id,
    });
  }

  if (task && cfg.pulseExtra && cfg.pulseExtra.subjectIf(task)) {
    pulseService.emitAutoSignal({
      missionId: task.missionId,
      signalType: cfg.pulseExtra.type,
      subject: cfg.pulseExtra.subject(task),
      taskId: task.id,
    });
  }

  if (habitatId && cfg.notifyTaskEvent) {
    notifyTaskEvent({
      taskId,
      habitatId,
      event: cfg.notifyTaskEvent,
      actorType: context.actorType ?? "agent",
      actorId: context.actorId ?? "",
      metadata: context.metadata,
    });
  }
}
