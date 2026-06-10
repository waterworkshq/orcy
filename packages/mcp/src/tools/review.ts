import type { ReviewClient } from '../api/interfaces.js';
import type { ReviewRule, TaskReviewer, ReviewRuleStrategy } from '@orcy/shared';

const VALID_STRATEGIES: readonly string[] = ['domain_expert', 'round_robin', 'least_loaded', 'random', 'fixed'] as const;

function parseStrategy(s: string | undefined): ReviewRuleStrategy | undefined {
  if (!s) return undefined;
  if (!VALID_STRATEGIES.includes(s)) {
    throw new Error(`Invalid assignmentStrategy: ${s}. Must be one of: ${VALID_STRATEGIES.join(', ')}`);
  }
  return s as ReviewRuleStrategy;
}

/**
 * @requires ReviewClient
 */
export async function listReviewRules(
  client: ReviewClient,
  args: { boardId: string }
): Promise<{ reviewRules: ReviewRule[] }> {
  return client.listReviewRules(args.boardId);
}

/**
 * @requires ReviewClient
 */
export async function createReviewRule(
  client: ReviewClient,
  args: {
    boardId: string;
    name: string;
    enabled?: number;
    priority?: number;
    matchDomain?: string | null;
    matchLabels?: string[];
    matchPriority?: string | null;
    assignmentStrategy?: string;
    requiredReviews?: number;
    antiSelfReview?: number;
    fixedReviewerIds?: string[];
  }
): Promise<{ reviewRule: ReviewRule }> {
  return client.createReviewRule(args.boardId, {
    name: args.name,
    enabled: args.enabled,
    priority: args.priority,
    matchDomain: args.matchDomain,
    matchLabels: args.matchLabels,
    matchPriority: args.matchPriority,
    assignmentStrategy: parseStrategy(args.assignmentStrategy),
    requiredReviews: args.requiredReviews,
    antiSelfReview: args.antiSelfReview,
    fixedReviewerIds: args.fixedReviewerIds,
  });
}

/**
 * @requires ReviewClient
 */
export async function updateReviewRule(
  client: ReviewClient,
  args: {
    ruleId: string;
    name?: string;
    enabled?: number;
    priority?: number;
    matchDomain?: string | null;
    matchLabels?: string[];
    matchPriority?: string | null;
    assignmentStrategy?: string;
    requiredReviews?: number;
    antiSelfReview?: number;
    fixedReviewerIds?: string[];
  }
): Promise<{ reviewRule: ReviewRule | null }> {
  return client.updateReviewRule(args.ruleId, {
    name: args.name,
    enabled: args.enabled,
    priority: args.priority,
    matchDomain: args.matchDomain,
    matchLabels: args.matchLabels,
    matchPriority: args.matchPriority,
    assignmentStrategy: parseStrategy(args.assignmentStrategy),
    requiredReviews: args.requiredReviews,
    antiSelfReview: args.antiSelfReview,
    fixedReviewerIds: args.fixedReviewerIds,
  });
}

/**
 * @requires ReviewClient
 */
export async function deleteReviewRule(
  client: ReviewClient,
  args: { ruleId: string }
): Promise<Record<string, unknown>> {
  await client.deleteReviewRule(args.ruleId);
  return { success: true, ruleId: args.ruleId, message: `Review rule ${args.ruleId} deleted` };
}

/**
 * @requires ReviewClient
 */
export async function listTaskReviewers(
  client: ReviewClient,
  args: { taskId: string }
): Promise<{ reviewers: TaskReviewer[] }> {
  return client.listTaskReviewers(args.taskId);
}

/**
 * @requires ReviewClient
 */
export async function addTaskReviewer(
  client: ReviewClient,
  args: { taskId: string; reviewerId: string; reviewerType?: string }
): Promise<{ reviewer: TaskReviewer }> {
  return client.addTaskReviewer(args.taskId, {
    reviewerId: args.reviewerId,
    reviewerType: (args.reviewerType as 'human' | 'agent') ?? 'human',
  });
}

/**
 * @requires ReviewClient
 */
export async function removeTaskReviewer(
  client: ReviewClient,
  args: { taskId: string; reviewerId: string }
): Promise<Record<string, unknown>> {
  await client.removeTaskReviewer(args.taskId, args.reviewerId);
  return { success: true, message: `Reviewer ${args.reviewerId} removed from task ${args.taskId}` };
}
