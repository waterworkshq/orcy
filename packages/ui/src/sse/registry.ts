import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/queryKeys.js";
import {
  invalidateHabitatRepresentations,
  invalidateMissionRepresentations,
  patchMissionInHabitatDetail,
  removeMissionFromHabitatDetail,
  resetArchivedForHabitat,
  type HabitatDetailData,
} from "../lib/habitatMutations.js";
import type { SSEEvent } from "../types/index.js";
import {
  defineSSEHandler,
  type SSEEventHandler,
  type SSEEventType,
  type SSEStoreState,
  type SSENotificationResult,
  type SSEToastNotification,
  type ServerProjectionContext,
} from "./types.js";

type AssertNever<T extends never> = T;

export const SSE_EVENT_TYPES = [
  "task.created",
  "task.updated",
  "task.moved",
  "task.claimed",
  "task.submitted",
  "task.approved",
  "task.rejected",
  "task.completed",
  "task.failed",
  "task.released",
  "task.delegated",
  "task.cloned",
  "task.deleted",
  "task.overdue",
  "task.watcher_notify",
  "task.mentioned",
  "task.commented",
  "task.comment_deleted",
  "agent.status_changed",
  "agent.heartbeat",
  "column.created",
  "column.updated",
  "column.deleted",
  "column.wip_limit_reached",
  "habitat.created",
  "habitat.updated",
  "habitat.deleted",
  "subtask.created",
  "subtask.updated",
  "subtask.deleted",
  "presence.joined",
  "presence.left",
  "presence.refresh",
  "presence.summary",
  "agent.message_received",
  "pulse.signal_posted",
  "task.retry_scheduled",
  "task.retry_executed",
  "task.escalated",
  "anomaly.detected",
  "mission.created",
  "mission.updated",
  "mission.moved",
  "mission.status_changed",
  "mission.deleted",
  "mission.progress",
  "mission.commented",
  "mission.comment_deleted",
  "mission.mentioned",
  "task.priority_changed",
  "scheduled_task.executed",
  "scheduled_task.failed",
  "scheduled_task.created",
  "task.review_assigned",
  "task.review_completed",
  "sprint.created",
  "sprint.started",
  "sprint.completed",
  "code_evidence.updated",
  "effort.updated",
  "wiki_page_created",
  "wiki_page_updated",
  "wiki_page_deleted",
  "wiki_coverage_changed",
  "plugin.enrollment_toggled",
  "plugin.enrollment_removed",
  "plugin.quarantined",
  "triage.finding_created",
  "triage.finding_updated",
] as const satisfies readonly SSEEventType[];

export type SSEEventRegistryMissingEvents = AssertNever<
  Exclude<SSEEventType, (typeof SSE_EVENT_TYPES)[number]>
>;
export type SSEEventRegistryExtraEvents = AssertNever<
  Exclude<(typeof SSE_EVENT_TYPES)[number], SSEEventType>
>;

const noopHandler = defineSSEHandler<SSEEventType>({});

function getTaskId(event: SSEEvent): string | null {
  if ("taskId" in event.data) return event.data.taskId;
  if ("id" in event.data && typeof event.data.id === "string") return event.data.id;
  return null;
}

function getAgentName(agentId: string | null): string {
  return agentId ? `Agent ${agentId.slice(0, 8)}` : "Unknown agent";
}

function getTaskTitle(taskId: string | null): string {
  return taskId ? `Task ${taskId.slice(0, 8)}` : "Unknown task";
}

function taskNotification(
  event: SSEEvent,
  level: SSEToastNotification["level"],
  message: string,
): SSENotificationResult | null {
  const taskId = getTaskId(event);
  if (!taskId) return null;

  const agentId = "agentId" in event.data ? event.data.agentId : null;
  const agentName = getAgentName(agentId);
  const taskTitle = getTaskTitle(taskId);

  return {
    app: {
      type: event.type,
      taskId,
      taskTitle,
      agentName: agentName !== "Unknown agent" ? agentName : undefined,
      message,
      timestamp: new Date().toISOString(),
    },
    toast: { level, message },
  };
}

function invalidateTaskDetail<T extends SSEEventType>(context: ServerProjectionContext<T>): void {
  const taskId = getTaskId(context.event);
  if (taskId) {
    context.queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
    context.queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
    context.queryClient.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
  }
}

/**
 * Task lifecycle can change Mission progress, so it invalidates the Task
 * representations, the owning Mission progress/detail, and the Habitat detail
 * (complete active collection). Invalidate-only — no speculative patch.
 */
function projectTaskServer<T extends SSEEventType>(context: ServerProjectionContext<T>): void {
  invalidateTaskDetail(context);
  const taskId = getTaskId(context.event);
  if (taskId) {
    const missionId =
      "missionId" in context.event.data
        ? (context.event.data as { missionId?: string }).missionId
        : undefined;
    if (missionId) {
      context.queryClient.invalidateQueries({
        queryKey: queryKeys.missions.progress(missionId),
      });
      context.queryClient.invalidateQueries({
        queryKey: queryKeys.missions.detail(missionId),
      });
    }
  }
  context.queryClient.invalidateQueries({
    queryKey: queryKeys.habitats.detail(context.subscriptionHabitatId),
  });
}

const taskServerHandler = defineSSEHandler<SSEEventType>({ server: projectTaskServer });

/**
 * Cancel the in-flight Queries whose queryFns forward the AbortSignal to fetch,
 * so an older HTTP response cannot replace the event patch applied afterwards.
 * Cancellation is only real because the domain queryFns are signal-aware.
 */
async function cancelAffectedQueries(
  qc: QueryClient,
  habitatId: string,
  missionId?: string,
): Promise<void> {
  const keys: readonly (readonly string[])[] = [
    queryKeys.habitats.detail(habitatId),
    ...(missionId
      ? [queryKeys.missions.detail(missionId), queryKeys.missions.details(missionId)]
      : []),
  ];
  await Promise.all(keys.map((k) => qc.cancelQueries({ queryKey: k })));
}

const sprintServerHandler = defineSSEHandler<SSEEventType>({
  server: ({ event, queryClient, subscriptionHabitatId }) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.sprints.list(subscriptionHabitatId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sprints.active(subscriptionHabitatId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(subscriptionHabitatId) });
    queryClient.invalidateQueries({
      queryKey: queryKeys.habitats.detail(subscriptionHabitatId),
    });
    if ("sprintId" in event.data && typeof event.data.sprintId === "string") {
      queryClient.invalidateQueries({ queryKey: queryKeys.sprints.detail(event.data.sprintId) });
    }
  },
});

export const SSE_EVENT_REGISTRY = {
  "task.created": taskServerHandler,
  "task.updated": taskServerHandler,
  "task.moved": taskServerHandler,
  "task.claimed": defineSSEHandler<"task.claimed">({
    server: projectTaskServer,
    notification: ({ event }) => {
      const agentName = getAgentName(event.data.agentId);
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(event, "info", `Agent ${agentName} claimed "${taskTitle}"`);
    },
  }),
  "task.submitted": defineSSEHandler<"task.submitted">({
    server: projectTaskServer,
    notification: ({ event }) => {
      const agentName = getAgentName(event.data.agentId);
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(
        event,
        "info",
        `Agent ${agentName} submitted "${taskTitle}" for review`,
      );
    },
  }),
  "task.approved": defineSSEHandler<"task.approved">({
    server: projectTaskServer,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(event, "success", `Task "${taskTitle}" approved`);
    },
  }),
  "task.rejected": defineSSEHandler<"task.rejected">({
    server: projectTaskServer,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      const message = `Task "${taskTitle}" rejected${event.data.reason ? `: ${event.data.reason}` : ""}`;
      return taskNotification(event, "warning", message);
    },
  }),
  "task.completed": defineSSEHandler<"task.completed">({
    server: projectTaskServer,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(event, "success", `Task "${taskTitle}" completed`);
    },
  }),
  "task.failed": defineSSEHandler<"task.failed">({
    server: projectTaskServer,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      const message = `Task "${taskTitle}" failed${event.data.reason ? `: ${event.data.reason}` : ""}`;
      return taskNotification(event, "error", message);
    },
  }),
  "task.released": defineSSEHandler<"task.released">({
    server: projectTaskServer,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(event, "info", `Task "${taskTitle}" released`);
    },
  }),
  "task.delegated": defineSSEHandler<"task.delegated">({
    server: projectTaskServer,
  }),
  "task.cloned": noopHandler,
  "task.deleted": defineSSEHandler<"task.deleted">({
    server: projectTaskServer,
  }),
  "task.overdue": taskServerHandler,
  "task.watcher_notify": defineSSEHandler<"task.watcher_notify">({
    notification: ({ event, currentUserId }) => {
      if (!currentUserId || !event.data.watcherUserIds.includes(currentUserId)) return null;
      const actionLabel = event.data.eventType.replace("task.", "").replace("_", " ");
      return {
        toast: {
          level: "info",
          message: `Watched task "${event.data.taskTitle}" was ${actionLabel}`,
        },
      };
    },
  }),
  "task.mentioned": defineSSEHandler<"task.mentioned">({
    notification: ({ event, currentUserId }) => {
      if (
        !currentUserId ||
        event.data.mentionedType !== "human" ||
        currentUserId !== event.data.mentionedId
      )
        return null;
      const taskTitle = getTaskTitle(event.data.taskId);
      return {
        toast: {
          level: "info",
          message: `You were mentioned on "${taskTitle}"`,
        },
      };
    },
  }),
  "task.commented": defineSSEHandler<"task.commented">({
    server: ({ event, queryClient }) => {
      const taskId = getTaskId(event);
      if (taskId) queryClient.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) });
    },
  }),
  "task.comment_deleted": defineSSEHandler<"task.comment_deleted">({
    server: ({ event, queryClient }) => {
      const taskId = getTaskId(event);
      if (taskId) queryClient.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) });
    },
  }),
  "agent.status_changed": defineSSEHandler<"agent.status_changed">({
    server: ({ event, queryClient }) => {
      if (!("agentId" in event.data)) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(event.data.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.listWithTasks() });
    },
    notification: ({ event }) => ({
      toast: {
        level: "info",
        message: `Agent ${getAgentName(event.data.agentId)} is now ${event.data.status}`,
      },
    }),
  }),
  "agent.heartbeat": defineSSEHandler<"agent.heartbeat">({
    server: ({ event, queryClient }) => {
      if (!("agentId" in event.data)) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(event.data.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.listWithTasks() });
    },
  }),
  "column.created": defineSSEHandler<"column.created">({
    server: ({ queryClient, subscriptionHabitatId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(subscriptionHabitatId) });
    },
  }),
  "column.updated": defineSSEHandler<"column.updated">({
    server: ({ queryClient, subscriptionHabitatId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(subscriptionHabitatId) });
    },
  }),
  "column.deleted": defineSSEHandler<"column.deleted">({
    server: ({ queryClient, subscriptionHabitatId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(subscriptionHabitatId) });
    },
  }),
  "column.wip_limit_reached": defineSSEHandler<"column.wip_limit_reached">({
    ephemeral: ({ event, state, set }) => {
      set({
        wipAlerts: {
          ...state.wipAlerts,
          [event.data.columnId]: { limit: event.data.limit, timestamp: Date.now() },
        },
      });
    },
    notification: ({ event }) => ({
      toast: { level: "warning", message: `WIP limit (${event.data.limit}) reached for column` },
    }),
  }),
  "habitat.created": noopHandler,
  "habitat.updated": defineSSEHandler<"habitat.updated">({
    server: ({ queryClient, subscriptionHabitatId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(subscriptionHabitatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.list() });
    },
  }),
  "habitat.deleted": defineSSEHandler<"habitat.deleted">({
    server: ({ event, queryClient, routeHabitatId, navigateHome }) => {
      const deletedId = event.data.habitatId;
      queryClient.removeQueries({ queryKey: queryKeys.habitats.detail(deletedId) });
      queryClient.removeQueries({ queryKey: queryKeys.habitats.stats(deletedId) });
      queryClient.removeQueries({ queryKey: queryKeys.habitats.events(deletedId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.list() });
      if (routeHabitatId === deletedId) navigateHome();
    },
  }),
  "subtask.created": noopHandler,
  "subtask.updated": noopHandler,
  "subtask.deleted": noopHandler,
  "presence.joined": defineSSEHandler<"presence.joined">({
    ephemeral: ({ event, state, set }) => {
      set({
        presence: state.presence.some((p) => p.sessionId === event.data.presence.sessionId)
          ? state.presence
          : [...state.presence, event.data.presence],
      });
    },
  }),
  "presence.left": defineSSEHandler<"presence.left">({
    ephemeral: ({ event, state, set }) => {
      set({ presence: state.presence.filter((p) => p.sessionId !== event.data.sessionId) });
    },
  }),
  "presence.refresh": defineSSEHandler<"presence.refresh">({
    ephemeral: ({ event, state, set }) => {
      set({
        presence: state.presence.map((p) =>
          p.sessionId === event.data.presence.sessionId ? event.data.presence : p,
        ),
      });
    },
  }),
  "presence.summary": defineSSEHandler<"presence.summary">({
    ephemeral: ({ event, set }) => {
      set({ presence: event.data.viewers });
    },
  }),
  "agent.message_received": noopHandler,
  "pulse.signal_posted": defineSSEHandler<"pulse.signal_posted">({
    server: ({ queryClient, subscriptionHabitatId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pulse.byBoard(subscriptionHabitatId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.insights.byBoard(subscriptionHabitatId),
      });
      queryClient.invalidateQueries({ queryKey: ["wiki", "signalSurface", subscriptionHabitatId] });
    },
  }),
  "task.retry_scheduled": noopHandler,
  "task.retry_executed": noopHandler,
  "task.escalated": noopHandler,
  "anomaly.detected": noopHandler,
  "mission.created": defineSSEHandler<"mission.created">({
    server: ({ event, queryClient }) => {
      const habitatId = event.data.habitatId;
      invalidateHabitatRepresentations(queryClient, habitatId);
      invalidateMissionRepresentations(queryClient, event.data.id);
    },
  }),
  "mission.updated": defineSSEHandler<"mission.updated">({
    server: async (ctx) => {
      const mission = ctx.event.data;
      const habitatId = mission.habitatId;
      const detail = ctx.queryClient.getQueryData<HabitatDetailData>(
        queryKeys.habitats.detail(habitatId),
      );
      const present = !!detail?.missions.some((m) => m.id === mission.id);

      if (mission.isArchived) {
        await cancelAffectedQueries(ctx.queryClient, habitatId, mission.id);
        if (!ctx.isActive()) return;
        removeMissionFromHabitatDetail(ctx.queryClient, habitatId, mission.id);
        ctx.queryClient.removeQueries({ queryKey: queryKeys.missions.detail(mission.id) });
        invalidateHabitatRepresentations(ctx.queryClient, habitatId);
        resetArchivedForHabitat(ctx.queryClient, habitatId);
        invalidateMissionRepresentations(ctx.queryClient, mission.id);
        return;
      }

      if (present) {
        await cancelAffectedQueries(ctx.queryClient, habitatId, mission.id);
        if (!ctx.isActive()) return;
        patchMissionInHabitatDetail(ctx.queryClient, habitatId, mission);
        invalidateHabitatRepresentations(ctx.queryClient, habitatId);
        invalidateMissionRepresentations(ctx.queryClient, mission.id);
        return;
      }

      invalidateHabitatRepresentations(ctx.queryClient, habitatId);
      resetArchivedForHabitat(ctx.queryClient, habitatId);
      invalidateMissionRepresentations(ctx.queryClient, mission.id);
    },
  }),
  "mission.moved": defineSSEHandler<"mission.moved">({
    server: ({ queryClient, subscriptionHabitatId, event }) => {
      invalidateHabitatRepresentations(queryClient, subscriptionHabitatId);
      invalidateMissionRepresentations(queryClient, event.data.missionId);
    },
  }),
  "mission.status_changed": defineSSEHandler<"mission.status_changed">({
    server: ({ queryClient, subscriptionHabitatId, event }) => {
      invalidateHabitatRepresentations(queryClient, subscriptionHabitatId);
      invalidateMissionRepresentations(queryClient, event.data.missionId);
    },
  }),
  "mission.deleted": defineSSEHandler<"mission.deleted">({
    server: async (ctx) => {
      const missionId = ctx.event.data.missionId;
      const habitatId = ctx.subscriptionHabitatId;
      await cancelAffectedQueries(ctx.queryClient, habitatId, missionId);
      if (!ctx.isActive()) return;
      removeMissionFromHabitatDetail(ctx.queryClient, habitatId, missionId);
      ctx.queryClient.removeQueries({ queryKey: queryKeys.missions.detail(missionId) });
      invalidateHabitatRepresentations(ctx.queryClient, habitatId);
      resetArchivedForHabitat(ctx.queryClient, habitatId);
      invalidateMissionRepresentations(ctx.queryClient, missionId);
    },
  }),
  "mission.progress": defineSSEHandler<"mission.progress">({
    server: ({ event, queryClient }) => {
      invalidateMissionRepresentations(queryClient, event.data.missionId);
    },
  }),
  "mission.commented": noopHandler,
  "mission.comment_deleted": noopHandler,
  "mission.mentioned": noopHandler,
  "task.priority_changed": defineSSEHandler<"task.priority_changed">({
    server: (context) => {
      invalidateTaskDetail(context);
      context.queryClient.invalidateQueries({
        queryKey: queryKeys.habitats.detail(context.subscriptionHabitatId),
      });
    },
  }),
  "scheduled_task.executed": noopHandler,
  "scheduled_task.failed": noopHandler,
  "scheduled_task.created": noopHandler,
  "task.review_assigned": defineSSEHandler<"task.review_assigned">({
    server: ({ event, queryClient }) => {
      const taskId = getTaskId(event);
      if (taskId) queryClient.invalidateQueries({ queryKey: queryKeys.tasks.reviewers(taskId) });
    },
  }),
  "task.review_completed": defineSSEHandler<"task.review_completed">({
    server: (context) => {
      invalidateTaskDetail(context);
      context.queryClient.invalidateQueries({
        queryKey: queryKeys.habitats.detail(context.subscriptionHabitatId),
      });
    },
  }),
  "sprint.created": sprintServerHandler,
  "sprint.started": sprintServerHandler,
  "sprint.completed": sprintServerHandler,
  "code_evidence.updated": noopHandler,
  "effort.updated": noopHandler,
  wiki_page_created: defineSSEHandler<"wiki_page_created">({
    server: ({ event, queryClient }) => {
      if (event.type !== "wiki_page_created") return;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(event.data.habitatId) });
      queryClient.invalidateQueries({ queryKey: ["wiki", "search", event.data.habitatId] });
    },
  }),
  wiki_page_updated: defineSSEHandler<"wiki_page_updated">({
    server: ({ event, queryClient }) => {
      if (event.type !== "wiki_page_updated") return;
      const { habitatId, pageId } = event.data;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.versions(habitatId, pageId) });
      queryClient.invalidateQueries({ queryKey: ["wiki", "search", habitatId] });
    },
  }),
  wiki_page_deleted: defineSSEHandler<"wiki_page_deleted">({
    server: ({ event, queryClient }) => {
      if (event.type !== "wiki_page_deleted") return;
      const { habitatId, pageId } = event.data;
      queryClient.removeQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
      queryClient.invalidateQueries({ queryKey: ["wiki", "search", habitatId] });
    },
  }),
  wiki_coverage_changed: defineSSEHandler<"wiki_coverage_changed">({
    server: ({ event, queryClient }) => {
      if (event.type !== "wiki_coverage_changed") return;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.cadence(event.data.habitatId) });
    },
  }),
  "plugin.enrollment_toggled": defineSSEHandler<"plugin.enrollment_toggled">({
    server: ({ event, queryClient }) => {
      if (event.type !== "plugin.enrollment_toggled") return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.plugins.enrollments(event.data.habitatId),
      });
    },
  }),
  "plugin.enrollment_removed": defineSSEHandler<"plugin.enrollment_removed">({
    server: ({ event, queryClient }) => {
      if (event.type !== "plugin.enrollment_removed") return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.plugins.enrollments(event.data.habitatId),
      });
    },
  }),
  "plugin.quarantined": defineSSEHandler<"plugin.quarantined">({
    server: ({ event, queryClient }) => {
      if (event.type !== "plugin.quarantined") return;
      queryClient.invalidateQueries({
        queryKey: queryKeys.plugins.enrollments(event.data.habitatId),
      });
      queryClient.invalidateQueries({
        queryKey: queryKeys.plugins.runs(event.data.habitatId),
      });
    },
  }),
  "triage.finding_created": defineSSEHandler<"triage.finding_created">({
    server: ({ queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triage.all });
    },
  }),
  "triage.finding_updated": defineSSEHandler<"triage.finding_updated">({
    server: ({ queryClient }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.triage.all });
    },
  }),
} satisfies Record<SSEEventType, SSEEventHandler>;

export function getSSEEventHandler(type: SSEEventType): SSEEventHandler {
  return SSE_EVENT_REGISTRY[type];
}

export function applySSEEphemeralUpdate(
  event: SSEEvent,
  state: SSEStoreState,
  set: (partial: Partial<SSEStoreState>) => void,
): void {
  getSSEEventHandler(event.type).ephemeral?.({ event, state, set });
}

export function projectSSEServerEvent(
  event: SSEEvent,
  context: ServerProjectionContext,
): void | Promise<void> {
  return getSSEEventHandler(event.type).server?.(context);
}

export function getSSEEventDedupeKey(event: SSEEvent): string {
  const taskId = getTaskId(event);
  return taskId ? `${event.type}:${taskId}` : event.type;
}

export function getSSENotification(
  event: SSEEvent,
  state: SSEStoreState,
  currentUserId: string | null,
): SSENotificationResult | null {
  return getSSEEventHandler(event.type).notification?.({ event, state, currentUserId }) ?? null;
}
