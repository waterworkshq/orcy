import type { StateCreator } from 'zustand';
import type { Board, Column, EnrichedBoardEvent, FeatureWithProgress } from '../../types/index.js';
import type { FeatureSlice } from './featureSlice.js';

interface ColumnPaginationEntry {
  features: FeatureWithProgress[];
  total?: number;
  offset: number;
  isLoadingMore: boolean;
}

export interface BoardSlice {
  board: Board | null;
  columns: Column[];
  wipAlerts: Record<string, { limit: number; timestamp: number }>;
  boardEvents: EnrichedBoardEvent[];
  columnPagination: Record<string, ColumnPaginationEntry | undefined>;
  setBoard: (board: Board, columns: Column[], features: FeatureWithProgress[]) => void;
  setColumns: (columns: Column[]) => void;
  updateColumn: (column: Column) => void;
  addColumn: (column: Column) => void;
  removeColumn: (columnId: string) => void;
  updateBoard: (board: Board) => void;
  setBoardEvents: (events: EnrichedBoardEvent[]) => void;
  prependBoardEvent: (event: EnrichedBoardEvent) => void;
  setColumnPagination: (columnId: string, data: { features: FeatureWithProgress[]; total?: number; offset: number }) => void;
  appendColumnFeatures: (columnId: string, features: FeatureWithProgress[], total?: number) => void;
  setColumnLoadingMore: (columnId: string, isLoading: boolean) => void;
  clearColumnPagination: () => void;
  clearWipAlert: (columnId: string) => void;
}

export const createBoardSlice: StateCreator<BoardSlice & FeatureSlice & { selectedFeatureIds: string[] }, [], [], BoardSlice> = (set) => ({
  board: null,
  columns: [],
  wipAlerts: {},
  boardEvents: [],
  columnPagination: {},

  setBoard: (board, columns, features) =>
    set((state) => ({
      board,
      columns,
      features,
      selectedFeatureIds: state.selectedFeatureIds.filter((id) => features.some((f) => f.id === id)),
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

  setBoardEvents: (events) => set({ boardEvents: events }),

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

  clearWipAlert: (columnId) =>
    set((state) => {
      const { [columnId]: _, ...rest } = state.wipAlerts;
      return { wipAlerts: rest };
    }),
});
