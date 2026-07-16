import { getDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import { eq, and, sql, inArray, isNotNull } from "drizzle-orm";
import { cycleTimeMinutes } from "../db/dialect-helpers.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import { getAutoAssignSettings } from "./autoAssignService.js";
import { daysAgoISO } from "./analyticsDate.js";

/** Per-agent workload snapshot used by the auto-assigner and capacity dashboard. */
export interface AgentCapacity {
  agentId: string;
  agentName: string;
  domain: string;
  status: string;
  activeTasks: number;
  completedLast7d: number;
  avgCycleMinutes: number;
  maxTasks: number;
  availableCapacity: number;
  utilization: number;
  overCapacity: boolean;
}

/** Habitat-level capacity rollup: per-agent rows, aggregate summary, and rebalancing suggestions. */
export interface CapacityReport {
  agents: AgentCapacity[];
  summary: {
    totalCapacity: number;
    totalAllocated: number;
    totalAvailable: number;
    averageUtilization: number;
    overCapacityCount: number;
  };
  suggestions: string[];
}

/** Compute the {@link CapacityReport} for a habitat, querying active tasks, 7-day completions, and average cycle time per agent. */
export function getCapacityReport(habitatId: string): CapacityReport | null {
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (!habitat) return null;

  const db = getDb();
  const settings = getAutoAssignSettings(habitatId);
  const maxTasks = settings.maxTasksPerAgent;
  const sevenDaysAgo = daysAgoISO(7);

  const agents = agentRepo.listAgents();

  const agentCapacities: AgentCapacity[] = agents.map((agent) => {
    const activeRow = db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(eq(tasks.assignedAgentId, agent.id), inArray(tasks.status, ["claimed", "in_progress"])),
      )
      .get();
    const activeTasks = activeRow?.count ?? 0;

    const completedRow = db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedAgentId, agent.id),
          inArray(tasks.status, ["approved", "done"]),
          sql`${tasks.completedAt} >= ${sevenDaysAgo}`,
        ),
      )
      .get();
    const completedLast7d = completedRow?.count ?? 0;

    const ctExpr = cycleTimeMinutes(tasks.completedAt, tasks.claimedAt);
    const cycleRow = db
      .select({
        avgMinutes: sql<number>`avg(${ctExpr})`,
      })
      .from(tasks)
      .where(
        and(
          eq(tasks.assignedAgentId, agent.id),
          inArray(tasks.status, ["approved", "done"]),
          sql`${tasks.completedAt} >= ${sevenDaysAgo}`,
          isNotNull(tasks.claimedAt),
          isNotNull(tasks.completedAt),
        ),
      )
      .get();

    const avgCycleMinutes = cycleRow?.avgMinutes != null ? Math.round(cycleRow.avgMinutes) : 0;
    const availableCapacity = Math.max(0, maxTasks - activeTasks);
    const utilization = maxTasks > 0 ? Math.round((activeTasks / maxTasks) * 100) : 0;
    const overCapacity = activeTasks > maxTasks;

    return {
      agentId: agent.id,
      agentName: agent.name,
      domain: agent.domain,
      status: agent.status,
      activeTasks,
      completedLast7d,
      avgCycleMinutes,
      maxTasks,
      availableCapacity,
      utilization,
      overCapacity,
    };
  });

  const totalCapacity = agents.length * maxTasks;
  const totalAllocated = agentCapacities.reduce((sum, a) => sum + a.activeTasks, 0);
  const totalAvailable = Math.max(0, totalCapacity - totalAllocated);
  const averageUtilization =
    totalCapacity > 0 ? Math.round((totalAllocated / totalCapacity) * 100) : 0;
  const overCapacityCount = agentCapacities.filter((a) => a.overCapacity).length;

  const suggestions = generateSuggestions(agentCapacities, maxTasks);

  return {
    agents: agentCapacities,
    summary: {
      totalCapacity,
      totalAllocated,
      totalAvailable,
      averageUtilization,
      overCapacityCount,
    },
    suggestions,
  };
}

function generateSuggestions(agents: AgentCapacity[], maxTasks: number): string[] {
  const suggestions: string[] = [];

  const overloaded = agents.filter((a) => a.overCapacity);
  const underloaded = agents.filter((a) => a.availableCapacity > 0 && a.status !== "offline");

  if (overloaded.length > 0 && underloaded.length > 0) {
    for (const over of overloaded) {
      const excess = over.activeTasks - maxTasks;
      const bestCandidate = underloaded
        .filter((u) => u.domain === over.domain || u.availableCapacity >= excess)
        .toSorted((a, b) => b.availableCapacity - a.availableCapacity)[0];

      if (bestCandidate) {
        const transferCount = Math.min(excess, bestCandidate.availableCapacity);
        suggestions.push(
          `${over.agentName} has ${over.activeTasks} tasks (over by ${excess}) — consider reassigning ${transferCount} task${transferCount > 1 ? "s" : ""} to ${bestCandidate.agentName} (${bestCandidate.availableCapacity} slots available)`,
        );
      }
    }
  }

  if (overloaded.length > 0 && underloaded.length === 0) {
    suggestions.push(
      `${overloaded.length} agent${overloaded.length > 1 ? "s are" : " is"} over-capacity with no available agents. Consider registering additional agents or increasing maxTasksPerAgent.`,
    );
  }

  const idleAgents = agents.filter((a) => a.activeTasks === 0 && a.status !== "offline");
  if (idleAgents.length > 0) {
    suggestions.push(
      `${idleAgents.length} agent${idleAgents.length > 1 ? "s have" : " has"} no active tasks — ${idleAgents.map((a) => a.agentName).join(", ")}`,
    );
  }

  const offlineAgents = agents.filter((a) => a.status === "offline");
  if (offlineAgents.length > 0) {
    suggestions.push(
      `${offlineAgents.length} agent${offlineAgents.length > 1 ? "s are" : " is"} offline — ${offlineAgents.map((a) => a.agentName).join(", ")}`,
    );
  }

  if (suggestions.length === 0 && agents.length > 0) {
    suggestions.push("All agents are within capacity limits. Workload is well balanced.");
  }

  return suggestions;
}
