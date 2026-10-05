/**
 * REC-07 family 2 — agent-facing automation inspection views.
 *
 * Bounded projections + the restricted agent simulation contract. Agents
 * never receive raw rule/run rows: rule rows carry secret-bearing action
 * config (webhook url + arbitrary headers, plugin params, signal content)
 * and run rows carry free-text error content plus `action_results` JSON.
 * Humans keep the raw rows byte-unchanged on every route (the only human
 * delta is the disclosed habitat-access tightening on the rule-id reads,
 * enforced at the route seam, not here).
 *
 * Static label discipline (reviewer C1/R8): every action/condition label
 * is an operand-free fixed string per discriminator type — no config
 * interpolation of any kind. Unknown/corrupt discriminators never echo:
 * they surface as the fixed "invalid"/"unknown" sentinel types.
 */
import { buildEvaluationContext, buildTriggerContext } from "./automationContextBuilder.js";
import { evaluateCondition, validateRule } from "./automationEvaluator.js";
import { validatePersistedCondition } from "../models/automationConditionSchema.js";
import { checkHabitatOwnership } from "./automationEventService.js";
import { badRequestWithCode, notFound } from "../errors.js";
import {
  AUTOMATION_ACTION_TYPES,
  AUTOMATION_EVENT_TYPES,
  AUTOMATION_SCAN_TYPES,
  type AutomationActionType,
  type AutomationCondition,
  type AutomationRule,
  type AutomationRuleRun,
  type AutomationRunStatus,
  type AutomationSkipReason,
  type AutomationTargetType,
} from "@orcy/shared";

// ---------------------------------------------------------------------------
// Fixed label tables (R8 — exact inventories, no counts, no operands)
// ---------------------------------------------------------------------------

/** The closed discriminator set of the condition tree (TS union has no runtime value). */
type ConditionDiscriminator = AutomationCondition["type"];

/** Operand-free per-type condition summaries; exhaustive over the union with a guard. */
const CONDITION_TYPE_SUMMARIES: Record<ConditionDiscriminator, string> = {
  always: "Always matches",
  and: "All child conditions match",
  or: "Any child condition matches",
  not: "The child condition does not match",
  field: "Compares a trigger context field against a configured value",
  priority_above: "Task priority is above a configured threshold",
  priority_below: "Task priority is below a configured threshold",
  status_in: "Task status is one of the configured statuses",
  assigned_to: "Task is assigned to a configured recipient",
  unassigned: "Task is unassigned",
  overdue_by: "Task is overdue by a configured number of minutes",
  label_contains: "Task labels contain a configured label",
  domain_is: "Agent domain equals a configured domain",
  plugin: "Plugin-defined condition",
};

/** Operand-free per-type static action labels; keyed against the runtime const. */
const ACTION_TYPE_DESCRIPTIONS: Record<AutomationActionType, string> = {
  notify: "Send a notification to the rule's configured recipients",
  create_signal: "Create a Pulse signal with the configured content",
  create_task: "Create a new task",
  change_priority: "Change the trigger target's priority to a configured level",
  assign: "Assign the trigger target to a configured recipient",
  release_assignment: "Release the trigger target's assignment",
  request_review: "Request a review on the trigger target",
  call_webhook: "POST to the configured webhook URL with the configured headers",
  mark_risk: "Mark the trigger target with a configured risk level",
  plugin: "Invoke the configured plugin action with the configured params",
};

const UNKNOWN_CONDITION_VIEW = {
  type: "invalid",
  summary: "Stored condition could not be interpreted",
} as const;

const UNKNOWN_ACTION_VIEW = {
  type: "unknown",
  description: "Unrecognized stored action type",
} as const;

/**
 * Runtime run-status allowlist. The DB column is free text;
 * writers use the `AutomationRunStatus` union. `satisfies` pins this set to
 * that union so a union change fails typecheck here. A non-conforming
 * stored status is OMITTED from the agent view (the same discipline as
 * `skipReason`) — never echoed as raw free text, never mapped to an
 * invented value.
 */
const RUN_STATUS_WHITELIST = new Set<string>([
  "matched",
  "skipped",
  "running",
  "succeeded",
  "partial_failed",
  "failed",
  "simulated",
] as const satisfies readonly AutomationRunStatus[]);

/**
 * Runtime skipReason whitelist. The DB column is free text; writers use the
 * `AutomationSkipReason` union. `satisfies` pins this set to that union so a
 * union change fails typecheck here (membership derived from the source
 * union, never hand-maintained prose). Non-conforming values are omitted.
 */
const SKIP_REASON_WHITELIST = new Set<string>([
  "disabled",
  "condition_false",
  "cooldown",
  "loop_guard",
  "rate_limited",
  "causal_cycle",
  "causal_depth_limit",
  "missing_target",
] as const satisfies readonly AutomationSkipReason[]);

// ---------------------------------------------------------------------------
// Rules projection
// ---------------------------------------------------------------------------

export interface AgentRuleView {
  id: string;
  habitatId: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  /** Constructed discriminated event/scan view; ABSENT when the stored trigger is malformed/unknown. */
  trigger?: { type: "event"; eventType: string } | { type: "scan"; scanType: string };
  cooldownSeconds: number;
  maxRunsPerHour: number;
  condition: { type: string; summary: string };
  actions: Array<{ type: string; description: string }>;
}

function conditionView(condition: unknown): { type: string; summary: string } {
  const t = (condition as { type?: unknown } | null | undefined)?.type;
  if (typeof t === "string" && t in CONDITION_TYPE_SUMMARIES) {
    return { type: t, summary: CONDITION_TYPE_SUMMARIES[t as ConditionDiscriminator] };
  }
  return { ...UNKNOWN_CONDITION_VIEW };
}

function actionView(action: unknown): { type: string; description: string } {
  const t = (action as { type?: unknown } | null | undefined)?.type;
  // AUTOMATION_ACTION_TYPES is the runtime inventory; guard against
  // corrupt legacy rows instead of trusting the stored discriminator.
  if (typeof t === "string" && (AUTOMATION_ACTION_TYPES as readonly string[]).includes(t)) {
    return {
      type: t,
      description: ACTION_TYPE_DESCRIPTIONS[t as AutomationActionType],
    };
  }
  return { ...UNKNOWN_ACTION_VIEW };
}

/**
 * Agent projection of a rule's trigger (reviewer F2): a NEWLY CONSTRUCTED
 * discriminated object — never a copy of the stored raw object, so extra
 * legacy keys (urls, params, headers) cannot ride along even on a valid
 * type. The discriminator and the enum member are validated against the
 * shared runtime allowlists; a malformed/unknown trigger OMITS the field.
 */
function triggerView(
  trigger: unknown,
): { type: "event"; eventType: string } | { type: "scan"; scanType: string } | undefined {
  const t = trigger as { type?: unknown; eventType?: unknown; scanType?: unknown } | null;
  if (
    t &&
    typeof t === "object" &&
    t.type === "event" &&
    typeof t.eventType === "string" &&
    (AUTOMATION_EVENT_TYPES as readonly string[]).includes(t.eventType)
  ) {
    return { type: "event", eventType: t.eventType };
  }
  if (
    t &&
    typeof t === "object" &&
    t.type === "scan" &&
    typeof t.scanType === "string" &&
    (AUTOMATION_SCAN_TYPES as readonly string[]).includes(t.scanType)
  ) {
    return { type: "scan", scanType: t.scanType };
  }
  return undefined;
}

/** Agent projection of a rule row: structural allowlist, fixed summaries, static labels. */
export function projectRuleForAgent(rule: AutomationRule): AgentRuleView {
  const trigger = triggerView(rule.trigger);
  return {
    id: rule.id,
    habitatId: rule.habitatId,
    name: rule.name,
    description: rule.description,
    enabled: rule.enabled,
    priority: rule.priority,
    // Constructed discriminated event/scan object only; omitted when the
    // stored trigger is malformed or outside the shared runtime allowlists.
    ...(trigger !== undefined ? { trigger } : {}),
    cooldownSeconds: rule.cooldownSeconds,
    maxRunsPerHour: rule.maxRunsPerHour,
    condition: conditionView(rule.condition),
    actions: (rule.actions ?? []).map(actionView),
  };
}

// ---------------------------------------------------------------------------
// Runs projection
// ---------------------------------------------------------------------------

export interface AgentRunView {
  id: string;
  ruleId: string;
  /** Whitelisted against the AutomationRunStatus union; omitted for non-conforming stored values. */
  status?: string;
  startedAt: string;
  finishedAt: string | null;
  skipReason?: string;
}

/** Agent projection of a run row: allowlisted fields; status and skipReason kept only when whitelisted. */
export function projectRunForAgent(run: AutomationRuleRun): AgentRunView {
  const view: AgentRunView = {
    id: run.id,
    ruleId: run.ruleId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
  };
  if (RUN_STATUS_WHITELIST.has(run.status)) {
    view.status = run.status;
  }
  if (run.skipReason !== null && SKIP_REASON_WHITELIST.has(run.skipReason)) {
    view.skipReason = run.skipReason;
  }
  return view;
}

// ---------------------------------------------------------------------------
// Restricted agent simulation
// ---------------------------------------------------------------------------

/** Bounded validation codes for the agent simulate response (separate from AutomationSkipReason). */
export type AgentSimulationValidationCode =
  | "invalid_condition"
  | "unsupported_plugin_condition"
  | "invalid_action_config";

export interface AgentSimulateResult {
  ruleId: string;
  ruleName: string;
  wouldExecute: boolean;
  skipReason?: AutomationSkipReason;
  validation: { valid: boolean; code?: AgentSimulationValidationCode };
  actionPreviews: Array<{ actionType: string; actionIndex: number; description: string }>;
  conditionResult: { matched: boolean; conditionType: string };
}

/** Recursive scan through and/or/not for ANY plugin-typed node (the real z.lazy grammar). */
function containsPluginNode(node: unknown): boolean {
  if (!node || typeof node !== "object") return false;
  const n = node as Record<string, unknown>;
  if (n.type === "plugin") return true;
  if (n.type === "and" || n.type === "or") {
    return Array.isArray(n.children) && n.children.some((c) => containsPluginNode(c));
  }
  if (n.type === "not") return containsPluginNode(n.child);
  return false;
}

/** Derive the effective trigger type string from a stored trigger (single source; routes reuse). */
export function deriveTriggerType(trigger: unknown, defaultIfEvent: string): string {
  const t = trigger as { type?: string; scanType?: string; eventType?: string };
  return t.type === "scan" ? (t.scanType ?? "unknown") : (t.eventType ?? defaultIfEvent);
}

/**
 * The restricted agent simulation contract (REC-07 family 2, reviewer form).
 *
 * Input rejections (fixed codes, never silent ignore):
 *   - `overrideCondition` present → 400 `override_condition_forbidden`
 *   - `payload` present           → 400 `payload_forbidden`
 *   - `targetType === "agent"`    → 400 `unsupported_target_type`
 *   - any other target fails `checkHabitatOwnership` scoped to the rule's
 *     habitat (missing or foreign, indistinguishable) → 404 BEFORE any
 *     context build or evaluation.
 *
 * Stored-condition classification (no evaluation on either branch):
 *   - schema-invalid tree → `invalid_condition`
 *   - plugin node anywhere in the tree → `unsupported_plugin_condition`
 *     (the evaluator — which dispatches plugin handlers — never runs).
 *
 * Evaluated branch: builtin conditions only, `skipReason` reported ONLY as
 * a real `AutomationSkipReason` ("condition_false"); never a coerced fake.
 * `triggerEventId` is accepted and carried, never dereferenced or echoed.
 * Actions are static previews only — nothing executes, nothing is written.
 */
export function simulateRuleForAgent(input: {
  rule: AutomationRule;
  body: Record<string, unknown>;
}): AgentSimulateResult {
  const body = input.body ?? {};
  if (body.overrideCondition !== undefined) {
    throw badRequestWithCode(
      "override_condition_forbidden",
      "Agents may not override a rule's condition",
    );
  }
  if (body.payload !== undefined) {
    throw badRequestWithCode("payload_forbidden", "Agents may not supply a simulation payload");
  }
  const targetType = body.targetType;
  const targetId = body.targetId;
  if (targetType === "agent") {
    throw badRequestWithCode(
      "unsupported_target_type",
      "agent targets are not supported by agent simulation",
    );
  }
  if (
    typeof targetType === "string" &&
    targetType !== "" &&
    typeof targetId === "string" &&
    targetId !== ""
  ) {
    const ownership = checkHabitatOwnership(
      input.rule.habitatId,
      targetType as AutomationTargetType,
      targetId,
    );
    if (ownership !== "valid") {
      throw notFound("Target not found");
    }
  }

  const previews = (input.rule.actions ?? []).map((action, index) => {
    const view = actionView(action);
    return { actionType: view.type, actionIndex: index, description: view.description };
  });

  const classified = (
    code: AgentSimulationValidationCode,
    conditionType: string,
  ): AgentSimulateResult => ({
    ruleId: input.rule.id,
    ruleName: input.rule.name,
    wouldExecute: false,
    validation: { valid: false, code },
    actionPreviews: previews,
    conditionResult: { matched: false, conditionType },
  });

  // Stored-tree classification BEFORE any evaluation: malformed legacy rows
  // are never evaluated and never echoed.
  const persisted = validatePersistedCondition(input.rule.condition);
  if (!persisted.valid) {
    return classified("invalid_condition", "invalid");
  }
  if (containsPluginNode(input.rule.condition)) {
    return classified("unsupported_plugin_condition", "plugin");
  }

  // Evaluated branch — builtin conditions only (plugin-free by the scan
  // above; the stored evaluator is safe to run on builtin trees).
  const trigger = buildTriggerContext({
    triggerType: deriveTriggerType(input.rule.trigger, "task.rejected"),
    triggerEventId: typeof body.triggerEventId === "string" ? body.triggerEventId : null,
    habitatId: input.rule.habitatId,
    targetType: (typeof targetType === "string" && targetType !== ""
      ? targetType
      : null) as AutomationTargetType | null,
    targetId: typeof targetId === "string" && targetId !== "" ? targetId : null,
    payload: {},
  });

  let conditionResult: { matched: boolean; conditionType: string };
  try {
    const evaluated = evaluateCondition(input.rule.condition, buildEvaluationContext(trigger));
    conditionResult = { matched: evaluated.matched, conditionType: evaluated.conditionType };
  } catch {
    // Schema-validated builtin trees cannot throw; a defensive fail-closed
    // classification if one ever does (never a 500 stack to an agent).
    return classified("invalid_condition", "invalid");
  }

  const actionValidation = validateRule(input.rule);
  if (!actionValidation.valid) {
    return {
      ruleId: input.rule.id,
      ruleName: input.rule.name,
      wouldExecute: false,
      // Bounded code only — the human validator's messages (header names,
      // template lengths) are not echoed to agents.
      validation: { valid: false, code: "invalid_action_config" },
      actionPreviews: previews,
      conditionResult,
    };
  }

  const wouldExecute = conditionResult.matched;
  const result: AgentSimulateResult = {
    ruleId: input.rule.id,
    ruleName: input.rule.name,
    wouldExecute,
    validation: { valid: true },
    actionPreviews: previews,
    conditionResult,
  };
  if (!wouldExecute) {
    result.skipReason = "condition_false";
  }
  return result;
}
