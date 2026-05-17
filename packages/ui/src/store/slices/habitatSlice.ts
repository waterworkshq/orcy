import type { StateCreator } from 'zustand';
import type { Habitat, Column, EnrichedHabitatEvent, MissionWithProgress } from '../../types/index.js';
import type { MissionSlice } from './missionSlice.js';

interface ColumnPaginationEntry {
  features: MissionWithProgress[];
  total?: number;
  offset: number;
  isLoadingMore: boolean;
}

export interface HabitatSlice {
  board: Habitat | null;
  columns: Column[];
  wipAlerts: Record<string, { limit: number; timestamp: number }>;
  habitatEvents: EnrichedHabitatEvent[];
  columnPagination: Record<string, ColumnPaginationEntry | undefined>;
  setBoard: (board: Habitat, columns: Column[], features: MissionWithProgress[]) => void;
  setColumns: (columns: Column[]) => void;
  updateColumn: (column: Column) => void;
  addColumn: (column: Column) => void;
  removeColumn: (columnId: string) => void;
  updateBoard: (board: Habitat) => void;
  setHabitatEvents: (events: EnrichedHabitatEvent[]) => void;
  prependHabitatEvent: (event: EnrichedHabitatEvent) => void;
  setColumnPagination: (columnId: string, data: { features: MissionWithProgress[]; total?: number; offset: number }) => void;
  appendColumnFeatures: (columnId: string, features: MissionWithProgress[], total?: number) => void;
  setColumnLoadingMore: (columnId: string, isLoading: boolean) => void;
  clearColumnPagination: () => void;
  clearWipAlert: (columnId: string) => void;
}

export const createHabitatSlice: StateCreator<HabitatSlice & MissionSlice & { selectedMissionIds: string[] }, [], [], HabitatSlice> = (set) => ({
  board: null,
  columns: [],
  wipAlerts: {},
  habitatEvents: [],
  columnPagination: {},

  setBoard: (board, columns, features) =>
    set((state) => ({
      board,
      columns,
      features,
      selectedMissionIds: state.selectedMissionIds.filter((id) => features.some((f) => f.id === id)),
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

  setHabitatEvents: (events) => set({ habitatEvents: events }),

  prependHabitatEvent: (event) =>
    set((state) => ({
      habitatEvents: [event, ...state.habitatEvents].slice(0, 100),
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

  clearWipAlert: (columnId) =>
    set((state) => {
      const { [columnId]: _, ...rest } = state.wipAlerts;
      return { wipAlerts: rest };
    }),
});
