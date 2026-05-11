import { getDb } from '../db/index.js';
import { tasks, features, agents, users, taskEvents } from '../db/schema/index.js';
import { eq, and, sql, isNotNull, notInArray, inArray, desc, ne } from 'drizzle-orm';
import { cycleTimeMinutes } from '../db/dialect-helpers.js';
import * as boardRepo from '../repositories/board.js';
import * as taskRepo from '../repositories/task.js';
import * as featureRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import * as emailService from './emailService.js';
import * as chatService from './chatService.js';
import { logger } from '../lib/logger.js';
import type { Anomaly, AnomalySettings, Board } from '../models/index.js';

const DEFAULT_SETTINGS: AnomalySettings = {
  enabled: true,
  scanIntervalMinutes: 5,
  thresholds: {
    staleInProgressMinutes: 240,
    rejectionRatePercent: 40,
    rejectionWindowTasks: 10,
    cycleTimeIncreasePercent: 50,
    backlogToAgentRatio: 2,
    agentOfflineMinutes: 15,
  },
  notifications: {
    email: true,
    sse: true,
    chat: true,
  },
};

export function getDefaultAnomalySettings(): AnomalySettings {
  return { ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds }, notifications: { ...DEFAULT_SETTINGS.notifications } };
}

export function getAnomalySettings(boardId: string): AnomalySettings {
  const board = boardRepo.getBoardById(boardId);
  if (!board) return getDefaultAnomalySettings();
  return board.anomalySettings ?? getDefaultAnomalySettings();
}

export interface AnomalyResult {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  message: string;
  data: Record<string, unknown>;
}

export function detectStaleInProgress(boardId: string, settings: AnomalySettings): AnomalyResult[] {
  const db = getDb();
  const thresholdMs = settings.thresholds.staleInProgressMinutes * 60 * 1000;
  const now = Date.now();

  const boardFeatureIds = db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.boardId, boardId))
    .all()
    .map(f => f.id);

  if (boardFeatureIds.length === 0) return [];

  const rows = db.select({
    id: tasks.id,
    title: tasks.title,
    startedAt: tasks.startedAt,
    assignedAgentId: tasks.assignedAgentId,
  })
  .from(tasks)
  .where(and(inArray(tasks.featureId, boardFeatureIds), eq(tasks.status, 'in_progress'), isNotNull(tasks.startedAt)))
  .all();

  const anomalies: AnomalyResult[] = [];
  for (const row of rows) {
    const elapsed = now - new Date(row.startedAt!).getTime();
    if (elapsed > thresholdMs) {
      const elapsedMinutes = Math.round(elapsed / 60000);
      let severity: AnomalyResult['severity'] = 'low';
      if (elapsedMinutes > settings.thresholds.staleInProgressMinutes * 3) severity = 'critical';
      else if (elapsedMinutes > settings.thresholds.staleInProgressMinutes * 2) severity = 'high';
      else severity = 'medium';

      anomalies.push({
        type: 'stale_in_progress',
        severity,
        message: `Task "${row.title}" has been in progress for ${elapsedMinutes} minutes (threshold: ${settings.thresholds.staleInProgressMinutes}m)`,
        data: { taskId: row.id, taskTitle: row.title, elapsedMinutes, agentId: row.assignedAgentId },
      });
    }
  }
  return anomalies;
}

export function detectRejectionSpike(boardId: string, settings: AnomalySettings): AnomalyResult[] {
  const db = getDb();
  const windowSize = settings.thresholds.rejectionWindowTasks;

  const boardFeatureIds = db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.boardId, boardId))
    .all()
    .map(f => f.id);

  if (boardFeatureIds.length === 0) return [];

  const rows = db.select({
    id: tasks.id,
    title: tasks.title,
    status: tasks.status,
    rejectedCount: tasks.rejectedCount,
  })
  .from(tasks)
  .where(inArray(tasks.featureId, boardFeatureIds))
  .orderBy(desc(tasks.updatedAt))
  .limit(windowSize)
  .all();

  let rejectedCount = 0;
  let total = 0;
  for (const row of rows) {
    total++;
    if (row.status === 'rejected' || row.rejectedCount > 0) rejectedCount++;
  }

  if (total < 3) return [];

  const rejectionRate = (rejectedCount / total) * 100;
  if (rejectionRate > settings.thresholds.rejectionRatePercent) {
    const severity: AnomalyResult['severity'] = rejectionRate > 70 ? 'critical' : rejectionRate > 55 ? 'high' : 'medium';
    return [{
      type: 'rejection_spike',
      severity,
      message: `Rejection rate is ${Math.round(rejectionRate)}% over last ${total} tasks (threshold: ${settings.thresholds.rejectionRatePercent}%)`,
      data: { rejectionRate: Math.round(rejectionRate), rejectedCount, totalTasks: total },
    }];
  }
  return [];
}

export function detectCycleTimeDegradation(boardId: string, settings: AnomalySettings): AnomalyResult[] {
  const db = getDb();
  const now = new Date();
  const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000).toISOString();

  const boardFeatureIds = db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.boardId, boardId))
    .all()
    .map(f => f.id);

  if (boardFeatureIds.length === 0) return [];

  function getAvgCycleTime(since: string, until: string): number {
    const ctExpr = cycleTimeMinutes(tasks.completedAt, tasks.claimedAt);
    const row = db.select({
      avgMinutes: sql<number>`avg(${ctExpr})`
    })
    .from(tasks)
    .where(
      and(
        inArray(tasks.featureId, boardFeatureIds),
        isNotNull(tasks.claimedAt),
        isNotNull(tasks.completedAt),
        inArray(tasks.status, ['approved', 'done']),
        sql`${tasks.completedAt} >= ${since}`,
        sql`${tasks.completedAt} < ${until}`
      )
    )
    .get();
    return row?.avgMinutes ?? 0;
  }

  const recentCycle = getAvgCycleTime(sevenDaysAgo, now.toISOString());
  const previousCycle = getAvgCycleTime(fourteenDaysAgo, sevenDaysAgo);

  if (previousCycle === 0 || recentCycle === 0) return [];

  const increasePercent = ((recentCycle - previousCycle) / previousCycle) * 100;
  if (increasePercent > settings.thresholds.cycleTimeIncreasePercent) {
    const severity: AnomalyResult['severity'] = increasePercent > 100 ? 'critical' : increasePercent > 75 ? 'high' : 'medium';
    return [{
      type: 'cycle_time_increase',
      severity,
      message: `Average cycle time increased by ${Math.round(increasePercent)}% (${Math.round(previousCycle)}m → ${Math.round(recentCycle)}m)`,
      data: { increasePercent: Math.round(increasePercent), previousAvgMinutes: Math.round(previousCycle), recentAvgMinutes: Math.round(recentCycle) },
    }];
  }
  return [];
}

export function detectBacklogGrowth(boardId: string, settings: AnomalySettings): AnomalyResult[] {
  const db = getDb();

  const boardFeatureIds = db
    .select({ id: features.id })
    .from(features)
    .where(eq(features.boardId, boardId))
    .all()
    .map(f => f.id);

  if (boardFeatureIds.length === 0) return [];

  const pendingRow = db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(inArray(tasks.featureId, boardFeatureIds), inArray(tasks.status, ['pending', 'claimed'])))
    .get();
  const pendingCount = pendingRow?.count ?? 0;

  const agentRow = db.select({ count: sql<number>`count(distinct ${tasks.assignedAgentId})` })
    .from(tasks)
    .where(
      and(
        inArray(tasks.featureId, boardFeatureIds),
        inArray(tasks.status, ['claimed', 'in_progress', 'submitted']),
        isNotNull(tasks.assignedAgentId)
      )
    )
    .get();
  const activeAgents = agentRow?.count ?? 0;

  if (activeAgents === 0) return [];

  const ratio = pendingCount / activeAgents;
  if (ratio > settings.thresholds.backlogToAgentRatio) {
    const severity: AnomalyResult['severity'] = ratio > settings.thresholds.backlogToAgentRatio * 3 ? 'critical' : ratio > settings.thresholds.backlogToAgentRatio * 2 ? 'high' : 'medium';
    return [{
      type: 'backlog_growth',
      severity,
      message: `Pending tasks (${pendingCount}) exceed ${settings.thresholds.backlogToAgentRatio}x active agents (${activeAgents})`,
      data: { pendingCount, activeAgents, ratio: Math.round(ratio * 10) / 10 },
    }];
  }
  return [];
}

export function detectAgentOffline(boardId: string, settings: AnomalySettings): AnomalyResult[] {
  const db = getDb();
  const thresholdMs = settings.thresholds.agentOfflineMinutes * 60 * 1000;
  const now = Date.now();

  const agentRows = db.select({
    id: agents.id,
    name: agents.name,
    lastHeartbeat: agents.lastHeartbeat,
  })
  .from(agents)
  .where(ne(agents.status, 'offline'))
  .all();

  const anomalies: AnomalyResult[] = [];
  for (const row of agentRows) {
    const elapsed = now - new Date(row.lastHeartbeat).getTime();
    if (elapsed > thresholdMs) {
      const elapsedMinutes = Math.round(elapsed / 60000);
      const severity: AnomalyResult['severity'] = elapsedMinutes > settings.thresholds.agentOfflineMinutes * 4 ? 'critical' : elapsedMinutes > settings.thresholds.agentOfflineMinutes * 2 ? 'high' : 'medium';

      const taskRow = db.select({ count: sql<number>`count(*)` })
        .from(tasks)
        .where(and(eq(tasks.assignedAgentId, row.id), inArray(tasks.status, ['claimed', 'in_progress'])))
        .get();
      const activeTasks = taskRow?.count ?? 0;

      anomalies.push({
        type: 'agent_offline',
        severity,
        message: `Agent "${row.name}" has been offline for ${elapsedMinutes} minutes (threshold: ${settings.thresholds.agentOfflineMinutes}m)`,
        data: { agentId: row.id, agentName: row.name, elapsedMinutes, activeTasks },
      });
    }
  }
  return anomalies;
}

export function detectAnomalies(boardId: string): AnomalyResult[] {
  const settings = getAnomalySettings(boardId);
  if (!settings.enabled) return [];

  return [
    ...detectStaleInProgress(boardId, settings),
    ...detectRejectionSpike(boardId, settings),
    ...detectCycleTimeDegradation(boardId, settings),
    ...detectBacklogGrowth(boardId, settings),
    ...detectAgentOffline(boardId, settings),
  ];
}

export function scanBoard(boardId: string): AnomalyResult[] {
  const settings = getAnomalySettings(boardId);
  if (!settings.enabled) return [];

  const anomalies = detectAnomalies(boardId);
  if (anomalies.length === 0) return [];

  const board = boardRepo.getBoardById(boardId);
  const boardName = board?.name ?? 'Unknown Board';
  const now = new Date().toISOString();

  for (const anomaly of anomalies) {
    if (settings.notifications.sse) {
      sseBroadcaster.publish(boardId, {
        type: 'anomaly.detected',
        data: { ...anomaly, boardId, detectedAt: now },
      });
    }

    if (settings.notifications.email && emailService.isConfigured() && (anomaly.severity === 'high' || anomaly.severity === 'critical')) {
      sendAnomalyEmails(boardId, boardName, anomaly);
    }

    if (settings.notifications.chat) {
      chatService.sendAnomalyAlert(boardId, anomaly).catch((err) => {
        logger.error({ err, boardId, anomalyType: anomaly.type }, 'Failed to send anomaly chat notification');
      });
    }
  }

  return anomalies;
}

function sendAnomalyEmails(boardId: string, boardName: string, anomaly: AnomalyResult): void {
  const db = getDb();
  const adminRows = db.select({ id: users.id, email: users.email })
    .from(users)
    .where(eq(users.role, 'admin'))
    .all();
  for (const row of adminRows) {
    if (!row.email) continue;
    const payload = emailService.anomalyAlertTemplate(anomaly.type, anomaly.severity, anomaly.message, boardName);
    payload.to = row.email;
    emailService.sendEmail(payload).catch(err => {
      logger.error({ err, boardId, anomalyType: anomaly.type }, 'Failed to send anomaly email');
    });
  }
}

export function scanAllBoards(): { boardId: string; anomalies: AnomalyResult[] }[] {
  const boards = boardRepo.listBoards();
  const results: { boardId: string; anomalies: AnomalyResult[] }[] = [];

  for (const board of boards) {
    const anomalies = scanBoard(board.id);
    if (anomalies.length > 0) {
      results.push({ boardId: board.id, anomalies });
    }
  }

  return results;
}
