import type {
  AutomationCondition,
  AutomationConditionResult,
  AutomationRule,
  TaskPriority,
  Task,
  Mission,
  Habitat,
  Agent,
  Sprint,
  PluginEvaluationContext,
  PluginHabitatView,
} from "@orcy/shared";
import type { AutomationEvaluationContext } from "./automationContextBuilder.js";
import * as pluginManager from "../plugins/pluginManager.js";

/** Maximum nesting depth allowed for recursive AND/OR/NOT condition trees before {@link ConditionDepthExceededError} is thrown. */
export const MAX_CONDITION_DEPTH = 5;

/** Error thrown when a condition tree is nested deeper than {@link MAX_CONDITION_DEPTH}. */
export class ConditionDepthExceededError extends Error {
  constructor(public readonly depth: number) {
    super(`Condition nesting depth exceeds maximum of ${MAX_CONDITION_DEPTH}: ${depth}`);
    this.name = "ConditionDepthExceededError";
  }
}

/** Error thrown when an automation condition is structurally invalid or uses an unrecognized shape. */
export class InvalidConditionError extends Error {
  constructor(message: string) {
    super(`INVALID_AUTOMATION_CONDITION: ${message}`);
    this.name = "InvalidConditionError";
  }
}

const PRIORITY_RANK: Record<TaskPriority, number> = {
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Recursively evaluates an automation condition tree against the evaluation context and returns whether it matched plus a human-readable reason. */
export function evaluateCondition(
  condition: AutomationCondition,
  ctx: AutomationEvaluationContext,
  depth: number = 0,
): AutomationConditionResult {
  if (depth > MAX_CONDITION_DEPTH) {
    throw new ConditionDepthExceededError(depth);
  }

  if (!condition || typeof condition !== "object" || !("type" in condition)) {
    throw new InvalidConditionError("Condition must be an object with a type field");
  }

  switch (condition.type) {
    case "always":
      return { matched: true, conditionType: "always", reason: "Always matches" };

    case "and": {
      const children = condition.children ?? [];
      if (children.length === 0) {
        return { matched: true, conditionType: "and", reason: "Empty AND matches vacuously" };
      }
      const childResults = children.map((c) => evaluateCondition(c, ctx, depth + 1));
      const matched = childResults.every((r) => r.matched);
      return {
        matched,
        conditionType: "and",
        reason: matched ? "All AND children matched" : "At least one AND child did not match",
        children: childResults,
      };
    }

    case "or": {
      const children = condition.children ?? [];
      if (children.length === 0) {
        return { matched: false, conditionType: "or", reason: "Empty OR does not match" };
      }
      const childResults = children.map((c) => evaluateCondition(c, ctx, depth + 1));
      const matched = childResults.some((r) => r.matched);
      return {
        matched,
        conditionType: "or",
        reason: matched ? "At least one OR child matched" : "No OR children matched",
        children: childResults,
      };
    }

    case "not": {
      if (!condition.child) {
        return { matched: true, conditionType: "not", reason: "Empty NOT matches vacuously" };
      }
      const childResult = evaluateCondition(condition.child, ctx, depth + 1);
      return {
        matched: !childResult.matched,
        conditionType: "not",
        reason: `Inverted child (was: ${childResult.matched})`,
        children: [childResult],
      };
    }

    case "field":
      return evaluateFieldCondition(condition.field, condition.operator, condition.value, ctx);

    case "priority_above":
      return evaluatePriorityAbove(condition.threshold as TaskPriority, ctx);

    case "priority_below":
      return evaluatePriorityBelow(condition.threshold as TaskPriority, ctx);

    case "status_in":
      return evaluateStatusIn(condition.statuses, ctx);

    case "assigned_to":
      return evaluateAssignedTo(condition.recipientType, condition.recipientId, ctx);

    case "unassigned":
      return evaluateUnassigned(ctx);

    case "overdue_by":
      return evaluateOverdueBy(condition.minutes, ctx);

    case "label_contains":
      return evaluateLabelContains(condition.label, ctx);

    case "domain_is":
      return evaluateDomainIs(condition.domain, ctx);

    case "plugin":
      return evaluatePluginCondition(condition, ctx);

    default:
      return {
        matched: false,
        conditionType: "unknown",
        reason: `Unknown condition type: ${JSON.stringify(condition)}`,
      };
  }
}

function evaluateFieldCondition(
  field: string,
  operator: string,
  value: unknown,
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  const fieldValue = resolveFieldPath(field, ctx);

  let matched = false;
  switch (operator) {
    case "equals":
      matched = fieldValue === value;
      break;
    case "not_equals":
      matched = fieldValue !== value;
      break;
    case "contains":
      matched =
        typeof fieldValue === "string" && typeof value === "string"
          ? fieldValue.includes(value)
          : Array.isArray(fieldValue) && fieldValue.includes(value as never);
      break;
    case "greater_than":
      matched = typeof fieldValue === "number" && typeof value === "number" && fieldValue > value;
      break;
    case "less_than":
      matched = typeof fieldValue === "number" && typeof value === "number" && fieldValue < value;
      break;
    case "in":
      matched = Array.isArray(value) && value.includes(fieldValue as never);
      break;
    case "not_in":
      matched = Array.isArray(value) && !value.includes(fieldValue as never);
      break;
    case "exists":
      matched = fieldValue !== null && fieldValue !== undefined;
      break;
    case "not_exists":
      matched = fieldValue === null || fieldValue === undefined;
      break;
    default:
      matched = false;
  }

  return {
    matched,
    conditionType: "field",
    reason: `${field} ${operator} ${JSON.stringify(value)} -> ${matched}`,
  };
}

function evaluatePriorityAbove(
  threshold: TaskPriority,
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  if (!ctx.task) {
    return { matched: false, conditionType: "priority_above", reason: "Missing task context" };
  }
  const taskRank = PRIORITY_RANK[ctx.task.priority];
  const thresholdRank = PRIORITY_RANK[threshold] ?? 0;
  const matched = taskRank > thresholdRank;
  return {
    matched,
    conditionType: "priority_above",
    reason: `Task priority ${ctx.task.priority} ${matched ? ">" : "<="} ${threshold}`,
  };
}

function evaluatePriorityBelow(
  threshold: TaskPriority,
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  if (!ctx.task) {
    return { matched: false, conditionType: "priority_below", reason: "Missing task context" };
  }
  const taskRank = PRIORITY_RANK[ctx.task.priority];
  const thresholdRank = PRIORITY_RANK[threshold] ?? 0;
  const matched = taskRank < thresholdRank;
  return {
    matched,
    conditionType: "priority_below",
    reason: `Task priority ${ctx.task.priority} ${matched ? "<" : ">="} ${threshold}`,
  };
}

function evaluateStatusIn(
  statuses: string[],
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  if (!ctx.task) {
    return { matched: false, conditionType: "status_in", reason: "Missing task context" };
  }
  const matched = statuses.includes(ctx.task.status);
  return {
    matched,
    conditionType: "status_in",
    reason: `Task status ${ctx.task.status} ${matched ? "in" : "not in"} [${statuses.join(", ")}]`,
  };
}

function evaluateAssignedTo(
  recipientType: string,
  recipientId: string,
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  if (!ctx.task) {
    return { matched: false, conditionType: "assigned_to", reason: "Missing task context" };
  }
  if (recipientType === "agent") {
    const matched = ctx.task.assignedAgentId === recipientId;
    return {
      matched,
      conditionType: "assigned_to",
      reason: `Task assignee ${ctx.task.assignedAgentId ?? "none"} ${matched ? "=" : "!="} ${recipientId}`,
    };
  }
  if (recipientType === "human") {
    const matched = ctx.task.createdBy === recipientId;
    return {
      matched,
      conditionType: "assigned_to",
      reason: `Task createdBy ${ctx.task.createdBy} ${matched ? "=" : "!="} ${recipientId}`,
    };
  }
  return {
    matched: false,
    conditionType: "assigned_to",
    reason: `Unknown recipient type: ${recipientType}`,
  };
}

function evaluateUnassigned(ctx: AutomationEvaluationContext): AutomationConditionResult {
  if (!ctx.task) {
    return { matched: false, conditionType: "unassigned", reason: "Missing task context" };
  }
  const matched = ctx.task.assignedAgentId === null;
  return {
    matched,
    conditionType: "unassigned",
    reason: matched ? "Task is unassigned" : "Task has an assignee",
  };
}

function evaluateOverdueBy(
  minutes: number,
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  if (!ctx.task) {
    return { matched: false, conditionType: "overdue_by", reason: "Missing task context" };
  }
  if (!ctx.mission) {
    return { matched: false, conditionType: "overdue_by", reason: "Missing mission context" };
  }
  const dueAt = ctx.mission.dueAt;
  if (!dueAt) {
    return { matched: false, conditionType: "overdue_by", reason: "Mission has no dueAt" };
  }
  const dueMs = new Date(dueAt).getTime();
  const nowMs = Date.now();
  const overdueMs = nowMs - dueMs;
  const overdueMinutes = overdueMs / 60000;
  const matched = overdueMinutes >= minutes;
  return {
    matched,
    conditionType: "overdue_by",
    reason: `Overdue by ${overdueMinutes.toFixed(1)} min ${matched ? ">=" : "<"} ${minutes} min`,
  };
}

function evaluateLabelContains(
  label: string,
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  if (!ctx.task) {
    return { matched: false, conditionType: "label_contains", reason: "Missing task context" };
  }
  const matched = ctx.task.labels.includes(label);
  return {
    matched,
    conditionType: "label_contains",
    reason: `Task labels [${ctx.task.labels.join(", ")}] ${matched ? "contain" : "do not contain"} "${label}"`,
  };
}

function evaluateDomainIs(
  domain: string,
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  if (!ctx.agent) {
    return { matched: false, conditionType: "domain_is", reason: "Missing agent context" };
  }
  const matched = ctx.agent.domain === domain;
  return {
    matched,
    conditionType: "domain_is",
    reason: `Agent domain ${ctx.agent.domain} ${matched ? "=" : "!="} ${domain}`,
  };
}

function resolveFieldPath(path: string, ctx: AutomationEvaluationContext): unknown {
  const parts = path.split(".");
  const root = parts[0];
  let current: unknown;
  switch (root) {
    case "task":
      current = ctx.task;
      break;
    case "mission":
      current = ctx.mission;
      break;
    case "habitat":
      current = ctx.habitat;
      break;
    case "agent":
      current = ctx.agent;
      break;
    case "sprint":
      current = ctx.sprint;
      break;
    case "raw":
      current = ctx.raw;
      break;
    default:
      return undefined;
  }

  let acc: unknown = current;
  for (let i = 1; i < parts.length; i++) {
    if (acc === null || acc === undefined) return undefined;
    acc = (acc as Record<string, unknown>)[parts[i]];
  }
  return acc;
}

/**
 * Evaluates a plugin-defined condition by dispatching to the registered handler.
 * If no handler is registered for the conditionId, returns not-matched (fail-safe).
 * Handler errors are caught and returned as not-matched — critical because
 * gateConditionMatches runs on the workflow gate path where a throw would
 * block transitions.
 */
function evaluatePluginCondition(
  condition: Extract<AutomationCondition, { type: "plugin" }>,
  ctx: AutomationEvaluationContext,
): AutomationConditionResult {
  const handler = pluginManager.getConditionHandler(condition.conditionId);
  if (!handler) {
    return {
      matched: false,
      conditionType: "plugin",
      reason: `No plugin handler registered for conditionId "${condition.conditionId}"`,
    };
  }
  try {
    const pluginCtx = toPluginEvaluationContext(ctx);
    const result = handler(pluginCtx, condition.params ?? {});
    return {
      matched: result.matched,
      conditionType: "plugin",
      reason: result.reason,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      matched: false,
      conditionType: "plugin",
      reason: `Plugin condition "${condition.conditionId}" threw: ${message}`,
    };
  }
}

/** Projects the internal evaluation context into the stripped plugin-safe view (ADR-0022). */
function toPluginEvaluationContext(ctx: AutomationEvaluationContext): PluginEvaluationContext {
  return {
    habitat: ctx.habitat
      ? {
          id: ctx.habitat.id,
          name: ctx.habitat.name,
          description: ctx.habitat.description,
          teamId: ctx.habitat.teamId,
          createdAt: ctx.habitat.createdAt,
          updatedAt: ctx.habitat.updatedAt,
        }
      : null,
    task: ctx.task,
    mission: ctx.mission
      ? {
          id: ctx.mission.id,
          title: ctx.mission.title,
          status: ctx.mission.status,
          habitatId: ctx.mission.habitatId,
          sprintId: ctx.mission.sprintId ?? null,
        }
      : null,
    agent: ctx.agent
      ? {
          id: ctx.agent.id,
          name: ctx.agent.name,
          type: ctx.agent.type,
          domain: ctx.agent.domain,
          status: ctx.agent.status,
        }
      : null,
    sprint: ctx.sprint
      ? {
          id: ctx.sprint.id,
          name: ctx.sprint.name,
          status: ctx.sprint.status,
          habitatId: ctx.sprint.habitatId,
        }
      : null,
    raw: ctx.raw,
  };
}

/** Outcome of validating an automation rule's structure and action configuration. */
export interface RuleValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/** Validates an automation rule's actions for structural constraints such as action limits, template size, and disallowed webhook headers. */
export function validateRule(rule: AutomationRule): RuleValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!rule.actions || rule.actions.length === 0) {
    errors.push("Rule must have at least one action");
  }
  if (rule.actions && rule.actions.length > 10) {
    errors.push("Rule cannot have more than 10 actions");
  }

  for (const action of rule.actions ?? []) {
    if (action.type === "notify") {
      const totalLen = (action.template ?? "").length;
      if (totalLen > 4000) {
        errors.push(`notify action template exceeds 4000 chars: ${totalLen}`);
      }
      if (!action.recipients || action.recipients.length === 0) {
        warnings.push("notify action has no recipients");
      }
    }
    if (action.type === "create_task" && !action.missionId) {
      warnings.push(
        "create_task action without explicit missionId must rely on trigger context mission",
      );
    }
    if (action.type === "call_webhook") {
      const bannedHeaders = ["authorization", "cookie", "x-api-key", "x-token", "x-secret"];
      for (const banned of bannedHeaders) {
        if (action.headers && Object.keys(action.headers).some((h) => h.toLowerCase() === banned)) {
          errors.push(`call_webhook action uses banned header: ${banned}`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, warnings };
}
