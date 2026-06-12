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

function getTaskTitle(state: SSEStoreState, taskId: string | null): string {
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
  return task?.title ?? "Unknown task";
}

function taskNotification(
  event: SSEEvent,
  state: SSEStoreState,
  level: SSEToastNotification["level"],
  message: string,
): SSENotificationResult | null {
  const taskId = getTaskId(event);
  if (!taskId) return null;

  const agentId = "agentId" in event.data ? event.data.agentId : null;
  const agentName = getAgentName(agentId);
  const taskTitle = getTaskTitle(state, taskId);

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
      const task = context.getState().tasks.find((t) => t.id === taskId);
      if (task?.missionId) {
        context.queryClient.invalidateQueries({
          queryKey: queryKeys.missions.progress(task.missionId),
        });
        context.queryClient.invalidateQueries({
          queryKey: queryKeys.missions.detail(task.missionId),
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
  "task.created": defineSSEHandler<"task.created">({
    zustand: ({ event, state, set }) => {
      if (!state.tasks.some((t) => t.id === event.data.id)) {
        set({ tasks: [...state.tasks, event.data] });
      }
    },
    cache: taskCacheHandler.cache,
  }),
  "task.updated": defineSSEHandler<"task.updated">({
    zustand: ({ event, state, set }) => {
      set({ tasks: state.tasks.map((t) => (t.id === event.data.id ? event.data : t)) });
    },
    cache: taskCacheHandler.cache,
  }),
  "task.moved": taskCacheHandler,
  "task.claimed": defineSSEHandler<"task.claimed">({
    zustand: ({ event, state, set }) => {
      set({
        tasks: state.tasks.map((t) =>
          t.id === event.data.taskId
            ? { ...t, assignedAgentId: event.data.agentId, status: "claimed" as const }
            : t,
        ),
      });
    },
    cache: taskCacheHandler.cache,
    notification: ({ event, state }) => {
      const agentName = getAgentName(event.data.agentId);
      const taskTitle = getTaskTitle(state, event.data.taskId);
      return taskNotification(event, state, "info", `Agent ${agentName} claimed "${taskTitle}"`);
    },
  }),
  "task.submitted": defineSSEHandler<"task.submitted">({
    zustand: ({ event, state, set }) => {
      set({
        tasks: state.tasks.map((t) =>
          t.id === event.data.taskId ? { ...t, status: "submitted" as const } : t,
        ),
      });
    },
    cache: taskCacheHandler.cache,
    notification: ({ event, state }) => {
      const agentName = getAgentName(event.data.agentId);
      const taskTitle = getTaskTitle(state, event.data.taskId);
      return taskNotification(
        event,
        state,
        "info",
        `Agent ${agentName} submitted "${taskTitle}" for review`,
      );
    },
  }),
  "task.approved": defineSSEHandler<"task.approved">({
    zustand: ({ event, state, set }) => {
      set({
        tasks: state.tasks.map((t) =>
          t.id === event.data.taskId ? { ...t, status: "approved" as const } : t,
        ),
      });
    },
    cache: taskCacheHandler.cache,
    notification: ({ event, state }) => {
      const taskTitle = getTaskTitle(state, event.data.taskId);
      return taskNotification(event, state, "success", `Task "${taskTitle}" approved`);
    },
  }),
  "task.rejected": defineSSEHandler<"task.rejected">({
    zustand: ({ event, state, set }) => {
      set({
        tasks: state.tasks.map((t) =>
          t.id === event.data.taskId ? { ...t, status: "rejected" as const } : t,
        ),
      });
    },
    cache: taskCacheHandler.cache,
    notification: ({ event, state }) => {
      const taskTitle = getTaskTitle(state, event.data.taskId);
      const message = `Task "${taskTitle}" rejected${event.data.reason ? `: ${event.data.reason}` : ""}`;
      return taskNotification(event, state, "warning", message);
    },
  }),
  "task.completed": defineSSEHandler<"task.completed">({
    zustand: ({ event, state, set }) => {
      set({
        tasks: state.tasks.map((t) =>
          t.id === event.data.taskId ? { ...t, status: "done" as const } : t,
        ),
      });
    },
    cache: taskCacheHandler.cache,
    notification: ({ event, state }) => {
      const taskTitle = getTaskTitle(state, event.data.taskId);
      return taskNotification(event, state, "success", `Task "${taskTitle}" completed`);
    },
  }),
  "task.failed": defineSSEHandler<"task.failed">({
    zustand: ({ event, state, set }) => {
      set({
        tasks: state.tasks.map((t) =>
          t.id === event.data.taskId ? { ...t, status: "failed" as const } : t,
        ),
      });
    },
    cache: taskCacheHandler.cache,
    notification: ({ event, state }) => {
      const taskTitle = getTaskTitle(state, event.data.taskId);
      const message = `Task "${taskTitle}" failed${event.data.reason ? `: ${event.data.reason}` : ""}`;
      return taskNotification(event, state, "error", message);
    },
  }),
  "task.released": defineSSEHandler<"task.released">({
    zustand: ({ event, state, set }) => {
      set({
        tasks: state.tasks.map((t) =>
          t.id === event.data.taskId
            ? { ...t, assignedAgentId: null, status: "pending" as const }
            : t,
        ),
      });
    },
    cache: taskCacheHandler.cache,
    notification: ({ event, state }) => {
      const taskTitle = getTaskTitle(state, event.data.taskId);
      return taskNotification(event, state, "info", `Task "${taskTitle}" released`);
    },
  }),
  "task.delegated": defineSSEHandler<"task.delegated">({
    zustand: ({ event, state, set }) => {
      set({
        tasks: state.tasks.map((t) =>
          t.id === event.data.taskId ? { ...t, delegatedToAgentId: event.data.toAgentId } : t,
        ),
      });
    },
    cache: taskCacheHandler.cache,
  }),
  "task.cloned": noopHandler,
  "task.deleted": defineSSEHandler<"task.deleted">({
    zustand: ({ event, state, set }) => {
      set({ tasks: state.tasks.filter((t) => t.id !== event.data.taskId) });
    },
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
    notification: ({ event, state, currentUserId }) => {
      if (
        !currentUserId ||
        event.data.mentionedType !== "human" ||
        currentUserId !== event.data.mentionedId
      )
        return null;
      const mentionedTask = state.tasks.find((t) => t.id === event.data.taskId);
      return {
        toast: {
          level: "info",
          message: `You were mentioned on "${mentionedTask?.title ?? "a task"}"`,
        },
      };
    },
  }),
  "task.commented": defineSSEHandler<"task.commented">({
    zustand: ({ event, state, set }) => {
      set({
        comments: {
          ...state.comments,
          [event.data.taskId]: [event.data.comment, ...(state.comments[event.data.taskId] || [])],
        },
      });
    },
    cache: ({ event, queryClient }) => {
      const taskId = getTaskId(event);
      if (taskId) queryClient.invalidateQueries({ queryKey: queryKeys.tasks.comments(taskId) });
    },
  }),
  "task.comment_deleted": defineSSEHandler<"task.comment_deleted">({
    zustand: ({ event, state, set }) => {
      set({
        comments: {
          ...state.comments,
          [event.data.taskId]: (state.comments[event.data.taskId] || []).filter(
            (c) => c.id !== event.data.commentId,
          ),
        },
      });
    },
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
    zustand: ({ event, state, set }) => {
      if (!state.features.some((f) => f.id === event.data.id)) {
        const featureWithProgress: MissionWithProgress = {
          ...event.data,
          progress: {
            total: 0,
            pending: 0,
            claimed: 0,
            inProgress: 0,
            submitted: 0,
            approved: 0,
            done: 0,
            failed: 0,
            rejected: 0,
            percentage: 0,
          },
        };
        set({
          features: [...state.features, featureWithProgress],
          columnPagination: { ...state.columnPagination, [event.data.columnId]: undefined },
        });
      }
    },
    cache: missionListCacheHandler.cache,
  }),
  "mission.updated": defineSSEHandler<"mission.updated">({
    zustand: ({ event, state, set }) => {
      set({
        features: state.features.map((f) =>
          f.id === event.data.id ? { ...f, ...event.data, progress: f.progress } : f,
        ),
        columnPagination: { ...state.columnPagination, [event.data.columnId]: undefined },
      });
    },
    cache: missionListCacheHandler.cache,
  }),
  "mission.moved": defineSSEHandler<"mission.moved">({
    zustand: ({ event, state, set }) => {
      set({
        features: state.features.map((f) =>
          f.id === event.data.missionId ? { ...f, columnId: event.data.toColumnId } : f,
        ),
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
    zustand: ({ event, state, set }) => {
      const existing = state.features.find((f) => f.id === event.data.missionId);
      const colId = existing?.columnId;
      set({
        features: state.features.map((f) =>
          f.id === event.data.missionId ? { ...f, status: event.data.toStatus } : f,
        ),
        ...(colId ? { columnPagination: { ...state.columnPagination, [colId]: undefined } } : {}),
      });
    },
    cache: missionListCacheHandler.cache,
  }),
  "mission.deleted": defineSSEHandler<"mission.deleted">({
    zustand: ({ event, state, set }) => {
      const deleted = state.features.find((f) => f.id === event.data.missionId);
      const delColId = deleted?.columnId;
      set({
        features: state.features.filter((f) => f.id !== event.data.missionId),
        selectedMissionIds: state.selectedMissionIds.filter((id) => id !== event.data.missionId),
        selectedMissionId:
          state.selectedMissionId === event.data.missionId ? null : state.selectedMissionId,
        ...(delColId
          ? { columnPagination: { ...state.columnPagination, [delColId]: undefined } }
          : {}),
      });
    },
    cache: missionListCacheHandler.cache,
  }),
  "mission.progress": defineSSEHandler<"mission.progress">({
    zustand: ({ event, state, set }) => {
      const progressFeature = state.features.find((f) => f.id === event.data.missionId);
      const progColId = progressFeature?.columnId;
      set({
        features: state.features.map((f) =>
          f.id === event.data.missionId
            ? {
                ...f,
                progress: {
                  ...f.progress,
                  total: event.data.total,
                  done: event.data.completed,
                  percentage:
                    event.data.total > 0
                      ? Math.round((event.data.completed / event.data.total) * 100)
                      : 0,
                },
              }
            : f,
        ),
        ...(progColId
          ? { columnPagination: { ...state.columnPagination, [progColId]: undefined } }
          : {}),
      });
    },
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
