import { create } from 'zustand';
import { createThemeSlice, type ThemeSlice } from './slices/themeSlice.js';
import { createHabitatSlice, type HabitatSlice } from './slices/habitatSlice.js';
import { createPresenceSlice, type PresenceSlice } from './slices/presenceSlice.js';
import { createUiSlice, type UiSlice } from './slices/uiSlice.js';
import { createSseHandlerSlice, type SseHandlerSlice } from './slices/sseHandler.js';

export type HabitatState = ThemeSlice & HabitatSlice & PresenceSlice & UiSlice & SseHandlerSlice;

export const useHabitatStore = create<HabitatState>()((...a) => ({
  ...createThemeSlice(...a),
  ...createHabitatSlice(...a),
  ...createPresenceSlice(...a),
  ...createUiSlice(...a),
  ...createSseHandlerSlice(...a),
}));