import { getDb } from '../db/index.js';
import { tasks, agents, taskEvents, taskDependencies, missions, sprints } from '../db/schema/index.js';
import { eq, and, sql, isNotNull, notInArray, inArray } from 'drizzle-orm';
import { dateDayExpr } from '../db/dialect-helpers.js';
import { priorityOrderExpr } from '../db/sql-helpers.js';
import type { TaskPriority, TaskStatus } from '../models/index.js';

export interface VelocityMetrics {
  days7: number;
  days14: number;
  days30: number;
  perAgent: Record<string, { days7: number; days14: number; days30: number; agentName: string }>;
}

export interface TaskEstimate {
  taskId: string;
  taskTitle: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignedAgentId: string | null;
  dueAt: string | null;
  estimatedCompletionAt: string | null;
  confidence: 'high' | 'medium' | 'low';
  positionInQueue: number;
  daysUntilDue: number | null;
  daysUntilEstimated: number | null;
}

export interface AtRiskTask {
  taskId: string;
  taskTitle: string;
  reason: 'overdue_prediction' | 'no_activity' | 'blocked_by_dependency' | 'past_due';
  severity: 'low' | 'medium' | 'high' | 'critical';
  details: string;
  assignedAgentId: string | null;
  dueAt: string | null;
  lastActivityAt: string | null;
}

export interface PredictionResponse {
  velocity: VelocityMetrics;
  estimates: TaskEstimate[];
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

export function calculateVelocity(habitatId: string, options?: { sprintId?: string }): VelocityMetrics {
  const db = getDb();
  const now = Date.now();
  const msDay = 24 * 60 * 60 * 1000;
  const since = (days: number) => new Date(now - days * msDay).toISOString();

  function countCompleted(sinceDate: string, agentId?: string): number {
    const conditions = [
      eq(missions.habitatId, habitatId),
      inArray(tasks.status, ['approved', 'done']),
      sql`${tasks.completedAt} >= ${sinceDate}`,
    ];
    if (agentId) conditions.push(eq(tasks.assignedAgentId, agentId));
    if (options?.sprintId) conditions.push(eq(missions.sprintId, options.sprintId));
    const row = db.select({ count: sql<number>`count(*)` })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(and(...conditions))
      .get();
    return row?.count ?? 0;
  }

  const days7 = countCompleted(since(7));
  const days14 = countCompleted(since(14));
  const days30 = countCompleted(since(30));

  const agentRows = db.selectDistinct({ id: agents.id, name: agents.name })
    .from(agents)
    .innerJoin(tasks, eq(tasks.assignedAgentId, agents.id))
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(eq(missions.habitatId, habitatId))
    .all();

  const perAgent: VelocityMetrics['perAgent'] = {};
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

export function estimateCompletionDates(habitatId: string, velocity: VelocityMetrics): TaskEstimate[] {
  const db = getDb();
  const now = Date.now();
  const msDay = 24 * 60 * 60 * 1000;

  const dailyVelocity = velocity.days14 > 0 ? velocity.days14 / 14 : velocity.days30 > 0 ? velocity.days30 / 30 : 0.5;

  const rows = db.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    priority: tasks.priority,
    assignedAgentId: tasks.assignedAgentId,
    dueAt: missions.dueAt,
    lastActivity: sql<string | null>`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
  })
  .from(tasks)
  .innerJoin(missions, eq(tasks.missionId, missions.id))
  .where(
    and(
      eq(missions.habitatId, habitatId),
      notInArray(tasks.status, ['approved', 'done', 'failed'])
    )
  )
  .orderBy(
    priorityOrderExpr(tasks.priority),
    tasks.createdAt
  )
  .all();

  const estimates: TaskEstimate[] = [];
  let queuePosition = 0;

  for (const row of rows) {
    const taskId = row.id;
    const status = row.status as TaskStatus;
    const priority = row.priority as TaskPriority;

    const depRow = db.select({ count: sql<number>`count(*)` })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
      .where(
        and(
          eq(taskDependencies.taskId, taskId),
          notInArray(tasks.status, ['approved', 'done'])
        )
      )
      .get();
    const unmetDeps = depRow?.count ?? 0;

    let positionInQueue = queuePosition;
    if (status === 'in_progress' || status === 'claimed') {
      positionInQueue = 0;
    } else {
      queuePosition++;
    }

    let agentVelocity = dailyVelocity;
    if (row.assignedAgentId && velocity.perAgent[row.assignedAgentId]) {
      const av = velocity.perAgent[row.assignedAgentId];
      agentVelocity = av.days14 > 0 ? av.days14 / 14 : av.days30 > 0 ? av.days30 / 30 : dailyVelocity;
    }

    const effectiveVelocity = agentVelocity > 0 ? agentVelocity * (PRIORITY_BOOST[priority] ?? 1.0) : 0.5;

    let daysOffset: number;
    if (unmetDeps > 0) {
      daysOffset = (positionInQueue + unmetDeps) / Math.max(effectiveVelocity, 0.1);
    } else if (status === 'in_progress') {
      daysOffset = 1 / Math.max(effectiveVelocity, 0.1);
    } else if (status === 'claimed') {
      daysOffset = 2 / Math.max(effectiveVelocity, 0.1);
    } else {
      daysOffset = (positionInQueue + 1) / Math.max(effectiveVelocity, 0.1);
    }

    let confidence: TaskEstimate['confidence'] = 'low';
    if (velocity.days14 >= 5 && unmetDeps === 0) confidence = 'high';
    else if (velocity.days14 >= 2 || velocity.days30 >= 5) confidence = 'medium';

    const estimatedCompletionAt = new Date(now + daysOffset * msDay).toISOString();
    const daysUntilDue = row.dueAt ? (new Date(row.dueAt).getTime() - now) / msDay : null;
    const daysUntilEstimated = daysOffset;

    estimates.push({
      taskId,
      taskTitle: row.title,
      status,
      priority,
      assignedAgentId: row.assignedAgentId,
      dueAt: row.dueAt,
      estimatedCompletionAt,
      confidence,
      positionInQueue,
      daysUntilDue: daysUntilDue !== null ? Math.round(daysUntilDue * 10) / 10 : null,
      daysUntilEstimated: Math.round(daysUntilEstimated * 10) / 10,
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
        const severity: AtRiskTask['severity'] = daysOver > 3 ? 'critical' : daysOver > 1 ? 'high' : 'medium';
        atRisk.push({
          taskId: est.taskId,
          taskTitle: est.taskTitle,
          reason: 'overdue_prediction',
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
        reason: 'past_due',
        severity: 'critical',
        details: `Task is ${Math.abs(Math.round(est.daysUntilDue))}d past due`,
        assignedAgentId: est.assignedAgentId,
        dueAt: est.dueAt,
        lastActivityAt: null,
      });
    }
  }

  const activityRows = db.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    assignedAgentId: tasks.assignedAgentId,
    dueAt: missions.dueAt,
    updatedAt: tasks.updatedAt,
    lastActivity: sql<string | null>`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
  })
  .from(tasks)
  .innerJoin(missions, eq(tasks.missionId, missions.id))
  .where(
    and(
      eq(missions.habitatId, habitatId),
      inArray(tasks.status, ['claimed', 'in_progress'])
    )
  )
  .all();

  for (const row of activityRows) {
    const lastActivity = row.lastActivity ?? row.updatedAt;
    const hoursSinceActivity = lastActivity ? (now - new Date(lastActivity).getTime()) / msHour : Infinity;

    if (hoursSinceActivity > NO_ACTIVITY_THRESHOLD_HOURS) {
      const severity: AtRiskTask['severity'] = hoursSinceActivity > 72 ? 'critical' : hoursSinceActivity > 48 ? 'high' : 'medium';
      atRisk.push({
        taskId: row.id,
        taskTitle: row.title,
        reason: 'no_activity',
        severity,
        details: `No activity for ${Math.round(hoursSinceActivity)}h (threshold: ${NO_ACTIVITY_THRESHOLD_HOURS}h)`,
        assignedAgentId: row.assignedAgentId,
        dueAt: row.dueAt,
        lastActivityAt: lastActivity,
      });
    }
  }

  const blockedRows = db.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    assignedAgentId: tasks.assignedAgentId,
    dueAt: missions.dueAt,
    lastActivity: sql<string | null>`(SELECT MAX(${taskEvents.timestamp}) FROM ${taskEvents} WHERE ${taskEvents.taskId} = ${tasks.id})`,
  })
  .from(tasks)
  .innerJoin(missions, eq(tasks.missionId, missions.id))
  .where(
    and(
      eq(missions.habitatId, habitatId),
      eq(tasks.status, 'pending'),
      sql`EXISTS (
        SELECT 1 FROM task_dependencies td
        INNER JOIN tasks dep ON td.depends_on_id = dep.id
        WHERE td.task_id = ${tasks.id} AND dep.status NOT IN ('approved', 'done')
      )`
    )
  )
  .all();

  for (const row of blockedRows) {
    const depCountRow = db.select({ count: sql<number>`count(*)` })
      .from(taskDependencies)
      .innerJoin(tasks, eq(taskDependencies.dependsOnId, tasks.id))
      .where(
        and(
          eq(taskDependencies.taskId, row.id),
          notInArray(tasks.status, ['approved', 'done'])
        )
      )
      .get();
    const unmetCount = depCountRow?.count ?? 0;

    const severity: AtRiskTask['severity'] = unmetCount > 2 ? 'high' : 'medium';

    atRisk.push({
      taskId: row.id,
      taskTitle: row.title,
      reason: 'blocked_by_dependency',
      severity,
      details: `Blocked by ${unmetCount} unmet dependenc${unmetCount === 1 ? 'y' : 'ies'}`,
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

export function getPredictions(habitatId: string): PredictionResponse {
  const velocity = calculateVelocity(habitatId);
  const estimates = estimateCompletionDates(habitatId, velocity);
  const atRiskTasks = detectAtRiskTasks(habitatId, estimates);
  return { velocity, estimates, atRiskTasks };
}

export function getBurndown(habitatId: string, days: number, options?: { sprintId?: string }): BurndownResponse {
  const db = getDb();
  const now = new Date();
  const msDay = 24 * 60 * 60 * 1000;

  const sprintFilter = options?.sprintId ? eq(missions.sprintId, options.sprintId) : undefined;

  let startDate: Date;
  let effectiveDays: number;

  if (options?.sprintId) {
    const sprintRow = db.select({ startDate: sprints.startDate, endDate: sprints.endDate }).from(sprints).where(eq(sprints.id, options.sprintId)).get();
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

  const endDate = now;

  const baseConditions = [eq(missions.habitatId, habitatId)];
  if (sprintFilter) baseConditions.push(sprintFilter);

  const totalRow = db.select({ count: sql<number>`count(*)` }).from(tasks).innerJoin(missions, eq(tasks.missionId, missions.id)).where(and(...baseConditions)).get();
  const totalTasks = totalRow?.count ?? 0;

  const completedRow = db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(and(...baseConditions, inArray(tasks.status, ['approved', 'done'])))
    .get();
  const completedTasks = completedRow?.count ?? 0;

  const remainingTasks = totalTasks - completedTasks;

  const dayExpr = dateDayExpr(tasks.completedAt);
  const dailyCompletedRows = db.select({
    date: dayExpr,
    count: sql<number>`count(*)`,
  })
  .from(tasks)
  .innerJoin(missions, eq(tasks.missionId, missions.id))
  .where(
    and(
      ...baseConditions,
      inArray(tasks.status, ['approved', 'done']),
      isNotNull(tasks.completedAt),
      sql`${tasks.completedAt} >= ${startDate.toISOString()}`
    )
  )
  .groupBy(dayExpr)
  .orderBy(dayExpr)
  .all();

  const completedByDate: Record<string, number> = {};
  for (const row of dailyCompletedRows) {
    completedByDate[row.date as string] = row.count;
  }

  const cumulativeRow = db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .innerJoin(missions, eq(tasks.missionId, missions.id))
    .where(
      and(
        ...baseConditions,
        inArray(tasks.status, ['approved', 'done']),
        isNotNull(tasks.completedAt),
        sql`${tasks.completedAt} < ${startDate.toISOString()}`
      )
    )
    .get();
  let cumulativeCompleted = cumulativeRow?.count ?? 0;

  const data: BurndownDataPoint[] = [];
  const idealPerDay = totalTasks > 0 ? totalTasks / effectiveDays : 0;

  for (let i = 0; i <= effectiveDays; i++) {
    const currentDate = new Date(startDate.getTime() + i * msDay);
    const dateStr = currentDate.toISOString().split('T')[0];

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

  const completedInPeriod = cumulativeCompleted - (totalTasks - remainingTasks - (cumulativeCompleted - completedTasks));
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
