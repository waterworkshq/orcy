import type { CausalContext } from "./causalContext.js";

/** Discriminator for real-time events that can fire an automation rule. */
export type AutomationEventType =
  | "task.rejected"
  | "task.overdue"
  | "task.priority_changed"
  | "task.review_assigned"
  | "task.review_completed"
  | "task.created"
  | "mission.status_changed"
  | "mission.progress"
  | "pulse.signal_posted"
  | "scheduled_task.failed"
  | "code_evidence.updated"
  | "anomaly.detected"
  | "sprint.started"
  | "sprint.completed"
  | "release.shipped";

/** Discriminator for periodic scans that can fire an automation rule. */
export type AutomationScanType =
  | "mission_blocked"
  | "sprint_ending"
  | "agent_silent"
  | "evidence_gap_open"
  | "signal_pattern_clustered"
  | "agent_quality_degraded"
  | "orphan_mission_unmapped";

/** Union of all trigger discriminators, combining events and scans. */
export type AutomationTriggerType = AutomationEventType | AutomationScanType;

/** A rule's trigger source: either an instantaneous event or a scheduled scan. */
export type AutomationTrigger =
  | { type: "event"; eventType: AutomationEventType }
  | { type: "scan"; scanType: AutomationScanType };

/** Boolean combinator for grouping child conditions in a compound {@link AutomationCondition}. */
export type AutomationConditionOperator = "and" | "or";

/** Comparison operators for field-level condition predicates. */
export type AutomationConditionComparison =
  | "equals"
  | "not_equals"
  | "contains"
  | "greater_than"
  | "less_than"
  | "in"
  | "not_in"
  | "exists"
  | "not_exists";

/** Recursive predicate tree evaluated against a trigger payload; supports boolean composition, field comparisons, and plugin-defined conditions (ADR-0022). */
export type AutomationCondition =
  | { type: "always" }
  | { type: "and"; children: AutomationCondition[] }
  | { type: "or"; children: AutomationCondition[] }
  | { type: "not"; child: AutomationCondition }
  | {
      type: "field";
      field: string;
      operator: AutomationConditionComparison;
      value: unknown;
    }
  | { type: "priority_above"; threshold: string }
  | { type: "priority_below"; threshold: string }
  | { type: "status_in"; statuses: string[] }
  | { type: "assigned_to"; recipientType: string; recipientId: string }
  | { type: "unassigned" }
  | { type: "overdue_by"; minutes: number }
  | { type: "label_contains"; label: string }
  | { type: "domain_is"; domain: string }
  | { type: "plugin"; conditionId: string; params?: Record<string, unknown> };

/** Discriminator for the concrete action a rule executes when its condition matches. */
export type AutomationActionType =
  | "notify"
  | "create_signal"
  | "create_task"
  | "change_priority"
  | "assign"
  | "release_assignment"
  | "request_review"
  | "call_webhook"
  | "mark_risk"
  | "plugin";

/** Resolvable destination for an automation notification — a role-based group or an explicit agent/human reference. */
export type AutomationRecipient =
  | { type: "assignee" }
  | { type: "reporter" }
  | { type: "reviewers" }
  | { type: "mission_owner" }
  | { type: "habitat_admins" }
  | { type: "agent"; agentId: string }
  | { type: "human"; userId: string }
  | { type: "channel"; channelId: string };

/** Automation action that delivers a templated notification to one or more {@link AutomationRecipient}s. */
export interface AutomationActionNotify {
  type: "notify";
  recipients: AutomationRecipient[];
  template: string;
  channels?: string[];
  severity?: string;
}

/** Automation action that posts a new Pulse signal. */
export interface AutomationActionCreateSignal {
  type: "create_signal";
  content: string;
}

/** Automation action that creates a new task, optionally within a mission. */
export interface AutomationActionCreateTask {
  type: "create_task";
  title: string;
  description?: string;
  missionId?: string;
  assignedTo?: { recipientType: string; recipientId: string };
}

/** Automation action that re-prioritizes the trigger target. */
export interface AutomationActionChangePriority {
  type: "change_priority";
  priority: string;
}

/** Automation action that assigns the trigger target to a specific recipient. */
export interface AutomationActionAssign {
  type: "assign";
  recipientType: string;
  recipientId: string;
}

/** Automation action that un-assigns the trigger target. */
export interface AutomationActionReleaseAssignment {
  type: "release_assignment";
}

/** Automation action that requests a review on the trigger target. */
export interface AutomationActionRequestReview {
  type: "request_review";
  reviewerType?: string;
  reviewerId?: string;
}

/** Automation action that performs an outbound HTTP request with optional headers and body template. */
export interface AutomationActionCallWebhook {
  type: "call_webhook";
  url: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
}

/** Automation action that flags the trigger target with a named risk level. */
export interface AutomationActionMarkRisk {
  type: "mark_risk";
  level: string;
  reason?: string;
}

/** Discriminated union of every action a rule can perform, keyed by {@link AutomationActionType}. */
export type AutomationAction =
  | AutomationActionNotify
  | AutomationActionCreateSignal
  | AutomationActionCreateTask
  | AutomationActionChangePriority
  | AutomationActionAssign
  | AutomationActionReleaseAssignment
  | AutomationActionRequestReview
  | AutomationActionCallWebhook
  | AutomationActionMarkRisk
  | { type: "plugin"; actionId: string; params?: Record<string, unknown> };

/** Runtime enablement state of a rule. */
export type AutomationRuleStatus = "enabled" | "disabled";

/** Lifecycle state of a single rule execution attempt. */
export type AutomationRunStatus =
  | "matched"
  | "skipped"
  | "running"
  | "succeeded"
  | "partial_failed"
  | "failed"
  | "simulated";

/** Reason a rule run did not execute — disabled, false condition, cooldown, loop guard, rate limit, causal cycle, causal depth limit, or missing target. */
export type AutomationSkipReason =
  | "disabled"
  | "condition_false"
  | "cooldown"
  | "loop_guard"
  | "rate_limited"
  | "causal_cycle"
  | "causal_depth_limit"
  | "missing_target";

/** Kind of domain object an automation operated on. */
export type AutomationTargetType =
  | "task"
  | "mission"
  | "agent"
  | "sprint"
  | "pulse"
  | "habitat"
  | "integration"
  | "none";

/** A persisted automation rule: trigger, condition tree, and actions, scoped to a habitat with cooldown/rate limits. */
export interface AutomationRule {
  id: string;
  habitatId: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  trigger: AutomationTrigger;
  condition: AutomationCondition;
  actions: AutomationAction[];
  cooldownSeconds: number;
  maxRunsPerHour: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt: string | null;
}

/** Auditable record of one execution attempt of an {@link AutomationRule}. */
export interface AutomationRuleRun {
  id: string;
  ruleId: string;
  habitatId: string;
  triggerType: string;
  triggerEventId: string | null;
  targetType: AutomationTargetType | null;
  targetId: string | null;
  fingerprint: string;
  status: AutomationRunStatus;
  skipReason: AutomationSkipReason | null;
  conditionResult: AutomationConditionResult | null;
  actionResults: AutomationActionResult[] | null;
  metadata: Record<string, unknown> | null;
  startedAt: string;
  finishedAt: string | null;
}

/** Evaluated outcome of an {@link AutomationCondition} node. */
export interface AutomationConditionResult {
  matched: boolean;
  conditionType: string;
  reason: string;
  children?: AutomationConditionResult[];
}

/** Outcome of executing a single action within a rule run. */
export interface AutomationActionResult {
  actionType: AutomationActionType;
  actionIndex: number;
  status: "succeeded" | "failed" | "skipped";
  error?: string;
  result?: Record<string, unknown>;
}

/** Dry-run preview of what a rule would do given a trigger. */
export interface AutomationSimulationResult {
  ruleId: string;
  ruleName: string;
  conditionResult: AutomationConditionResult;
  wouldExecute: boolean;
  skipReason?: AutomationSkipReason;
  actionPreviews: Array<{
    actionType: AutomationActionType;
    actionIndex: number;
    description: string;
  }>;
}

/** Runtime bundle passed into rule evaluation: trigger type, target, habitat, and payload. */
export interface AutomationTriggerContext {
  triggerType: AutomationTriggerType;
  triggerEventId: string | null;
  targetType: AutomationTargetType | null;
  targetId: string | null;
  habitatId: string;
  payload: Record<string, unknown>;
  /**
   * Server-constructed causal context connecting this trigger to its origin
   * chain (root + parent + appended rule/run hops). Used by chain-membership
   * inspection to detect `causal_cycle` / `causal_depth_limit` skips.
   * Untrusted callers cannot inject these identities.
   */
  causalContext?: CausalContext;
}

/** Payload for creating a new {@link AutomationRule}. */
export interface CreateAutomationRuleInput {
  habitatId: string;
  name: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  trigger: AutomationTrigger;
  condition?: AutomationCondition;
  actions: AutomationAction[];
  cooldownSeconds?: number;
  maxRunsPerHour?: number;
  createdBy: string;
}

/** Partial payload for patching an existing {@link AutomationRule}. */
export interface UpdateAutomationRuleInput {
  name?: string;
  description?: string;
  enabled?: boolean;
  priority?: number;
  trigger?: AutomationTrigger;
  condition?: AutomationCondition;
  actions?: AutomationAction[];
  cooldownSeconds?: number;
  maxRunsPerHour?: number;
}

/** Builds a stable identity string for a rule run, used by cooldown/dedup/loop-guard logic. */
export function buildFingerprint(
  habitatId: string,
  ruleId: string,
  triggerType: string,
  triggerEventId: string | null,
  targetType: string | null,
  targetId: string | null,
): string {
  return `${habitatId}:${ruleId}:${triggerType}:${triggerEventId ?? ""}:${targetType ?? ""}:${targetId ?? ""}`;
}
