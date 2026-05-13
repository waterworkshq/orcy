/**
 * Global board store — holds board data, features, tasks, agents, columns, presence,
 * and SSE event handlers. Features are the board-level kanban cards.
 */
import { create } from 'zustand';
import type { Board, Task, Agent, Column, SSEEvent, TaskComment, EnrichedBoardEvent, PresenceEntry, FeatureWithProgress, Feature, FeatureStatus, Notification } from '../types/index.js';

type Theme = 'light' | 'dark';

interface ColumnPagination {
  features: FeatureWithProgress[];
  total?: number;
  offset: number;
  isLoadingMore: boolean;
}

interface BoardState {
  theme: Theme;
  board: Board | null;
  features: FeatureWithProgress[];
  tasks: Task[];
  agents: Agent[];
  columns: Column[];
  selectedFeatureId: string | null;
  isLoading: boolean;
  error: string | null;
  wipAlerts: Record<string, { limit: number; timestamp: number }>;
  comments: Record<string, TaskComment[]>;
  boardEvents: EnrichedBoardEvent[];
  columnPagination: Record<string, ColumnPagination | undefined>;
  allFeaturesLoaded: boolean;
  presence: PresenceEntry[];
  isBulkSelectMode: boolean;
  selectedFeatureIds: string[];
  notifications: Notification[];
  recentSSEEvents: SSEEvent[];

  setTheme: (theme: Theme) => void;
  toggleTheme: () => void;
  setBoard: (board: Board, columns: Column[], features: FeatureWithProgress[]) => void;
  setFeatures: (features: FeatureWithProgress[]) => void;
  setTasks: (tasks: Task[]) => void;
  setAgents: (agents: Agent[]) => void;
  setSelectedFeature: (featureId: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;

  addFeature: (feature: FeatureWithProgress) => void;
  updateFeature: (feature: FeatureWithProgress) => void;
  removeFeature: (featureId: string) => void;
  moveFeatureToColumn: (featureId: string, columnId: string) => void;
  updateFeatureStatus: (featureId: string, status: FeatureStatus) => void;
  updateFeatureProgress: (featureId: string, completed: number, total: number) => void;

  addTask: (task: Task) => void;
  updateTask: (task: Task) => void;
  removeTask: (taskId: string) => void;
  updateColumn: (column: Column) => void;
  setColumns: (columns: Column[]) => void;
  addColumn: (column: Column) => void;
  removeColumn: (columnId: string) => void;
  updateBoard: (board: Board) => void;

  upsertAgent: (agent: Agent) => void;
  removeAgent: (agentId: string) => void;

  setComments: (taskId: string, comments: TaskComment[]) => void;
  addComment: (comment: TaskComment) => void;
  removeComment: (taskId: string, commentId: string) => void;

  setBoardEvents: (events: EnrichedBoardEvent[]) => void;
  prependBoardEvent: (event: EnrichedBoardEvent) => void;
  setColumnPagination: (columnId: string, data: { features: FeatureWithProgress[]; total?: number; offset: number }) => void;

  appendColumnFeatures: (columnId: string, features: FeatureWithProgress[], total?: number) => void;
  setColumnLoadingMore: (columnId: string, isLoading: boolean) => void;
  clearColumnPagination: () => void;

  setPresence: (viewers: PresenceEntry[]) => void;
  removePresenceSession: (sessionId: string) => void;
  upsertPresenceEntry: (entry: PresenceEntry) => void;

  setBulkSelectMode: (enabled: boolean) => void;
  toggleFeatureSelection: (featureId: string) => void;
  clearFeatureSelection: () => void;
  selectFeatureIds: (featureIds: string[]) => void;

  addNotification: (notification: Omit<Notification, 'id' | 'read'>) => void;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;

  collapsedColumns: Record<string, boolean>;
  toggleColumnCollapsed: (columnId: string) => void;
  clearWipAlert: (columnId: string) => void;

  /** Dispatches an SSEEvent to the appropriate state mutation. */
  handleSSEEvent: (event: SSEEvent) => void;
}

export const useBoardStore = create<BoardState>((set, get) => ({
  theme: 'light',

  setTheme: (theme) => {
    set({ theme });
    localStorage.setItem('orcy_theme', theme);
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  },

  toggleTheme: () => {
    const newTheme = get().theme === 'light' ? 'dark' : 'light';
    get().setTheme(newTheme);
  },

  board: null,
  features: [],
  tasks: [],
  agents: [],
  columns: [],
  selectedFeatureId: null,
  isLoading: false,
  error: null,
  wipAlerts: {},
  comments: {},
  boardEvents: [],
  columnPagination: {},
  allFeaturesLoaded: false,
  presence: [],
  isBulkSelectMode: false,
  selectedFeatureIds: [],
  notifications: [],
  recentSSEEvents: [],
  collapsedColumns: {},

  setBoard: (board, columns, features) =>
    set((state) => ({
      board,
      columns,
      features,
      selectedFeatureIds: state.selectedFeatureIds.filter((id) => features.some((f) => f.id === id)),
    })),

  setFeatures: (features) =>
    set((state) => ({
      features,
      selectedFeatureIds: state.selectedFeatureIds.filter((id) => features.some((f) => f.id === id)),
    })),

  setTasks: (tasks) => set({ tasks }),

  setAgents: (agents) => set({ agents }),

  setSelectedFeature: (featureId) => set({ selectedFeatureId: featureId }),

  setLoading: (isLoading) => set({ isLoading }),

  setError: (error) => set({ error }),

  addFeature: (feature) =>
    set((state) => ({
      features: [...state.features, feature],
    })),

  updateFeature: (feature) =>
    set((state) => ({
      features: state.features.map((f) => (f.id === feature.id ? feature : f)),
    })),

  removeFeature: (featureId) =>
    set((state) => ({
      features: state.features.filter((f) => f.id !== featureId),
      selectedFeatureId: state.selectedFeatureId === featureId ? null : state.selectedFeatureId,
      selectedFeatureIds: state.selectedFeatureIds.filter((id) => id !== featureId),
    })),

  moveFeatureToColumn: (featureId, columnId) =>
    set((state) => ({
      features: state.features.map((f) =>
        f.id === featureId ? { ...f, columnId } : f
      ),
    })),

  updateFeatureStatus: (featureId, status) =>
    set((state) => ({
      features: state.features.map((f) =>
        f.id === featureId ? { ...f, status } : f
      ),
    })),

  updateFeatureProgress: (featureId, completed, total) =>
    set((state) => ({
      features: state.features.map((f) =>
        f.id === featureId
          ? {
              ...f,
              progress: {
                ...f.progress,
                total,
                done: completed,
                percentage: total > 0 ? Math.round((completed / total) * 100) : 0,
              },
            }
          : f
      ),
    })),

  addTask: (task) =>
    set((state) => ({
      tasks: [...state.tasks, task],
    })),

  updateTask: (task) =>
    set((state) => ({
      tasks: state.tasks.map((t) => (t.id === task.id ? task : t)),
    })),

  removeTask: (taskId) =>
    set((state) => ({
      tasks: state.tasks.filter((t) => t.id !== taskId),
    })),

  updateColumn: (column) =>
    set((state) => ({
      columns: state.columns.map((c) => (c.id === column.id ? column : c)),
    })),

  setColumns: (columns) =>
    set({ columns: [...columns].sort((a, b) => a.order - b.order) }),

  addColumn: (column) =>
    set((state) => ({
      columns: [...state.columns, column].sort((a, b) => a.order - b.order),
    })),

  removeColumn: (columnId) =>
    set((state) => ({
      columns: state.columns.filter((c) => c.id !== columnId),
      columnPagination: Object.fromEntries(
        Object.entries(state.columnPagination).filter(([id]) => id !== columnId)
      ),
    })),

  updateBoard: (board) =>
    set((state) => ({
      board: state.board?.id === board.id ? board : state.board,
    })),

  upsertAgent: (agent) =>
    set((state) => ({
      agents: state.agents.some((a) => a.id === agent.id)
        ? state.agents.map((a) => (a.id === agent.id ? agent : a))
        : [...state.agents, agent],
    })),

  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== agentId),
    })),

  setComments: (taskId, comments) =>
    set((state) => ({
      comments: { ...state.comments, [taskId]: comments },
    })),

  addComment: (comment) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [comment.taskId]: [comment, ...(state.comments[comment.taskId] || [])],
      },
    })),

  removeComment: (taskId, commentId) =>
    set((state) => ({
      comments: {
        ...state.comments,
        [taskId]: (state.comments[taskId] || []).filter((c) => c.id !== commentId),
      },
    })),

  setBoardEvents: (events) =>
    set({ boardEvents: events }),

  prependBoardEvent: (event) =>
    set((state) => ({
      boardEvents: [event, ...state.boardEvents].slice(0, 100),
    })),

  setColumnPagination: (columnId, data) =>
    set((state) => ({
      columnPagination: {
        ...state.columnPagination,
        [columnId]: {
          features: data.features,
          total: data.total,
          offset: data.offset,
          isLoadingMore: false,
        },
      },
    })),

  appendColumnFeatures: (columnId, features, total) =>
    set((state) => {
      const existing = state.columnPagination[columnId];
      if (!existing) return state;
      return {
        columnPagination: {
          ...state.columnPagination,
          [columnId]: {
            features: [...existing.features, ...features],
            total,
            offset: existing.offset + features.length,
            isLoadingMore: false,
          },
        },
      };
    }),

  setColumnLoadingMore: (columnId, isLoading) =>
    set((state) => {
      const existing = state.columnPagination[columnId];
      if (!existing) return state;
      return {
        columnPagination: {
          ...state.columnPagination,
          [columnId]: { ...existing, isLoadingMore: isLoading },
        },
      };
    }),

  clearColumnPagination: () => set({ columnPagination: {}, allFeaturesLoaded: false }),

  setPresence: (viewers) => set({ presence: viewers }),

  removePresenceSession: (sessionId) =>
    set((state) => ({
      presence: state.presence.filter((p) => p.sessionId !== sessionId),
    })),

  upsertPresenceEntry: (entry) =>
    set((state) => ({
      presence: state.presence.some((p) => p.sessionId === entry.sessionId)
        ? state.presence.map((p) => (p.sessionId === entry.sessionId ? entry : p))
        : [...state.presence, entry],
    })),

  setBulkSelectMode: (enabled) =>
    set({ isBulkSelectMode: enabled, selectedFeatureIds: enabled ? [] : [] }),

  toggleFeatureSelection: (featureId) =>
    set((state) => ({
      selectedFeatureIds: state.selectedFeatureIds.includes(featureId)
        ? state.selectedFeatureIds.filter((id) => id !== featureId)
        : [...state.selectedFeatureIds, featureId],
    })),

  clearFeatureSelection: () => set({ selectedFeatureIds: [] }),

  selectFeatureIds: (featureIds) => set({ selectedFeatureIds: featureIds }),

  addNotification: (notification) =>
    set((state) => ({
      notifications: [
        { ...notification, id: crypto.randomUUID(), read: false },
        ...state.notifications,
      ],
    })),

  markNotificationRead: (id) =>
    set((state) => ({
      notifications: state.notifications.map((n) =>
        n.id === id ? { ...n, read: true } : n
      ),
    })),

  clearNotifications: () => set({ notifications: [] }),

  toggleColumnCollapsed: (columnId) =>
    set((state) => ({
      collapsedColumns: {
        ...state.collapsedColumns,
        [columnId]: !state.collapsedColumns[columnId],
      },
    })),

  clearWipAlert: (columnId: string) =>
    set((state) => {
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [columnId]: _, ...rest } = state.wipAlerts;
      return { wipAlerts: rest };
    }),

  handleSSEEvent: (event) => {
    const state = get();
    set({ recentSSEEvents: [...state.recentSSEEvents.slice(-99), event] });
    switch (event.type) {

      // --- Feature lifecycle events ---
      case 'feature.created':
        if (!state.features.some((f) => f.id === event.data.id)) {
          const featureWithProgress: FeatureWithProgress = {
            ...event.data,
            progress: {
              total: 0, pending: 0, claimed: 0, inProgress: 0,
              submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0,
            },
          };
          set((s) => ({
            features: [...state.features, featureWithProgress],
            columnPagination: {
              ...s.columnPagination,
              [event.data.columnId]: undefined,
            },
          }));
        }
        break;
      case 'feature.updated':
        set((s) => ({
          features: state.features.map((f) =>
            f.id === event.data.id ? { ...f, ...event.data, progress: f.progress } : f
          ),
          columnPagination: {
            ...s.columnPagination,
            [event.data.columnId]: undefined,
          },
        }));
        break;
      case 'feature.moved':
        set((s) => ({
          features: state.features.map((f) =>
            f.id === event.data.featureId
              ? { ...f, columnId: event.data.toColumnId }
              : f
          ),
          columnPagination: {
            ...s.columnPagination,
            [event.data.fromColumnId]: undefined,
            [event.data.toColumnId]: undefined,
          },
        }));
        break;
      case 'feature.status_changed': {
        const existing = state.features.find((f) => f.id === event.data.featureId);
        const colId = existing?.columnId;
        set((s) => ({
          features: state.features.map((f) =>
            f.id === event.data.featureId
              ? { ...f, status: event.data.toStatus }
              : f
          ),
          ...(colId ? { columnPagination: { ...s.columnPagination, [colId]: undefined } } : {}),
        }));
        break;
      }
      case 'feature.deleted': {
        const deleted = state.features.find((f) => f.id === event.data.featureId);
        const delColId = deleted?.columnId;
        set((s) => ({
          features: s.features.filter((f) => f.id !== event.data.featureId),
          selectedFeatureIds: s.selectedFeatureIds.filter((id) => id !== event.data.featureId),
          selectedFeatureId: s.selectedFeatureId === event.data.featureId ? null : s.selectedFeatureId,
          ...(delColId ? { columnPagination: { ...s.columnPagination, [delColId]: undefined } } : {}),
        }));
        break;
      }
      case 'feature.progress': {
        const progressFeature = state.features.find((f) => f.id === event.data.featureId);
        const progColId = progressFeature?.columnId;
        set((s) => ({
          features: s.features.map((f) =>
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
          ...(progColId ? { columnPagination: { ...s.columnPagination, [progColId]: undefined } } : {}),
        }));
        break;
      }

      // --- Task lifecycle events ---
      case 'task.created':
        if (!state.tasks.some((t) => t.id === event.data.id)) {
          set({ tasks: [...state.tasks, event.data] });
        }
        break;
      case 'task.updated':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.id ? event.data : t
          ),
        });
        break;
      case 'task.claimed':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId
              ? { ...t, assignedAgentId: event.data.agentId, status: 'claimed' as const }
              : t
          ),
        });
        break;
      case 'task.submitted':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'submitted' as const } : t
          ),
        });
        break;
      case 'task.approved':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'approved' as const } : t
          ),
        });
        break;
      case 'task.rejected':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'rejected' as const } : t
          ),
        });
        break;
      case 'task.completed':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'done' as const } : t
          ),
        });
        break;
      case 'task.failed':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId ? { ...t, status: 'failed' as const } : t
          ),
        });
        break;
      case 'task.released':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId
              ? { ...t, assignedAgentId: null, status: 'pending' as const }
              : t
          ),
        });
        break;
      case 'task.delegated':
        set({
          tasks: state.tasks.map((t) =>
            t.id === event.data.taskId
              ? { ...t, delegatedToAgentId: event.data.toAgentId }
              : t
          ),
        });
        break;

      // --- Agent events ---
      case 'agent.status_changed':
        set({
          agents: state.agents.map((a) =>
            a.id === event.data.agentId
              ? { ...a, status: event.data.status }
              : a
          ),
        });
        break;
      case 'agent.heartbeat':
        set({
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
          set((s) => ({ board: { ...s.board!, ...event.data } }));
        }
        break;
      case 'board.deleted':
        if (event.data.boardId === state.board?.id) {
          window.location.hash = '#/';
        }
        break;
      case 'column.wip_limit_reached':
        set((state) => ({
          wipAlerts: {
            ...state.wipAlerts,
            [event.data.columnId]: { limit: event.data.limit, timestamp: Date.now() },
          },
        }));
        break;

      // --- Column events ---
      case 'column.created':
        if (event.data.boardId === state.board?.id && !state.columns.some(c => c.id === event.data.id)) {
          set((s) => ({ columns: [...s.columns, event.data].sort((a, b) => a.order - b.order) }));
        }
        break;
      case 'column.updated':
        set((s) => ({ columns: s.columns.map((c) => c.id === event.data.id ? event.data : c) }));
        break;
      case 'column.deleted':
        if (event.data.boardId === state.board?.id) {
          set((s) => ({ columns: s.columns.filter((c) => c.id !== event.data.columnId) }));
        }
        break;
      case 'task.commented':
        set((state) => ({
          comments: {
            ...state.comments,
            [event.data.taskId]: [event.data.comment, ...(state.comments[event.data.taskId] || [])],
          },
        }));
        break;
      case 'task.comment_deleted':
        set((state) => ({
          comments: {
            ...state.comments,
            [event.data.taskId]: (state.comments[event.data.taskId] || []).filter(
              (c) => c.id !== event.data.commentId
            ),
          },
        }));
        break;

      // --- Presence events ---
      case 'presence.summary':
        set({ presence: event.data.viewers });
        break;
      case 'presence.joined':
        set((s) => ({
          presence: s.presence.some((p) => p.sessionId === event.data.presence.sessionId)
            ? s.presence
            : [...s.presence, event.data.presence],
        }));
        break;
      case 'presence.left':
        set((s) => ({
          presence: s.presence.filter((p) => p.sessionId !== event.data.sessionId),
        }));
        break;
      case 'presence.refresh':
        set((s) => ({
          presence: s.presence.map((p) =>
            p.sessionId === event.data.presence.sessionId ? event.data.presence : p
          ),
        }));
        break;
      case 'task.watcher_notify':
        break;
      case 'task.deleted':
        set((state) => ({
          tasks: state.tasks.filter((t) => t.id !== event.data.taskId),
        }));
        break;
      case 'anomaly.detected':
        break;
      case 'task.overdue':
        break;
    }
  },
}));
