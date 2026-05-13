import type { StateCreator } from 'zustand';
import type { Notification } from '../../types/index.js';

export interface UiSlice {
  selectedFeatureId: string | null;
  isLoading: boolean;
  error: string | null;
  isBulkSelectMode: boolean;
  selectedFeatureIds: string[];
  notifications: Notification[];
  collapsedColumns: Record<string, boolean>;
  setSelectedFeature: (featureId: string | null) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  setBulkSelectMode: (enabled: boolean) => void;
  toggleFeatureSelection: (featureId: string) => void;
  clearFeatureSelection: () => void;
  selectFeatureIds: (featureIds: string[]) => void;
  addNotification: (notification: Omit<Notification, 'id' | 'read'>) => void;
  markNotificationRead: (id: string) => void;
  clearNotifications: () => void;
  toggleColumnCollapsed: (columnId: string) => void;
}

export const createUiSlice: StateCreator<UiSlice, [], [], UiSlice> = (set) => ({
  selectedFeatureId: null,
  isLoading: false,
  error: null,
  isBulkSelectMode: false,
  selectedFeatureIds: [],
  notifications: [],
  collapsedColumns: {},

  setSelectedFeature: (featureId) => set({ selectedFeatureId: featureId }),
  setLoading: (isLoading) => set({ isLoading }),
  setError: (error) => set({ error }),

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
});
