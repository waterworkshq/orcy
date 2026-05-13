import type { StateCreator } from 'zustand';
import type { Agent } from '../../types/index.js';

export interface AgentSlice {
  agents: Agent[];
  setAgents: (agents: Agent[]) => void;
  upsertAgent: (agent: Agent) => void;
  removeAgent: (agentId: string) => void;
}

export const createAgentSlice: StateCreator<AgentSlice, [], [], AgentSlice> = (set) => ({
  agents: [],

  setAgents: (agents) => set({ agents }),

  upsertAgent: (agent) =>
    set((state) => ({
      agents: state.agents.some((a) => a.id === agent.id)
        ? state.agents.map((a) => (a.id === agent.id ? agent : a))
        : [...state.agents, agent],
    })),

  removeAgent: (agentId) =>
    set((state) => ({
      agents: state.agents.filter((a) => a.id !== agentId),
    })),
});
