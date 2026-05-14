import type { Task, TaskPriority } from '../models/index.js';
import * as featureRepo from '../repositories/feature.js';

export const PRIORITY_WEIGHTS: Record<TaskPriority, number> = {
  critical: 40,
  high: 30,
  medium: 20,
  low: 10,
};

const MS_PER_DAY = 86_400_000;
const MAX_AGE_WEIGHT = 10;
const AGE_WEIGHT_PER_DAY = 0.5;
const SLA_URGENCY_WEIGHT_MAX = 35;

export function scoreTask(
  task: Task,
  agentDomain?: string,
  agentCapabilities?: string[]
): number {
  const priorityWeight = PRIORITY_WEIGHTS[task.priority] ?? 20;
  const feature = task.featureId ? featureRepo.getFeatureById(task.featureId) : null;
  const urgencyWeight = computeUrgencyWeight(feature?.dueAt ?? null);
  const slaUrgencyWeight = computeSlaUrgencyWeight(feature?.slaDeadlineAt ?? null);
  const ageWeight = computeAgeWeight(task.createdAt);
  const capabilityWeight = computeCapabilityWeight(
    task,
    agentDomain,
    agentCapabilities
  );
  return priorityWeight + urgencyWeight + slaUrgencyWeight + ageWeight + capabilityWeight;
}

function computeUrgencyWeight(dueAt: string | null): number {
  if (!dueAt) return 0;
  const ms = new Date(dueAt).getTime() - Date.now();
  if (ms < 0) return 30;
  if (ms < MS_PER_DAY) return 25;
  if (ms < 3 * MS_PER_DAY) return 15;
  if (ms < 7 * MS_PER_DAY) return 5;
  return 0;
}

export function computeSlaUrgencyWeight(slaDeadlineAt: string | null): number {
  if (!slaDeadlineAt) return 0;
  const ms = new Date(slaDeadlineAt).getTime() - Date.now();
  if (ms < 0) return SLA_URGENCY_WEIGHT_MAX;
  if (ms < MS_PER_DAY) return 28;
  if (ms < 3 * MS_PER_DAY) return 18;
  if (ms < 7 * MS_PER_DAY) return 8;
  return 0;
}

function computeAgeWeight(createdAt: string): number {
  const days = (Date.now() - new Date(createdAt).getTime()) / MS_PER_DAY;
  return Math.min(days * AGE_WEIGHT_PER_DAY, MAX_AGE_WEIGHT);
}

export function computeCapabilityWeight(
  task: Task,
  agentDomain?: string,
  agentCapabilities?: string[]
): number {
  if (!agentDomain && !agentCapabilities) return 0;
  let weight = 0;
  if (agentDomain && task.requiredDomain && task.requiredDomain === agentDomain) {
    weight += 10;
  }
  if (agentCapabilities && task.requiredCapabilities && task.requiredCapabilities.length > 0) {
    const agentCapSet = new Set(agentCapabilities.map(c => c.toLowerCase()));
    const matched = (task.requiredCapabilities as string[]).filter(c => agentCapSet.has(c.toLowerCase()));
    weight += Math.min(matched.length * 5, 10);
  }
  return weight;
}

export function sortTasksBySmartScore(
  tasks: Task[],
  agentDomain?: string,
  agentCapabilities?: string[]
): Task[] {
  return [...tasks].sort((a, b) => {
    const scoreA = scoreTask(a, agentDomain, agentCapabilities);
    const scoreB = scoreTask(b, agentDomain, agentCapabilities);
    return scoreB - scoreA;
  });
}
