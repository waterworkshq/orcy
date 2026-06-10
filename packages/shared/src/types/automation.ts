export type AutomationEventType =
  | "task.rejected"
  | "task.overdue"
  | "task.priority_changed"
  | "task.review_assigned"
  | "task.review_completed"
  | "mission.status_changed"
  | "mission.progress"
  | "pulse.signal_posted"
  | "scheduled_task.failed"
  | "code_evidence.updated"
  | "anomaly.detected"
  | "sprint.started"
  | "sprint.completed";

export type AutomationScanType =
  | "mission_blocked"
  | "sprint_ending"
  | "agent_silent"
  | "evidence_gap_open";

export type AutomationTriggerType = AutomationEventType | AutomationScanType;

export type AutomationTrigger =
  | { type: "event"; eventType: AutomationEventType }
  | { type: "scan"; scanType: AutomationScanType };

export type AutomationConditionOperator = "and" | "or";

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
  | { type: "domain_is"; domain: string };

export type AutomationActionType =
  | "notify"
  | "create_signal"
  | "create_task"
  | "change_priority"
  | "assign"
  | "release_assignment"
  | "request_review"
  | "call_webhook"
  | "mark_risk";

export type AutomationRecipient =
  | { type: "assignee" }
  | { type: "reporter" }
  | { type: "reviewers" }
  | { type: "mission_owner" }
  | { type: "habitat_admins" }
  | { type: "agent"; agentId: string }
  | { type: "human"; userId: string }
  | { type: "channel"; channelId: string };

export interface AutomationActionNotify {
  type: "notify";
  recipients: AutomationRecipient[];
  template: string;
  channels?: string[];
  severity?: string;
}

export interface AutomationActionCreateSignal {
  type: "create_signal";
  content: string;
}

export interface AutomationActionCreateTask {
  type: "create_task";
  title: string;
  description?: string;
  missionId?: string;
  assignedTo?: { recipientType: string; recipientId: string };
}

export interface AutomationActionChangePriority {
  type: "change_priority";
  priority: string;
}

export interface AutomationActionAssign {
  type: "assign";
  recipientType: string;
  recipientId: string;
}

export interface AutomationActionReleaseAssignment {
  type: "release_assignment";
}

export interface AutomationActionRequestReview {
  type: "request_review";
  reviewerType?: string;
  reviewerId?: string;
}

export interface AutomationActionCallWebhook {
  type: "call_webhook";
  url: string;
  headers?: Record<string, string>;
  bodyTemplate?: string;
}

export interface AutomationActionMarkRisk {
  type: "mark_risk";
  level: string;
  reason?: string;
}

export type AutomationAction =
  | AutomationActionNotify
  | AutomationActionCreateSignal
  | AutomationActionCreateTask
  | AutomationActionChangePriority
  | AutomationActionAssign
  | AutomationActionReleaseAssignment
  | AutomationActionRequestReview
  | AutomationActionCallWebhook
  | AutomationActionMarkRisk;

export type AutomationRuleStatus = "enabled" | "disabled";

export type AutomationRunStatus =
  | "matched"
  | "skipped"
  | "running"
  | "succeeded"
  | "partial_failed"
  | "failed"
  | "simulated";

export type AutomationSkipReason =
  | "disabled"
  | "condition_false"
  | "cooldown"
  | "loop_guard"
  | "rate_limited"
  | "missing_target";

export type AutomationTargetType =
  | "task"
  | "mission"
  | "agent"
  | "sprint"
  | "pulse"
  | "habitat"
  | "integration"
  | "none";

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

export interface AutomationConditionResult {
  matched: boolean;
  conditionType: string;
  reason: string;
  children?: AutomationConditionResult[];
}

export interface AutomationActionResult {
  actionType: AutomationActionType;
  actionIndex: number;
  status: "succeeded" | "failed" | "skipped";
  error?: string;
  result?: Record<string, unknown>;
}

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

export interface AutomationTriggerContext {
  triggerType: AutomationTriggerType;
  triggerEventId: string | null;
  targetType: AutomationTargetType | null;
  targetId: string | null;
  habitatId: string;
  payload: Record<string, unknown>;
  provenance?: {
    source: string;
    ruleId?: string;
    runId?: string;
  };
}

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
