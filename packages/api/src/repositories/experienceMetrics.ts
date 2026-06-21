import { getDb } from "../db/index.js";
import { pulses, tasks, missions, agents } from "../db/schema/index.js";
import { eq, and, count, gt, inArray, isNotNull } from "drizzle-orm";
import type { ExperienceCategory } from "@orcy/shared";

/** Raw experience signal row extracted for per-agent aggregation. */
export interface ExperienceSignalRow {
  fromId: string;
  experience: ExperienceCategory | null;
  timing: "mid_task" | "completion" | null;
}

/** Count of tasks worked by a single agent (status reached submitted or beyond). */
export interface TasksWorkedCount {
  assignedAgentId: string;
  total: number;
}

/** Agent identity fields joined to experience metrics for display. */
export interface AgentIdentityRow {
  id: string;
  name: string;
  type: string;
  domain: string;
}

/** Experience signal status values that indicate the agent submitted work for review. */
export const SUBMITTED_OR_BEYOND_STATUSES = ["submitted", "approved", "rejected", "done"] as const;

/** Returns raw experience signal rows (fromId + category + timing) for a habitat within an optional time range. */
export function getExperienceSignalRows(habitatId: string, since?: string): ExperienceSignalRow[] {
  const db = getDb();
  const conditions = [eq(pulses.signalType, "experience"), eq(pulses.habitatId, habitatId)];
  if (since) {
    conditions.push(gt(pulses.createdAt, since));
  }
  const rows = db
    .select({
      fromId: pulses.fromId,
      metadata: pulses.metadata,
    })
    .from(pulses)
    .where(and(...conditions))
    .all();
  return rows.map((row) => {
    const meta = row.metadata ?? {};
    return {
      fromId: row.fromId,
      experience: (meta.experience as ExperienceCategory | undefined) ?? null,
      timing: (meta.timing as "mid_task" | "completion" | undefined) ?? null,
    };
  });
}

/** Returns task counts per agent where status reached submitted or beyond in a habitat within an optional time range. */
export function getTasksWorkedCounts(habitatId: string, since?: string): TasksWorkedCount[] {
  const db = getDb();
  const conditions = [
    eq(missions.habitatId, habitatId),
    isNotNull(tasks.assignedAgentId),
    inArray(tasks.status, [...SUBMITTED_OR_BEYOND_STATUSES]),
  ];
  if (since) {
    conditions.push(gt(tasks.submittedAt, since));
  }
  const rows = db
    .select({
      assignedAgentId: tasks.assignedAgentId,
      total: count(),
    })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...conditions))
    .groupBy(tasks.assignedAgentId)
    .all();
  return rows.filter((r): r is TasksWorkedCount => r.assignedAgentId !== null);
}

/** Returns agent identity rows for a set of agent IDs. */
export function getAgentIdentities(agentIds: string[]): AgentIdentityRow[] {
  if (agentIds.length === 0) return [];
  const db = getDb();
  const rows = db
    .select({
      id: agents.id,
      name: agents.name,
      type: agents.type,
      domain: agents.domain,
    })
    .from(agents)
    .where(inArray(agents.id, agentIds))
    .all();
  return rows;
}
