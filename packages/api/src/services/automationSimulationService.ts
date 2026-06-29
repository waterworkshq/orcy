import {
  buildEvaluationContext,
  buildTriggerContext,
  type AutomationEvaluationContext,
} from "./automationContextBuilder.js";
import {
  evaluateCondition,
  validateRule,
  type RuleValidationResult,
} from "./automationEvaluator.js";
import type {
  AutomationRule,
  AutomationSimulationResult,
  AutomationTriggerContext,
  AutomationAction,
  AutomationActionType,
  AutomationConditionResult,
  AutomationSkipReason,
} from "@orcy/shared";

/** Input for simulating an automation rule against a trigger without executing its actions. */
export interface SimulateRuleInput {
  rule: AutomationRule;
  trigger: AutomationTriggerContext;
  overrideCondition?: AutomationRule["condition"];
}

/** Outcome of a simulation: condition result, action previews, resolved context, and rule validation. */
export interface SimulateRuleResult extends AutomationSimulationResult {
  context: AutomationEvaluationContext;
  validation: RuleValidationResult;
}

/** Simulates an automation rule against a trigger, reporting whether it would execute and previewing each action without side effects. */
export function simulateRule(input: SimulateRuleInput): SimulateRuleResult {
  const context = buildEvaluationContext(input.trigger);
  const validation = validateRule(input.rule);

  const condition = input.overrideCondition ?? input.rule.condition;
  const conditionResult = evaluateCondition(condition, context);

  const wouldExecute = conditionResult.matched && validation.valid;

  const skipReason: AutomationSkipReason | undefined = wouldExecute
    ? undefined
    : !validation.valid
      ? "missing_target"
      : "condition_false";

  const actionPreviews = (input.rule.actions ?? []).map((action, index) =>
    previewAction(action, index, context),
  );

  return {
    ruleId: input.rule.id,
    ruleName: input.rule.name,
    conditionResult,
    wouldExecute,
    skipReason: wouldExecute ? undefined : skipReason,
    actionPreviews,
    context,
    validation,
  };
}

function previewAction(
  action: AutomationAction,
  index: number,
  context: AutomationEvaluationContext,
): { actionType: AutomationActionType; actionIndex: number; description: string } {
  switch (action.type) {
    case "notify":
      return {
        actionType: "notify",
        actionIndex: index,
        description: `Send notification to ${action.recipients.length} recipient(s): ${action.template ?? "(no template)"}`,
      };
    case "create_signal":
      return {
        actionType: "create_signal",
        actionIndex: index,
        description: `Create Pulse signal: ${action.content ?? "(no content)"}`,
      };
    case "create_task":
      return {
        actionType: "create_task",
        actionIndex: index,
        description: `Create task "${action.title ?? "(no title)"}" in mission ${action.missionId ?? "(from context)"}`,
      };
    case "change_priority":
      return {
        actionType: "change_priority",
        actionIndex: index,
        description: `Change task priority to ${action.priority ?? "(unknown)"}`,
      };
    case "assign":
      return {
        actionType: "assign",
        actionIndex: index,
        description: `Assign to ${action.recipientType}:${action.recipientId ?? "(unknown)"}`,
      };
    case "release_assignment":
      return {
        actionType: "release_assignment",
        actionIndex: index,
        description: "Release task assignment",
      };
    case "request_review":
      return {
        actionType: "request_review",
        actionIndex: index,
        description: action.reviewerId
          ? `Request review from ${action.reviewerType ?? "agent"}:${action.reviewerId}`
          : "Request review (auto-pick reviewer)",
      };
    case "call_webhook":
      return {
        actionType: "call_webhook",
        actionIndex: index,
        description: `POST to webhook ${action.url ?? "(no url)"}`,
      };
    case "mark_risk":
      return {
        actionType: "mark_risk",
        actionIndex: index,
        description: `Mark risk level ${action.level ?? "(unknown)"}${action.reason ? `: ${action.reason}` : ""}`,
      };
    case "plugin":
      return {
        actionType: "plugin",
        actionIndex: index,
        description: `Plugin action "${action.actionId}"${Object.keys(action.params ?? {}).length > 0 ? ` (params: ${JSON.stringify(action.params)})` : ""}`,
      };
  }
}

/** Convenience wrapper that assembles a trigger context for simulation from simplified arguments. */
export function buildSimulationTrigger(args: {
  habitatId: string;
  triggerType: string;
  triggerEventId?: string | null;
  targetType?: AutomationTriggerContext["targetType"];
  targetId?: string | null;
  payload?: Record<string, unknown>;
}): AutomationTriggerContext {
  return buildTriggerContext({
    triggerType: args.triggerType,
    triggerEventId: args.triggerEventId ?? null,
    habitatId: args.habitatId,
    targetType: args.targetType,
    targetId: args.targetId,
    payload: args.payload,
  });
}
