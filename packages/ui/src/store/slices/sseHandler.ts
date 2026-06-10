import type { StateCreator } from "zustand";
import type { SSEEvent } from "../../types/index.js";
import { applySSEStoreUpdate } from "../../sse/registry.js";
import type { SSEStoreSet, SSEStoreState } from "../../sse/types.js";

export interface SseHandlerSlice {
  recentSSEEvents: SSEEvent[];
  handleSSEEvent: (event: SSEEvent) => void;
}

export const createSseHandlerSlice: StateCreator<SSEStoreState, [], [], SseHandlerSlice> = (
  set,
  get,
) => ({
  recentSSEEvents: [],

  handleSSEEvent: (event) => {
    const state = get();
    set({ recentSSEEvents: [...state.recentSSEEvents.slice(-99), event] });
    applySSEStoreUpdate(event, state, set as SSEStoreSet);
  },
});
