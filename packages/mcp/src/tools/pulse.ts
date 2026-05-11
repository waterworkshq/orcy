import type { KanbanApiClient } from '../api.js';
import type { Agent } from '@orcy/shared';

const SIGNAL_TYPES = [
  'finding', 'blocker', 'offer', 'warning',
  'question', 'answer', 'directive', 'context', 'handoff',
] as const;

export async function pulsePost(
  client: KanbanApiClient,
  args: {
    missionId: string;
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

export async function pulseCheck(
  client: KanbanApiClient,
  args: {
    missionId?: string;
    signalType?: typeof SIGNAL_TYPES[number];
    limit?: number;
    offset?: number;
  }
) {
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
