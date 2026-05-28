import { getDb } from '../../db/index.js';
import { taskEvents, tasks, agents } from '../../db/schema/index.js';
import { eq, and, isNotNull, sql, desc, inArray } from 'drizzle-orm';
import { cycleTimeMinutes } from '../../db/dialect-helpers.js';
import { logger } from '../../lib/logger.js';
import {
  computeCycleTimeStats,
  computeThroughput,
  computeCurrentStreak,
  getDateThresholds,
} from './stats-helpers.js';
import type { AgentStats, AllAgentStats, Artifact } from '../../models/index.js';

export function getAgentStats(agentId: string): AgentStats | null {
  const db = getDb();

  const agentRow = db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get();
  if (!agentRow) return null;

  const agentName = agentRow.name;

  const summaryRow = db
    .select({
      totalAssigned: sql<number>`COUNT(*)`,
      completed: sql<number>`SUM(CASE WHEN ${tasks.status} IN ('approved', 'done') THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${tasks.status} = 'failed' THEN 1 ELSE 0 END)`,
      inProgress: sql<number>`SUM(CASE WHEN ${tasks.status} IN ('claimed', 'in_progress', 'submitted') THEN 1 ELSE 0 END)`,
      rejected: sql<number>`SUM(CASE WHEN ${tasks.status} = 'rejected' THEN 1 ELSE 0 END)`,
      totalRejections: sql<number>`SUM(${tasks.rejectedCount})`,
    })
    .from(tasks)
    .where(eq(tasks.assignedAgentId, agentId))
    .get();

  const cycleRows = db
    .select({
      cycleMinutes: sql<number>`ROUND((${cycleTimeMinutes(tasks.completedAt, tasks.claimedAt)}))`,
    })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedAgentId, agentId),
        isNotNull(tasks.claimedAt),
        isNotNull(tasks.completedAt),
        sql`${tasks.status} IN ('approved', 'done')`,
      ),
    )
    .all();

  const cycleTimes: number[] = [];
  for (const row of cycleRows) {
    if (!isNaN(row.cycleMinutes)) {
      cycleTimes.push(row.cycleMinutes);
    }
  }

  const { todayStart, weekStart, monthStart } = getDateThresholds();

  const throughputRows = db
    .select({ ts: tasks.completedAt })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedAgentId, agentId),
        sql`${tasks.status} IN ('approved', 'done')`,
        isNotNull(tasks.completedAt),
      ),
    )
    .all();

  const approvalRow = db
    .select({
      submissions: sql<number>`COUNT(CASE WHEN ${taskEvents.action} = 'submitted' THEN 1 END)`,
      approvals: sql<number>`COUNT(CASE WHEN ${taskEvents.action} = 'approved' THEN 1 END)`,
      rejections: sql<number>`COUNT(CASE WHEN ${taskEvents.action} = 'rejected' THEN 1 END)`,
    })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.actorType, 'agent'),
        eq(taskEvents.actorId, agentId),
        inArray(taskEvents.action, ['submitted', 'approved', 'rejected']),
      ),
    )
    .get();

  const streakRows = db
    .select({ action: taskEvents.action })
    .from(taskEvents)
    .where(
      and(
        eq(taskEvents.actorType, 'agent'),
        eq(taskEvents.actorId, agentId),
        inArray(taskEvents.action, ['approved', 'rejected', 'completed']),
      ),
    )
    .orderBy(desc(taskEvents.timestamp))
    .limit(100)
    .all();

  const artifactRows = db
    .select({ artifacts: tasks.artifacts })
    .from(tasks)
    .where(
      and(
        eq(tasks.assignedAgentId, agentId),
        isNotNull(tasks.artifacts),
        sql`${tasks.artifacts} != '[]'`,
      ),
    )
    .all();

  let totalArtifacts = 0;
  const artifactByType: Record<string, number> = {};
  for (const row of artifactRows) {
    try {
      const artifacts: Artifact[] = row.artifacts as Artifact[];
      for (const artifact of artifacts) {
        totalArtifacts++;
        artifactByType[artifact.type] = (artifactByType[artifact.type] || 0) + 1;
      }
    } catch (err) {
      logger.warn({ err }, 'Failed to parse artifacts JSON in agent stats query');
    }
  }

  const submissions = approvalRow?.submissions || 1;
  const rejections = approvalRow?.rejections || 0;

  return {
    agentId,
    agentName,
    tasks: {
      completed: summaryRow?.completed || 0,
      failed: summaryRow?.failed || 0,
      inProgress: summaryRow?.inProgress || 0,
      rejected: summaryRow?.rejected || 0,
      totalAssigned: summaryRow?.totalAssigned || 0,
    },
    cycleTime: computeCycleTimeStats(cycleTimes),
    throughput: computeThroughput(throughputRows, todayStart, weekStart, monthStart),
    quality: {
      rejectionRate: Math.round((rejections / submissions) * 100) / 100,
      approvalRate:
        Math.round(((approvalRow?.approvals || 0) / submissions) * 100) / 100,
      currentStreak: computeCurrentStreak(streakRows),
      totalRejections: summaryRow?.totalRejections || 0,
    },
    artifacts: { total: totalArtifacts, byType: artifactByType },
  };
}

export function getAllAgentStats(): AllAgentStats {
  const db = getDb();
  const completedExpr = sql<number>`SUM(CASE WHEN ${tasks.status} IN ('approved','done') THEN 1 ELSE 0 END)`;

  const agentRows = db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      domain: agents.domain,
      status: agents.status,
      totalAssigned: sql<number>`COUNT(${tasks.id})`,
      completed: completedExpr,
      failed: sql<number>`SUM(CASE WHEN ${tasks.status} = 'failed' THEN 1 ELSE 0 END)`,
      inProgress: sql<number>`SUM(CASE WHEN ${tasks.status} IN ('claimed', 'in_progress', 'submitted') THEN 1 ELSE 0 END)`,
    })
    .from(agents)
    .leftJoin(tasks, eq(tasks.assignedAgentId, agents.id))
    .groupBy(agents.id)
    .orderBy(desc(completedExpr))
    .all();

  const agentIds = agentRows.map((r) => r.agentId);

  const cycleMap = new Map<string, number>();
  if (agentIds.length > 0) {
    const cycleRows = db
      .select({
        agentId: tasks.assignedAgentId,
        avgCycle: sql<number | null>`AVG(${cycleTimeMinutes(tasks.completedAt, tasks.claimedAt)})`,
      })
      .from(tasks)
      .where(
        and(
          inArray(tasks.assignedAgentId, agentIds),
          isNotNull(tasks.claimedAt),
          isNotNull(tasks.completedAt),
          sql`${tasks.status} IN ('approved', 'done')`,
        ),
      )
      .groupBy(tasks.assignedAgentId)
      .all();
    for (const row of cycleRows) {
      if (row.agentId) cycleMap.set(row.agentId, row.avgCycle || 0);
    }
  }

  const approvalMap = new Map<string, { submissions: number; approvals: number }>();
  if (agentIds.length > 0) {
    const approvalRows = db
      .select({
        actorId: taskEvents.actorId,
        submissions: sql<number>`COUNT(CASE WHEN ${taskEvents.action} = 'submitted' THEN 1 END)`,
        approvals: sql<number>`COUNT(CASE WHEN ${taskEvents.action} = 'approved' THEN 1 END)`,
      })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.actorType, 'agent'),
          inArray(taskEvents.actorId, agentIds),
          inArray(taskEvents.action, ['submitted', 'approved']),
        ),
      )
      .groupBy(taskEvents.actorId)
      .all();
    for (const row of approvalRows) {
      approvalMap.set(row.actorId, {
        submissions: row.submissions,
        approvals: row.approvals,
      });
    }
  }

  const streakMap = new Map<string, number>();
  if (agentIds.length > 0) {
    const streakRows = db
      .select({
        actorId: taskEvents.actorId,
        action: taskEvents.action,
        timestamp: taskEvents.timestamp,
      })
      .from(taskEvents)
      .where(
        and(
          eq(taskEvents.actorType, 'agent'),
          inArray(taskEvents.actorId, agentIds),
          inArray(taskEvents.action, ['approved', 'rejected', 'completed']),
        ),
      )
      .orderBy(desc(taskEvents.timestamp))
      .limit(1000)
      .all();

    const grouped = new Map<string, { action: string }[]>();
    for (const row of streakRows) {
      if (!grouped.has(row.actorId)) grouped.set(row.actorId, []);
      grouped.get(row.actorId)!.push({ action: row.action });
    }
    for (const [actorId, actions] of grouped) {
      streakMap.set(actorId, computeCurrentStreak(actions));
    }
  }

  const agentsList: AllAgentStats['agents'] = [];
  let totalTasksCompleted = 0;
  let totalTasksFailed = 0;
  let totalAgentsActive = 0;

  for (const row of agentRows) {
    const completed = row.completed || 0;
    const failed = row.failed || 0;

    if (completed > 0) totalAgentsActive++;

    const avgCycle = cycleMap.get(row.agentId) || 0;
    const approval = approvalMap.get(row.agentId);
    const submissions = approval?.submissions || 1;
    const currentStreak = streakMap.get(row.agentId) || 0;

    agentsList.push({
      agentId: row.agentId,
      agentName: row.agentName,
      domain: row.domain,
      status: row.status as 'idle' | 'working' | 'offline',
      completed,
      failed,
      inProgress: row.inProgress || 0,
      avgCycleMinutes: Math.round(avgCycle),
      approvalRate:
        Math.round(((approval?.approvals || 0) / submissions) * 100) / 100,
      currentStreak,
    });

    totalTasksCompleted += completed;
    totalTasksFailed += failed;
  }

  return {
    agents: agentsList,
    summary: { totalTasksCompleted, totalTasksFailed, totalAgentsActive },
  };
}
