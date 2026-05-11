export interface AnomalySettings {
  enabled: boolean;
  scanIntervalMinutes: number;
  thresholds: {
    staleInProgressMinutes: number;
    rejectionRatePercent: number;
    rejectionWindowTasks: number;
    cycleTimeIncreasePercent: number;
    backlogToAgentRatio: number;
    agentOfflineMinutes: number;
  };
  notifications: {
    email: boolean;
    sse: boolean;
    chat: boolean;
  };
}

export interface Anomaly {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  data: Record<string, unknown>;
}

export type AutoAssignStrategy = 'round_robin' | 'least_loaded' | 'best_match';

export interface AutoAssignSettings {
  enabled: boolean;
  strategy: AutoAssignStrategy;
  maxTasksPerAgent: number;
  requireDomainMatch: boolean;
  requireCapabilityMatch: boolean;
  excludeOfflineAgents: boolean;
}

export interface GitWorktreeSettings {
  repoPath: string;
  branchPrefix: string;
  autoCleanup: boolean;
}

export interface CodeReviewSettings {
  autoApproveOnMerge: boolean;
  githubSecret: string | null;
  gitlabSecret: string | null;
  taskPattern: string;
}

export interface CiCdSettings {
  githubSecret: string | null;
  gitlabSecret: string | null;
  taskPattern: string;
}
