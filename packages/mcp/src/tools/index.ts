import type { Tool } from '@modelcontextprotocol/sdk/types.js';

// Re-export all individual handler functions (needed for tests and consumers)
export * from './constants.js';
export * from './enrichment.js';
export * from './agent-id.js';
export * from './instructions.js';
export * from './task-crud.js';
export * from './task-lifecycle.js';
export * from './task-detail.js';
export * from './subtask.js';
export * from './agent.js';
export * from './habitat.js';
export * from './webhook.js';
export * from './template.js';
export * from './messaging.js';
export * from './pulse.js';
export * from './pulse-skill.js';
export * from './subscription.js';
export * from './worktree.js';
export * from './suggest.js';
export * from './mission.js';
export * from './lifecycle-gaps.js';
export * from './task-batch.js';
export * from './review.js';
export * from './review-dispatch.js';
export * from './sprint.js';
export * from './sprint-dispatch.js';

// Re-export dispatch utilities (for tests)
export * from './dispatch-utils.js';

// Import dispatch tool constants and handlers
import {
  HABITAT_DISPATCH_TOOL,
  HABITAT_DISPATCH_HANDLER,
} from './habitat-dispatch.js';
import {
  MISSION_DISPATCH_TOOL,
  MISSION_DISPATCH_HANDLER,
} from './mission-dispatch.js';
import {
  TASK_DISPATCH_TOOL,
  TASK_DISPATCH_HANDLER,
} from './task-dispatch.js';
import {
  AGENT_DISPATCH_TOOL,
  AGENT_DISPATCH_HANDLER,
} from './agent-dispatch.js';
import {
  ADMIN_DISPATCH_TOOL,
  ADMIN_DISPATCH_HANDLER,
} from './admin-dispatch.js';
import {
  SUGGEST_DISPATCH_TOOL,
  SUGGEST_DISPATCH_HANDLER,
} from './suggest-dispatch.js';
import {
  WORKTREE_DISPATCH_TOOL,
  WORKTREE_DISPATCH_HANDLER,
} from './worktree-dispatch.js';
import {
  MESSAGE_DISPATCH_TOOL,
  MESSAGE_DISPATCH_HANDLER,
} from './message-dispatch.js';
import {
  PULSE_DISPATCH_TOOL,
  PULSE_DISPATCH_HANDLER,
} from './pulse-dispatch.js';
import {
  SUBSCRIPTION_DISPATCH_TOOL,
  SUBSCRIPTION_DISPATCH_HANDLER,
} from './subscription-dispatch.js';
import {
  REVIEW_DISPATCH_TOOL,
  REVIEW_DISPATCH_HANDLER,
} from './review-dispatch.js';
import {
  SPRINT_DISPATCH_TOOL,
  SPRINT_DISPATCH_HANDLER,
} from './sprint-dispatch.js';
import { ORCY_INITIAL_INSTRUCTIONS_TOOL } from './instructions.js';
import { PULSE_SKILL_TOOL } from './pulse-skill.js';

// Re-export dispatch handlers for consumers (src/index.ts, tests)
export {
  HABITAT_DISPATCH_HANDLER,
  MISSION_DISPATCH_HANDLER,
  TASK_DISPATCH_HANDLER,
  AGENT_DISPATCH_HANDLER,
  ADMIN_DISPATCH_HANDLER,
  SUGGEST_DISPATCH_HANDLER,
  WORKTREE_DISPATCH_HANDLER,
  MESSAGE_DISPATCH_HANDLER,
  PULSE_DISPATCH_HANDLER,
  SUBSCRIPTION_DISPATCH_HANDLER,
  REVIEW_DISPATCH_HANDLER,
  SPRINT_DISPATCH_HANDLER,
};
export {
  HABITAT_DISPATCH_TOOL,
  MISSION_DISPATCH_TOOL,
  TASK_DISPATCH_TOOL,
  AGENT_DISPATCH_TOOL,
  ADMIN_DISPATCH_TOOL,
  SUGGEST_DISPATCH_TOOL,
  WORKTREE_DISPATCH_TOOL,
  MESSAGE_DISPATCH_TOOL,
  PULSE_DISPATCH_TOOL,
  SUBSCRIPTION_DISPATCH_TOOL,
  REVIEW_DISPATCH_TOOL,
  SPRINT_DISPATCH_TOOL,
};

export const ALL_TOOLS: Tool[] = [
  ORCY_INITIAL_INSTRUCTIONS_TOOL,
  PULSE_SKILL_TOOL,
  HABITAT_DISPATCH_TOOL,
  MISSION_DISPATCH_TOOL,
  TASK_DISPATCH_TOOL,
  AGENT_DISPATCH_TOOL,
  ADMIN_DISPATCH_TOOL,
  SUGGEST_DISPATCH_TOOL,
  WORKTREE_DISPATCH_TOOL,
  MESSAGE_DISPATCH_TOOL,
  PULSE_DISPATCH_TOOL,
  SUBSCRIPTION_DISPATCH_TOOL,
  REVIEW_DISPATCH_TOOL,
  SPRINT_DISPATCH_TOOL,
];