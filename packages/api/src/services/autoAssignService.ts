import { getDb } from "../db/index.js";
import { tasks, taskEvents } from "../db/schema/index.js";
import { eq, and, sql, inArray } from "drizzle-orm";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import * as habitatRepo from "../repositories/board.js";
import type { AutoAssignSettings, Task } from "../models/index.js";
import { emitTransition } from "./tasks/transition-emitter.js";

const DEFAULT_SETTINGS: AutoAssignSettings = {
  enabled: false,
  strategy: "best_match",
  maxTasksPerAgent: 5,
  requireDomainMatch: false,
  requireCapabilityMatch: false,
  excludeOfflineAgents: true,
};

/** Returns a fresh copy of the default auto-assignment settings. */
export function getDefaultAutoAssignSettings(): AutoAssignSettings {
  return { ...DEFAULT_SETTINGS };
}

/** Resolves the effective auto-assignment settings for a habitat by merging stored overrides over the defaults. */
export function getAutoAssignSettings(habitatId: string): AutoAssignSettings {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat?.autoAssignSettings) return { ...DEFAULT_SETTINGS };
  return { ...DEFAULT_SETTINGS, ...habitat.autoAssignSettings };
}

interface EligibleAgent {
  id: string;
  name: string;
  domain: string;
  capabilities: string[];
  status: string;
  lastHeartbeat: string;
  activeTaskCount: number;
}

/** Counts an agent's currently claimed or in-progress tasks. */
export function getAgentActiveTaskCount(agentId: string): number {
  const db = getDb();
  const row = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(
      and(eq(tasks.assignedAgentId, agentId), inArray(tasks.status, ["claimed", "in_progress"])),
    )
    .get();
  return row?.count ?? 0;
}

/** Filters agents against the habitat's auto-assignment settings, returning only those eligible for the given task. */
export function getEligibleAgents(
  _habitatId: string,
  task: Task,
  settings: AutoAssignSettings,
): EligibleAgent[] {
  const agents = agentRepo.listAgents();
  const staleThreshold = new Date(Date.now() - 30 * 60 * 1000).toISOString();

  return agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      domain: agent.domain,
      capabilities: agent.capabilities,
      status: agent.status,
      lastHeartbeat: agent.lastHeartbeat,
      activeTaskCount: getAgentActiveTaskCount(agent.id),
    }))
    .filter((agent) => {
      if (agent.activeTaskCount >= settings.maxTasksPerAgent) return false;
      if (settings.excludeOfflineAgents && agent.status === "offline") return false;
      if (settings.excludeOfflineAgents && agent.lastHeartbeat < staleThreshold) return false;
      if (
        settings.requireDomainMatch &&
        task.requiredDomain &&
        agent.domain !== task.requiredDomain
      )
        return false;
      if (
        settings.requireCapabilityMatch &&
        task.requiredCapabilities &&
        task.requiredCapabilities.length > 0
      ) {
        const agentCaps = new Set(agent.capabilities.map((c) => c.toLowerCase()));
        const missing = task.requiredCapabilities.filter((c) => !agentCaps.has(c.toLowerCase()));
        if (missing.length > 0) return false;
      }
      return true;
    });
}

const roundRobinCounters = new Map<string, number>();

/** Resets the round-robin selection counter for one habitat, or all of them when no habitat is specified. */
export function resetRoundRobinCounter(habitatId?: string): void {
  if (habitatId) roundRobinCounters.delete(habitatId);
  else roundRobinCounters.clear();
}

/** Picks the next agent in round-robin order, advancing the per-habitat counter. */
export function selectAgentRoundRobin(
  agents: EligibleAgent[],
  habitatId: string,
): EligibleAgent | null {
  if (agents.length === 0) return null;
  const index = roundRobinCounters.get(habitatId) ?? 0;
  const selected = agents[index % agents.length];
  roundRobinCounters.set(habitatId, (index + 1) % agents.length);
  return selected;
}

/** Picks the agent with the fewest active tasks, breaking ties by oldest heartbeat. */
export function selectAgentLeastLoaded(agents: EligibleAgent[]): EligibleAgent | null {
  if (agents.length === 0) return null;
  return agents.reduce((best, agent) => {
    if (agent.activeTaskCount < best.activeTaskCount) return agent;
    if (agent.activeTaskCount === best.activeTaskCount && agent.lastHeartbeat < best.lastHeartbeat)
      return agent;
    return best;
  });
}

/** Scores each agent against the task's domain, capabilities, load, history, and rejection rate, then picks the highest. */
export function selectAgentBestMatch(
  agents: EligibleAgent[],
  task: Task,
  _habitatId: string,
): EligibleAgent | null {
  if (agents.length === 0) return null;

  const db = getDb();
  const scored = agents.map((agent) => {
    let score = 0;
    if (task.requiredDomain && agent.domain === task.requiredDomain) score += 30;
    if (task.requiredCapabilities && task.requiredCapabilities.length > 0) {
      const agentCaps = new Set(agent.capabilities.map((c) => c.toLowerCase()));
      const matches = task.requiredCapabilities.filter((c) =>
        agentCaps.has(c.toLowerCase()),
      ).length;
      score += Math.min(matches * 5, 20);
    }
    score -= agent.activeTaskCount * 10;

    const completedRow = db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(and(eq(tasks.assignedAgentId, agent.id), inArray(tasks.status, ["approved", "done"])))
      .get();
    score += Math.min((completedRow?.count ?? 0) * 2, 10);

    const rejRow = db
      .select({
        submissions: sql<number>`count(case when ${taskEvents.action} = 'submitted' then 1 end)`,
        rejections: sql<number>`count(case when ${taskEvents.action} = 'rejected' then 1 end)`,
      })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.actorType, "agent"),
          eq(taskEvents.actorId, agent.id),
          inArray(taskEvents.action, ["submitted", "rejected"]),
        ),
      )
      .get();
    const rejectionRate =
      (rejRow?.submissions ?? 0) > 0 ? (rejRow?.rejections ?? 0) / rejRow!.submissions : 0;
    score -= Math.round(rejectionRate * 20);

    return { agent, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].agent;
}

/** Outcome of an auto-assignment attempt, including the selected agent on success or a reason on failure. */
export interface AssignResult {
  success: boolean;
  agentId?: string;
  agentName?: string;
  reason?: string;
}

/** Selects an eligible agent for a pending task using the habitat's configured strategy, claims the task, and emits a `claimed` transition. */
export function assignTask(taskId: string, habitatId: string): AssignResult {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return { success: false, reason: "task_not_found" };
  if (task.assignedAgentId) return { success: false, reason: "already_assigned" };
  if (task.status !== "pending") return { success: false, reason: "not_pending" };

  const settings = getAutoAssignSettings(habitatId);
  if (!settings.enabled) return { success: false, reason: "auto_assign_disabled" };

  const eligible = getEligibleAgents(habitatId, task, settings);
  if (eligible.length === 0) return { success: false, reason: "no_eligible_agents" };

  let selected: EligibleAgent | null = null;

  switch (settings.strategy) {
    case "round_robin":
      selected = selectAgentRoundRobin(eligible, habitatId);
      break;
    case "least_loaded":
      selected = selectAgentLeastLoaded(eligible);
      break;
    case "best_match":
    default:
      selected = selectAgentBestMatch(eligible, task, habitatId);
      break;
  }

  if (!selected) return { success: false, reason: "no_agent_selected" };

  const claimResult = taskRepo.claimTask(taskId, selected.id);
  if (!claimResult.success) return { success: false, reason: claimResult.reason };

  emitTransition(taskId, "claimed", habitatId, {
    actorType: "system",
    actorId: "auto_assign",
    oldStatus: "pending",
    newStatus: "claimed",
    assignedAgentId: selected.id,
    metadata: {
      strategy: settings.strategy,
      agentId: selected.id,
      agentName: selected.name,
      autoAssigned: true,
    },
    task: claimResult.task,
  });

  return { success: true, agentId: selected.id, agentName: selected.name };
}
