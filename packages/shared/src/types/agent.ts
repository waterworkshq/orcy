/** Identifier of the CLI binary backing an {@link Agent} (claude-code, codex, opencode, cursor, or gemini). */
export type AgentType = "claude-code" | "codex" | "opencode" | "cursor" | "gemini";

/** Work specialization of an {@link Agent}; the open `string` tail lets new domains be added without schema churn. */
export type AgentDomain = "frontend" | "backend" | "devops" | "testing" | string;

/** Lifecycle state of an {@link Agent} in the orchestrator (idle, working, or offline). */
export type AgentStatus = "idle" | "working" | "offline";

/** Canonical persisted record for an agent registered with the orchestrator; surfaces in {@link AgentStats} and {@link AllAgentStats}. */
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

/** Per-agent aggregate of task, cycle-time, throughput, quality, and artifact metrics for an {@link Agent}. */
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

/** Fleet-wide stats response: per-agent rollups (each tagged with an {@link AgentStatus}) plus a totals summary. */
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
