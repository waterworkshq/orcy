/**
 * Global board store — holds board data, features, tasks, agents, columns, presence,
 * and SSE event handlers. Features are the board-level kanban cards.
 *
 * Composed from 7 domain slices + 1 SSE handler slice.
 */
import { create } from 'zustand';
import { createThemeSlice, type ThemeSlice } from './slices/themeSlice.js';
import { createBoardSlice, type BoardSlice } from './slices/boardSlice.js';
import { createFeatureSlice, type FeatureSlice } from './slices/featureSlice.js';
import { createTaskSlice, type TaskSlice } from './slices/taskSlice.js';
import { createAgentSlice, type AgentSlice } from './slices/agentSlice.js';
import { createPresenceSlice, type PresenceSlice } from './slices/presenceSlice.js';
import { createUiSlice, type UiSlice } from './slices/uiSlice.js';
import { createSseHandlerSlice, type SseHandlerSlice } from './slices/sseHandler.js';

export type BoardState = ThemeSlice & BoardSlice & FeatureSlice & TaskSlice & AgentSlice & PresenceSlice & UiSlice & SseHandlerSlice;

export const useBoardStore = create<BoardState>()((...a) => ({
  ...createThemeSlice(...a),
  ...createBoardSlice(...a),
  ...createFeatureSlice(...a),
  ...createTaskSlice(...a),
  ...createAgentSlice(...a),
  ...createPresenceSlice(...a),
  ...createUiSlice(...a),
  ...createSseHandlerSlice(...a),
}));
