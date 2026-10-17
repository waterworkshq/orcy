import type { ReviewClient } from '../api/interfaces.js';
import type { ReviewRule, TaskReviewer, ReviewRuleStrategy, ReviewRuleUpdateInput } from '@orcy/shared';

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
  args: { habitatId?: string; boardId?: string }
): Promise<{ reviewRules: ReviewRule[] }> {
  const habitatId = args.habitatId ?? args.boardId ?? '';
  return client.listReviewRules(habitatId);
}

/**
 * @requires ReviewClient
 */
export async function createReviewRule(
  client: ReviewClient,
  args: {
    habitatId?: string;
    boardId?: string;
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
  const habitatId = args.habitatId ?? args.boardId ?? '';
  return client.createReviewRule(habitatId, {
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
    expectedVersion?: number;
  }
): Promise<{ reviewRule: ReviewRule | null }> {
  const input: ReviewRuleUpdateInput = {
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
  };
  if (args.expectedVersion !== undefined) {
    input.expectedVersion = args.expectedVersion;
  }
  return client.updateReviewRule(args.ruleId, input);
}

/**
 * @requires ReviewClient
 */
export async function deleteReviewRule(
  client: ReviewClient,
  args: { ruleId: string; expectedVersion?: number }
): Promise<Record<string, unknown>> {
  await client.deleteReviewRule(args.ruleId, args.expectedVersion);
  return { success: true, ruleId: args.ruleId, message: `Review rule ${args.ruleId} deleted` };
}

/**
 * @requires ReviewClient
 */
export async function listTaskReviewers(
  client: ReviewClient,
  args: { taskId: string }
): Promise<{ reviewers: TaskReviewer[]; reviewersToken?: string }> {
  return client.listTaskReviewers(args.taskId);
}

/**
 * @requires ReviewClient
 */
export async function addTaskReviewer(
  client: ReviewClient,
  args: { taskId: string; reviewerId: string; reviewerType?: string; expectedReviewersToken?: string }
): Promise<{ reviewer: TaskReviewer }> {
  const reviewerType = args.reviewerType === undefined ? 'human' : args.reviewerType;
  if (reviewerType !== 'human' && reviewerType !== 'agent') {
    throw new Error('reviewerType must be human or agent');
  }
  const input: { reviewerId: string; reviewerType: "human" | "agent"; expectedReviewersToken?: string } = {
    reviewerId: args.reviewerId,
    reviewerType,
  };
  if (args.expectedReviewersToken !== undefined) {
    input.expectedReviewersToken = args.expectedReviewersToken;
  }
  return client.addTaskReviewer(args.taskId, input);
}

/**
 * @requires ReviewClient
 */
export async function removeTaskReviewer(
  client: ReviewClient,
  args: { taskId: string; reviewerId: string; expectedReviewersToken?: string }
): Promise<Record<string, unknown>> {
  await client.removeTaskReviewer(args.taskId, args.reviewerId, args.expectedReviewersToken);
  return { success: true, message: `Reviewer ${args.reviewerId} removed from task ${args.taskId}` };
}
