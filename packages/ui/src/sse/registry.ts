import { queryKeys } from "../lib/queryKeys.js";
import type { MissionWithProgress, SSEEvent } from "../types/index.js";
import {
  defineSSEHandler,
  type SSEEventHandler,
  type SSEEventType,
  type SSEStoreState,
  type SSENotificationResult,
  type SSEToastNotification,
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

function invalidateTaskDetail(context: Parameters<NonNullable<SSEEventHandler["cache"]>>[0]): void {
  const taskId = getTaskId(context.event);
  if (!taskId) return;

  context.queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
  context.queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
  context.queryClient.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
}

const taskCacheHandler = defineSSEHandler<SSEEventType>({
  cache: (context) => {
    const taskId = getTaskId(context.event);
    if (taskId) {
      invalidateTaskDetail(context);
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
    context.queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(context.boardId) });
  },
});

const missionListCacheHandler = defineSSEHandler<SSEEventType>({
  cache: ({ event, queryClient, boardId }) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(boardId) });
    if ("id" in event.data && event.data.id) {
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.detail(event.data.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.details(event.data.id) });
    }
    if ("missionId" in event.data && typeof event.data.missionId === "string") {
      queryClient.invalidateQueries({
        queryKey: queryKeys.missions.progress(event.data.missionId),
      });
    }
  },
});

const sprintCacheHandler = defineSSEHandler<SSEEventType>({
  cache: ({ event, queryClient, boardId }) => {
    queryClient.invalidateQueries({ queryKey: queryKeys.sprints.list(boardId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.sprints.active(boardId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.missions.list(boardId) });
    queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
    if ("sprintId" in event.data && typeof event.data.sprintId === "string") {
      queryClient.invalidateQueries({ queryKey: queryKeys.sprints.detail(event.data.sprintId) });
    }
  },
});

export const SSE_EVENT_REGISTRY = {
  "task.created": taskCacheHandler,
  "task.updated": taskCacheHandler,
  "task.moved": taskCacheHandler,
  "task.claimed": defineSSEHandler<"task.claimed">({
    cache: taskCacheHandler.cache,
    notification: ({ event }) => {
      const agentName = getAgentName(event.data.agentId);
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(event, "info", `Agent ${agentName} claimed "${taskTitle}"`);
    },
  }),
  "task.submitted": defineSSEHandler<"task.submitted">({
    cache: taskCacheHandler.cache,
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
    cache: taskCacheHandler.cache,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(event, "success", `Task "${taskTitle}" approved`);
    },
  }),
  "task.rejected": defineSSEHandler<"task.rejected">({
    cache: taskCacheHandler.cache,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      const message = `Task "${taskTitle}" rejected${event.data.reason ? `: ${event.data.reason}` : ""}`;
      return taskNotification(event, "warning", message);
    },
  }),
  "task.completed": defineSSEHandler<"task.completed">({
    cache: taskCacheHandler.cache,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(event, "success", `Task "${taskTitle}" completed`);
    },
  }),
  "task.failed": defineSSEHandler<"task.failed">({
    cache: taskCacheHandler.cache,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      const message = `Task "${taskTitle}" failed${event.data.reason ? `: ${event.data.reason}` : ""}`;
      return taskNotification(event, "error", message);
    },
  }),
  "task.released": defineSSEHandler<"task.released">({
    cache: taskCacheHandler.cache,
    notification: ({ event }) => {
      const taskTitle = getTaskTitle(event.data.taskId);
      return taskNotification(event, "info", `Task "${taskTitle}" released`);
    },
  }),
  "task.delegated": defineSSEHandler<"task.delegated">({
    cache: taskCacheHandler.cache,
  }),
  "task.cloned": noopHandler,
  "task.deleted": defineSSEHandler<"task.deleted">({
    cache: taskCacheHandler.cache,
  }),
  "task.overdue": taskCacheHandler,
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
    cache: ({ event, queryClient }) => {
      const taskId = getTaskId(event);
      if (taskId) queryClient.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) });
    },
  }),
  "task.comment_deleted": defineSSEHandler<"task.comment_deleted">({
    cache: ({ event, queryClient }) => {
      const taskId = getTaskId(event);
      if (taskId) queryClient.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) });
    },
  }),
  "agent.status_changed": defineSSEHandler<"agent.status_changed">({
    cache: ({ event, queryClient }) => {
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
    cache: ({ event, queryClient }) => {
      if (!("agentId" in event.data)) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.detail(event.data.agentId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      queryClient.invalidateQueries({ queryKey: queryKeys.agents.listWithTasks() });
    },
  }),
  "column.created": defineSSEHandler<"column.created">({
    zustand: ({ event, state, set }) => {
      if (
        event.data.habitatId === state.board?.id &&
        !state.columns.some((c) => c.id === event.data.id)
      ) {
        set({ columns: [...state.columns, event.data].toSorted((a, b) => a.order - b.order) });
      }
    },
    cache: ({ queryClient, boardId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
    },
  }),
  "column.updated": defineSSEHandler<"column.updated">({
    zustand: ({ event, state, set }) => {
      set({ columns: state.columns.map((c) => (c.id === event.data.id ? event.data : c)) });
    },
    cache: ({ queryClient, boardId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
    },
  }),
  "column.deleted": defineSSEHandler<"column.deleted">({
    zustand: ({ event, state, set }) => {
      if (event.data.habitatId === state.board?.id) {
        set({ columns: state.columns.filter((c) => c.id !== event.data.columnId) });
      }
    },
    cache: ({ queryClient, boardId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
    },
  }),
  "column.wip_limit_reached": defineSSEHandler<"column.wip_limit_reached">({
    zustand: ({ event, state, set }) => {
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
    zustand: ({ event, state, set }) => {
      if (event.data.id === state.board?.id) set({ board: { ...state.board, ...event.data } });
    },
    cache: ({ queryClient, boardId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.list() });
    },
  }),
  "habitat.deleted": defineSSEHandler<"habitat.deleted">({
    zustand: ({ event, state }) => {
      if (event.data.habitatId === state.board?.id) window.location.hash = "#/";
    },
  }),
  "subtask.created": noopHandler,
  "subtask.updated": noopHandler,
  "subtask.deleted": noopHandler,
  "presence.joined": defineSSEHandler<"presence.joined">({
    zustand: ({ event, state, set }) => {
      set({
        presence: state.presence.some((p) => p.sessionId === event.data.presence.sessionId)
          ? state.presence
          : [...state.presence, event.data.presence],
      });
    },
  }),
  "presence.left": defineSSEHandler<"presence.left">({
    zustand: ({ event, state, set }) => {
      set({ presence: state.presence.filter((p) => p.sessionId !== event.data.sessionId) });
    },
  }),
  "presence.refresh": defineSSEHandler<"presence.refresh">({
    zustand: ({ event, state, set }) => {
      set({
        presence: state.presence.map((p) =>
          p.sessionId === event.data.presence.sessionId ? event.data.presence : p,
        ),
      });
    },
  }),
  "presence.summary": defineSSEHandler<"presence.summary">({
    zustand: ({ event, set }) => {
      set({ presence: event.data.viewers });
    },
  }),
  "agent.message_received": noopHandler,
  "pulse.signal_posted": defineSSEHandler<"pulse.signal_posted">({
    cache: ({ queryClient, boardId }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.pulse.byBoard(boardId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.insights.byBoard(boardId) });
    },
  }),
  "task.retry_scheduled": noopHandler,
  "task.retry_executed": noopHandler,
  "task.escalated": noopHandler,
  "anomaly.detected": noopHandler,
  "mission.created": defineSSEHandler<"mission.created">({
    cache: missionListCacheHandler.cache,
  }),
  "mission.updated": defineSSEHandler<"mission.updated">({
    zustand: ({ event, state, set }) => {
      set({
        columnPagination: { ...state.columnPagination, [event.data.columnId]: undefined },
      });
    },
    cache: missionListCacheHandler.cache,
  }),
  "mission.moved": defineSSEHandler<"mission.moved">({
    zustand: ({ event, state, set }) => {
      set({
        columnPagination: {
          ...state.columnPagination,
          [event.data.fromColumnId]: undefined,
          [event.data.toColumnId]: undefined,
        },
      });
    },
    cache: missionListCacheHandler.cache,
  }),
  "mission.status_changed": defineSSEHandler<"mission.status_changed">({
    cache: missionListCacheHandler.cache,
  }),
  "mission.deleted": defineSSEHandler<"mission.deleted">({
    cache: missionListCacheHandler.cache,
  }),
  "mission.progress": defineSSEHandler<"mission.progress">({
    cache: ({ event, queryClient }) => {
      if (!("missionId" in event.data) || typeof event.data.missionId !== "string") return;
      queryClient.invalidateQueries({ queryKey: queryKeys.missions.detail(event.data.missionId) });
      queryClient.invalidateQueries({
        queryKey: queryKeys.missions.progress(event.data.missionId),
      });
    },
  }),
  "mission.commented": noopHandler,
  "mission.comment_deleted": noopHandler,
  "mission.mentioned": noopHandler,
  "task.priority_changed": defineSSEHandler<"task.priority_changed">({
    cache: ({ event, queryClient, boardId }) => {
      const taskId = getTaskId(event);
      if (taskId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
    },
  }),
  "scheduled_task.executed": noopHandler,
  "scheduled_task.failed": noopHandler,
  "scheduled_task.created": noopHandler,
  "task.review_assigned": defineSSEHandler<"task.review_assigned">({
    cache: ({ event, queryClient }) => {
      const taskId = getTaskId(event);
      if (taskId) queryClient.invalidateQueries({ queryKey: queryKeys.tasks.reviewers(taskId) });
    },
  }),
  "task.review_completed": defineSSEHandler<"task.review_completed">({
    cache: ({ event, queryClient, boardId }) => {
      const taskId = getTaskId(event);
      if (!taskId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.reviewers(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.detail(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.details(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.tasks.events(taskId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.habitats.detail(boardId) });
    },
  }),
  "sprint.created": sprintCacheHandler,
  "sprint.started": sprintCacheHandler,
  "sprint.completed": sprintCacheHandler,
  "code_evidence.updated": noopHandler,
  "effort.updated": noopHandler,
  wiki_page_created: defineSSEHandler<"wiki_page_created">({
    cache: ({ event, queryClient }) => {
      if (event.type !== "wiki_page_created") return;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(event.data.habitatId) });
    },
  }),
  wiki_page_updated: defineSSEHandler<"wiki_page_updated">({
    cache: ({ event, queryClient }) => {
      if (event.type !== "wiki_page_updated") return;
      const { habitatId, pageId } = event.data;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.versions(habitatId, pageId) });
    },
  }),
  wiki_page_deleted: defineSSEHandler<"wiki_page_deleted">({
    cache: ({ event, queryClient }) => {
      if (event.type !== "wiki_page_deleted") return;
      const { habitatId, pageId } = event.data;
      queryClient.removeQueries({ queryKey: queryKeys.wiki.page(habitatId, pageId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.pages(habitatId) });
    },
  }),
  wiki_coverage_changed: defineSSEHandler<"wiki_coverage_changed">({
    cache: ({ event, queryClient }) => {
      if (event.type !== "wiki_coverage_changed") return;
      queryClient.invalidateQueries({ queryKey: queryKeys.wiki.cadence(event.data.habitatId) });
    },
  }),
} satisfies Record<SSEEventType, SSEEventHandler>;

export function getSSEEventHandler(type: SSEEventType): SSEEventHandler {
  return SSE_EVENT_REGISTRY[type];
}

export function applySSEStoreUpdate(
  event: SSEEvent,
  state: SSEStoreState,
  set: (partial: Partial<SSEStoreState>) => void,
): void {
  getSSEEventHandler(event.type).zustand?.({ event, state, set });
}

export function invalidateSSEEventCache(
  event: SSEEvent,
  queryClient: Parameters<NonNullable<SSEEventHandler["cache"]>>[0]["queryClient"],
  boardId: string,
  getState: () => SSEStoreState,
): void {
  getSSEEventHandler(event.type).cache?.({ event, queryClient, boardId, getState });
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
