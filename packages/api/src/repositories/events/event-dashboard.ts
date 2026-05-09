import { getDb } from '../../db/index.js';
import { taskEvents, tasks, features, agents, columns, boards, webhookDeliveries } from '../../db/schema.js';
import { eq, and, isNotNull, sql, count, desc, asc, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/sqlite-core';
import { cycleTimeMinutes } from '../../db/dialect-helpers.js';
import { boardFilter, resolveDateWindow, computeCurrentStreak } from './stats-helpers.js';
import type { DashboardStats } from '../../models/index.js';

function queryThroughput(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
  startDate: string,
): { date: string; count: number }[] {
  const rows = db
    .select({
      date: sql<string>`DATE(${taskEvents.timestamp})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(features, eq(tasks.featureId, features.id))
    .where(
      and(
        eq(taskEvents.action, 'completed'),
        sql`${taskEvents.timestamp} >= ${startDate}`,
        ...(boardId ? [eq(features.boardId, boardId)] : []),
      ),
    )
    .groupBy(sql`DATE(${taskEvents.timestamp})`)
    .orderBy(asc(sql`DATE(${taskEvents.timestamp})`))
    .all();
  return rows.map((r) => ({ date: r.date, count: r.count }));
}

function queryCycleTime(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
  startDate: string,
): { date: string; avgMinutes: number; medianMinutes: number }[] {
  const rows = db
    .select({
      date: sql<string>`DATE(${tasks.completedAt})`,
      avgMinutes: sql<number | null>`AVG(${cycleTimeMinutes(tasks.completedAt, tasks.claimedAt)})`,
    })
    .from(tasks)
    .innerJoin(features, eq(tasks.featureId, features.id))
    .where(
      and(
        sql`${tasks.status} IN ('approved', 'done')`,
        sql`${tasks.completedAt} >= ${startDate}`,
        isNotNull(tasks.claimedAt),
        isNotNull(tasks.completedAt),
        ...(boardId ? [eq(features.boardId, boardId)] : []),
      ),
    )
    .groupBy(sql`DATE(${tasks.completedAt})`)
    .orderBy(asc(sql`DATE(${tasks.completedAt})`))
    .all();
  return rows
    .filter((r) => r.avgMinutes !== null)
    .map((r) => ({
      date: r.date,
      avgMinutes: Math.round(r.avgMinutes!),
      medianMinutes: Math.round(r.avgMinutes!),
    }));
}

function queryRejectionRate(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
  startDate: string,
): { date: string; rejections: number; total: number }[] {
  const rows = db
    .select({
      date: sql<string>`DATE(${taskEvents.timestamp})`,
      rejections: sql<number>`COUNT(CASE WHEN ${taskEvents.action} = 'rejected' THEN 1 END)`,
      total: sql<number>`COUNT(*)`,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(features, eq(tasks.featureId, features.id))
    .where(
      and(
        inArray(taskEvents.action, ['submitted', 'rejected', 'approved']),
        sql`${taskEvents.timestamp} >= ${startDate}`,
        ...(boardId ? [eq(features.boardId, boardId)] : []),
      ),
    )
    .groupBy(sql`DATE(${taskEvents.timestamp})`)
    .orderBy(asc(sql`DATE(${taskEvents.timestamp})`))
    .all();
  return rows.map((r) => ({ date: r.date, rejections: r.rejections, total: r.total }));
}

function queryAgentLeaderboard(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
  startDate: string,
): DashboardStats['agentLeaderboard'] {
  const leaderboardRows = db
    .select({
      agentId: agents.id,
      agentName: agents.name,
      completed: sql<number>`COUNT(CASE WHEN ${tasks.status} IN ('approved', 'done') THEN 1 END)`,
      failed: sql<number>`COUNT(CASE WHEN ${tasks.status} = 'failed' THEN 1 END)`,
      avgCycle: sql<number | null>`AVG(CASE WHEN ${tasks.completedAt} IS NOT NULL AND ${tasks.claimedAt} IS NOT NULL THEN ${cycleTimeMinutes(tasks.completedAt, tasks.claimedAt)} END)`,
    })
    .from(agents)
    .leftJoin(
      tasks,
      and(
        eq(tasks.assignedAgentId, agents.id),
        sql`${tasks.completedAt} >= ${startDate}`,
      ),
    )
    .leftJoin(features, eq(tasks.featureId, features.id))
    .where(boardId ? eq(features.boardId, boardId) : undefined)
    .groupBy(agents.id)
    .orderBy(desc(sql`COUNT(CASE WHEN ${tasks.status} IN ('approved', 'done') THEN 1 END)`))
    .limit(10)
    .all();

  const agentIds = leaderboardRows.map((r) => r.agentId);

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
      approvalMap.set(row.actorId, { submissions: row.submissions, approvals: row.approvals });
    }
  }

  const leaderboard: DashboardStats['agentLeaderboard'] = [];
  for (const row of leaderboardRows) {
    const approval = approvalMap.get(row.agentId);
    const submissions = approval?.submissions || 1;
    leaderboard.push({
      agentId: row.agentId,
      agentName: row.agentName,
      completed: row.completed || 0,
      failed: row.failed || 0,
      avgCycleMinutes: Math.round(row.avgCycle || 0),
      approvalRate: Math.round(((approval?.approvals || 0) / submissions) * 100) / 100,
    });
  }
  return leaderboard;
}

function queryTaskByPriority(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
): { critical: number; high: number; medium: number; low: number } {
  const row = db
    .select({
      critical: sql<number>`SUM(CASE WHEN ${tasks.priority} = 'critical' THEN 1 ELSE 0 END)`,
      high: sql<number>`SUM(CASE WHEN ${tasks.priority} = 'high' THEN 1 ELSE 0 END)`,
      medium: sql<number>`SUM(CASE WHEN ${tasks.priority} = 'medium' THEN 1 ELSE 0 END)`,
      low: sql<number>`SUM(CASE WHEN ${tasks.priority} = 'low' THEN 1 ELSE 0 END)`,
    })
    .from(tasks)
    .innerJoin(features, eq(tasks.featureId, features.id))
    .where(boardFilter(boardId))
    .get();
  return {
    critical: row?.critical || 0,
    high: row?.high || 0,
    medium: row?.medium || 0,
    low: row?.low || 0,
  };
}

function queryTaskByStatus(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
): { pending: number; claimed: number; in_progress: number; submitted: number; done: number } {
  const row = db
    .select({
      pending: sql<number>`SUM(CASE WHEN ${tasks.status} = 'pending' THEN 1 ELSE 0 END)`,
      claimed: sql<number>`SUM(CASE WHEN ${tasks.status} = 'claimed' THEN 1 ELSE 0 END)`,
      in_progress: sql<number>`SUM(CASE WHEN ${tasks.status} = 'in_progress' THEN 1 ELSE 0 END)`,
      submitted: sql<number>`SUM(CASE WHEN ${tasks.status} = 'submitted' THEN 1 ELSE 0 END)`,
      done: sql<number>`SUM(CASE WHEN ${tasks.status} IN ('approved', 'done') THEN 1 ELSE 0 END)`,
    })
    .from(tasks)
    .innerJoin(features, eq(tasks.featureId, features.id))
    .where(boardFilter(boardId))
    .get();
  return {
    pending: row?.pending || 0,
    claimed: row?.claimed || 0,
    in_progress: row?.in_progress || 0,
    submitted: row?.submitted || 0,
    done: row?.done || 0,
  };
}

function queryWipHealth(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
): DashboardStats['wipHealth'] {
  const wipCondition = boardId ? eq(columns.boardId, boardId) : sql`1=1`;
  const wipRows = db
    .select({
      columnId: columns.id,
      columnName: columns.name,
      boardId: columns.boardId,
      boardName: boards.name,
      wipLimit: columns.wipLimit,
      current: sql<number>`COUNT(${tasks.id})`,
    })
    .from(columns)
    .innerJoin(boards, eq(columns.boardId, boards.id))
    .leftJoin(features, eq(columns.id, features.columnId))
    .leftJoin(
      tasks,
      and(
        eq(tasks.featureId, features.id),
        sql`${tasks.status} NOT IN ('approved', 'done', 'failed')`,
      ),
    )
    .where(wipCondition)
    .groupBy(columns.id)
    .orderBy(asc(columns.boardId), asc(columns.order))
    .all();

  const wipHealth: DashboardStats['wipHealth'] = [];
  for (const row of wipRows) {
    const limit = row.wipLimit;
    let health: 'ok' | 'warning' | 'exceeded' = 'ok';
    if (limit !== null) {
      if (row.current > limit) health = 'exceeded';
      else if (row.current >= limit * 0.8) health = 'warning';
    }
    wipHealth.push({
      columnId: row.columnId,
      columnName: row.columnName,
      boardId: row.boardId,
      boardName: row.boardName,
      current: row.current || 0,
      limit,
      health,
    });
  }
  return wipHealth;
}

function queryWebhookStats(
  db: ReturnType<typeof getDb>,
  startDate: string,
): DashboardStats['webhookStats'] {
  const webhookRow = db
    .select({
      total: sql<number>`COUNT(*)`,
      success: sql<number>`SUM(CASE WHEN ${webhookDeliveries.status} = 'success' THEN 1 ELSE 0 END)`,
      failed: sql<number>`SUM(CASE WHEN ${webhookDeliveries.status} = 'failed' THEN 1 ELSE 0 END)`,
      pending: sql<number>`SUM(CASE WHEN ${webhookDeliveries.status} = 'pending' THEN 1 ELSE 0 END)`,
    })
    .from(webhookDeliveries)
    .where(sql`${webhookDeliveries.createdAt} >= ${startDate}`)
    .get();
  const webhookTotal = webhookRow?.total || 1;
  return {
    total: webhookRow?.total || 0,
    success: webhookRow?.success || 0,
    failed: webhookRow?.failed || 0,
    pending: webhookRow?.pending || 0,
    successRate:
      webhookTotal > 0
        ? Math.round(((webhookRow?.success || 0) / webhookTotal) * 100) / 100
        : 0,
  };
}

function querySummaryStats(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
): {
  totalCompleted: number;
  totalInProgress: number;
  averageCycleTimeMinutes: number;
  activeAgents: number;
} {
  const row = db
    .select({
      totalCompleted: sql<number>`COUNT(CASE WHEN ${tasks.status} IN ('approved', 'done') THEN 1 END)`,
      totalInProgress: sql<number>`COUNT(CASE WHEN ${tasks.status} IN ('claimed', 'in_progress', 'submitted') THEN 1 END)`,
      avgCycle: sql<number | null>`AVG(CASE WHEN ${tasks.completedAt} IS NOT NULL AND ${tasks.claimedAt} IS NOT NULL AND ${tasks.status} IN ('approved', 'done') THEN ${cycleTimeMinutes(tasks.completedAt, tasks.claimedAt)} END)`,
      activeAgents: sql<number>`COUNT(DISTINCT CASE WHEN ${tasks.assignedAgentId} IS NOT NULL AND ${tasks.status} IN ('claimed', 'in_progress', 'submitted') THEN ${tasks.assignedAgentId} END)`,
    })
    .from(tasks)
    .innerJoin(features, eq(tasks.featureId, features.id))
    .where(boardFilter(boardId))
    .get();
  return {
    totalCompleted: row?.totalCompleted || 0,
    totalInProgress: row?.totalInProgress || 0,
    averageCycleTimeMinutes: Math.round(row?.avgCycle || 0),
    activeAgents: row?.activeAgents || 0,
  };
}

function queryRejectionTotal(
  db: ReturnType<typeof getDb>,
  boardId: string | undefined,
): { rejections: number; totalReviews: number } {
  const row = db
    .select({
      rejections: sql<number>`COUNT(CASE WHEN ${taskEvents.action} = 'rejected' THEN 1 END)`,
      totalReviews: sql<number>`COUNT(CASE WHEN ${taskEvents.action} IN ('submitted', 'approved', 'rejected') THEN 1 END)`,
    })
    .from(taskEvents)
    .innerJoin(tasks, eq(taskEvents.taskId, tasks.id))
    .innerJoin(features, eq(tasks.featureId, features.id))
    .where(
      and(inArray(taskEvents.action, ['submitted', 'approved', 'rejected']), boardFilter(boardId)),
    )
    .get();
  return { rejections: row?.rejections || 0, totalReviews: row?.totalReviews || 0 };
}

export function getDashboardStats(
  boardId?: string,
  period: '7d' | '30d' | '90d' = '30d',
): DashboardStats {
  const db = getDb();
  const { startDate } = resolveDateWindow(period);

  const throughput = queryThroughput(db, boardId, startDate);
  const cycleTime = queryCycleTime(db, boardId, startDate);
  const rejectionRate = queryRejectionRate(db, boardId, startDate);
  const agentLeaderboard = queryAgentLeaderboard(db, boardId, startDate);
  const taskByPriority = queryTaskByPriority(db, boardId);
  const taskByStatus = queryTaskByStatus(db, boardId);
  const wipHealth = queryWipHealth(db, boardId);
  const webhookStats = queryWebhookStats(db, startDate);
  const summaryStats = querySummaryStats(db, boardId);
  const rejTotal = queryRejectionTotal(db, boardId);

  return {
    throughput,
    cycleTime,
    rejectionRate,
    agentLeaderboard,
    taskByPriority,
    taskByStatus,
    wipHealth,
    webhookStats,
    summary: {
      totalTasksCompleted: summaryStats.totalCompleted,
      totalTasksInProgress: summaryStats.totalInProgress,
      averageCycleTimeMinutes: summaryStats.averageCycleTimeMinutes,
      overallRejectionRate:
        rejTotal.totalReviews > 0
          ? Math.round((rejTotal.rejections / rejTotal.totalReviews) * 100) / 100
          : 0,
      activeAgents: summaryStats.activeAgents,
    },
  };
}
