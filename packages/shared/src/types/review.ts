export type ReviewRuleStrategy = 'domain_expert' | 'round_robin' | 'least_loaded' | 'random' | 'fixed';

export type ReviewerStatus = 'pending' | 'approved' | 'rejected' | 'skipped';

export type ReviewerType = 'human' | 'agent';

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
