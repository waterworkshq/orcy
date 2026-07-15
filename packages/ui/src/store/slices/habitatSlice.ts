import type { StateCreator } from 'zustand';

export interface HabitatSlice {
  wipAlerts: Record<string, { limit: number; timestamp: number }>;
  clearWipAlert: (columnId: string) => void;
}

export const createHabitatSlice: StateCreator<HabitatSlice, [], [], HabitatSlice> = (set) => ({
  wipAlerts: {},

  clearWipAlert: (columnId) =>
    set((state) => {
      const { [columnId]: _drop, ...rest } = state.wipAlerts;
      return { wipAlerts: rest };
    }),
});