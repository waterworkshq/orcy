import { getDb } from "../db/index.js";
import {
  tasks,
  agents,
  taskEvents,
  taskDependencies,
  missions,
  sprints,
} from "../db/schema/index.js";
import { eq, and, sql, isNotNull, notInArray, inArray } from "drizzle-orm";
import { dateDayExpr } from "../db/dialect-helpers.js";
import { priorityOrderExpr } from "../db/sql-helpers.js";
import type { TaskPriority, TaskStatus } from "../models/index.js";

export type ForecastConfidence = "high" | "medium" | "low" | "insufficient_data";

export interface ForecastReason {
  code:
    | "small_sample"
    | "no_recent_velocity"
    | "blocked_dependencies"
    | "unstable_rejection_rate"
    | "missing_estimates"
    | "effort_overlap"
    | "overdue"
    | "stable_history";
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface ForecastEstimate {
  targetType: "task" | "mission" | "sprint";
  targetId: string;
  estimatedCompletionAt: string | null;
  earliestCompletionAt: string | null;
  latestCompletionAt: string | null;
  confidence: ForecastConfidence;
  confidenceScore: number;
  reasons: ForecastReason[];
  sampleSize: number;
  basis: "throughput" | "logged_effort" | "inferred_presence" | "hybrid";
}

export interface VelocityMetrics {
  days7: number;
  days14: number;
  days30: number;
  perAgent: Record<string, { days7: number; days14: number; days30: number; agentName: string }>;
}

export interface TaskEstimate {
  targetType: "task";
  targetId: string;
  taskId: string;
  missionId: string;
  taskTitle: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId: string | null;
  dueAt: string | null;
  estimatedCompletionAt: string | null;
  earliestCompletionAt: string | null;
  latestCompletionAt: string | null;
  confidence: ForecastConfidence;
  confidenceScore: number;
  confidenceReasons: string[];
  reasons: ForecastReason[];
  sampleSize: number;
  basis: ForecastEstimate["basis"];
  positionInQueue: number;
  daysUntilDue: number | null;
  daysUntilEstimated: number | null;
}

export interface AtRiskTask {
  taskId: string;
  taskTitle: string;
  reason: "overdue_prediction" | "no_activity" | "blocked_by_dependency" | "past_due";
  severity: "low" | "medium" | "high" | "critical";
  details: string;
  assignedAgentId: string | null;
  dueAt: string | null;
  lastActivityAt: string | null;
}

export interface PredictionResponse {
  velocity: VelocityMetrics;
  estimates: TaskEstimate[];
  forecasts: ForecastEstimate[];
  atRiskTasks: AtRiskTask[];
}

export interface BurndownDataPoint {
  date: string;
  completed: number;
  remaining: number;
  idealRemaining: number;
  totalTasks: number;
}

export interface BurndownResponse {
  data: BurndownDataPoint[];
  startDate: string;
  endDate: string;
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
  averageDailyVelocity: number;
  estimatedCompletionDate: string | null;
}

const PRIORITY_BOOST: Record<TaskPriority, number> = {
  critical: 0.7,
  high: 0.85,
  medium: 1.0,
  low: 1.2,
};

const NO_ACTIVITY_THRESHOLD_HOURS = 24;

const CONFIDENCE_SCORE: Record<ForecastConfidence, number> = {
  high: 0.9,
  medium: 0.65,
  low: 0.4,
  insufficient_data: 0.2,
};

function roundDays(value: number): number {
  return Math.round(value * 10) / 10;
}

function confidenceRank(confidence: ForecastConfidence): number {
  return { high: 4, medium: 3, low: 2, insufficient_data: 1 }[confidence];
}

function weakestConfidence(values: ForecastConfidence[]): ForecastConfidence {
  return values.reduce<ForecastConfidence>(
    (weakest, current) => (confidenceRank(current) < confidenceRank(weakest) ? current : weakest),
    "high",
  );
}

function dateRangeForOffset(
  now: number,
  daysOffset: number,
  confidence: ForecastConfidence,
): {
  earliestCompletionAt: string | null;
  latestCompletionAt: string | null;
} {
  if (confidence === "insufficient_data") {
    return { earliestCompletionAt: null, latestCompletionAt: null };
  }

  const msDay = 24 * 60 * 60 * 1000;
  const spread = confidence === "high" ? 0.2 : confidence === "medium" ? 0.5 : 1;
  const earliestOffset = Math.max(0, daysOffset * (1 - spread));
  const latestOffset = daysOffset * (1 + spread);
  return {
    earliestCompletionAt: new Date(now + earliestOffset * msDay).toISOString(),
    latestCompletionAt: new Date(now + latestOffset * msDay).toISOString(),
  };
}

function getConfidenceDetails(
  velocity: VelocityMetrics,
  unmetDeps: number,
): {
  confidence: ForecastConfidence;
  confidenceScore: number;
  confidenceReasons: string[];
  reasons: ForecastReason[];
} {
  const confidenceReasons: string[] = [];
  const reasons: ForecastReason[] = [];
  const recentSample = velocity.days14;
  const monthlySample = velocity.days30;

  if (monthlySample <= 2) {
    confidenceReasons.push(
      `Insufficient completion history: ${recentSample} tasks in 14 days and ${monthlySample} tasks in 30 days.`,
    );
    reasons.push({
      code: monthlySample === 0 ? "no_recent_velocity" : "small_sample",
      message:
        monthlySample === 0
          ? "No completed tasks in the last 30 days; forecast uses a conservative fallback throughput."
          : `Only ${monthlySample} completed task${monthlySample === 1 ? "" : "s"} in the last 30 days; forecast uses a conservative fallback throughput.`,
      severity: "warning",
    });
    if (unmetDeps > 0) {
      const message = `${unmetDeps} unmet dependenc${unmetDeps === 1 ? "y" : "ies"} ${unmetDeps === 1 ? "reduces" : "reduce"} confidence.`;
      confidenceReasons.push(message);
      reasons.push({ code: "blocked_dependencies", message, severity: "warning" });
    }
    return {
      confidence: "insufficient_data",
      confidenceScore: CONFIDENCE_SCORE.insufficient_data,
      confidenceReasons,
      reasons,
    };
  }

  if (recentSample >= 5 && unmetDeps === 0) {
    confidenceReasons.push(`${recentSample} tasks completed in the last 14 days.`);
    confidenceReasons.push("No unmet dependencies are blocking this task.");
    reasons.push({
      code: "stable_history",
      message: `${recentSample} tasks completed in the last 14 days with no unmet dependencies.`,
      severity: "info",
    });
    return {
      confidence: "high",
      confidenceScore: CONFIDENCE_SCORE.high,
      confidenceReasons,
      reasons,
    };
  }

  if (recentSample >= 2 || monthlySample >= 5) {
    if (recentSample >= 2) {
      confidenceReasons.push(`${recentSample} tasks completed in the last 14 days.`);
    } else {
      confidenceReasons.push(`${monthlySample} tasks completed in the last 30 days.`);
    }
    if (unmetDeps > 0) {
      const message = `${unmetDeps} unmet dependenc${unmetDeps === 1 ? "y" : "ies"} ${unmetDeps === 1 ? "reduces" : "reduce"} confidence.`;
      confidenceReasons.push(message);
      reasons.push({ code: "blocked_dependencies", message, severity: "warning" });
    } else {
      confidenceReasons.push("No unmet dependencies are blocking this task.");
      reasons.push({
        code: "stable_history",
        message: "Recent completion history is sufficient and there are no unmet dependencies.",
        severity: "info",
      });
    }
    return {
      confidence: "medium",
      confidenceScore: CONFIDENCE_SCORE.medium,
      confidenceReasons,
      reasons,
    };
  }

  confidenceReasons.push(
    `Limited completion history: ${recentSample} tasks in 14 days and ${monthlySample} tasks in 30 days.`,
  );
  reasons.push({
    code: "small_sample",
    message: `Only ${monthlySample} completed tasks in the last 30 days.`,
    severity: "warning",
  });
  if (unmetDeps > 0) {
    const message = `${unmetDeps} unmet dependenc${unmetDeps === 1 ? "y" : "ies"} ${unmetDeps === 1 ? "reduces" : "reduce"} confidence.`;
    confidenceReasons.push(message);
    reasons.push({ code: "blocked_dependencies", message, severity: "warning" });
  }
  return { confidence: "low", confidenceScore: CONFIDENCE_SCORE.low, confidenceReasons, reasons };
}

export function calculateVelocity(
  habitatId: string,
  options?: { sprintId?: string },
): VelocityMetrics {
  const db = getDb();
  const now = Date.now();
  const msDay = 24 * 60 * 60 * 1000;
  const since = (days: number) => new Date(now - days * msDay).toISOString();

  function countCompleted(sinceDate: string, agentId?: string): number {
    const conditions = [
      eq(missions.habitatId, habitatId),
      inArray(tasks.status, ["approved", "done"]),
      sql`${tasks.completedAt} >= ${sinceDate}`,
    ];
    if (agentId) conditions.push(eq(tasks.assignedAgentId, agentId));
    if (options?.sprintId) conditions.push(eq(missions.sprintId, options.sprintId));
    const row = db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(and(...conditions))
      .get();
    return row?.count ?? 0;
  }

  const days7 = countCompleted(since(7));
  const days14 = countCompleted(since(14));
  const days30 = countCompleted(since(30));

  const agentRows = db
    .selectDistinct({ id: agents.id, name: agents.name })
    .from(agents)
    .innerJoin(tasks, eq(tasks.assignedAgentId, agents.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(missions.habitatId, habitatId))
    .all();

  const perAgent: VelocityMetrics["perAgent"] = {};
  for (const row of agentRows) {
    perAgent[row.id] = {
      days7: countCompleted(since(7), row.id),
      days14: countCompleted(since(14), row.id),
      days30: countCompleted(since(30), row.id),
      agentName: row.name,
    };
  }

  return { days7, days14, days30, perAgent };
}

export function estimateCompletionDates(
  habitatId: string,
  velocity: VelocityMetrics,
): TaskEstimate[] {
  const db = getDb();
  const now = Date.now();
  const msDay = 24 * 60 * 60 * 1000;

  const dailyVelocity =
    velocity.days14 > 0 ? velocity.days14 / 14 : velocity.days30 > 0 ? velocity.days30 / 30 : 0.5;

  const rows = db
    .select({
      id: tasks.id,
      missionId: tasks.missionId,
      title: tasks.title,
      status: tasks.status,
      priority: tasks.priority,
      assignedAgentId: tasks.assignedAgentId,
      dueAt: missions.dueAt,
      lastActivity: sql<
        string | null
      >`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        notInArray(tasks.status, ["approved", "done", "failed"]),
      ),
    )
    .orderBy(priorityOrderExpr(tasks.priority), tasks.createdAt)
    .all();

  const estimates: TaskEstimate[] = [];
  let queuePosition = 0;

  for (const row of rows) {
    const taskId = row.id;
    const status = row.status as TaskStatus;
    const priority = row.priority as TaskPriority;

    const depRow = db
      .select({ count: sql<number>`count(*)` })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
      .where(
        and(eq(taskDependencies.taskId, taskId), notInArray(tasks.status, ["approved", "done"])),
      )
      .get();
    const unmetDeps = depRow?.count ?? 0;

    let positionInQueue = queuePosition;
    if (status === "in_progress" || status === "claimed") {
      positionInQueue = 0;
    } else {
      queuePosition++;
    }

    let agentVelocity = dailyVelocity;
    if (row.assignedAgentId && velocity.perAgent[row.assignedAgentId]) {
      const av = velocity.perAgent[row.assignedAgentId];
      agentVelocity =
        av.days14 > 0 ? av.days14 / 14 : av.days30 > 0 ? av.days30 / 30 : dailyVelocity;
    }

    const effectiveVelocity =
      agentVelocity > 0 ? agentVelocity * (PRIORITY_BOOST[priority] ?? 1.0) : 0.5;

    let daysOffset: number;
    if (unmetDeps > 0) {
      daysOffset = (positionInQueue + unmetDeps) / Math.max(effectiveVelocity, 0.1);
    } else if (status === "in_progress") {
      daysOffset = 1 / Math.max(effectiveVelocity, 0.1);
    } else if (status === "claimed") {
      daysOffset = 2 / Math.max(effectiveVelocity, 0.1);
    } else {
      daysOffset = (positionInQueue + 1) / Math.max(effectiveVelocity, 0.1);
    }

    const { confidence, confidenceScore, confidenceReasons, reasons } = getConfidenceDetails(
      velocity,
      unmetDeps,
    );

    const estimatedCompletionAt = new Date(now + daysOffset * msDay).toISOString();
    const { earliestCompletionAt, latestCompletionAt } = dateRangeForOffset(
      now,
      daysOffset,
      confidence,
    );
    const daysUntilDue = row.dueAt ? (new Date(row.dueAt).getTime() - now) / msDay : null;
    const daysUntilEstimated = daysOffset;

    estimates.push({
      targetType: "task",
      targetId: taskId,
      taskId,
      missionId: row.missionId,
      taskTitle: row.title,
      status,
      priority,
      assignedAgentId: row.assignedAgentId,
      dueAt: row.dueAt,
      estimatedCompletionAt,
      earliestCompletionAt,
      latestCompletionAt,
      confidence,
      confidenceScore,
      confidenceReasons,
      reasons,
      sampleSize: velocity.days30,
      basis: "throughput",
      positionInQueue,
      daysUntilDue: daysUntilDue !== null ? roundDays(daysUntilDue) : null,
      daysUntilEstimated: roundDays(daysUntilEstimated),
    });
  }

  return estimates;
}

export function detectAtRiskTasks(habitatId: string, estimates: TaskEstimate[]): AtRiskTask[] {
  const db = getDb();
  const now = Date.now();
  const msHour = 60 * 60 * 1000;
  const atRisk: AtRiskTask[] = [];

  for (const est of estimates) {
    if (est.dueAt && est.estimatedCompletionAt) {
      const dueDate = new Date(est.dueAt).getTime();
      const estDate = new Date(est.estimatedCompletionAt).getTime();
      if (estDate > dueDate) {
        const daysOver = (estDate - dueDate) / (24 * msHour);
        const severity: AtRiskTask["severity"] =
          daysOver > 3 ? "critical" : daysOver > 1 ? "high" : "medium";
        atRisk.push({
          taskId: est.taskId,
          taskTitle: est.taskTitle,
          reason: "overdue_prediction",
          severity,
          details: `Estimated completion ${Math.round(daysOver)}d past due date`,
          assignedAgentId: est.assignedAgentId,
          dueAt: est.dueAt,
          lastActivityAt: null,
        });
      }
    }

    if (est.daysUntilDue !== null && est.daysUntilDue < 0) {
      atRisk.push({
        taskId: est.taskId,
        taskTitle: est.taskTitle,
        reason: "past_due",
        severity: "critical",
        details: `Task is ${Math.abs(Math.round(est.daysUntilDue))}d past due`,
        assignedAgentId: est.assignedAgentId,
        dueAt: est.dueAt,
        lastActivityAt: null,
      });
    }
  }

  const activityRows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      assignedAgentId: tasks.assignedAgentId,
      dueAt: missions.dueAt,
      updatedAt: tasks.updatedAt,
      lastActivity: sql<
        string | null
      >`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(eq(missions.habitatId, habitatId), inArray(tasks.status, ["claimed", "in_progress"])),
    )
    .all();

  for (const row of activityRows) {
    const lastActivity = row.lastActivity ?? row.updatedAt;
    const hoursSinceActivity = lastActivity
      ? (now - new Date(lastActivity).getTime()) / msHour
      : Infinity;

    if (hoursSinceActivity > NO_ACTIVITY_THRESHOLD_HOURS) {
      const severity: AtRiskTask["severity"] =
        hoursSinceActivity > 72 ? "critical" : hoursSinceActivity > 48 ? "high" : "medium";
      atRisk.push({
        taskId: row.id,
        taskTitle: row.title,
        reason: "no_activity",
        severity,
        details: `No activity for ${Math.round(hoursSinceActivity)}h (threshold: ${NO_ACTIVITY_THRESHOLD_HOURS}h)`,
        assignedAgentId: row.assignedAgentId,
        dueAt: row.dueAt,
        lastActivityAt: lastActivity,
      });
    }
  }

  const blockedRows = db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      assignedAgentId: tasks.assignedAgentId,
      dueAt: missions.dueAt,
      lastActivity: sql<
        string | null
      >`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        eq(missions.habitatId, habitatId),
        eq(tasks.status, "pending"),
        sql`EXISTS (
        SELECT 1 FROM task_dependencies td
        INNER JOIN tasks dep ON td.depends_on_id = dep.id
        WHERE td.task_id = ${tasks.id} AND dep.status NOT IN ('approved', 'done')
      )`,
      ),
    )
    .all();

  for (const row of blockedRows) {
    const depCountRow = db
      .select({ count: sql<number>`count(*)` })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
      .where(
        and(eq(taskDependencies.taskId, row.id), notInArray(tasks.status, ["approved", "done"])),
      )
      .get();
    const unmetCount = depCountRow?.count ?? 0;

    const severity: AtRiskTask["severity"] = unmetCount > 2 ? "high" : "medium";

    atRisk.push({
      taskId: row.id,
      taskTitle: row.title,
      reason: "blocked_by_dependency",
      severity,
      details: `Blocked by ${unmetCount} unmet dependenc${unmetCount === 1 ? "y" : "ies"}`,
      assignedAgentId: row.assignedAgentId,
      dueAt: row.dueAt,
      lastActivityAt: row.lastActivity,
    });
  }

  const seen = new Set<string>();
  return atRisk.filter((item) => {
    const key = `${item.taskId}:${item.reason}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function maxIsoDate(values: Array<string | null>): string | null {
  const timestamps = values
    .filter((value): value is string => value !== null)
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function mergeReasons(estimates: TaskEstimate[]): ForecastReason[] {
  const byCode = new Map<string, ForecastReason>();
  for (const estimate of estimates) {
    for (const reason of estimate.reasons) {
      if (!byCode.has(reason.code)) byCode.set(reason.code, reason);
    }
  }
  return Array.from(byCode.values());
}

function aggregateForecast(
  targetType: "mission" | "sprint",
  targetId: string,
  estimates: TaskEstimate[],
  sampleSize: number,
): ForecastEstimate | null {
  if (estimates.length === 0) return null;

  const confidence = weakestConfidence(estimates.map((estimate) => estimate.confidence));
  const reasons = mergeReasons(estimates);
  if (estimates.some((estimate) => estimate.estimatedCompletionAt === null)) {
    reasons.push({
      code: "missing_estimates",
      message: "One or more child tasks could not be estimated.",
      severity: "warning",
    });
  }

  return {
    targetType,
    targetId,
    estimatedCompletionAt: maxIsoDate(estimates.map((estimate) => estimate.estimatedCompletionAt)),
    earliestCompletionAt: maxIsoDate(estimates.map((estimate) => estimate.earliestCompletionAt)),
    latestCompletionAt: maxIsoDate(estimates.map((estimate) => estimate.latestCompletionAt)),
    confidence,
    confidenceScore: Math.min(...estimates.map((estimate) => estimate.confidenceScore)),
    reasons,
    sampleSize,
    basis: "throughput",
  };
}

export function buildForecasts(
  habitatId: string,
  velocity: VelocityMetrics,
  estimates: TaskEstimate[],
): ForecastEstimate[] {
  const db = getDb();
  const forecasts: ForecastEstimate[] = estimates.map((estimate) => ({
    targetType: "task",
    targetId: estimate.taskId,
    estimatedCompletionAt: estimate.estimatedCompletionAt,
    earliestCompletionAt: estimate.earliestCompletionAt,
    latestCompletionAt: estimate.latestCompletionAt,
    confidence: estimate.confidence,
    confidenceScore: estimate.confidenceScore,
    reasons: estimate.reasons,
    sampleSize: estimate.sampleSize,
    basis: estimate.basis,
  }));

  const estimatesByMission = new Map<string, TaskEstimate[]>();
  for (const estimate of estimates) {
    const existing = estimatesByMission.get(estimate.missionId) ?? [];
    existing.push(estimate);
    estimatesByMission.set(estimate.missionId, existing);
  }

  for (const [missionId, missionEstimates] of estimatesByMission) {
    const forecast = aggregateForecast("mission", missionId, missionEstimates, velocity.days30);
    if (forecast) forecasts.push(forecast);
  }

  const missionRows = db
    .select({ id: missions.id, sprintId: missions.sprintId })
    .from(missions)
    .where(and(eq(missions.habitatId, habitatId), isNotNull(missions.sprintId)))
    .all();

  const estimatesBySprint = new Map<string, TaskEstimate[]>();
  for (const mission of missionRows) {
    if (!mission.sprintId) continue;
    const missionEstimates = estimatesByMission.get(mission.id) ?? [];
    if (missionEstimates.length === 0) continue;
    const existing = estimatesBySprint.get(mission.sprintId) ?? [];
    existing.push(...missionEstimates);
    estimatesBySprint.set(mission.sprintId, existing);
  }

  for (const [sprintId, sprintEstimates] of estimatesBySprint) {
    const forecast = aggregateForecast("sprint", sprintId, sprintEstimates, velocity.days30);
    if (forecast) forecasts.push(forecast);
  }

  return forecasts;
}

export function getPredictions(habitatId: string): PredictionResponse {
  const velocity = calculateVelocity(habitatId);
  const estimates = estimateCompletionDates(habitatId, velocity);
  const forecasts = buildForecasts(habitatId, velocity, estimates);
  const atRiskTasks = detectAtRiskTasks(habitatId, estimates);
  return { velocity, estimates, forecasts, atRiskTasks };
}

export function getBurndown(
  habitatId: string,
  days: number,
  options?: { sprintId?: string },
): BurndownResponse {
  const db = getDb();
  const now = new Date();
  const msDay = 24 * 60 * 60 * 1000;

  const sprintFilter = options?.sprintId ? eq(missions.sprintId, options.sprintId) : undefined;

  let startDate: Date;
  let effectiveDays: number;
  let sprintRow: { startDate: string; endDate: string } | undefined;

  if (options?.sprintId) {
    sprintRow = db
      .select({ startDate: sprints.startDate, endDate: sprints.endDate })
      .from(sprints)
      .where(eq(sprints.id, options.sprintId))
      .get();
    if (sprintRow) {
      startDate = new Date(sprintRow.startDate);
      const sprintEnd = new Date(sprintRow.endDate);
      effectiveDays = Math.max(1, Math.ceil((sprintEnd.getTime() - startDate.getTime()) / msDay));
    } else {
      startDate = new Date(now.getTime() - days * msDay);
      effectiveDays = days;
    }
  } else {
    startDate = new Date(now.getTime() - days * msDay);
    effectiveDays = days;
  }

  const endDate = options?.sprintId && sprintRow ? new Date(sprintRow.endDate) : now;

  const baseConditions = [eq(missions.habitatId, habitatId)];
  if (sprintFilter) baseConditions.push(sprintFilter);

  const totalRow = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...baseConditions))
    .get();
  const totalTasks = totalRow?.count ?? 0;

  const completedRow = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...baseConditions, inArray(tasks.status, ["approved", "done"])))
    .get();
  const completedTasks = completedRow?.count ?? 0;

  const remainingTasks = totalTasks - completedTasks;

  const dayExpr = dateDayExpr(tasks.completedAt);
  const dailyCompletedRows = db
    .select({
      date: dayExpr,
      count: sql<number>`count(*)`,
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        ...baseConditions,
        inArray(tasks.status, ["approved", "done"]),
        isNotNull(tasks.completedAt),
        sql`${tasks.completedAt} >= ${startDate.toISOString()}`,
      ),
    )
    .groupBy(dayExpr)
    .orderBy(dayExpr)
    .all();

  const completedByDate: Record<string, number> = {};
  for (const row of dailyCompletedRows) {
    completedByDate[row.date as string] = row.count;
  }

  const cumulativeRow = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        ...baseConditions,
        inArray(tasks.status, ["approved", "done"]),
        isNotNull(tasks.completedAt),
        sql`${tasks.completedAt} < ${startDate.toISOString()}`,
      ),
    )
    .get();
  let cumulativeCompleted = cumulativeRow?.count ?? 0;

  const data: BurndownDataPoint[] = [];
  const idealPerDay = totalTasks > 0 ? totalTasks / effectiveDays : 0;

  for (let i = 0; i <= effectiveDays; i++) {
    const currentDate = new Date(startDate.getTime() + i * msDay);
    const dateStr = currentDate.toISOString().split("T")[0];

    const dailyCompleted = completedByDate[dateStr] ?? 0;
    cumulativeCompleted += dailyCompleted;

    const currentRemaining = totalTasks - cumulativeCompleted;
    const idealRemaining = Math.max(totalTasks - idealPerDay * i, 0);

    data.push({
      date: dateStr,
      completed: cumulativeCompleted,
      remaining: currentRemaining,
      idealRemaining: Math.round(idealRemaining * 10) / 10,
      totalTasks,
    });
  }

  const averageDailyVelocity = effectiveDays > 0 ? completedTasks / effectiveDays : 0;

  let estimatedCompletionDate: string | null = null;
  if (averageDailyVelocity > 0 && remainingTasks > 0) {
    const daysToComplete = remainingTasks / averageDailyVelocity;
    estimatedCompletionDate = new Date(now.getTime() + daysToComplete * msDay).toISOString();
  } else if (remainingTasks === 0) {
    estimatedCompletionDate = now.toISOString();
  }

  return {
    data,
    startDate: startDate.toISOString(),
    endDate: endDate.toISOString(),
    totalTasks,
    completedTasks,
    remainingTasks,
    averageDailyVelocity: Math.round(averageDailyVelocity * 100) / 100,
    estimatedCompletionDate,
  };
}
