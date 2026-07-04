import { z } from "zod";

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

/** Configuration for the automation execution engine, controlling whether matched rules actually fire their actions. */
export interface AutomationSettings {
  executeActions: boolean;
}

/** Per-habitat triage scan thresholds. Stored as a JSON column on `habitats.triage_settings`. Controls the cluster-detection and agent-quality scans. */
export interface TriageSettings {
  minClusterSize: number;
  clusterWindowDays: number;
  agentQualityThreshold: number;
  agentQualityMinSample: number;
}

/** Default triage thresholds used when a habitat has no `triageSettings` configured. Single source of truth for both scan services and UI defaults. */
export const DEFAULT_TRIAGE_SETTINGS: TriageSettings = {
  minClusterSize: 3,
  clusterWindowDays: 7,
  agentQualityThreshold: 40,
  agentQualityMinSample: 5,
};

/** Per-habitat release activation settings (ADR-0031 kill switch). Stored as a JSON column on `habitats.release_settings`. */
export interface ReleaseSettings {
  /** Master switch for the auto-promotion loop. Detection/recording/retrospective/event still occur when false. Default ON. */
  autoPromote: boolean;
  /** Release-workflow name substring for workflow_run detection. Default "release". */
  releaseWorkflowName: string;
  /** Whether the v* tag requirement is enforced for workflow_run detection. Default true. */
  requireVersionTag: boolean;
}

/** Default release settings used when a habitat has no `releaseSettings` configured. */
export const DEFAULT_RELEASE_SETTINGS: ReleaseSettings = {
  autoPromote: true,
  releaseWorkflowName: "release",
  requireVersionTag: true,
};

/** Zod schema for validating `releaseSettings` patches (all fields optional). */
export const releaseSettingsSchema = z.object({
  autoPromote: z.boolean().optional(),
  releaseWorkflowName: z.string().optional(),
  requireVersionTag: z.boolean().optional(),
});

/**
 * Selectable roadmap scoring algorithms (v0.25.4). `fanout` is the v0.25.0 default.
 * A goal/direction-aware algorithm (critical-path toward an orcy-chosen or self-derived
 * target) is deferred to its own patch — see `docs/plans/v25/PATCHES.md`.
 */
export type RoadmapScoringAlgorithm = "fanout" | "depth_from_root" | "release_proximity";

/** Per-habitat roadmap scoring configuration. Stored as JSON on `habitats.roadmap_settings`. */
export interface RoadmapSettings {
  /** Active scoring algorithm for the roadmap-position bonus. Default `fanout`. */
  scoringAlgorithm: RoadmapScoringAlgorithm;
  /** Authoring mode: `release` (default) shows release-gate/deadline selectors in mission forms; `feature` hides them for teams not shipping on a release cadence. Display of existing gates is unaffected. */
  mode: "release" | "feature";
}

/** Default roadmap settings used when a habitat has no `roadmapSettings` configured. */
export const DEFAULT_ROADMAP_SETTINGS: RoadmapSettings = {
  scoringAlgorithm: "fanout",
  mode: "release",
};

/** Zod schema for validating `roadmapSettings` patches (all fields optional). */
export const roadmapSettingsSchema = z.object({
  scoringAlgorithm: z.enum(["fanout", "depth_from_root", "release_proximity"]).optional(),
  mode: z.enum(["release", "feature"]).optional(),
});

/**
 * Per-habitat wiki cadence configuration. Stored as a JSON column on `habitats.wiki_settings`
 * (mirrors the v0.18.1 `automation_settings` precedent). When `enabled` is `true`, the
 * {@link wikiSchedulerService} registers a `scheduled_tasks` row that runs `runCadence` on the
 * configured interval. When `false`, the schedule is deregistered. `intervalMinutes` is used for
 * `scheduleType: "interval"`; `cronExpression` is used for `scheduleType: "cron"`.
 */
export interface WikiSettings {
  enabled: boolean;
  scheduleType?: "interval" | "cron";
  intervalMinutes?: number;
  cronExpression?: string;
  timezone: string;
  scheduledTaskId?: string;
  updatedAt: string;
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
