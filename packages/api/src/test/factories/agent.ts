import type { Agent, AgentStatus, AgentType, AgentDomain } from '../../models/index.js';

function generateId(): string {
  return crypto.randomUUID();
}

export function makeAgent(overrides: Partial<Agent> = {}): Agent {
  const id = overrides.id ?? generateId();
  const now = new Date().toISOString();
  return {
    id,
    name: 'Test Agent',
    type: 'claude-code' as AgentType,
    domain: 'backend' as AgentDomain,
    capabilities: [],
    status: 'idle' as AgentStatus,
    currentTaskId: null,
    apiKeyHash: 'hash',
    rateLimitPerMinute: null,
    createdAt: now,
    lastHeartbeat: now,
    metadata: {},
    ...overrides,
  } as Agent;
}
