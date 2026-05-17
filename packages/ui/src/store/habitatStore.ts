/**
 * Global habitat store — holds habitat data, missions, tasks, agents, columns, presence,
 * and SSE event handlers.
 *
 * Composed from 7 domain slices + 1 SSE handler slice.
 */
import { create } from 'zustand';
import { createThemeSlice, type ThemeSlice } from './slices/themeSlice.js';
import { createHabitatSlice, type HabitatSlice } from './slices/habitatSlice.js';
import { createMissionSlice, type MissionSlice } from './slices/missionSlice.js';
import { createTaskSlice, type TaskSlice } from './slices/taskSlice.js';
import { createAgentSlice, type AgentSlice } from './slices/agentSlice.js';
import { createPresenceSlice, type PresenceSlice } from './slices/presenceSlice.js';
import { createUiSlice, type UiSlice } from './slices/uiSlice.js';
import { createSseHandlerSlice, type SseHandlerSlice } from './slices/sseHandler.js';

export type HabitatState = ThemeSlice & HabitatSlice & MissionSlice & TaskSlice & AgentSlice & PresenceSlice & UiSlice & SseHandlerSlice;

export const useHabitatStore = create<HabitatState>()((...a) => ({
  ...createThemeSlice(...a),
  ...createHabitatSlice(...a),
  ...createMissionSlice(...a),
  ...createTaskSlice(...a),
  ...createAgentSlice(...a),
  ...createPresenceSlice(...a),
  ...createUiSlice(...a),
  ...createSseHandlerSlice(...a),
}));
