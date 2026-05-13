import type { StateCreator } from 'zustand';
import type { SSEEvent, FeatureWithProgress } from '../../types/index.js';
import type { ThemeSlice } from './themeSlice.js';
import type { BoardSlice } from './boardSlice.js';
import type { FeatureSlice } from './featureSlice.js';
import type { TaskSlice } from './taskSlice.js';
import type { AgentSlice } from './agentSlice.js';
import type { PresenceSlice } from './presenceSlice.js';
import type { UiSlice } from './uiSlice.js';

type FullState = ThemeSlice & BoardSlice & FeatureSlice & TaskSlice & AgentSlice & PresenceSlice & UiSlice & {
  recentSSEEvents: SSEEvent[];
};

export interface SseHandlerSlice {
  recentSSEEvents: SSEEvent[];
  handleSSEEvent: (event: SSEEvent) => void;
}

export const createSseHandlerSlice: StateCreator<FullState, [], [], SseHandlerSlice> = (set, get) => ({
  recentSSEEvents: [],

  // eslint-disable-next-line complexity
  handleSSEEvent: (event) => {
    const state = get();
    set({ recentSSEEvents: [...state.recentSSEEvents.slice(-99), event] });
    const sseSet = set as (partial: Partial<FullState>) => void;

    switch (event.type) {

      // --- Feature lifecycle events ---
      case 'feature.created':
        if (!state.features.some((f) => f.id === event.data.id)) {
          const featureWithProgress: FeatureWithProgress = {
            ...event.data,
            progress: {
              total: 0, pending: 0, claimed: 0, inProgress: 0,
              submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0, percentage: 0,
            },
          };
          sseSet({
            features: [...state.features, featureWithProgress],
            columnPagination: {
              ...state.columnPagination,
              [event.data.columnId]: undefined,
            },
          });
        }
        break;
      case 'feature.updated':
        sseSet({
          features: state.features.map((f) =>
            f.id === event.data.id ? { ...f, ...event.data, progress: f.progress } : f
          ),
          columnPagination: {
            ...state.columnPagination,
            [event.data.columnId]: undefined,
          },
        });
        break;
      case 'feature.moved':
        sseSet({
          features: state.features.map((f) =>
            f.id === event.data.featureId
              ? { ...f, columnId: event.data.toColumnId }
              : f
          ),
          columnPagination: {
            ...state.columnPagination,
            [event.data.fromColumnId]: undefined,
            [event.data.toColumnId]: undefined,
          },
        });
        break;
      case 'feature.status_changed': {
        const existing = state.features.find((f) => f.id === event.data.featureId);
        const colId = existing?.columnId;
        sseSet({
          features: state.features.map((f) =>
            f.id === event.data.featureId
              ? { ...f, status: event.data.toStatus }
              : f
          ),
          ...(colId ? { columnPagination: { ...state.columnPagination, [colId]: undefined } } : {}),
        });
        break;
      }
      case 'feature.deleted': {
        const deleted = state.features.find((f) => f.id === event.data.featureId);
        const delColId = deleted?.columnId;
        sseSet({
          features: state.features.filter((f) => f.id !== event.data.featureId),
          selectedFeatureIds: state.selectedFeatureIds.filter((id) => id !== event.data.featureId),
          selectedFeatureId: state.selectedFeatureId === event.data.featureId ? null : state.selectedFeatureId,
          ...(delColId ? { columnPagination: { ...state.columnPagination, [delColId]: undefined } } : {}),
        });
        break;
      }
      case 'feature.progress': {
        const progressFeature = state.features.find((f) => f.id === event.data.featureId);
        const progColId = progressFeature?.columnId;
        sseSet({
          features: state.features.map((f) =>
            f.id === event.data.featureId
              ? {
                  ...f,
                  progress: {
                    ...f.progress,
                    total: event.data.total,
                    done: event.data.completed,
                    percentage: event.data.total > 0 ? Math.round((event.data.completed / event.data.total) * 100) : 0,
                  },
                }
              : f
          ),
          ...(progColId ? { columnPagination: { ...state.columnPagination, [progColId]: undefined } } : {}),
        });
        break;
      }

      // --- Task lifecycle events ---
      case 'task.created':
        if (!state.tasks.some((t) => t.id === event.data.id)) {
          sseSet({ tasks: [...state.tasks, event.data] });
        }
        break;
      case 'task.updated':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.id ? event.data : t
          ),
        });
        break;
      case 'task.claimed':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId
              ? { ...t, assignedAgentId: event.data.agentId, status: 'claimed' as const }
              : t
          ),
        });
        break;
      case 'task.submitted':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'submitted' as const } : t
          ),
        });
        break;
      case 'task.approved':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'approved' as const } : t
          ),
        });
        break;
      case 'task.rejected':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'rejected' as const } : t
          ),
        });
        break;
      case 'task.completed':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'done' as const } : t
          ),
        });
        break;
      case 'task.failed':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'failed' as const } : t
          ),
        });
        break;
      case 'task.released':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId
              ? { ...t, assignedAgentId: null, status: 'pending' as const }
              : t
          ),
        });
        break;
      case 'task.delegated':
        sseSet({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId
              ? { ...t, delegatedToAgentId: event.data.toAgentId }
              : t
          ),
        });
        break;

      // --- Agent events ---
      case 'agent.status_changed':
        sseSet({
          agents: state.agents.map((a) =>
            a.id === event.data.agentId
              ? { ...a, status: event.data.status }
              : a
          ),
        });
        break;
      case 'agent.heartbeat':
        sseSet({
          agents: state.agents.map((a) =>
            a.id === event.data.agentId
              ? { ...a, currentTaskId: event.data.taskId ?? a.currentTaskId }
              : a
          ),
        });
        break;

      // --- Board events ---
      case 'board.created':
        break;
      case 'board.updated':
        if (event.data.id === state.board?.id) {
          sseSet({ board: { ...state.board!, ...event.data } });
        }
        break;
      case 'board.deleted':
        if (event.data.boardId === state.board?.id) {
          window.location.hash = '#/';
        }
        break;
      case 'column.wip_limit_reached':
        sseSet({
          wipAlerts: {
            ...state.wipAlerts,
            [event.data.columnId]: { limit: event.data.limit, timestamp: Date.now() },
          },
        });
        break;

      // --- Column events ---
      case 'column.created':
        if (event.data.boardId === state.board?.id && !state.columns.some(c => c.id === event.data.id)) {
          sseSet({ columns: [...state.columns, event.data].sort((a, b) => a.order - b.order) });
        }
        break;
      case 'column.updated':
        sseSet({ columns: state.columns.map((c) => c.id === event.data.id ? event.data : c) });
        break;
      case 'column.deleted':
        if (event.data.boardId === state.board?.id) {
          sseSet({ columns: state.columns.filter((c) => c.id !== event.data.columnId) });
        }
        break;
      case 'task.commented':
        sseSet({
          comments: {
            ...state.comments,
            [event.data.taskId]: [event.data.comment, ...(state.comments[event.data.taskId] || [])],
          },
        });
        break;
      case 'task.comment_deleted':
        sseSet({
          comments: {
            ...state.comments,
            [event.data.taskId]: (state.comments[event.data.taskId] || []).filter(
              (c) => c.id !== event.data.commentId
            ),
          },
        });
        break;

      // --- Presence events ---
      case 'presence.summary':
        sseSet({ presence: event.data.viewers });
        break;
      case 'presence.joined':
        sseSet({
          presence: state.presence.some((p) => p.sessionId === event.data.presence.sessionId)
            ? state.presence
            : [...state.presence, event.data.presence],
        });
        break;
      case 'presence.left':
        sseSet({
          presence: state.presence.filter((p) => p.sessionId !== event.data.sessionId),
        });
        break;
      case 'presence.refresh':
        sseSet({
          presence: state.presence.map((p) =>
            p.sessionId === event.data.presence.sessionId ? event.data.presence : p
          ),
        });
        break;
      case 'task.watcher_notify':
        break;
      case 'task.deleted':
        sseSet({
          tasks: state.tasks.filter((t) => t.id !== event.data.taskId),
        });
        break;
      case 'anomaly.detected':
        break;
      case 'task.overdue':
        break;
    }
  },
});
