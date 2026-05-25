import { getDb } from '../db/index.js';
import { users, teamMembers, habitats } from '../db/schema/index.js';
import { eq, inArray } from 'drizzle-orm';
import * as reviewRuleRepo from '../repositories/reviewRule.js';
import * as taskReviewerRepo from '../repositories/taskReviewer.js';
import * as taskRepo from '../repositories/task.js';
import type { ReviewRule, Task, ReviewRuleStrategy } from '@orcy/shared';
import { logger } from '../lib/logger.js';

interface EligibleReviewer {
  id: string;
  username: string;
  displayName: string;
  pendingReviewCount: number;
}

export function matchRules(taskId: string, habitatId: string): ReviewRule[] {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return [];

  const rules = reviewRuleRepo.getEnabledRulesForHabitat(habitatId);
  if (rules.length === 0) return [];

  return rules.filter(rule => doesRuleMatch(rule, task));
}

function doesRuleMatch(rule: ReviewRule, task: Task): boolean {
  if (rule.matchDomain && rule.matchDomain !== task.requiredDomain) return false;

  if (rule.matchLabels && rule.matchLabels.length > 0) {
    const taskLabels = new Set(task.labels ?? []);
    const hasMatch = rule.matchLabels.some(label => taskLabels.has(label));
    if (!hasMatch) return false;
  }

  if (rule.matchPriority && rule.matchPriority !== task.priority) return false;

  return true;
}

export function getEligibleReviewers(habitatId: string, excludeUserId?: string): EligibleReviewer[] {
  const db = getDb();
  const habitat = db.select({ teamId: habitats.teamId }).from(habitats).where(eq(habitats.id, habitatId)).get();
  if (!habitat?.teamId) return [];

  const memberRows = db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, habitat.teamId))
    .all();

  const userIds = memberRows.map(m => m.userId);
  if (userIds.length === 0) return [];

  const userRows = db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, userIds))
    .all();

  return userRows
    .filter(u => u.id !== excludeUserId)
    .map(u => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      pendingReviewCount: taskReviewerRepo.getPendingCountByReviewer(u.id),
    }));
}

// NOTE: Round-robin counters are in-memory only. They reset on server restart.
// For multi-instance deployments, use 'least_loaded' or 'random' instead.
const roundRobinCounters = new Map<string, number>();

export function resetRoundRobinCounter(habitatId?: string): void {
  if (habitatId) roundRobinCounters.delete(habitatId);
  else roundRobinCounters.clear();
}

function selectReviewer(reviewers: EligibleReviewer[], strategy: ReviewRuleStrategy, habitatId: string, fixedReviewerIds: string[]): EligibleReviewer | null {
  if (reviewers.length === 0) return null;

  switch (strategy) {
    case 'fixed': {
      if (fixedReviewerIds.length === 0) return null;
      const fixedSet = new Set(fixedReviewerIds);
      const matched = reviewers.find(r => fixedSet.has(r.id));
      return matched ?? null;
    }
    case 'round_robin': {
      const index = roundRobinCounters.get(habitatId) ?? 0;
      const selected = reviewers[index % reviewers.length];
      roundRobinCounters.set(habitatId, (index + 1) % reviewers.length);
      return selected;
    }
    case 'least_loaded': {
      return reviewers.reduce((best, r) =>
        r.pendingReviewCount < best.pendingReviewCount ? r : best
      );
    }
    case 'random': {
      return reviewers[Math.floor(Math.random() * reviewers.length)];
    }
    case 'domain_expert':
    default: {
      return reviewers[0];
    }
  }
}

export interface AssignReviewersResult {
  assigned: Array<{ reviewerId: string; reviewerName: string }>;
  skipped: boolean;
  reason?: string;
}

export function assignReviewers(taskId: string, habitatId: string, excludeReviewerId?: string): AssignReviewersResult {
  const matchedRules = matchRules(taskId, habitatId);
  if (matchedRules.length === 0) {
    return { assigned: [], skipped: true, reason: 'no_matching_rules' };
  }

  const primaryRule = matchedRules[0];

  // Build exclusion list: agent (excludeReviewerId) + task creator (antiSelfReview)
  const excludeIds: string[] = excludeReviewerId ? [excludeReviewerId] : [];
  if (primaryRule.antiSelfReview) {
    const task = taskRepo.getTaskById(taskId);
    if (task?.createdBy) {
      excludeIds.push(task.createdBy);
    }
  }

  const eligible = getEligibleReviewers(habitatId, excludeReviewerId)
    .filter(r => !excludeIds.includes(r.id));
  if (eligible.length === 0) {
    return { assigned: [], skipped: true, reason: 'no_eligible_reviewers' };
  }

  const assigned: Array<{ reviewerId: string; reviewerName: string }> = [];
  const reviewsNeeded = primaryRule.requiredReviews;

  for (let i = 0; i < reviewsNeeded; i++) {
    const remaining = eligible.filter(e => !assigned.some(a => a.reviewerId === e.id));
    if (remaining.length === 0) break;

    const selected = selectReviewer(remaining, primaryRule.assignmentStrategy, habitatId, primaryRule.fixedReviewerIds);
      if (!selected) break;

      if (taskReviewerRepo.findByTaskAndReviewer(taskId, selected.id)) continue;
      taskReviewerRepo.create(taskId, 'human', selected.id);
      assigned.push({ reviewerId: selected.id, reviewerName: selected.displayName || selected.username });
  }

  if (assigned.length === 0) {
    return { assigned: [], skipped: true, reason: 'no_reviewer_selected' };
  }

  logger.info({ taskId, habitatId, assignedCount: assigned.length, ruleName: primaryRule.name, antiSelfReview: primaryRule.antiSelfReview }, 'Reviewers assigned');
  return { assigned, skipped: false };
}

export function hasAssignedReviewers(taskId: string): boolean {
  const reviewers = taskReviewerRepo.getByTaskId(taskId);
  return reviewers.length > 0;
}

export function isAssignedReviewer(taskId: string, reviewerId: string): boolean {
  return taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId) !== null;
}

export function recordApproval(taskId: string, reviewerId: string): boolean {
  const reviewer = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId);
  if (!reviewer) return false;
  if (reviewer.status === 'approved') return true; // already approved, idempotent
  taskReviewerRepo.updateStatus(reviewer.id, 'approved');
  return true;
}

export function hasAllRequiredApprovals(taskId: string, requiredCount?: number): boolean {
  const reviewers = taskReviewerRepo.getByTaskId(taskId);
  if (reviewers.length === 0) return true;

  const approvedCount = reviewers.filter(r => r.status === 'approved').length;
  const pendingCount = reviewers.filter(r => r.status === 'pending').length;

  if (pendingCount > 0) return false;
  const threshold = requiredCount ?? reviewers.length;
  return approvedCount >= threshold;
}
