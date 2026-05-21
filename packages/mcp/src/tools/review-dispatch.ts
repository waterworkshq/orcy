import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { createDispatchTool, createDispatchHandler, type Handler } from './dispatch-utils.js';
import {
  listReviewRules,
  createReviewRule,
  updateReviewRule,
  deleteReviewRule,
  listTaskReviewers,
  addTaskReviewer,
  removeTaskReviewer,
} from './review.js';

function requireArgs(action: string, args: Record<string, unknown>, keys: string[]): void {
  for (const key of keys) {
    if (!args[key]) {
      throw new Error(`${key} is required for ${action}`);
    }
  }
}

export const REVIEW_DISPATCH_TOOL: Tool = createDispatchTool({
  name: 'orcy_review',
  description: 'Review rule operations: list, create, update, delete rules; list, add, remove task reviewers',
  actions: ['list_rules', 'create_rule', 'update_rule', 'delete_rule', 'list_reviewers', 'add_reviewer', 'remove_reviewer'],
  sharedParams: {
    boardId: { type: 'string', description: 'Habitat UUID (used with list_rules, create_rule)' },
    ruleId: { type: 'string', description: 'Review rule UUID (used with update_rule, delete_rule)' },
    taskId: { type: 'string', description: 'Task UUID (used with list_reviewers, add_reviewer, remove_reviewer)' },
    reviewerId: { type: 'string', description: 'Reviewer user UUID (used with add_reviewer, remove_reviewer)' },
    reviewerType: { type: 'string', description: 'Reviewer type: human or agent (used with add_reviewer, default: human)' },
    name: { type: 'string', description: 'Rule name (used with create_rule, update_rule)' },
    enabled: { type: 'number', description: '1=enabled, 0=disabled (used with create_rule, update_rule)' },
    priority: { type: 'number', description: 'Rule priority order (used with create_rule, update_rule)' },
    matchDomain: { type: 'string', description: 'Match tasks with this domain (used with create_rule, update_rule)' },
    matchLabels: { type: 'array', items: { type: 'string' }, description: 'Match tasks with any of these labels (used with create_rule, update_rule)' },
    matchPriority: { type: 'string', description: 'Match tasks with this priority (used with create_rule, update_rule)' },
    assignmentStrategy: { type: 'string', description: 'Strategy: domain_expert, round_robin, least_loaded, random, fixed (used with create_rule, update_rule)' },
    requiredReviews: { type: 'number', description: 'Number of required reviews (used with create_rule, update_rule)' },
    antiSelfReview: { type: 'number', description: '1=prevent self-review, 0=allow (used with create_rule, update_rule)' },
    fixedReviewerIds: { type: 'array', items: { type: 'string' }, description: 'Fixed reviewer user IDs for fixed strategy (used with create_rule, update_rule)' },
  },
});

export const REVIEW_ACTIONS: Record<string, Handler> = {
  'list_rules': (client, args) => {
    requireArgs('list_rules', args, ['boardId']);
    return listReviewRules(client, args);
  },
  'create_rule': (client, args) => {
    requireArgs('create_rule', args, ['boardId', 'name']);
    return createReviewRule(client, args);
  },
  'update_rule': (client, args) => {
    requireArgs('update_rule', args, ['ruleId']);
    return updateReviewRule(client, args);
  },
  'delete_rule': (client, args) => {
    requireArgs('delete_rule', args, ['ruleId']);
    return deleteReviewRule(client, args);
  },
  'list_reviewers': (client, args) => {
    requireArgs('list_reviewers', args, ['taskId']);
    return listTaskReviewers(client, args);
  },
  'add_reviewer': (client, args) => {
    requireArgs('add_reviewer', args, ['taskId', 'reviewerId']);
    return addTaskReviewer(client, args);
  },
  'remove_reviewer': (client, args) => {
    requireArgs('remove_reviewer', args, ['taskId', 'reviewerId']);
    return removeTaskReviewer(client, args);
  },
};

export const REVIEW_DISPATCH_HANDLER = createDispatchHandler(REVIEW_ACTIONS);
