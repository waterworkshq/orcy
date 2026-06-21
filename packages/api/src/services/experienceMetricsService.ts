import type { ExperienceCategory } from "@orcy/shared";
import { daysAgoISO } from "./analyticsDate.js";
import {
  getExperienceSignalRows,
  getTasksWorkedCounts,
  getAgentIdentities,
} from "../repositories/experienceMetrics.js";

/** All seven experience categories surfaced by the self-reporting convention. */
export const EXPERIENCE_CATEGORIES: readonly ExperienceCategory[] = [
  "stuck",
  "confused",
  "backtrack",
  "surprised",
  "ambiguous",
  "sidetracked",
  "smooth",
];

/** Multiplier above the habitat median that flags an agent as a high reporter. */
export const HIGH_REPORTER_THRESHOLD = 2;

/** Fraction of the habitat median below which an agent is flagged as a low reporter. */
export const LOW_REPORTER_THRESHOLD = 0.5;

/** Outlier label assigned when an agent reports far more or fewer signals than the habitat median. */
export type OutlierFlag = "high_reporter" | "low_reporter" | null;

/** Per-agent experience signal metrics assembled for the admin dashboard. */
export interface AgentExperienceMetrics {
  agentId: string;
  agentName: string;
  agentType: string;
  agentDomain: string;
  signalCount: number;
  tasksWorked: number;
  signalsTaskRatio: number;
  categoryDistribution: Partial<Record<ExperienceCategory, number>>;
  midTaskCount: number;
  completionCount: number;
  midTaskCompletionRatio: number;
  outlierFlag: OutlierFlag;
}

/** Full experience metrics response returned by the admin route. */
export interface ExperienceMetricsResult {
  agents: AgentExperienceMetrics[];
  medianSignalsTaskRatio: number;
  generatedAt: string;
}

/** Returns the median of a list of numbers using the average-of-middle-pair rule for even-length inputs. */
export function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = values.toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

/** Classifies a ratio against the habitat median into an outlier flag, or null when within the normal band. */
export function classifyOutlier(ratio: number, medianRatio: number): OutlierFlag {
  if (medianRatio <= 0) return null;
  if (ratio > medianRatio * HIGH_REPORTER_THRESHOLD) return "high_reporter";
  if (ratio < medianRatio * LOW_REPORTER_THRESHOLD) return "low_reporter";
  return null;
}

/** Computes per-agent experience signal metrics for a habitat within a trailing-day window (default 30 days; 0 or undefined disables the time filter). */
export function getExperienceMetrics(habitatId: string, days = 30): ExperienceMetricsResult {
  const since = days && days > 0 ? daysAgoISO(days) : undefined;

  const signalRows = getExperienceSignalRows(habitatId, since);
  const taskCounts = getTasksWorkedCounts(habitatId, since);

  const tasksByAgent = new Map<string, number>();
  for (const row of taskCounts) {
    tasksByAgent.set(row.assignedAgentId, row.total);
  }

  const agentAggregations = new Map<
    string,
    {
      signalCount: number;
      categoryDistribution: Partial<Record<ExperienceCategory, number>>;
      midTaskCount: number;
      completionCount: number;
    }
  >();

  for (const row of signalRows) {
    let agg = agentAggregations.get(row.fromId);
    if (!agg) {
      agg = {
        signalCount: 0,
        categoryDistribution: {},
        midTaskCount: 0,
        completionCount: 0,
      };
      agentAggregations.set(row.fromId, agg);
    }
    agg.signalCount += 1;
    if (row.experience) {
      agg.categoryDistribution[row.experience] =
        (agg.categoryDistribution[row.experience] ?? 0) + 1;
    }
    if (row.timing === "mid_task") agg.midTaskCount += 1;
    else if (row.timing === "completion") agg.completionCount += 1;
  }

  const agentIds = [...agentAggregations.keys()];
  const identities = getAgentIdentities(agentIds);
  const identityMap = new Map(identities.map((i) => [i.id, i]));

  const ratios: number[] = [];
  const agents: AgentExperienceMetrics[] = [];

  for (const [agentId, agg] of agentAggregations) {
    const tasksWorked = tasksByAgent.get(agentId) ?? 0;
    const ratio = tasksWorked > 0 ? agg.signalCount / tasksWorked : 0;
    const identity = identityMap.get(agentId);
    ratios.push(ratio);
    agents.push({
      agentId,
      agentName: identity?.name ?? agentId,
      agentType: identity?.type ?? "unknown",
      agentDomain: identity?.domain ?? "unknown",
      signalCount: agg.signalCount,
      tasksWorked,
      signalsTaskRatio: Math.round(ratio * 100) / 100,
      categoryDistribution: agg.categoryDistribution,
      midTaskCount: agg.midTaskCount,
      completionCount: agg.completionCount,
      midTaskCompletionRatio:
        agg.completionCount > 0
          ? Math.round((agg.midTaskCount / agg.completionCount) * 100) / 100
          : agg.midTaskCount,
      outlierFlag: null,
    });
  }

  const medianRatio = median(ratios);
  for (const agent of agents) {
    agent.outlierFlag = classifyOutlier(agent.signalsTaskRatio, medianRatio);
  }

  agents.sort((a, b) => b.signalsTaskRatio - a.signalsTaskRatio);

  return {
    agents,
    medianSignalsTaskRatio: Math.round(medianRatio * 100) / 100,
    generatedAt: new Date().toISOString(),
  };
}
