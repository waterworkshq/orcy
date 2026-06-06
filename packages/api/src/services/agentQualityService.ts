import { and, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../db/index.js";
import {
  agents,
  codeEvidenceCompleteness,
  codeEvidenceGaps,
  codeEvidenceLinks,
  missions,
  taskEvents,
  tasks,
} from "../db/schema/index.js";
import * as effortRepo from "../repositories/effortEntry.js";
import {
  daysAgoISO,
  utcNowISO,
  confidenceForSample,
  type AnalyticsConfidence,
} from "./analyticsDate.js";

export type AgentQualityConfidence = AnalyticsConfidence;

export interface AgentQualityInputs {
  agentId: string;
  agentName: string;
  completedTasks: number;
  approvedEvents: number;
  rejectedEvents: number;
  totalRejections: number;
  cycleTimeSamples: number[];
  estimateAccuracySamples: number[];
  evidenceCompletenessSamples: Array<0 | 0.5 | 1>;
}

export interface AgentQualitySignal {
  agentId: string;
  agentName: string;
  score: number | null;
  confidence: AgentQualityConfidence;
  sampleSize: number;
  dimensions: {
    approval: number | null;
    nonRejectionRate: number | null;
    consistency: number | null;
    cycleDataCompleteness: number | null;
    estimateAccuracy: number | null;
    evidenceCompleteness: number | null;
  };
  warnings: string[];
}

export interface AgentQualityResponse {
  habitatId: string;
  generatedAt: string;
  signals: AgentQualitySignal[];
}

const COMPLETE_STATUSES = ["approved", "done"] as const;

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function average(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values: number[]): number | null {
  const avg = average(values);
  if (avg === null || values.length < 2) return null;
  const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

function cycleMinutes(task: {
  cycleTimeMinutes: number | null;
  claimedAt: string | null;
  completedAt: string | null;
}): number | null {
  if (task.cycleTimeMinutes !== null && task.cycleTimeMinutes >= 0) return task.cycleTimeMinutes;
  if (!task.claimedAt || !task.completedAt) return null;
  const start = new Date(task.claimedAt).getTime();
  const end = new Date(task.completedAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.round((end - start) / 60_000);
}

function estimateAccuracyScore(actualMinutes: number, estimatedMinutes: number): number {
  if (estimatedMinutes <= 0) return 0;
  const ratio = actualMinutes / estimatedMinutes;
  return round(Math.max(0, 1 - Math.abs(ratio - 1)));
}

function evidenceSamplesForTasks(taskIds: string[]): Map<string, 0 | 0.5 | 1> {
  const result = new Map<string, 0 | 0.5 | 1>();
  if (taskIds.length === 0) return result;
  const db = getDb();
  const idList = sql.join(taskIds, sql`, `);

  const linkedIds = new Set(
    db
      .select({ targetId: codeEvidenceLinks.targetId })
      .from(codeEvidenceLinks)
      .where(
        and(
          eq(codeEvidenceLinks.targetType, "task"),
          sql`${codeEvidenceLinks.targetId} IN (${idList})`,
          eq(codeEvidenceLinks.status, "active"),
        ),
      )
      .all()
      .map((r) => r.targetId),
  );

  const completenessMap = new Map(
    db
      .select({
        targetId: codeEvidenceCompleteness.targetId,
        status: codeEvidenceCompleteness.status,
      })
      .from(codeEvidenceCompleteness)
      .where(
        and(
          eq(codeEvidenceCompleteness.targetType, "task"),
          sql`${codeEvidenceCompleteness.targetId} IN (${idList})`,
        ),
      )
      .all()
      .map((r) => [r.targetId, r.status]),
  );

  for (const taskId of taskIds) {
    if (linkedIds.has(taskId)) {
      result.set(taskId, 1);
      continue;
    }
    const status = completenessMap.get(taskId);
    if (status === "complete" || status === "not_applicable") {
      result.set(taskId, 1);
      continue;
    }
    if (status === "partial") {
      result.set(taskId, 0.5);
      continue;
    }
    result.set(taskId, 0);
  }
  return result;
}

export function getAgentQualityInputs(
  habitatId: string,
  agentId?: string,
  windowDays = 90,
): AgentQualityInputs[] {
  const db = getDb();
  const agentQuery = db.select({ id: agents.id, name: agents.name }).from(agents);
  const agentRows = agentId ? agentQuery.where(eq(agents.id, agentId)).all() : agentQuery.all();
  const windowStart = daysAgoISO(windowDays);

  return agentRows.map((agent) => {
    const assignedTasks = db
      .select({
        id: tasks.id,
        status: tasks.status,
        rejectedCount: tasks.rejectedCount,
        estimatedMinutes: tasks.estimatedMinutes,
        cycleTimeMinutes: tasks.cycleTimeMinutes,
        claimedAt: tasks.claimedAt,
        completedAt: tasks.completedAt,
      })
      .from(tasks)
      .innerJoin(missions, eq(tasks.missionId, missions.id))
      .where(
        and(
          eq(missions.habitatId, habitatId),
          eq(tasks.assignedAgentId, agent.id),
          sql`${tasks.completedAt} >= ${windowStart}`,
        ),
      )
      .all();
    const completedTasks = assignedTasks.filter((task) =>
      COMPLETE_STATUSES.includes(task.status as "approved" | "done"),
    );
    const taskIds = assignedTasks.map((task) => task.id);

    const eventRows = taskIds.length
      ? db
          .select({ action: taskEvents.action, count: sql<number>`count(*)` })
          .from(taskEvents)
          .where(
            and(
              inArray(taskEvents.taskId, taskIds),
              inArray(taskEvents.action, ["approved", "rejected"]),
            ),
          )
          .groupBy(taskEvents.action)
          .all()
      : [];
    const approvedEvents = eventRows.find((row) => row.action === "approved")?.count ?? 0;
    const rejectedEvents = eventRows.find((row) => row.action === "rejected")?.count ?? 0;
    const totalRejections =
      assignedTasks.reduce((sum, task) => sum + task.rejectedCount, 0) + rejectedEvents;

    const cycleTimeSamples = completedTasks
      .map(cycleMinutes)
      .filter((value): value is number => value !== null && value >= 0);
    const completedTaskIds = completedTasks.map((t) => t.id);
    const completedEffort = effortRepo.getEffortTotalsForTasks(completedTaskIds);
    const completedEvidence = evidenceSamplesForTasks(completedTaskIds);

    const estimateAccuracySamples = completedTasks
      .map((task) => {
        if (!task.estimatedMinutes) return null;
        const totals = completedEffort.get(task.id);
        const correctedLogged =
          (totals?.loggedEffortMinutes ?? 0) + (totals?.correctionAdjustmentMinutes ?? 0);
        const actual =
          correctedLogged > 0 ? correctedLogged : (totals?.inferredPresenceMinutes ?? 0);
        return actual > 0 ? estimateAccuracyScore(actual, task.estimatedMinutes) : null;
      })
      .filter((value): value is number => value !== null);
    const evidenceCompletenessSamples = completedTasks.map(
      (task) => completedEvidence.get(task.id) ?? 0,
    );

    return {
      agentId: agent.id,
      agentName: agent.name,
      completedTasks: completedTasks.length,
      approvedEvents,
      rejectedEvents,
      totalRejections,
      cycleTimeSamples,
      estimateAccuracySamples,
      evidenceCompletenessSamples,
    };
  });
}

export function buildAgentQualitySignal(inputs: AgentQualityInputs): AgentQualitySignal {
  const sampleSize = inputs.completedTasks;
  const confidence = confidenceForSample(sampleSize);
  const reviewEvents = inputs.approvedEvents + inputs.rejectedEvents;
  const approval = reviewEvents > 0 ? round(inputs.approvedEvents / reviewEvents) : null;
  const nonRejectionRate =
    reviewEvents > 0 ? round(1 - inputs.rejectedEvents / reviewEvents) : null;
  const avgCycle = average(inputs.cycleTimeSamples);
  const cycleStdDev = standardDeviation(inputs.cycleTimeSamples);
  const consistency =
    avgCycle !== null && cycleStdDev !== null && avgCycle > 0
      ? round(Math.max(0, 1 - Math.min(cycleStdDev / avgCycle, 1)))
      : null;
  const cycleDataCompleteness =
    sampleSize > 0 ? round(inputs.cycleTimeSamples.length / sampleSize) : null;
  const estimateAccuracy = average(inputs.estimateAccuracySamples);
  const evidenceCompleteness = average(inputs.evidenceCompletenessSamples);
  const dimensions = {
    approval,
    nonRejectionRate,
    consistency,
    cycleDataCompleteness,
    estimateAccuracy: estimateAccuracy === null ? null : round(estimateAccuracy),
    evidenceCompleteness: evidenceCompleteness === null ? null : round(evidenceCompleteness),
  };
  const warnings: string[] = [];
  if (confidence === "insufficient_data") {
    warnings.push("Low confidence: not enough completed work yet.");
  }
  if (reviewEvents === 0)
    warnings.push("No approval/rejection review events found in this sample.");
  if (inputs.estimateAccuracySamples.length === 0) {
    warnings.push("Estimate accuracy is unavailable because effort or estimate data is missing.");
  }
  if (dimensions.evidenceCompleteness !== null && dimensions.evidenceCompleteness < 0.8) {
    warnings.push("Code evidence completeness is below the target range for this sample.");
  }
  if (inputs.totalRejections >= 3 || (nonRejectionRate !== null && nonRejectionRate < 0.7)) {
    warnings.push("High rejection rate in recent sample.");
  }

  const scoreInputs = Object.values(dimensions).filter((value): value is number => value !== null);
  const score =
    confidence === "insufficient_data" || scoreInputs.length === 0
      ? null
      : round(average(scoreInputs)!);
  return {
    agentId: inputs.agentId,
    agentName: inputs.agentName,
    score,
    confidence,
    sampleSize,
    dimensions,
    warnings,
  };
}

export function getAgentQualitySignals(habitatId: string, agentId?: string): AgentQualityResponse {
  const inputs = getAgentQualityInputs(habitatId, agentId);
  const signals = inputs
    .map(buildAgentQualitySignal)
    .toSorted((a, b) => a.agentName.localeCompare(b.agentName));
  return { habitatId, generatedAt: utcNowISO(), signals };
}
