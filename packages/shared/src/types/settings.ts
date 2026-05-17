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

export interface PrioritizationSettings {
  enabled: boolean;
  evaluateIntervalMinutes: number;
  rules: PrioritizationRule[];
  fallbackToManual: boolean;
}

export interface PrioritizationRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: PrioritizationRuleCondition;
  action: PrioritizationRuleAction;
  priority: number;
}

export type PrioritizationRuleCondition =
  | { type: 'overdue'; byDays?: number }
  | { type: 'sla_approaching'; withinHours: number }
  | { type: 'due_soon'; withinDays: number }
  | { type: 'pending_duration'; greaterThanHours: number }
  | { type: 'dependency_count'; greaterThan: number; direction: 'blocking' | 'blocked_by' }
  | { type: 'rejection_count'; greaterThan: number }
  | { type: 'mission_status'; status: string }
  | { type: 'agent_idle'; greaterThanMinutes: number }
  | { type: 'label_match'; labels: string[] }
  | { type: 'priority_is'; priority: string }
  | { type: 'and'; conditions: PrioritizationRuleCondition[] }
  | { type: 'or'; conditions: PrioritizationRuleCondition[] };

export type PrioritizationRuleAction =
  | { type: 'set_priority'; value: string }
  | { type: 'bump_priority'; value: number }
  | { type: 'add_label'; value: string }
  | { type: 'set_score_bonus'; value: number };
