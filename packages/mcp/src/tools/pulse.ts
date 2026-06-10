import type { PulseClient } from "../api/interfaces.js";
import type { KanbanApiClient } from '../api.js';
import type { Agent } from '@orcy/shared';

const SIGNAL_TYPES = [
  'finding', 'blocker', 'offer', 'warning',
  'question', 'answer', 'directive', 'context', 'handoff',
] as const;

/**
 * @requires PulseClient
 * @requires AgentClient
 */
export async function pulsePost(
  client: KanbanApiClient,
  args: {
    missionId?: string;
    boardId?: string;
    scope?: 'mission' | 'habitat';
    signalType: typeof SIGNAL_TYPES[number];
    subject: string;
    body?: string;
    taskId?: string;
    toAgentName?: string;
    replyToId?: string;
    metadata?: Record<string, unknown>;
  }
) {
  let toAgentId: string | undefined;

  if (args.toAgentName) {
    const agentsResp = await client.listAgents();
    const agents = Array.isArray(agentsResp.agents)
      ? agentsResp.agents as Agent[]
      : (agentsResp.agents as { agent: Agent }[]).map(a => a.agent);
    const found = agents.find(a => a.name === args.toAgentName);
    if (!found) {
      throw new Error(`Agent with name "${args.toAgentName}" not found`);
    }
    toAgentId = found.id;
  }

  const isHabitat = args.scope === 'habitat';

  if (isHabitat) {
    if (!args.boardId) {
      throw new Error('boardId is required for habitat-scoped signals');
    }
    return client.postHabitatPulse(args.boardId, {
      signalType: args.signalType,
      subject: args.subject,
      body: args.body,
      taskId: args.taskId,
      toAgentName: args.toAgentName,
      toAgentId,
      replyToId: args.replyToId,
      metadata: args.metadata,
    });
  }

  if (!args.missionId) {
    throw new Error('missionId is required for mission-scoped signals (or use scope="habitat" with boardId)');
  }

  return client.postPulse(args.missionId, {
    signalType: args.signalType,
    subject: args.subject,
    body: args.body,
    taskId: args.taskId,
    toAgentName: args.toAgentName,
    toAgentId,
    replyToId: args.replyToId,
    metadata: args.metadata,
  });
}

/**
 * @requires PulseClient
 * @requires AgentClient
 */
export async function pulseCheck(
  client: KanbanApiClient,
  args: {
    missionId?: string;
    boardId?: string;
    scope?: 'mission' | 'habitat';
    signalType?: typeof SIGNAL_TYPES[number];
    limit?: number;
    offset?: number;
  }
) {
  if (args.scope === 'habitat' && args.boardId) {
    return client.getHabitatPulses(args.boardId, {
      signalType: args.signalType,
      scope: 'habitat',
      limit: args.limit,
      offset: args.offset,
    });
  }

  if (args.missionId) {
    return client.getPulses(args.missionId, {
      signalType: args.signalType,
      limit: args.limit,
      offset: args.offset,
    });
  }

  return client.getPulseInbox({
    signalType: args.signalType,
    limit: args.limit,
    offset: args.offset,
  });
}
