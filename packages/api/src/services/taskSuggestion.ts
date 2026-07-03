import {
  scoreTask,
  computeSlaUrgencyWeight,
  PRIORITY_WEIGHTS,
  computeCapabilityWeight,
} from "./taskScoring.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as agentRepo from "../repositories/agent.js";
import { areAllWorkflowGatesSatisfied } from "../repositories/workflow.js";
import { getDb } from "../db/index.js";
import { tasks, taskDependencies } from "../db/schema/index.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import type { Task, Agent } from "../models/index.js";

const MS_PER_DAY = 86_400_000;
const FAN_OUT_WEIGHT = 5;
const MAX_FAN_OUT_BONUS = 25;

/** Weighted components contributing to a task suggestion score, exposed for transparency and debugging. */
export interface SuggestionFactors {
  priorityWeight: number;
  urgencyWeight: number;
  slaUrgencyWeight: number;
  capabilityWeight: number;
  dependencyBonus: number;
  specializationBonus: number;
  workloadPenalty: number;
  stalePickupBonus: number;
}

/** A single ranked task recommendation for an agent, including the computed score and human-readable reasons. */
export interface TaskSuggestion {
  taskId: string;
  taskTitle: string;
  missionId: string;
  missionTitle: string;
  score: number;
  reasons: string[];
  factors: SuggestionFactors;
}

/** An agent's current task load, used to penalize over-assigned agents and cap recommendations. */
export interface AgentWorkload {
  claimed: number;
  inProgress: number;
  maxRecommended: number;
}

/** Ranked task suggestions for an agent alongside the agent's current workload snapshot. */
export interface SuggestionResult {
  suggestions: TaskSuggestion[];
  agentWorkload: AgentWorkload;
}

/** Builds a map of taskId → downstream-dependent count for the given tasks. One query (batched), not per-task. Task-level fan-out only in v0.25.0; mission-level fan-out deferred to patch (RM-3). */
function buildFanOutMap(taskIds: string[]): Map<string, number> {
  if (taskIds.length === 0) return new Map();
  const db = getDb();
  const rows = db
    .select({ dependsOnId: taskDependencies.dependsOnId })
    .from(taskDependencies)
    .where(inArray(taskDependencies.dependsOnId, taskIds))
    .all();
  const counts = new Map<string, number>();
  for (const row of rows) {
    counts.set(row.dependsOnId, (counts.get(row.dependsOnId) ?? 0) + 1);
  }
  return counts;
}

/** Scores pending tasks in a habitat for a specific agent and returns the top-ranked suggestions with workload-aware penalties applied. */
export function getSuggestionsForAgent(
  habitatId: string,
  agentId: string,
  limit: number = 5,
): SuggestionResult {
  const agent = agentRepo.getAgentById(agentId);
  if (!agent) {
    return { suggestions: [], agentWorkload: { claimed: 0, inProgress: 0, maxRecommended: 3 } };
  }

  const availableTasks = taskRepo
    .getAvailableTasksForAgent(habitatId, agent.domain, {
      status: "pending",
    })
    .filter((task) => areAllWorkflowGatesSatisfied(task.id));

  const { claimed, inProgress } = getAgentWorkload(agentId);
  const missionMap = new Map<string, string>();

  for (const task of availableTasks) {
    if (!missionMap.has(task.missionId)) {
      const mission = missionRepo.getMissionById(task.missionId);
      if (mission) missionMap.set(task.missionId, mission.title);
    }
  }

  const fanOutMap = buildFanOutMap(availableTasks.map((t) => t.id));

  const suggestions: TaskSuggestion[] = availableTasks
    .map((task) => scoreWithFactors(task, agent, claimed, inProgress, missionMap, fanOutMap))
    .toSorted((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    suggestions,
    agentWorkload: { claimed, inProgress, maxRecommended: 3 },
  };
}

function scoreWithFactors(
  task: Task,
  agent: Omit<Agent, "apiKeyHash">,
  claimedCount: number,
  inProgressCount: number,
  missionMap: Map<string, string>,
  fanOutMap: Map<string, number>,
): TaskSuggestion {
  const reasons: string[] = [];
  const baseScore = scoreTask(task, undefined, agent.capabilities);

  const fanOut = fanOutMap.get(task.id) ?? 0;
  const dependencyBonus = Math.min(FAN_OUT_WEIGHT * fanOut, MAX_FAN_OUT_BONUS);

  const factors: SuggestionFactors = {
    priorityWeight: PRIORITY_WEIGHTS[task.priority] ?? 20,
    urgencyWeight: 0,
    slaUrgencyWeight: 0,
    capabilityWeight: computeCapabilityWeight(task, undefined, agent.capabilities),
    dependencyBonus,
    specializationBonus: 0,
    workloadPenalty: 0,
    stalePickupBonus: 0,
  };

  let totalScore = baseScore;

  if (fanOut > 0) {
    totalScore += dependencyBonus;
    reasons.push(`Unblocks ${fanOut} downstream task${fanOut > 1 ? "s" : ""}`);
  }

  const mission = task.missionId ? missionRepo.getMissionById(task.missionId) : null;
  const slaDeadline = mission?.slaDeadlineAt ?? null;
  const slaWeight = computeSlaUrgencyWeight(slaDeadline);
  if (slaWeight > 0) {
    factors.slaUrgencyWeight = slaWeight;
    const ms = slaDeadline ? new Date(slaDeadline).getTime() - Date.now() : 0;
    if (ms < 0) {
      reasons.push("SLA breached");
    } else if (ms < MS_PER_DAY) {
      reasons.push("SLA deadline within 24h");
    } else if (ms < 3 * MS_PER_DAY) {
      reasons.push("SLA deadline within 3 days");
    } else {
      reasons.push("SLA deadline within 7 days");
    }
  }

  const workloadTotal = claimedCount + inProgressCount;
  if (workloadTotal > 1) {
    const penalty = (workloadTotal - 1) * 10;
    factors.workloadPenalty = -penalty;
    totalScore -= penalty;
    reasons.push(`Agent has ${workloadTotal} active tasks`);
  }

  if (task.requiredDomain && task.requiredDomain === agent.domain) {
    factors.specializationBonus = 20;
    totalScore += 20;
    reasons.push(`Domain match: ${agent.domain}`);
  }

  const staleBonus = computeStalePickupBonus(task);
  if (staleBonus > 0) {
    factors.stalePickupBonus = staleBonus;
    totalScore += staleBonus;
    reasons.push("Task pending >24h without claims");
  }

  if (task.priority === "critical") reasons.push("Critical priority");
  else if (task.priority === "high") reasons.push("High priority");

  if (reasons.length === 0) reasons.push("Available task matching criteria");

  return {
    taskId: task.id,
    taskTitle: task.title,
    missionId: task.missionId,
    missionTitle: missionMap.get(task.missionId) ?? "Unknown mission",
    score: Math.round(totalScore),
    reasons,
    factors,
  };
}

function computeStalePickupBonus(task: Task): number {
  const ageMs = Date.now() - new Date(task.createdAt).getTime();
  if (ageMs > MS_PER_DAY && !task.assignedAgentId && task.status === "pending") return 5;
  return 0;
}

function getAgentWorkload(agentId: string): { claimed: number; inProgress: number } {
  const db = getDb();
  const claimedRow = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.assignedAgentId, agentId), eq(tasks.status, "claimed")))
    .get();

  const inProgressRow = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.assignedAgentId, agentId), eq(tasks.status, "in_progress")))
    .get();

  return { claimed: claimedRow?.count ?? 0, inProgress: inProgressRow?.count ?? 0 };
}
