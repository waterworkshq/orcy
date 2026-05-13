import type { StateCreator } from 'zustand';
import type { PresenceEntry } from '../../types/index.js';

export interface PresenceSlice {
  presence: PresenceEntry[];
  setPresence: (viewers: PresenceEntry[]) => void;
  removePresenceSession: (sessionId: string) => void;
  upsertPresenceEntry: (entry: PresenceEntry) => void;
}

export const createPresenceSlice: StateCreator<PresenceSlice, [], [], PresenceSlice> = (set) => ({
  presence: [],

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
});
