import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { createDispatchTool, createDispatchHandler, type Handler } from "./dispatch-utils.js";
import {
  listReviewRules,
  createReviewRule,
  updateReviewRule,
  deleteReviewRule,
  listTaskReviewers,
  addTaskReviewer,
  removeTaskReviewer,
} from "./review.js";

/** MCP `Tool` registration schema for review rule and task reviewer operations. */
export const REVIEW_DISPATCH_TOOL: Tool = createDispatchTool({
  name: "orcy_review",
  description:
    "Review rule operations: list, create, update, delete rules; list, add, remove task reviewers",
  actions: [
    "list_rules",
    "create_rule",
    "update_rule",
    "delete_rule",
    "list_reviewers",
    "add_reviewer",
    "remove_reviewer",
  ],
  sharedParams: {
    boardId: { type: "string", description: "Habitat UUID (used with list_rules, create_rule)" },
    ruleId: {
      type: "string",
      description: "Review rule UUID (used with update_rule, delete_rule)",
    },
    taskId: {
      type: "string",
      description: "Task UUID (used with list_reviewers, add_reviewer, remove_reviewer)",
    },
    reviewerId: {
      type: "string",
      description: "Reviewer user UUID (used with add_reviewer, remove_reviewer)",
    },
    reviewerType: {
      type: "string",
      description: "Reviewer type: human or agent (used with add_reviewer, default: human)",
    },
    name: { type: "string", description: "Rule name (used with create_rule, update_rule)" },
    enabled: {
      type: "number",
      description: "1=enabled, 0=disabled (used with create_rule, update_rule)",
    },
    priority: {
      type: "number",
      description: "Rule priority order (used with create_rule, update_rule)",
    },
    matchDomain: {
      type: "string",
      description: "Match tasks with this domain (used with create_rule, update_rule)",
    },
    matchLabels: {
      type: "array",
      items: { type: "string" },
      description: "Match tasks with any of these labels (used with create_rule, update_rule)",
    },
    matchPriority: {
      type: "string",
      description: "Match tasks with this priority (used with create_rule, update_rule)",
    },
    assignmentStrategy: {
      type: "string",
      description:
        "Strategy: domain_expert, round_robin, least_loaded, random, fixed (used with create_rule, update_rule)",
    },
    requiredReviews: {
      type: "number",
      description: "Number of required reviews (used with create_rule, update_rule)",
    },
    antiSelfReview: {
      type: "number",
      description: "1=prevent self-review, 0=allow (used with create_rule, update_rule)",
    },
    fixedReviewerIds: {
      type: "array",
      items: { type: "string" },
      description:
        "Fixed reviewer user IDs for fixed strategy (used with create_rule, update_rule)",
    },
  },
});

/** Action-name → {@link Handler} map routing each review operation to its habitat client implementation. */
export const REVIEW_ACTIONS: Record<string, Handler> = {
  list_rules: (client, args) => listReviewRules(client, args),
  create_rule: (client, args) => createReviewRule(client, args),
  update_rule: (client, args) => updateReviewRule(client, args),
  delete_rule: (client, args) => deleteReviewRule(client, args),
  list_reviewers: (client, args) => listTaskReviewers(client, args),
  add_reviewer: (client, args) => addTaskReviewer(client, args),
  remove_reviewer: (client, args) => removeTaskReviewer(client, args),
};

/** Per-action required parameters, validated by {@link createDispatchHandler} before the handler runs. */
export const REVIEW_REQUIRED_PARAMS: Record<string, string[]> = {
  list_rules: ["boardId"],
  create_rule: ["boardId", "name"],
  update_rule: ["ruleId"],
  delete_rule: ["ruleId"],
  list_reviewers: ["taskId"],
  add_reviewer: ["taskId", "reviewerId"],
  remove_reviewer: ["taskId", "reviewerId"],
};

/** Top-level {@link ToolHandler} that routes incoming `orcy_review` MCP calls to the matching action. */
export const REVIEW_DISPATCH_HANDLER = createDispatchHandler(
  REVIEW_ACTIONS,
  REVIEW_REQUIRED_PARAMS,
);
