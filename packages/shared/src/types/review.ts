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
  /** Optimistic-concurrency version; incremented on every repository update (0083). */
  version: number;
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
  /** Current-generation projected status (shipped 0082 projection; not a new column). */
  projectedStatus?: ReviewerStatus | "ineligible";
  /**
   * Deterministic SHA-256 roster token over the task's actual reviewer rows,
   * their raw and projected statuses, and the review-requirement fields
   * (missing/state/generation/round/version). Opaque: clients echo it back on
   * manual add/remove as `expectedReviewersToken`; it is not parseable state.
   */
  reviewersToken?: string;
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
  /**
   * Optional optimistic-concurrency expectation (0083): the rule version the
   * caller last observed. Omitted = legacy last-write-wins; supplied and
   * stale = 409 REVIEW_RULE_VERSION_CONFLICT with no write.
   */
  expectedVersion?: number;
}

/** Input payload for adding a task reviewer. */
export interface TaskReviewerAddInput {
  reviewerId: string;
  reviewerType?: ReviewerType;
  /**
   * Optional deterministic roster token (0083) covering the task's actual
   * reviewer rows, projected state and requirement fields. Omitted = legacy
   * compatibility; supplied and stale = 409 REVIEWERS_TOKEN_CONFLICT.
   */
  expectedReviewersToken?: string;
}
