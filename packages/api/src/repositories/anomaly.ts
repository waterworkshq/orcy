import { getDb } from "../db/index.js";
import { cycleTimeMinutes } from "../db/dialect-helpers.js";
import { agents, missions, tasks, users } from "../db/schema/index.js";
import { and, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";

export interface StaleInProgressCandidate {
  id: string;
  title: string;
  startedAt: string | null;
  assignedAgentId: string | null;
}

export interface RejectionWindowTask {
  id: string;
  title: string;
  status: string;
  rejectedCount: number;
}

export interface BacklogStats {
  pendingCount: number;
  activeAgents: number;
}

export interface AgentOfflineCandidate {
  id: string;
  name: string;
  lastHeartbeat: string;
  activeTasks: number;
}

export interface AdminEmailRecipient {
  id: string;
  email: string | null;
}

export function getMissionIdsForHabitat(habitatId: string): string[] {
  const db = getDb();
  return db
    .select({ id: missions.id })
    .from(missions)
    .where(eq(missions.habitatId, habitatId))
    .all()
    .map((mission) => mission.id);
}

export function getStaleInProgressCandidates(missionIds: string[]): StaleInProgressCandidate[] {
  if (missionIds.length === 0) return [];

  const db = getDb();
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      startedAt: tasks.startedAt,
      assignedAgentId: tasks.assignedAgentId,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.missionId, missionIds),
        eq(tasks.status, "in_progress"),
        isNotNull(tasks.startedAt),
      ),
    )
    .all();
}

export function getRecentTasksForRejectionWindow(
  missionIds: string[],
  limit: number,
): RejectionWindowTask[] {
  if (missionIds.length === 0) return [];

  const db = getDb();
  return db
    .select({
      id: tasks.id,
      title: tasks.title,
      status: tasks.status,
      rejectedCount: tasks.rejectedCount,
    })
    .from(tasks)
    .where(inArray(tasks.missionId, missionIds))
    .orderBy(desc(tasks.updatedAt))
    .limit(limit)
    .all();
}

export function getAverageCycleTimeMinutes(
  missionIds: string[],
  since: string,
  until: string,
): number {
  if (missionIds.length === 0) return 0;

  const db = getDb();
  const ctExpr = cycleTimeMinutes(tasks.completedAt, tasks.claimedAt);
  const row = db
    .select({
      avgMinutes: sql<number>`avg(${ctExpr})`,
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.missionId, missionIds),
        isNotNull(tasks.claimedAt),
        isNotNull(tasks.completedAt),
        inArray(tasks.status, ["approved", "done"]),
        sql`${tasks.completedAt} >= ${since}`,
        sql`${tasks.completedAt} < ${until}`,
      ),
    )
    .get();
  return row?.avgMinutes ?? 0;
}

export function getBacklogStats(missionIds: string[]): BacklogStats {
  if (missionIds.length === 0) return { pendingCount: 0, activeAgents: 0 };

  const db = getDb();
  const pendingRow = db
    .select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(inArray(tasks.missionId, missionIds), inArray(tasks.status, ["pending", "claimed"])))
    .get();

  const agentRow = db
    .select({ count: sql<number>`count(distinct ${tasks.assignedAgentId})` })
    .from(tasks)
    .where(
      and(
        inArray(tasks.missionId, missionIds),
        inArray(tasks.status, ["claimed", "in_progress", "submitted"]),
        isNotNull(tasks.assignedAgentId),
      ),
    )
    .get();

  return {
    pendingCount: pendingRow?.count ?? 0,
    activeAgents: agentRow?.count ?? 0,
  };
}

export function getAgentOfflineCandidates(): AgentOfflineCandidate[] {
  const db = getDb();
  const agentRows = db
    .select({
      id: agents.id,
      name: agents.name,
      lastHeartbeat: agents.lastHeartbeat,
    })
    .from(agents)
    .where(ne(agents.status, "offline"))
    .all();

  return agentRows.map((agent) => {
    const taskRow = db
      .select({ count: sql<number>`count(*)` })
      .from(tasks)
      .where(
        and(eq(tasks.assignedAgentId, agent.id), inArray(tasks.status, ["claimed", "in_progress"])),
      )
      .get();

    return {
      ...agent,
      activeTasks: taskRow?.count ?? 0,
    };
  });
}

export function getAdminEmailRecipients(): AdminEmailRecipient[] {
  const db = getDb();
  return db
    .select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.role, "admin"))
    .all();
}
