import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import { habitats, missions, taskDependencies, taskEvents, tasks } from "../db/schema/index.js";
import * as effortRepo from "../repositories/effortEntry.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as predictionService from "./predictionService.js";
import type { ForecastEstimate } from "./predictionService.js";

export interface AnalyticsWarning {
  code: string;
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface SprintMetricsV2 {
  sprintId: string;
  totalMissions: number;
  completedMissions: number;
  completionPercentage: number;
  totalTasks: number;
  completedTasks: number;
  velocity: number;
  remainingDays: number;
  isOnTrack: boolean;
  plannedMinutes: number | null;
  loggedEffortMinutes: number;
  inferredPresenceMinutes: number;
  carryOverCount: number;
  forecast: ForecastEstimate | null;
  warnings: AnalyticsWarning[];
}

export interface SprintCarryOverReason {
  code:
    | "incomplete_tasks"
    | "blocked_dependencies"
    | "missing_estimates"
    | "overdue"
    | "no_recent_activity"
    | "high_rejection_rate"
    | "effort_overrun";
  message: string;
  severity: "info" | "warning" | "critical";
}

export interface SprintCarryOverMission {
  missionId: string;
  title: string;
  status: string;
  reasons: SprintCarryOverReason[];
}

export interface SprintCarryOverReport {
  sprintId: string;
  generatedAt: string;
  policy: "backlog" | "next_sprint" | "none";
  carriedOverMissions: SprintCarryOverMission[];
  warnings: AnalyticsWarning[];
}

const COMPLETE_TASK_STATUSES = ["approved", "done"] as const;
const COMPLETE_MISSION_STATUSES = ["done"] as const;
const NO_RECENT_ACTIVITY_DAYS = 7;

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function diffDays(startDate: string, endDate: string): number {
  const start = new Date(startDate).getTime();
  const end = new Date(endDate).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 1;
  return Math.max(1, Math.ceil((end - start) / (24 * 60 * 60 * 1000)));
}

function daysUntil(date: string): number {
  const timestamp = new Date(date).getTime();
  if (!Number.isFinite(timestamp)) return 0;
  return Math.max(0, Math.ceil((timestamp - Date.now()) / (24 * 60 * 60 * 1000)));
}

function getSprintMissionIds(sprintId: string, committedMissionIds: string[]): string[] {
  const db = getDb();
  const currentRows = db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.sprintId, sprintId))
    .all();
  return unique([...committedMissionIds, ...currentRows.map((row) => row.id)]);
}

function countCompleted(
  rows: Array<{ status: string }>,
  completeStatuses: readonly string[],
): number {
  return rows.filter((row) => completeStatuses.includes(row.status)).length;
}

export function getSprintMetrics(sprintId: string): SprintMetricsV2 | null {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) return null;

  const db = getDb();
  const missionIds = getSprintMissionIds(sprint.id, sprint.committedMissionIds);
  const missionRows = missionIds.length
    ? db.select().from(missions).where(inArray(missions.id, missionIds)).all()
    : [];
  const taskRows = missionIds.length
    ? db.select().from(tasks).where(inArray(tasks.missionId, missionIds)).all()
    : [];

  const totalMissions = missionRows.length;
  const completedMissions = countCompleted(missionRows, COMPLETE_MISSION_STATUSES);
  const totalTasks = taskRows.length;
  const completedTasks = countCompleted(taskRows, COMPLETE_TASK_STATUSES);
  const completionPercentage =
    totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 1000) / 10 : 0;

  let loggedEffortMinutes = 0;
  let inferredPresenceMinutes = 0;
  const effortTotals = effortRepo.getEffortTotalsForTasks(taskRows.map((t) => t.id));
  for (const [, totals] of effortTotals) {
    loggedEffortMinutes += totals.loggedEffortMinutes + totals.correctionAdjustmentMinutes;
    inferredPresenceMinutes += totals.inferredPresenceMinutes;
  }

  const plannedFromTasks = taskRows.reduce(
    (total, task) => total + (task.estimatedMinutes ?? 0),
    0,
  );
  const plannedFromMissions = missionRows.reduce(
    (total, mission) => total + (mission.plannedMinutes ?? 0),
    0,
  );
  const plannedMinutes = plannedFromTasks > 0 ? plannedFromTasks : plannedFromMissions || null;

  const predictions = predictionService.getPredictions(sprint.habitatId);
  const forecast =
    predictions.forecasts.find(
      (candidate) => candidate.targetType === "sprint" && candidate.targetId === sprint.id,
    ) ?? null;
  const velocity = predictions.velocity.days30;

  const warnings: AnalyticsWarning[] = [];
  let isOnTrack = false;
  if (!forecast) {
    warnings.push({
      code: "missing_forecast",
      message:
        "No sprint forecast is available because there are no forecastable tasks in the sprint.",
      severity: "warning",
    });
  } else if (forecast.confidence === "insufficient_data") {
    warnings.push({
      code: "insufficient_forecast_data",
      message:
        "Sprint forecast has insufficient sample history, so on-track status is conservative.",
      severity: "warning",
    });
  } else if (forecast.estimatedCompletionAt) {
    isOnTrack =
      new Date(forecast.estimatedCompletionAt).getTime() <= new Date(sprint.endDate).getTime();
  }

  const carryOverCount = missionRows.filter(
    (mission) => !COMPLETE_MISSION_STATUSES.includes(mission.status as "done"),
  ).length;

  return {
    sprintId: sprint.id,
    totalMissions,
    completedMissions,
    completionPercentage,
    totalTasks,
    completedTasks,
    velocity,
    remainingDays: daysUntil(sprint.endDate),
    isOnTrack,
    plannedMinutes,
    loggedEffortMinutes,
    inferredPresenceMinutes,
    carryOverCount,
    forecast,
    warnings,
  };
}

export function getSprintBurndown(sprintId: string): predictionService.BurndownResponse | null {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) return null;
  return predictionService.getBurndown(
    sprint.habitatId,
    diffDays(sprint.startDate, sprint.endDate),
    {
      sprintId: sprint.id,
    },
  );
}

function buildCarryOverReasons(
  missionId: string,
  now: Date,
  effortTotals: Map<
    string,
    {
      loggedEffortMinutes: number;
      inferredPresenceMinutes: number;
      correctionAdjustmentMinutes: number;
    }
  >,
): SprintCarryOverReason[] {
  const db = getDb();
  const taskRows = db.select().from(tasks).where(eq(tasks.missionId, missionId)).all();
  const reasons: SprintCarryOverReason[] = [];
  const incompleteTasks = taskRows.filter(
    (task) => !COMPLETE_TASK_STATUSES.includes(task.status as "approved" | "done"),
  );

  if (incompleteTasks.length > 0) {
    reasons.push({
      code: "incomplete_tasks",
      message: `${incompleteTasks.length} task${incompleteTasks.length === 1 ? " is" : "s are"} incomplete.`,
      severity: "warning",
    });
  }

  let blockedCount = 0;
  if (taskRows.length > 0) {
    const blockedRow = db
      .select({ count: sql<number>`count(*)` })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
      .where(
        and(
          inArray(
            taskDependencies.taskId,
            taskRows.map((task) => task.id),
          ),
          notInArray(tasks.status, [...COMPLETE_TASK_STATUSES]),
        ),
      )
      .get();
    blockedCount = blockedRow?.count ?? 0;
  }
  if (blockedCount > 0) {
    reasons.push({
      code: "blocked_dependencies",
      message: `${blockedCount} unfinished dependenc${blockedCount === 1 ? "y is" : "ies are"} blocking sprint work.`,
      severity: "critical",
    });
  }

  const missingEstimates = taskRows.filter((task) => !task.estimatedMinutes).length;
  if (missingEstimates > 0) {
    reasons.push({
      code: "missing_estimates",
      message: `${missingEstimates} task${missingEstimates === 1 ? " is" : "s are"} missing estimates.`,
      severity: "warning",
    });
  }

  const missionRow = db
    .select({ dueAt: missions.dueAt })
    .from(missions)
    .where(eq(missions.id, missionId))
    .get();
  if (missionRow?.dueAt && new Date(missionRow.dueAt).getTime() < now.getTime()) {
    reasons.push({
      code: "overdue",
      message: "Mission due date is in the past.",
      severity: "critical",
    });
  }

  const lastActivity = db
    .select({ last: sql<string | null>`MAX(${taskEvents.timestamp})` })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .where(eq(tasks.missionId, missionId))
    .get()?.last;
  const staleBefore = now.getTime() - NO_RECENT_ACTIVITY_DAYS * 24 * 60 * 60 * 1000;
  if (!lastActivity || new Date(lastActivity).getTime() < staleBefore) {
    reasons.push({
      code: "no_recent_activity",
      message: `No task activity in the last ${NO_RECENT_ACTIVITY_DAYS} days.`,
      severity: "warning",
    });
  }

  const rejectedTasks = taskRows.filter((task) => task.rejectedCount >= 2).length;
  if (rejectedTasks > 0) {
    reasons.push({
      code: "high_rejection_rate",
      message: `${rejectedTasks} task${rejectedTasks === 1 ? " has" : "s have"} repeated rejection history.`,
      severity: "warning",
    });
  }

  const overruns = taskRows.filter((task) => {
    if (!task.estimatedMinutes) return false;
    const totals = effortTotals.get(task.id);
    const actual =
      (totals?.loggedEffortMinutes ?? 0) + (totals?.correctionAdjustmentMinutes ?? 0) ||
      (totals?.inferredPresenceMinutes ?? 0);
    return actual > task.estimatedMinutes * 1.25;
  }).length;
  if (overruns > 0) {
    reasons.push({
      code: "effort_overrun",
      message: `${overruns} task${overruns === 1 ? " is" : "s are"} over estimated effort by more than 25%.`,
      severity: "warning",
    });
  }

  if (reasons.length === 0) {
    reasons.push({
      code: "incomplete_tasks",
      message:
        "Mission is not complete, but no more specific reason is supported by current evidence.",
      severity: "info",
    });
  }

  return reasons;
}

export function getSprintCarryOver(sprintId: string): SprintCarryOverReport | null {
  const sprint = sprintRepo.getById(sprintId);
  if (!sprint) return null;

  const db = getDb();
  const missionIds = getSprintMissionIds(sprint.id, sprint.committedMissionIds);
  const missionRows = missionIds.length
    ? db
        .select({ id: missions.id, title: missions.title, status: missions.status })
        .from(missions)
        .where(
          and(
            inArray(missions.id, missionIds),
            notInArray(missions.status, [...COMPLETE_MISSION_STATUSES]),
          ),
        )
        .all()
    : [];
  const habitat = db
    .select({ carryOverPolicy: habitats.carryOverPolicy })
    .from(habitats)
    .where(eq(habitats.id, sprint.habitatId))
    .get();
  const now = new Date();

  const allTaskIds =
    missionRows.length > 0
      ? db
          .select({ id: tasks.id, missionId: tasks.missionId })
          .from(tasks)
          .where(
            inArray(
              tasks.missionId,
              missionRows.map((m) => m.id),
            ),
          )
          .all()
      : [];
  const carryOverEffort = effortRepo.getEffortTotalsForTasks(allTaskIds.map((t) => t.id));

  const carriedOverMissions = missionRows.map((mission) => ({
    missionId: mission.id,
    title: mission.title,
    status: mission.status,
    reasons: buildCarryOverReasons(mission.id, now, carryOverEffort),
  }));
  const warnings: AnalyticsWarning[] = [];
  if (sprint.status !== "completed") {
    warnings.push({
      code: "active_or_planning_sprint",
      message:
        "Carry-over report shows current candidates because the sprint has not been completed.",
      severity: "info",
    });
  }
  if (carriedOverMissions.length === 0) {
    warnings.push({
      code: "no_carry_over_candidates",
      message: "No incomplete sprint missions are currently visible for carry-over analysis.",
      severity: "info",
    });
  }

  return {
    sprintId: sprint.id,
    generatedAt: now.toISOString(),
    policy: (habitat?.carryOverPolicy as SprintCarryOverReport["policy"] | undefined) ?? "backlog",
    carriedOverMissions,
    warnings,
  };
}
