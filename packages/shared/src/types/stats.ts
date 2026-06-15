/** A single heartbeat sample capturing minutes an agent spent on a task. */
export interface TaskTimeRecord {
  id: string;
  taskId: string;
  agentId: string | null;
  minutesSpent: number;
  recordedAt: string;
  statusDuringWork: string;
}

/** Aggregated time-vs-estimate breakdown for a single task, including heartbeat history. */
export interface TaskTimeReport {
  taskId: string;
  estimatedMinutes: number | null;
  actualMinutes: number | null;
  cycleTimeMinutes: number | null;
  leadTimeMinutes: number | null;
  estimationAccuracy: number | null;
  heartbeatHistory: TaskTimeRecord[];
}

/** Payload backing the analytics dashboard, combining throughput, cycle-time, leaderboard, WIP health, and summary. */
export interface DashboardStats {
  throughput: Array<{ date: string; count: number }>;
  cycleTime: Array<{ date: string; avgMinutes: number; medianMinutes: number }>;
  rejectionRate: Array<{ date: string; rejections: number; total: number }>;
  agentLeaderboard: Array<{
    agentId: string;
    agentName: string;
    completed: number;
    failed: number;
    avgCycleMinutes: number;
    approvalRate: number;
  }>;
  taskByPriority: { critical: number; high: number; medium: number; low: number };
  taskByStatus: {
    pending: number;
    claimed: number;
    in_progress: number;
    submitted: number;
    done: number;
  };
  wipHealth: Array<{
    columnId: string;
    columnName: string;
    habitatId: string;
    habitatName: string;
    current: number;
    limit: number | null;
    health: "ok" | "warning" | "exceeded";
  }>;
  webhookStats: {
    total: number;
    success: number;
    failed: number;
    pending: number;
    successRate: number;
  };
  summary: {
    totalTasksCompleted: number;
    totalTasksInProgress: number;
    averageCycleTimeMinutes: number;
    overallRejectionRate: number;
    activeAgents: number;
  };
}

/** Habitat-level performance rollup aggregating cycle/lead times, estimation accuracy, and per-agent metrics. */
export interface HabitatMetrics {
  averageCycleTime: number;
  averageLeadTime: number;
  averageEstimationAccuracy: number;
  totalPlannedMinutes: number;
  totalActualMinutes: number;
  overdueTasks: number;
  onTimeCompletionRate: number;
  agentMetrics: {
    agentId: string;
    agentName: string;
    tasksCompleted: number;
    averageCycleTime: number;
    averageEstimationAccuracy: number;
    totalTimeTracked: number;
  }[];
  totalLoggedEffortMinutes: number;
  totalInferredPresenceMinutes: number;
  totalAccountedMinutes: number;
}

/** Set of origins for an effort entry: manually logged, agent-reported, or a correction adjustment. */
export type EffortSource = "human_manual" | "agent_reported" | "correction_adjustment";

/** Set of actor kinds that can log effort: local or remote humans and orcys. */
export type EffortActorType = "human" | "agent" | "remote_human" | "remote_orcy";

/** A single time-tracking record capturing minutes an actor spent on a task, with origin and optional correction linkage. */
export interface EffortEntry {
  id: string;
  taskId: string;
  actorType: EffortActorType;
  actorId: string | null;
  minutes: number;
  source: EffortSource;
  note: string | null;
  startedAt: string | null;
  endedAt: string | null;
  recordedAt: string;
  correctsEntryId: string | null;
  correctionReason: string | null;
  metadata: Record<string, unknown> | null;
}

/** An {@link EffortEntry} enriched with the resolved actor display name. */
export interface EffortEntryWithActor extends EffortEntry {
  actorName: string | null;
}

/** Request body for logging a new effort entry against a task. */
export interface LogEffortRequest {
  minutes: number;
  note?: string;
  startedAt?: string;
  endedAt?: string;
  source?: EffortSource;
}

/** Request body for correcting a prior effort entry by a signed minute delta. */
export interface CorrectEffortRequest {
  minutesDelta: number;
  correctionReason: string;
  note?: string;
}

/** Effort rollup splitting accounted minutes into logged effort, inferred presence, and corrections. */
export interface EffortTotals {
  loggedEffortMinutes: number;
  inferredPresenceMinutes: number;
  correctionAdjustmentMinutes: number;
  totalAccountedMinutes: number;
}

/** Full effort report for a task or mission, bundling {@link EffortTotals}, accuracy, and per-source breakdowns. */
export interface EffortReport {
  target: { type: "task" | "mission"; id: string };
  estimate: { plannedMinutes: number | null };
  totals: EffortTotals;
  elapsed: {
    cycleTimeMinutes: number | null;
    leadTimeMinutes: number | null;
  };
  accuracy: {
    estimationAccuracy: number | null;
    basis: "logged_effort" | "total_accounted" | "inferred_only" | "unavailable";
  };
  bySource: Record<string, number>;
  byActor: Array<{
    actorType: EffortActorType;
    actorId: string | null;
    actorName: string | null;
    loggedEffortMinutes: number;
    inferredPresenceMinutes: number;
    correctionAdjustmentMinutes: number;
  }>;
  entries: EffortEntryWithActor[];
  warnings: string[];
}

/** Effort report scoped to a mission, aggregating {@link EffortTotals} across child tasks. */
export interface MissionEffortReport {
  target: { type: "mission"; id: string };
  estimate: { plannedMinutes: number | null };
  totals: EffortTotals;
  tasks: Array<{
    taskId: string;
    taskTitle: string | null;
    totals: EffortTotals;
  }>;
  byActor: Array<{
    actorType: EffortActorType;
    actorId: string | null;
    actorName: string | null;
    loggedEffortMinutes: number;
    inferredPresenceMinutes: number;
    correctionAdjustmentMinutes: number;
  }>;
  warnings: string[];
}
