import { getDb } from '../db/index.js';
import { boardHealthSnapshots } from '../db/schema/index.js';
import { desc, eq, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';
import * as capacityService from './capacityService.js';
import * as anomalyService from './anomalyService.js';
import * as predictionService from './predictionService.js';
import * as timeTrackingService from './timeTrackingService.js';
import * as timeTrackingRepo from '../repositories/timeTracking.js';
import * as eventDashboard from '../repositories/events/event-dashboard.js';

export interface HealthDimensions {
  flow: {
    score: number;
    cycleTimeTrend: number;
    throughputTrend: number;
    wipUtilization: number;
  };
  quality: {
    score: number;
    rejectionRate: number;
    estimationAccuracy: number;
    onTimeCompletionRate: number;
  };
  delivery: {
    score: number;
    overdueTasks: number;
    atRiskTasks: number;
    slaCompliance: number;
  };
  capacity: {
    score: number;
    agentUtilization: number;
    agentAvailability: number;
    backlogToAgentRatio: number;
  };
  stability: {
    score: number;
    anomalyCount: number;
    criticalAnomalies: number;
    staleTaskCount: number;
  };
}

export interface BoardHealthReport {
  boardId: string;
  score: number;
  grade: string;
  dimensions: HealthDimensions;
  recommendations: string[];
  snapshotAt: string;
}

function getGrade(score: number): string {
  if (score >= 90) return 'A';
  if (score >= 75) return 'B';
  if (score >= 60) return 'C';
  if (score >= 40) return 'D';
  return 'F';
}

function computeFlowScore(boardId: string): { score: number; cycleTimeTrend: number; throughputTrend: number; wipUtilization: number } {
  const metrics = timeTrackingRepo.getBoardMetrics(boardId);

  const cycleTimeTrend = 0;
  const throughputTrend = 0;

  let wipScore = 70;
  let wipUtilization = 0;
  try {
    const dashboardStats = eventDashboard.getDashboardStats(boardId) as any;
    if (dashboardStats?.wipHealth) {
      const wipValues = Object.values(dashboardStats.wipHealth) as string[];
      const exceeded = wipValues.filter((v: string) => v === 'exceeded').length;
      const warning = wipValues.filter((v: string) => v === 'warning').length;
      const ok = wipValues.filter((v: string) => v === 'ok').length;
      const total = wipValues.length;

      if (total > 0) {
        const exceededRatio = exceeded / total;
        const warningRatio = warning / total;
        wipUtilization = (exceeded + warning * 0.5) / total;
        if (exceededRatio >= 0.5) wipScore = 20;
        else if (exceededRatio >= 0.2 || warningRatio >= 0.5) wipScore = 60;
        else wipScore = 100;
      }
    }
  } catch {}

  const flowScore = Math.round((70 + wipScore) / 2);
  return { score: flowScore, cycleTimeTrend, throughputTrend, wipUtilization };
}

function computeQualityScore(boardId: string): { score: number; rejectionRate: number; estimationAccuracy: number; onTimeCompletionRate: number } {
  const metrics = timeTrackingRepo.getBoardMetrics(boardId);
  let rejectionRate = 0;
  let estimationAccuracy = metrics.averageEstimationAccuracy || 1;
  const onTimeCompletionRate = metrics.onTimeCompletionRate;

  try {
    const dashboardStats = eventDashboard.getDashboardStats(boardId) as any;
    if (dashboardStats?.rejectionRate && typeof dashboardStats.rejectionRate !== 'object') {
      rejectionRate = dashboardStats.rejectionRate;
    }
  } catch {}

  let rejectionScore = 100;
  if (rejectionRate >= 0.25) rejectionScore = 30;
  else if (rejectionRate >= 0.1) rejectionScore = 70;

  let accuracyScore = 100;
  if (estimationAccuracy < 0.5 || estimationAccuracy > 2.0) accuracyScore = 50;
  else if (estimationAccuracy < 0.7 || estimationAccuracy > 1.5) accuracyScore = 75;

  let onTimeScore = 100;
  if (onTimeCompletionRate < 0.5) onTimeScore = 40;
  else if (onTimeCompletionRate < 0.8) onTimeScore = 70;

  const qualityScore = Math.round((rejectionScore + accuracyScore + onTimeScore) / 3);
  return { score: qualityScore, rejectionRate, estimationAccuracy, onTimeCompletionRate };
}

function computeDeliveryScore(boardId: string): { score: number; overdueTasks: number; atRiskTasks: number; slaCompliance: number } {
  const metrics = timeTrackingRepo.getBoardMetrics(boardId);
  const overdueTasks = metrics.overdueTasks;

  let atRiskTasks = 0;
  let slaCompliance = 1;
  try {
    const predictions = predictionService.getPredictions(boardId);
    atRiskTasks = predictions.atRiskTasks.length;
  } catch {}

  let overdueScore = 100;
  if (overdueTasks >= 5) overdueScore = 30;
  else if (overdueTasks >= 1) overdueScore = 70;

  let atRiskScore = 100;
  if (atRiskTasks >= 5) atRiskScore = 30;
  else if (atRiskTasks >= 1) atRiskScore = 70;

  const deliveryScore = Math.round((overdueScore + atRiskScore + 100) / 3);
  return { score: deliveryScore, overdueTasks, atRiskTasks, slaCompliance };
}

function computeCapacityScore(boardId: string): { score: number; agentUtilization: number; agentAvailability: number; backlogToAgentRatio: number } {
  let agentUtilization = 0;
  let agentAvailability = 0;
  let backlogToAgentRatio = 0;

  try {
    const capacity = capacityService.getCapacityReport(boardId);
    if (capacity) {
      agentUtilization = capacity.summary.averageUtilization;
      agentAvailability = capacity.summary.totalAvailable;
    }
  } catch {}

  let utilScore = 100;
  if (agentUtilization > 0.9 || agentUtilization < 0.4) utilScore = 40;
  else if (agentUtilization < 0.6 || agentUtilization > 0.8) utilScore = 70;

  let availScore = 100;
  if (agentAvailability === 0) availScore = 50;

  const capacityScore = Math.round((utilScore + availScore + 70) / 3);
  return { score: capacityScore, agentUtilization, agentAvailability, backlogToAgentRatio };
}

function computeStabilityScore(boardId: string): { score: number; anomalyCount: number; criticalAnomalies: number; staleTaskCount: number } {
  let anomalyCount = 0;
  let criticalAnomalies = 0;
  let staleTaskCount = 0;

  try {
    const anomalies = anomalyService.scanBoard(boardId);
    anomalyCount = anomalies.length;
    criticalAnomalies = anomalies.filter(a => a.severity === 'critical').length;
    staleTaskCount = anomalies.filter(a => a.type === 'stale_in_progress').length;
  } catch {}

  let anomalyScore = 100;
  if (anomalyCount >= 5) anomalyScore = 30;
  else if (anomalyCount >= 1) anomalyScore = 70;

  let criticalScore = 100;
  if (criticalAnomalies > 0) criticalScore = 40;

  let staleScore = 100;
  if (staleTaskCount >= 5) staleScore = 30;
  else if (staleTaskCount >= 1) staleScore = 60;

  const stabilityScore = Math.round((anomalyScore + criticalScore + staleScore) / 3);
  return { score: stabilityScore, anomalyCount, criticalAnomalies, staleTaskCount };
}

function generateRecommendations(score: number, dimensions: HealthDimensions): string[] {
  const recs: string[] = [];

  if (dimensions.quality.rejectionRate >= 0.1) {
    recs.push('High rejection rate — review task descriptions for clarity and check agent domain matching');
  }
  if (dimensions.delivery.overdueTasks >= 3) {
    recs.push('Multiple overdue tasks — consider reducing sprint scope or reassigning tasks');
  }
  if (dimensions.delivery.atRiskTasks >= 3) {
    recs.push('Several at-risk tasks detected — check for blockers or stalled work');
  }
  if (dimensions.capacity.agentAvailability === 0) {
    recs.push('All agents are busy — consider adding more agents or reducing workload');
  }
  if (dimensions.capacity.agentUtilization > 0.9) {
    recs.push('Agent utilization is very high — risk of burnout, consider redistributing tasks');
  }
  if (dimensions.capacity.agentUtilization < 0.3) {
    recs.push('Agent utilization is low — agents may be idle, check domain/capability matching');
  }
  if (dimensions.flow.wipUtilization >= 0.5) {
    recs.push('WIP limits are exceeded — finish current work before starting new tasks');
  }
  if (dimensions.stability.criticalAnomalies > 0) {
    recs.push('Critical anomalies detected — review and address immediately');
  }
  if (dimensions.stability.staleTaskCount >= 3) {
    recs.push('Multiple stale tasks — agents may have gone offline without releasing claims');
  }
  if (dimensions.quality.estimationAccuracy < 0.5) {
    recs.push('Poor estimation accuracy — tasks are taking 2x+ longer than estimated');
  }

  if (recs.length === 0 && score >= 90) {
    recs.push('Board is healthy — keep up the good work!');
  }

  return recs;
}

export function calculateHealth(boardId: string): BoardHealthReport {
  const flow = computeFlowScore(boardId);
  const quality = computeQualityScore(boardId);
  const delivery = computeDeliveryScore(boardId);
  const capacity = computeCapacityScore(boardId);
  const stability = computeStabilityScore(boardId);

  const score = Math.round(
    flow.score * 0.25 +
    quality.score * 0.25 +
    delivery.score * 0.20 +
    capacity.score * 0.15 +
    stability.score * 0.15
  );

  const grade = getGrade(score);
  const dimensions: HealthDimensions = { flow, quality, delivery, capacity, stability };
  const recommendations = generateRecommendations(score, dimensions);
  const snapshotAt = new Date().toISOString();

  const db = getDb();
  const id = uuid();

  try {
    db.insert(boardHealthSnapshots).values({
      id,
      boardId,
      score,
      grade: grade as 'A' | 'B' | 'C' | 'D' | 'F',
      dimensions: JSON.stringify(dimensions),
      metrics: JSON.stringify({
        flow,
        quality,
        delivery,
        capacity,
        stability,
      }),
      recommendations: JSON.stringify(recommendations),
      snapshotAt,
      createdAt: snapshotAt,
    }).run();
  } catch {}

  return { boardId, score, grade, dimensions, recommendations, snapshotAt };
}

export function getCurrentHealth(boardId: string): BoardHealthReport | null {
  const db = getDb();
  const row = db
    .select()
    .from(boardHealthSnapshots)
    .where(eq(boardHealthSnapshots.boardId, boardId))
    .orderBy(desc(boardHealthSnapshots.snapshotAt))
    .limit(1)
    .get();

  if (!row) return null;

  return {
    boardId: row.boardId,
    score: row.score,
    grade: row.grade,
    dimensions: JSON.parse(row.dimensions),
    recommendations: JSON.parse(row.recommendations),
    snapshotAt: row.snapshotAt,
  };
}

export function getHealthHistory(boardId: string, days = 30): BoardHealthReport[] {
  const db = getDb();
  const since = new Date(Date.now() - days * 86400000).toISOString();

  const rows = db
    .select()
    .from(boardHealthSnapshots)
    .where(
      sql`${boardHealthSnapshots.boardId} = ${boardId} AND ${boardHealthSnapshots.snapshotAt} >= ${since}`
    )
    .orderBy(desc(boardHealthSnapshots.snapshotAt))
    .all();

  return rows.map(row => ({
    boardId: row.boardId,
    score: row.score,
    grade: row.grade,
    dimensions: JSON.parse(row.dimensions),
    recommendations: JSON.parse(row.recommendations),
    snapshotAt: row.snapshotAt,
  }));
}
