import { scoreTask } from './taskScoring.js';
import * as taskRepo from '../repositories/task.js';
import * as featureRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import { getDb } from '../db/index.js';
import { tasks, features } from '../db/schema.js';
import { eq, and, sql, inArray } from 'drizzle-orm';
import type { Task, Agent } from '../models/index.js';

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export interface SuggestionFactors {
  priorityWeight: number;
  urgencyWeight: number;
  capabilityWeight: number;
  dependencyBonus: number;
  specializationBonus: number;
  workloadPenalty: number;
  stalePickupBonus: number;
}

export interface TaskSuggestion {
  taskId: string;
  taskTitle: string;
  featureId: string;
  featureTitle: string;
  score: number;
  reasons: string[];
  factors: SuggestionFactors;
}

export interface AgentWorkload {
  claimed: number;
  inProgress: number;
  maxRecommended: number;
}

export interface SuggestionResult {
  suggestions: TaskSuggestion[];
  agentWorkload: AgentWorkload;
}

export function getSuggestionsForAgent(
  boardId: string,
  agentId: string,
  limit: number = 5
): SuggestionResult {
  const agent = agentRepo.getAgentById(agentId);
  if (!agent) {
    return { suggestions: [], agentWorkload: { claimed: 0, inProgress: 0, maxRecommended: 3 } };
  }

  const availableTasks = taskRepo.getAvailableTasksForAgent(
    boardId,
    agent.domain,
    { status: 'pending' }
  );

  const { claimed, inProgress } = getAgentWorkload(agentId);
  const featureMap = new Map<string, string>();

  for (const task of availableTasks) {
    if (!featureMap.has(task.featureId)) {
      const feature = featureRepo.getFeatureById(task.featureId);
      if (feature) featureMap.set(task.featureId, feature.title);
    }
  }

  const suggestions: TaskSuggestion[] = availableTasks
    .map(task => scoreWithFactors(task, agent, claimed, inProgress, featureMap))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return {
    suggestions,
    agentWorkload: { claimed, inProgress, maxRecommended: 3 },
  };
}

function scoreWithFactors(
  task: Task,
  agent: Omit<Agent, 'apiKeyHash'>,
  claimedCount: number,
  inProgressCount: number,
  featureMap: Map<string, string>
): TaskSuggestion {
  const reasons: string[] = [];
  const baseScore = scoreTask(task, agent.domain, agent.capabilities);

  const factors: SuggestionFactors = {
    priorityWeight: getPriorityContribution(task),
    urgencyWeight: 0,
    capabilityWeight: getCapabilityContribution(task, agent.domain, agent.capabilities),
    dependencyBonus: 0,
    specializationBonus: 0,
    workloadPenalty: 0,
    stalePickupBonus: 0,
  };

  let totalScore = baseScore;

  const workloadTotal = claimedCount + inProgressCount;
  if (workloadTotal > 1) {
    const penalty = (workloadTotal - 1) * 10;
    factors.workloadPenalty = -penalty;
    totalScore -= penalty;
    reasons.push(`Agent has ${workloadTotal} active tasks`);
  }

  if (task.requiredDomain && task.requiredDomain === agent.domain) {
    factors.specializationBonus = 20;
    totalScore += 20;
    reasons.push(`Domain match: ${agent.domain}`);
  }

  const staleBonus = computeStalePickupBonus(task);
  if (staleBonus > 0) {
    factors.stalePickupBonus = staleBonus;
    totalScore += staleBonus;
    reasons.push('Task pending >24h without claims');
  }

  if (task.priority === 'critical') reasons.push('Critical priority');
  else if (task.priority === 'high') reasons.push('High priority');

  if (reasons.length === 0) reasons.push('Available task matching criteria');

  return {
    taskId: task.id,
    taskTitle: task.title,
    featureId: task.featureId,
    featureTitle: featureMap.get(task.featureId) ?? 'Unknown feature',
    score: Math.round(totalScore),
    reasons,
    factors,
  };
}

function getPriorityContribution(task: Task): number {
  const weights: Record<string, number> = { critical: 40, high: 30, medium: 20, low: 10 };
  return weights[task.priority] ?? 20;
}

function getCapabilityContribution(task: Task, domain?: string, capabilities?: string[]): number {
  if (!domain && !capabilities) return 0;
  let weight = 0;
  if (domain && task.requiredDomain && task.requiredDomain === domain) weight += 10;
  if (capabilities && task.requiredCapabilities && task.requiredCapabilities.length > 0) {
    const agentCapSet = new Set(capabilities.map(c => c.toLowerCase()));
    const matched = task.requiredCapabilities.filter(c => agentCapSet.has(c.toLowerCase()));
    weight += Math.min(matched.length * 5, 10);
  }
  return weight;
}

function computeStalePickupBonus(task: Task): number {
  const ageMs = Date.now() - new Date(task.createdAt).getTime();
  if (ageMs > MS_PER_DAY && !task.assignedAgentId && task.status === 'pending') return 5;
  return 0;
}

function getAgentWorkload(agentId: string): { claimed: number; inProgress: number } {
  const db = getDb();
  const claimedRow = db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.assignedAgentId, agentId), eq(tasks.status, 'claimed')))
    .get();

  const inProgressRow = db.select({ count: sql<number>`count(*)` })
    .from(tasks)
    .where(and(eq(tasks.assignedAgentId, agentId), eq(tasks.status, 'in_progress')))
    .get();

  return { claimed: claimedRow?.count ?? 0, inProgress: inProgressRow?.count ?? 0 };
}
