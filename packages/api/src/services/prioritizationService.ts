import { getDb } from "../db/index.js";
import { tasks, agents, taskDependencies } from "../db/schema/index.js";
import { eq, inArray, count } from "drizzle-orm";
import * as habitatRepo from "../repositories/board.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import { scoreTask } from "./taskScoring.js";
import { logger } from "../lib/logger.js";
import type {
  PrioritizationSettings,
  PrioritizationRule,
  PrioritizationRuleCondition,
  PrioritizationRuleAction,
  Task,
  TaskPriority,
  Mission,
} from "../models/index.js";

const TERMINAL_STATUSES: Task["status"][] = ["done", "approved", "failed"];

const PRIORITY_LEVELS: TaskPriority[] = ["low", "medium", "high", "critical"];

const DEFAULT_RULES: PrioritizationRule[] = [
  {
    id: "default-overdue",
    name: "Overdue tasks → critical",
    enabled: true,
    condition: { type: "overdue" },
    action: { type: "set_priority", value: "critical" },
    priority: 1,
  },
  {
    id: "default-sla-approaching",
    name: "SLA approaching → high",
    enabled: true,
    condition: { type: "sla_approaching", withinHours: 4 },
    action: { type: "set_priority", value: "high" },
    priority: 2,
  },
  {
    id: "default-due-soon",
    name: "Due within 1 day → high",
    enabled: true,
    condition: { type: "due_soon", withinDays: 1 },
    action: { type: "set_priority", value: "high" },
    priority: 3,
  },
  {
    id: "default-pending-age",
    name: "Pending >72h → bump priority",
    enabled: true,
    condition: { type: "pending_duration", greaterThanHours: 72 },
    action: { type: "bump_priority", value: 1 },
    priority: 4,
  },
  {
    id: "default-blocking-many",
    name: "Blocking 3+ tasks → score bonus",
    enabled: true,
    condition: { type: "dependency_count", greaterThan: 3, direction: "blocking" },
    action: { type: "set_score_bonus", value: 15 },
    priority: 5,
  },
];

const DEFAULT_SETTINGS: PrioritizationSettings = {
  enabled: true,
  evaluateIntervalMinutes: 5,
  rules: DEFAULT_RULES,
  fallbackToManual: true,
};

/** Returns a deep-cloned copy of the default {@link PrioritizationSettings} with independent rule objects, safe to mutate as a fallback when a habitat has no stored configuration. */
export function getDefaultPrioritizationSettings(): PrioritizationSettings {
  return {
    ...DEFAULT_SETTINGS,
    rules: DEFAULT_SETTINGS.rules.map((r) => ({ ...r })),
  };
}

/** Returns the {@link PrioritizationSettings} for a habitat, falling back to {@link getDefaultPrioritizationSettings} when the habitat is missing or has no `prioritizationSettings` field stored. */
export function getPrioritizationRules(habitatId: string): PrioritizationSettings {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) return getDefaultPrioritizationSettings();
  return habitat.prioritizationSettings ?? getDefaultPrioritizationSettings();
}

export interface EvaluationContext {
  missionMap: Map<string, Mission | null>;
  agentHeartbeatMap: Map<string, string>;
  blockingCountMap: Map<string, number>;
  blockedByCountMap: Map<string, number>;
}

/** Builds an {@link EvaluationContext} for the supplied tasks, hydrating {@link Mission} metadata, agent last-heartbeat timestamps, and blocking/blocked-by dependency counts from the database in a single batch per kind. */
export function buildEvaluationContext(habitatTasks: Task[]): EvaluationContext {
  const db = getDb();

  const missionIds = [...new Set(habitatTasks.map((t) => t.missionId))];
  const agentIds = [
    ...new Set(
      habitatTasks.map((t) => t.assignedAgentId).filter((id): id is string => id !== null),
    ),
  ];
  const taskIds = habitatTasks.map((t) => t.id);

  const missionMap = new Map<string, Mission | null>();
  for (const fid of missionIds) {
    missionMap.set(fid, missionRepo.getMissionById(fid));
  }

  const agentHeartbeatMap = new Map<string, string>();
  if (agentIds.length > 0) {
    const agentRows = db
      .select({ id: agents.id, lastHeartbeat: agents.lastHeartbeat })
      .from(agents)
      .where(inArray(agents.id, agentIds))
      .all();
    for (const row of agentRows) {
      agentHeartbeatMap.set(row.id, row.lastHeartbeat);
    }
  }

  const blockingCountMap = new Map<string, number>();
  const blockedByCountMap = new Map<string, number>();

  if (taskIds.length > 0) {
    const blockingRows = db
      .select({
        dependsOnId: taskDependencies.dependsOnId,
        cnt: count(),
      })
      .from(taskDependencies)
      .where(inArray(taskDependencies.dependsOnId, taskIds))
      .groupBy(taskDependencies.dependsOnId)
      .all();
    for (const row of blockingRows) {
      blockingCountMap.set(row.dependsOnId, row.cnt);
    }

    const blockedByRows = db
      .select({
        taskId: taskDependencies.taskId,
        cnt: count(),
      })
      .from(taskDependencies)
      .where(inArray(taskDependencies.taskId, taskIds))
      .groupBy(taskDependencies.taskId)
      .all();
    for (const row of blockedByRows) {
      blockedByCountMap.set(row.taskId, row.cnt);
    }
  }

  return { missionMap, agentHeartbeatMap, blockingCountMap, blockedByCountMap };
}

function evaluateOverdue(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "overdue" }>,
  context: EvaluationContext,
): boolean {
  const mission = context.missionMap.get(task.missionId);
  if (!mission?.dueAt) return false;
  const byDays = condition.byDays ?? 0;
  const threshold = new Date(mission.dueAt).getTime() + byDays * 86_400_000;
  return Date.now() > threshold;
}

function evaluateSlaApproaching(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "sla_approaching" }>,
  context: EvaluationContext,
): boolean {
  const mission = context.missionMap.get(task.missionId);
  if (!mission?.slaDeadlineAt) return false;
  const msRemaining = new Date(mission.slaDeadlineAt).getTime() - Date.now();
  return msRemaining > 0 && msRemaining <= condition.withinHours * 3_600_000;
}

function evaluateDueSoon(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "due_soon" }>,
  context: EvaluationContext,
): boolean {
  const mission = context.missionMap.get(task.missionId);
  if (!mission?.dueAt) return false;
  const msRemaining = new Date(mission.dueAt).getTime() - Date.now();
  return msRemaining > 0 && msRemaining <= condition.withinDays * 86_400_000;
}

function evaluatePendingDuration(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "pending_duration" }>,
): boolean {
  if (task.status !== "pending") return false;
  const msElapsed = Date.now() - new Date(task.createdAt).getTime();
  return msElapsed > condition.greaterThanHours * 3_600_000;
}

function evaluateDependencyCount(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "dependency_count" }>,
  context: EvaluationContext,
): boolean {
  const map =
    condition.direction === "blocking" ? context.blockingCountMap : context.blockedByCountMap;
  const cnt = map.get(task.id) ?? 0;
  return cnt > condition.greaterThan;
}

function evaluateRejectionCount(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "rejection_count" }>,
): boolean {
  return task.rejectedCount > condition.greaterThan;
}

function evaluateMissionStatus(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "mission_status" }>,
  context: EvaluationContext,
): boolean {
  const mission = context.missionMap.get(task.missionId);
  if (!mission) return false;
  return mission.status === condition.status;
}

function evaluateAgentIdle(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "agent_idle" }>,
  context: EvaluationContext,
): boolean {
  if (!task.assignedAgentId) return false;
  const lastHeartbeat = context.agentHeartbeatMap.get(task.assignedAgentId);
  if (!lastHeartbeat) return false;
  const msSinceHeartbeat = Date.now() - new Date(lastHeartbeat).getTime();
  return msSinceHeartbeat > condition.greaterThanMinutes * 60_000;
}

function evaluateLabelMatch(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "label_match" }>,
): boolean {
  const taskLabels = task.labels ?? [];
  return condition.labels.some((label) => taskLabels.includes(label));
}

function evaluatePriorityIs(
  task: Task,
  condition: Extract<PrioritizationRuleCondition, { type: "priority_is" }>,
): boolean {
  return task.priority === condition.priority;
}

/** Recursively evaluates a {@link PrioritizationRuleCondition} against a {@link Task} using the provided {@link EvaluationContext}, composing `and`/`or` conditions short-circuit-style. */
export function evaluateCondition(
  task: Task,
  condition: PrioritizationRuleCondition,
  context: EvaluationContext,
): boolean {
  switch (condition.type) {
    case "overdue":
      return evaluateOverdue(task, condition, context);
    case "sla_approaching":
      return evaluateSlaApproaching(task, condition, context);
    case "due_soon":
      return evaluateDueSoon(task, condition, context);
    case "pending_duration":
      return evaluatePendingDuration(task, condition);
    case "dependency_count":
      return evaluateDependencyCount(task, condition, context);
    case "rejection_count":
      return evaluateRejectionCount(task, condition);
    case "mission_status":
      return evaluateMissionStatus(task, condition, context);
    case "agent_idle":
      return evaluateAgentIdle(task, condition, context);
    case "label_match":
      return evaluateLabelMatch(task, condition);
    case "priority_is":
      return evaluatePriorityIs(task, condition);
    case "and":
      return condition.conditions.every((c) => evaluateCondition(task, c, context));
    case "or":
      return condition.conditions.some((c) => evaluateCondition(task, c, context));
    default:
      return false;
  }
}

function applyAction(taskId: string, action: PrioritizationRuleAction): string | null {
  const db = getDb();
  const now = new Date().toISOString();

  switch (action.type) {
    case "set_priority": {
      const newPriority = action.value as TaskPriority;
      db.update(tasks)
        .set({ priority: newPriority, updatedAt: now })
        .where(eq(tasks.id, taskId))
        .run();
      return newPriority;
    }
    case "bump_priority": {
      const task = taskRepo.getTaskById(taskId);
      if (!task) return null;
      const currentIdx = PRIORITY_LEVELS.indexOf(task.priority);
      const newIdx = Math.min(currentIdx + action.value, PRIORITY_LEVELS.length - 1);
      const newPriority = PRIORITY_LEVELS[newIdx];
      db.update(tasks)
        .set({ priority: newPriority, updatedAt: now })
        .where(eq(tasks.id, taskId))
        .run();
      return newPriority;
    }
    case "add_label": {
      const task = taskRepo.getTaskById(taskId);
      if (!task) return null;
      const labels = [...task.labels];
      if (!labels.includes(action.value)) {
        labels.push(action.value);
        db.update(tasks).set({ labels, updatedAt: now }).where(eq(tasks.id, taskId)).run();
      }
      return null;
    }
    case "set_score_bonus":
      return `+${action.value}`;
  }
}

export interface RuleEvaluationResult {
  taskId: string;
  ruleId: string;
  ruleName: string;
  action: PrioritizationRuleAction;
  matched: boolean;
}

/** Evaluates every enabled {@link PrioritizationRule} in ascending priority order against the habitat's active tasks and returns one {@link RuleEvaluationResult} per matched task, ensuring each task is matched by at most one rule. */
export function evaluateRules(habitatId: string): RuleEvaluationResult[] {
  const settings = getPrioritizationRules(habitatId);
  if (!settings.enabled) return [];

  const { tasks: habitatTasks } = taskRepo.getTasksByHabitatId(habitatId);
  if (habitatTasks.length === 0) return [];

  const activeTasks = habitatTasks.filter((t) => !TERMINAL_STATUSES.includes(t.status));
  if (activeTasks.length === 0) return [];

  const context = buildEvaluationContext(activeTasks);

  const sortedRules = [...settings.rules]
    .filter((r) => r.enabled)
    .toSorted((a, b) => a.priority - b.priority);

  const matchedTaskIds = new Set<string>();
  const results: RuleEvaluationResult[] = [];

  for (const rule of sortedRules) {
    for (const task of activeTasks) {
      if (matchedTaskIds.has(task.id)) continue;

      const matched = evaluateCondition(task, rule.condition, context);
      if (matched) {
        matchedTaskIds.add(task.id);
        results.push({
          taskId: task.id,
          ruleId: rule.id,
          ruleName: rule.name,
          action: rule.action,
          matched: true,
        });
      }
    }
  }

  return results;
}

export interface PrioritizationResult {
  habitatId: string;
  evaluatedTasks: number;
  changedTasks: number;
  results: Array<{
    taskId: string;
    ruleName: string;
    action: PrioritizationRuleAction;
    score: number;
  }>;
}

/** Evaluates rules for a habitat, applies each matched action to the database, recomputes scores via {@link scoreTask}, and publishes `task.priority_changed` SSE events whenever a task's priority actually changes; per-task apply failures are logged and skipped. */
export function applyPrioritization(habitatId: string): PrioritizationResult {
  const evaluations = evaluateRules(habitatId);

  const results: PrioritizationResult["results"] = [];
  let changedCount = 0;

  for (const evaluation of evaluations) {
    let oldPriority: string | null = null;
    try {
      const taskBefore = taskRepo.getTaskById(evaluation.taskId);
      oldPriority = taskBefore?.priority ?? null;

      applyAction(evaluation.taskId, evaluation.action);
    } catch (err) {
      logger.error(
        { err, taskId: evaluation.taskId, ruleName: evaluation.ruleName },
        "Failed to apply prioritization action for task",
      );
      continue;
    }

    const task = taskRepo.getTaskById(evaluation.taskId);
    if (!task) continue;

    const baseScore = scoreTask(task);
    const scoreBonus = evaluation.action.type === "set_score_bonus" ? evaluation.action.value : 0;
    const finalScore = baseScore + scoreBonus;

    if (task.priority !== oldPriority) {
      sseBroadcaster.publish(habitatId, {
        type: "task.priority_changed",
        data: {
          taskId: evaluation.taskId,
          ruleName: evaluation.ruleName,
          oldPriority,
          newPriority: task.priority,
          score: finalScore,
        },
      });
    }

    results.push({
      taskId: evaluation.taskId,
      ruleName: evaluation.ruleName,
      action: evaluation.action,
      score: finalScore,
    });

    changedCount++;
  }

  return {
    habitatId,
    evaluatedTasks: evaluations.length,
    changedTasks: changedCount,
    results,
  };
}

/** Invokes {@link applyPrioritization} for every habitat and returns a {@link PrioritizationResult} for each that had at least one evaluated task, logging and swallowing per-habitat errors so a single failure does not abort the sweep. */
export function applyAllHabitats(): PrioritizationResult[] {
  const habitats = habitatRepo.listHabitats();
  const results: PrioritizationResult[] = [];

  for (const habitat of habitats) {
    try {
      const result = applyPrioritization(habitat.id);
      if (result.evaluatedTasks > 0) {
        results.push(result);
      }
    } catch (err) {
      logger.error({ err, habitatId: habitat.id }, "Failed to apply prioritization for habitat");
    }
  }

  return results;
}
