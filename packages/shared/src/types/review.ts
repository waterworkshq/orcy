/** Exhaustive set of strategies for assigning reviewers to tasks under a {@link ReviewRule}. */
export type ReviewRuleStrategy =
  | "domain_expert"
  | "round_robin"
  | "least_loaded"
  | "random"
  | "fixed";

/** Lifecycle states of a {@link TaskReviewer} assignment from creation through resolution. */
export type ReviewerStatus = "pending" | "approved" | "rejected" | "skipped";

/** Kinds of entities that can be assigned as a {@link TaskReviewer}. */
export type ReviewerType = "human" | "agent";

/** A persisted rule that defines how reviewers are matched and assigned to tasks within a habitat. */
export interface ReviewRule {
  id: string;
  habitatId: string;
  name: string;
  enabled: number;
  priority: number;
  matchDomain: string | null;
  matchLabels: string[];
  matchPriority: string | null;
  assignmentStrategy: ReviewRuleStrategy;
  requiredReviews: number;
  antiSelfReview: number;
  fixedReviewerIds: string[];
  createdAt: string;
  updatedAt: string;
}

/** A reviewer assignment record for a specific task, tracked from initial claim through final review. */
export interface TaskReviewer {
  id: string;
  taskId: string;
  reviewerType: ReviewerType;
  reviewerId: string;
  status: ReviewerStatus;
  assignedAt: string;
  reviewedAt: string | null;
  reviewNote: string | null;
}

/** Input payload for creating a new {@link ReviewRule}; only the rule name is required. */
export interface ReviewRuleCreateInput {
  name: string;
  enabled?: number;
  priority?: number;
  matchDomain?: string | null;
  matchLabels?: string[];
  matchPriority?: string | null;
  assignmentStrategy?: ReviewRuleStrategy;
  requiredReviews?: number;
  antiSelfReview?: number;
  fixedReviewerIds?: string[];
}

/** Partial input payload for updating an existing {@link ReviewRule}; every field is optional. */
export interface ReviewRuleUpdateInput {
  name?: string;
  enabled?: number;
  priority?: number;
  matchDomain?: string | null;
  matchLabels?: string[];
  matchPriority?: string | null;
  assignmentStrategy?: ReviewRuleStrategy;
  requiredReviews?: number;
  antiSelfReview?: number;
  fixedReviewerIds?: string[];
}
