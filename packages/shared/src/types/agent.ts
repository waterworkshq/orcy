export type AgentType = 'claude-code' | 'codex' | 'opencode';
export type AgentDomain = 'frontend' | 'backend' | 'devops' | 'testing' | string;
export type AgentStatus = 'idle' | 'working' | 'offline';

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  domain: AgentDomain;
  capabilities: string[];
  status: AgentStatus;
  currentTaskId: string | null;
  apiKeyHash: string;
  rateLimitPerMinute: number | null;
  createdAt: string;
  lastHeartbeat: string;
  metadata: Record<string, unknown>;
}

export interface AgentStats {
  agentId: string;
  agentName: string;
  tasks: {
    completed: number;
    failed: number;
    inProgress: number;
    rejected: number;
    totalAssigned: number;
  };
  cycleTime: {
    averageMinutes: number;
    medianMinutes: number;
    count: number;
  };
  throughput: {
    today: number;
    last7d: number;
    last30d: number;
  };
  quality: {
    rejectionRate: number;
    approvalRate: number;
    currentStreak: number;
    totalRejections: number;
  };
  artifacts: {
    total: number;
    byType: Record<string, number>;
  };
}

export interface AllAgentStats {
  agents: Array<{
    agentId: string;
    agentName: string;
    domain: string;
    status: AgentStatus;
    completed: number;
    failed: number;
    inProgress: number;
    avgCycleMinutes: number;
    approvalRate: number;
    currentStreak: number;
  }>;
  summary: {
    totalTasksCompleted: number;
    totalTasksFailed: number;
    totalAgentsActive: number;
  };
}
