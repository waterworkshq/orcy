import type { KanbanApiClient } from '../api.js';
import type { ReviewRule, TaskReviewer } from '@orcy/shared';

export async function listReviewRules(
  client: KanbanApiClient,
  args: { boardId: string }
): Promise<{ reviewRules: ReviewRule[] }> {
  return client.listReviewRules(args.boardId);
}

export async function createReviewRule(
  client: KanbanApiClient,
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
    assignmentStrategy: args.assignmentStrategy as any,
    requiredReviews: args.requiredReviews,
    antiSelfReview: args.antiSelfReview,
    fixedReviewerIds: args.fixedReviewerIds,
  });
}

export async function updateReviewRule(
  client: KanbanApiClient,
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
    assignmentStrategy: args.assignmentStrategy as any,
    requiredReviews: args.requiredReviews,
    antiSelfReview: args.antiSelfReview,
    fixedReviewerIds: args.fixedReviewerIds,
  });
}

export async function deleteReviewRule(
  client: KanbanApiClient,
  args: { ruleId: string }
): Promise<Record<string, unknown>> {
  await client.deleteReviewRule(args.ruleId);
  return { success: true, ruleId: args.ruleId, message: `Review rule ${args.ruleId} deleted` };
}

export async function listTaskReviewers(
  client: KanbanApiClient,
  args: { taskId: string }
): Promise<{ reviewers: TaskReviewer[] }> {
  return client.listTaskReviewers(args.taskId);
}

export async function addTaskReviewer(
  client: KanbanApiClient,
  args: { taskId: string; reviewerId: string; reviewerType?: string }
): Promise<{ reviewer: TaskReviewer }> {
  return client.addTaskReviewer(args.taskId, {
    reviewerId: args.reviewerId,
    reviewerType: (args.reviewerType as 'human' | 'agent') ?? 'human',
  });
}

export async function removeTaskReviewer(
  client: KanbanApiClient,
  args: { taskId: string; reviewerId: string }
): Promise<Record<string, unknown>> {
  await client.removeTaskReviewer(args.taskId, args.reviewerId);
  return { success: true, message: `Reviewer ${args.reviewerId} removed from task ${args.taskId}` };
}
