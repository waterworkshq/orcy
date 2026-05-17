import type { StateCreator } from 'zustand';
import type { Notification } from '../../types/index.js';

export interface UiSlice {
  selectedMissionId: string | null;
  isLoading: boolean;
  error: string | null;
  isBulkSelectMode: boolean;
  selectedMissionIds: string[];
  notifications: Notification[];
  collapsedColumns: Record<string, boolean>;
  isTaskBulkSelectMode: boolean;
  selectedTaskIds: string[];
  setSelectedMission: (missionId: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setBulkSelectMode: (enabled: boolean) => void;
  toggleMissionSelection: (missionId: string) => void;
  clearMissionSelection: () => void;
  selectMissionIds: (missionIds: string[]) => void;
  addNotification: (notification: Omit<Notification, 'id' | 'read'>) => void;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;
  toggleColumnCollapsed: (columnId: string) => void;
  setTaskBulkSelectMode: (enabled: boolean) => void;
  toggleTaskSelection: (taskId: string) => void;
  clearTaskSelection: () => void;
  selectTaskIds: (taskIds: string[]) => void;
}

export const createUiSlice: StateCreator<UiSlice, [], [], UiSlice> = (set) => ({
  selectedMissionId: null,
  isLoading: false,
  error: null,
  isBulkSelectMode: false,
  selectedMissionIds: [],
  notifications: [],
  collapsedColumns: {},
  isTaskBulkSelectMode: false,
  selectedTaskIds: [],

  setSelectedMission: (missionId) => set({ selectedMissionId: missionId }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

  setBulkSelectMode: (enabled) =>
    set({ isBulkSelectMode: enabled, selectedMissionIds: enabled ? [] : [] }),

  toggleMissionSelection: (missionId) =>
    set((state) => ({
      selectedMissionIds: state.selectedMissionIds.includes(missionId)
        ? state.selectedMissionIds.filter((id) => id !== missionId)
        : [...state.selectedMissionIds, missionId],
    })),

  clearMissionSelection: () => set({ selectedMissionIds: [] }),

  selectMissionIds: (missionIds) => set({ selectedMissionIds: missionIds }),

  addNotification: (notification) =>
    set((state) => {
      const id = typeof crypto.randomUUID === 'function'
        ? crypto.randomUUID()
        : `notif-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
      return {
        notifications: [
          { ...notification, id, read: false },
          ...state.notifications,
        ].slice(0, 100),
      };
    }),

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

  setTaskBulkSelectMode: (enabled) =>
    set({ isTaskBulkSelectMode: enabled, selectedTaskIds: [] }),

  toggleTaskSelection: (taskId) =>
    set((state) => ({
      selectedTaskIds: state.selectedTaskIds.includes(taskId)
        ? state.selectedTaskIds.filter((id) => id !== taskId)
        : [...state.selectedTaskIds, taskId],
    })),

  clearTaskSelection: () => set({ selectedTaskIds: [] }),

  selectTaskIds: (taskIds) => set({ selectedTaskIds: taskIds }),
});
