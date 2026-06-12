import type { StateCreator } from "zustand";
import type { Agent } from "../../types/index.js";

/**
 * Agent slice — retained for MissionCard (deferred to C5).
 * Setters (setAgents, upsertAgent, removeAgent) removed in C1.
 */
export interface AgentSlice {
  agents: Agent[];
}

export const createAgentSlice: StateCreator<AgentSlice, [], [], AgentSlice> = () => ({
  agents: [],
  // agents data is now provided via React Query (useAgents()).
  // This empty array is a placeholder for MissionCard.tsx which
  // still reads agents from Zustand alongside s.tasks (deferred to C5).
});
