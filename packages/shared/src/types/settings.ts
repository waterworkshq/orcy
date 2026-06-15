/** Configuration for the anomaly detection subsystem that emits {@link Anomaly} records. */
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

/** A single anomaly condition detected by the subsystem configured in {@link AnomalySettings}. */
export interface Anomaly {
  type: string;
  severity: "low" | "medium" | "high" | "critical";
  message: string;
  data: Record<string, unknown>;
}

/** Strategy used to pick an agent when a task becomes eligible under {@link AutoAssignSettings}. */
export type AutoAssignStrategy = "round_robin" | "least_loaded" | "best_match";

/** Configuration for the automatic task-to-agent assignment engine. */
export interface AutoAssignSettings {
  enabled: boolean;
  strategy: AutoAssignStrategy;
  maxTasksPerAgent: number;
  requireDomainMatch: boolean;
  requireCapabilityMatch: boolean;
  excludeOfflineAgents: boolean;
}

/** Configuration for the git worktree provisioned when an agent claims a task. */
export interface GitWorktreeSettings {
  repoPath: string;
  branchPrefix: string;
  autoCleanup: boolean;
}

/** Configuration for the external code-review webhook integration. */
export interface CodeReviewSettings {
  autoApproveOnMerge: boolean;
  githubSecret: string | null;
  gitlabSecret: string | null;
  taskPattern: string;
}

/** Configuration for the CI/CD webhook integration. */
export interface CiCdSettings {
  githubSecret: string | null;
  gitlabSecret: string | null;
  taskPattern: string;
}

/** Configuration for the automated task prioritization engine that evaluates {@link PrioritizationRule} entries. */
export interface PrioritizationSettings {
  enabled: boolean;
  evaluateIntervalMinutes: number;
  rules: PrioritizationRule[];
  fallbackToManual: boolean;
}

/** A single rule evaluated by the prioritization engine, pairing a {@link PrioritizationRuleCondition} with a {@link PrioritizationRuleAction}. */
export interface PrioritizationRule {
  id: string;
  name: string;
  enabled: boolean;
  condition: PrioritizationRuleCondition;
  action: PrioritizationRuleAction;
  priority: number;
}

/** Discriminated predicate matched against a task by a {@link PrioritizationRule}. */
export type PrioritizationRuleCondition =
  | { type: "overdue"; byDays?: number }
  | { type: "sla_approaching"; withinHours: number }
  | { type: "due_soon"; withinDays: number }
  | { type: "pending_duration"; greaterThanHours: number }
  | { type: "dependency_count"; greaterThan: number; direction: "blocking" | "blocked_by" }
  | { type: "rejection_count"; greaterThan: number }
  | { type: "mission_status"; status: string }
  | { type: "agent_idle"; greaterThanMinutes: number }
  | { type: "label_match"; labels: string[] }
  | { type: "priority_is"; priority: string }
  | { type: "and"; conditions: PrioritizationRuleCondition[] }
  | { type: "or"; conditions: PrioritizationRuleCondition[] };

/** Discriminated effect applied to a task when its {@link PrioritizationRule}'s condition matches. */
export type PrioritizationRuleAction =
  | { type: "set_priority"; value: string }
  | { type: "bump_priority"; value: number }
  | { type: "add_label"; value: string }
  | { type: "set_score_bonus"; value: number };
