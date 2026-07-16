import type {
  AutomationRule,
  AutomationAction,
  AutomationRuleRun,
  AutomationActionResult,
  AutomationRunStatus,
  AutomationTargetType,
  NotificationEventType,
} from "@orcy/shared";
import type { AutomationEvaluationContext } from "./automationContextBuilder.js";
import { buildEvaluationContext, buildTriggerContext } from "./automationContextBuilder.js";
import { renderTemplate } from "./automationTemplateRenderer.js";
import { enqueueNotificationForRecipients } from "./notificationCommandService.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as taskRepo from "../repositories/task.js";
import * as missionRepo from "../repositories/feature.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import { claimTask } from "./tasks/task-lifecycle.js";
import { assignReviewers } from "./reviewAssignmentService.js";
import type { AssignResult } from "./autoAssignService.js";
import { logger } from "../lib/logger.js";

const BANNED_HEADERS = new Set(["authorization", "cookie", "x-api-key", "x-token", "x-secret"]);

const SSRF_BLOCKED_PATTERNS = [
  /^https?:\/\/(localhost|127\.|10\.|172\.1[6-9]|172\.2\d|172\.3[0-1]|192\.168\.|0\.0\.0\.0|169\.254\.)/i,
];

function isUrlSafe(url: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return { safe: false, reason: "URL must use http or https" };
    }
    for (const pattern of SSRF_BLOCKED_PATTERNS) {
      if (pattern.test(url)) {
        return { safe: false, reason: "URL resolves to a private/internal address" };
      }
    }
    return { safe: true };
  } catch {
    return { safe: false, reason: "Invalid URL" };
  }
}

/** Runs every action on an automation rule in order and aggregates their results into an overall run status. */
export async function executeActions(
  rule: AutomationRule,
  run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): Promise<{ status: AutomationRunStatus; actionResults: AutomationActionResult[] }> {
  const actionResults: AutomationActionResult[] = [];
  let succeededCount = 0;
  let failedCount = 0;

  for (let i = 0; i < (rule.actions ?? []).length; i++) {
    const action = rule.actions![i];
    try {
      const result = await executeAction(action, i, rule, run, ctx);
      actionResults.push(result);
      if (result.status === "succeeded") {
        succeededCount++;
      } else {
        failedCount++;
      }
    } catch (err) {
      failedCount++;
      actionResults.push({
        actionType: action.type,
        actionIndex: i,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const status = calculateRunStatus(succeededCount, failedCount, actionResults.length);
  return { status, actionResults };
}

async function executeAction(
  action: AutomationAction,
  index: number,
  rule: AutomationRule,
  run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): Promise<AutomationActionResult> {
  switch (action.type) {
    case "notify":
      return executeNotify(action, index, rule, run, ctx);
    case "create_signal":
      return executeCreateSignal(action, index, rule, run, ctx);
    case "create_task":
      return executeCreateTask(action, index, rule, run, ctx);
    case "change_priority":
      return executeChangePriority(action, index, rule, run, ctx);
    case "assign":
      return executeAssign(action, index, rule, run, ctx);
    case "release_assignment":
      return executeReleaseAssignment(action, index, rule, run, ctx);
    case "request_review":
      return executeRequestReview(action, index, rule, run, ctx);
    case "call_webhook":
      return executeCallWebhook(action, index, rule, run, ctx);
    case "mark_risk":
      return executeMarkRisk(action, index, rule, run, ctx);
    case "plugin":
      return executePluginAction(action, index, rule, ctx);
  }
}

/**
 * Dispatches a plugin-defined action to the registered handler (ADR-0023).
 * Builds a PluginContext with the contribution's required capabilities,
 * projects the evaluation context, and invokes the handler with timeout.
 * Missing handler returns a failed result (fail-safe).
 */
async function executePluginAction(
  action: Extract<AutomationAction, { type: "plugin" }>,
  index: number,
  rule: AutomationRule,
  ctx: AutomationEvaluationContext,
): Promise<AutomationActionResult> {
  const { getActionEntry, dispatchActionHandler } = await import("../plugins/pluginManager.js");
  const { toPluginEvaluationContext } = await import("./automationEvaluator.js");
  const entry = getActionEntry(action.actionId);
  if (!entry) {
    return {
      actionType: "plugin",
      actionIndex: index,
      status: "failed",
      error: `No plugin handler registered for actionId "${action.actionId}"`,
    };
  }
  const evaluationCtx = toPluginEvaluationContext(ctx);
  try {
    const result = await dispatchActionHandler(
      entry,
      action.actionId,
      rule.habitatId,
      evaluationCtx,
      action.params ?? {},
    );
    return {
      actionType: "plugin",
      actionIndex: index,
      status: result.status,
      result: result.result,
      error: result.error,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      actionType: "plugin",
      actionIndex: index,
      status: "failed",
      error: `Plugin action "${action.actionId}" threw: ${message}`,
    };
  }
}

function executeNotify(
  action: AutomationAction & { type: "notify" },
  index: number,
  rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  const template = renderTemplate(action.template ?? "", ctx);

  const recipients = (action.recipients ?? [])
    .map((r) => {
      if (r.type === "assignee" && ctx.task?.assignedAgentId) {
        return { recipientType: "agent" as const, recipientId: ctx.task.assignedAgentId };
      }
      if (r.type === "reporter" && ctx.task?.createdBy) {
        return { recipientType: "human" as const, recipientId: ctx.task.createdBy };
      }
      if (r.type === "habitat_admins") {
        return null; // deferred to subscription resolution
      }
      if (r.type === "human" && "userId" in r) {
        return { recipientType: "human" as const, recipientId: r.userId };
      }
      if (r.type === "agent" && "agentId" in r) {
        return { recipientType: "agent" as const, recipientId: r.agentId };
      }
      return null;
    })
    .filter(Boolean) as Array<{ recipientType: "human" | "agent"; recipientId: string }>;

  const severity = (action.severity ?? "info") as "info" | "warning" | "critical";

  const eventType = resolveNotifyEventType(rule);

  const result = enqueueNotificationForRecipients(
    rule.habitatId,
    eventType,
    "automation",
    severity,
    recipients,
    {
      payload: {
        ruleName: rule.name,
        ruleId: rule.id,
        renderedTemplate: template.rendered,
        ...ctx.raw,
      },
      createdByType: "automation",
      createdById: `rule:${rule.id}`,
    },
  );

  return {
    actionType: "notify",
    actionIndex: index,
    status: "succeeded",
    result: {
      eventId: result.event.id,
      deliveryCount: result.deliveries.length,
      suppressedCount: result.suppressed.length,
    },
  };
}

function executeCreateSignal(
  action: AutomationAction & { type: "create_signal" },
  index: number,
  rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  const rendered = renderTemplate(action.content ?? "", ctx);

  const pulse = pulseRepo.createPulse({
    habitatId: rule.habitatId,
    missionId: ctx.mission?.id,
    fromType: "system",
    fromId: `automation:${rule.id}`,
    signalType: "context",
    subject: `[Automation] ${rule.name}`,
    body: rendered.rendered,
    taskId: ctx.task?.id,
    isAuto: true,
    metadata: { ruleId: rule.id },
  });

  return {
    actionType: "create_signal",
    actionIndex: index,
    status: "succeeded",
    result: { pulseId: pulse.id },
  };
}

function executeCreateTask(
  action: AutomationAction & { type: "create_task" },
  index: number,
  rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  const missionId = action.missionId ?? ctx.mission?.id;
  if (!missionId) {
    return {
      actionType: "create_task",
      actionIndex: index,
      status: "failed",
      error:
        "No mission available — task must be created under an explicit mission or trigger context mission",
    };
  }

  const mission = missionRepo.getMissionById(missionId);
  if (!mission) {
    return {
      actionType: "create_task",
      actionIndex: index,
      status: "failed",
      error: `Mission not found: ${missionId}`,
    };
  }

  const renderedTitle = renderTemplate(action.title ?? "Automated task", ctx);

  const task = taskRepo.createTask({
    missionId,
    title: renderedTitle.rendered,
    description: action.description ? renderTemplate(action.description, ctx).rendered : undefined,
    createdBy: `automation:${rule.id}`,
  });

  if (action.assignedTo) {
    taskRepo.updateTask(task.id, {
      assignedAgentId:
        action.assignedTo.recipientType === "agent" ? action.assignedTo.recipientId : undefined,
    });
  }

  return {
    actionType: "create_task",
    actionIndex: index,
    status: "succeeded",
    result: { taskId: task.id, title: renderedTitle.rendered },
  };
}

function executeChangePriority(
  action: AutomationAction & { type: "change_priority" },
  index: number,
  _rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  if (!ctx.task) {
    return {
      actionType: "change_priority",
      actionIndex: index,
      status: "failed",
      error: "No task context available for priority change",
    };
  }

  const prior = ctx.task.priority;
  const updated = taskRepo.updateTask(ctx.task.id, { priority: action.priority as any });
  if (!updated || !("task" in updated)) {
    return {
      actionType: "change_priority",
      actionIndex: index,
      status: "failed",
      error: "Failed to update task priority",
    };
  }

  return {
    actionType: "change_priority",
    actionIndex: index,
    status: "succeeded",
    result: { oldPriority: prior, newPriority: action.priority },
  };
}

function executeAssign(
  action: AutomationAction & { type: "assign" },
  index: number,
  _rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  if (!ctx.task) {
    return {
      actionType: "assign",
      actionIndex: index,
      status: "failed",
      error: "No task context available for assignment",
    };
  }

  if (action.recipientType !== "agent") {
    return {
      actionType: "assign",
      actionIndex: index,
      status: "failed",
      error: `Only agent assignment is supported in v0.18, got: ${action.recipientType}`,
    };
  }

  try {
    const result = claimTask(ctx.task.id, action.recipientId);
    if (!result.success) {
      return {
        actionType: "assign",
        actionIndex: index,
        status: "failed",
        error: `claimTask failed: ${result.reason}`,
      };
    }
    return {
      actionType: "assign",
      actionIndex: index,
      status: "succeeded",
      result: { agentId: action.recipientId, taskId: ctx.task.id },
    };
  } catch (err) {
    return {
      actionType: "assign",
      actionIndex: index,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function executeReleaseAssignment(
  action: AutomationAction & { type: "release_assignment" },
  index: number,
  _rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  if (!ctx.task) {
    return {
      actionType: "release_assignment",
      actionIndex: index,
      status: "failed",
      error: "No task context available for release",
    };
  }

  if (!ctx.task.assignedAgentId) {
    return {
      actionType: "release_assignment",
      actionIndex: index,
      status: "failed",
      error: "Task is not currently assigned",
    };
  }

  // Use direct repository release since automation acts as system, not the agent
  const released = taskRepo.releaseTask(ctx.task.id, "Automation rule action");
  if (!released) {
    return {
      actionType: "release_assignment",
      actionIndex: index,
      status: "failed",
      error: "releaseTask failed — task may not be in correct state",
    };
  }

  return {
    actionType: "release_assignment",
    actionIndex: index,
    status: "succeeded",
    result: { taskId: ctx.task.id },
  };
}

function executeRequestReview(
  action: AutomationAction & { type: "request_review" },
  index: number,
  rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  if (!ctx.task) {
    return {
      actionType: "request_review",
      actionIndex: index,
      status: "failed",
      error: "No task context available for review request",
    };
  }

  if (action.reviewerId) {
    taskReviewerRepo.create(
      ctx.task.id,
      (action.reviewerType as "human" | "agent") ?? "agent",
      action.reviewerId,
    );
    return {
      actionType: "request_review",
      actionIndex: index,
      status: "succeeded",
      result: { taskId: ctx.task.id, reviewerId: action.reviewerId },
    };
  }

  const result = assignReviewers(ctx.task.id, rule.habitatId);
  return {
    actionType: "request_review",
    actionIndex: index,
    status: "succeeded",
    result: {
      taskId: ctx.task.id,
      assignedCount: result.assigned.length,
      skipped: result.skipped,
      reason: result.reason,
    },
  };
}

async function executeCallWebhook(
  action: AutomationAction & { type: "call_webhook" },
  index: number,
  _rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): Promise<AutomationActionResult> {
  if (!action.url) {
    return {
      actionType: "call_webhook",
      actionIndex: index,
      status: "failed",
      error: "Webhook URL is required",
    };
  }

  const urlCheck = isUrlSafe(action.url);
  if (!urlCheck.safe) {
    return {
      actionType: "call_webhook",
      actionIndex: index,
      status: "failed",
      error: `URL rejected: ${urlCheck.reason}`,
    };
  }

  if (action.headers) {
    for (const key of Object.keys(action.headers)) {
      if (BANNED_HEADERS.has(key.toLowerCase())) {
        return {
          actionType: "call_webhook",
          actionIndex: index,
          status: "failed",
          error: `Header "${key}" is not allowed in webhook calls`,
        };
      }
    }
  }

  const body = action.bodyTemplate ? renderTemplate(action.bodyTemplate, ctx).rendered : undefined;

  try {
    const response = await fetch(action.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Orcy-Automation/1.0",
        ...action.headers,
      },
      body: body ?? undefined,
    });

    const responseText = await response.text().catch(() => "");
    const truncated = responseText.slice(0, 1000);

    return {
      actionType: "call_webhook",
      actionIndex: index,
      status: response.ok ? "succeeded" : "failed",
      result: { statusCode: response.status, ok: response.ok },
      error: response.ok ? undefined : `HTTP ${response.status}: ${truncated}`,
    };
  } catch (err) {
    return {
      actionType: "call_webhook",
      actionIndex: index,
      status: "failed",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function executeMarkRisk(
  action: AutomationAction & { type: "mark_risk" },
  index: number,
  _rule: AutomationRule,
  _run: AutomationRuleRun,
  ctx: AutomationEvaluationContext,
): AutomationActionResult {
  if (!ctx.task && !ctx.mission) {
    return {
      actionType: "mark_risk",
      actionIndex: index,
      status: "failed",
      error: "No task or mission context available for risk marking",
    };
  }

  return {
    actionType: "mark_risk",
    actionIndex: index,
    status: "succeeded",
    result: {
      level: action.level,
      reason: action.reason ?? "Marked by automation",
      targetType: ctx.task ? "task" : "mission",
      targetId: ctx.task?.id ?? ctx.mission?.id,
    },
  };
}

const AUTOMATION_TRIGGER_TO_NOTIFY_EVENT: Record<string, NotificationEventType> = {
  "task.rejected": "task.review_requested",
  "task.overdue": "task.assigned",
  "task.priority_changed": "task.assigned",
  "task.review_assigned": "task.review_requested",
  "task.review_completed": "task.review_requested",
  "mission.status_changed": "mission.risk_marked",
  "mission.progress": "mission.risk_marked",
  "pulse.signal_posted": "pulse.signal_posted",
  "scheduled_task.failed": "automation.action_failed",
  "code_evidence.updated": "automation.rule_matched",
  "anomaly.detected": "mission.risk_marked",
  "sprint.started": "automation.rule_matched",
  "sprint.completed": "automation.rule_matched",
  mission_blocked: "task.blocked",
  sprint_ending: "task.blocked",
  agent_silent: "task.blocked",
  evidence_gap_open: "task.blocked",
};

function resolveNotifyEventType(rule: AutomationRule): NotificationEventType {
  const triggerType = rule.trigger.type === "scan" ? rule.trigger.scanType : rule.trigger.eventType;
  return AUTOMATION_TRIGGER_TO_NOTIFY_EVENT[triggerType] ?? "automation.rule_matched";
}

function calculateRunStatus(succeeded: number, failed: number, total: number): AutomationRunStatus {
  if (total === 0) return "failed";
  if (failed === 0) return "succeeded";
  if (succeeded === 0) return "failed";
  return "partial_failed";
}

// --- onAutomationRunCompleted subscriber hook (mirrors transition-emitter.ts pattern) ---

type AutomationRunCompletedHook = (opts: {
  run: AutomationRuleRun;
  rule: AutomationRule;
  outcome: AutomationRunStatus;
  habitatId: string;
}) => void;

const automationRunCompletedHooks: AutomationRunCompletedHook[] = [];

/** Registers a hook invoked when an automation run completes (after actions execute or fail). Returns an unsubscribe function. */
export function onAutomationRunCompleted(hook: AutomationRunCompletedHook): () => void {
  automationRunCompletedHooks.push(hook);
  return () => {
    const idx = automationRunCompletedHooks.indexOf(hook);
    if (idx >= 0) automationRunCompletedHooks.splice(idx, 1);
  };
}

function notifyAutomationRunCompleted(opts: Parameters<AutomationRunCompletedHook>[0]): void {
  for (const hook of automationRunCompletedHooks) {
    try {
      hook(opts);
    } catch (err) {
      // Swallow per-hook errors so one bad subscriber cannot block the others.
      logger.warn({ err, hookName: hook.name }, "Automation run completed hook failed");
    }
  }
}

// --- Kill switch: checks env var + habitat automationSettings before executing actions ---

import * as habitatRepo from "../repositories/habitat.js";

/** Returns `true` if automation actions should execute for the given habitat, checking env var override then habitat settings; defaults to `true`. */
export function shouldExecuteActions(habitatId: string): boolean {
  if (process.env.ORCY_AUTOMATION_EXECUTE_ACTIONS === "false") return false;
  const habitat = habitatRepo.getHabitatById(habitatId);
  if (habitat?.automationSettings?.executeActions === false) return false;
  return true;
}

/**
 * Encapsulates the full rule-run lifecycle: starts the run, builds the evaluation context,
 * checks the kill switch, executes actions (if enabled), records the result, and fires
 * the `onAutomationRunCompleted` hook. Replaces the pre-v0.20.1 pattern of
 * `startRuleRun → finishRuleRun(succeeded)` without executing any actions.
 */
export async function executeAndRecordRuleRun(
  rule: AutomationRule,
  habitatId: string,
  triggerType: string,
  triggerEventId: string | null,
  targetType: AutomationTargetType | null,
  targetId: string | null,
  payload?: Record<string, unknown>,
): Promise<{ run: AutomationRuleRun; outcome: AutomationRunStatus }> {
  const run = runRepo.startRuleRun({
    ruleId: rule.id,
    habitatId,
    triggerType: triggerType as AutomationRuleRun["triggerType"],
    triggerEventId,
    targetType,
    targetId,
  });

  if (!shouldExecuteActions(habitatId)) {
    runRepo.finishRuleRun(run.id, { status: "succeeded" });
    notifyAutomationRunCompleted({ run, rule, outcome: "succeeded", habitatId });
    return { run, outcome: "succeeded" };
  }

  try {
    const ctx = buildEvaluationContext(
      buildTriggerContext({
        triggerType,
        triggerEventId,
        habitatId,
        targetType,
        targetId,
        payload,
      }),
    );
    const result = await executeActions(rule, run, ctx);
    runRepo.finishRuleRun(run.id, {
      status: result.status as "succeeded" | "partial_failed" | "failed",
      actionResults: result.actionResults,
    });
    notifyAutomationRunCompleted({ run, rule, outcome: result.status, habitatId });
    return { run, outcome: result.status };
  } catch (err) {
    runRepo.finishRuleRun(run.id, { status: "failed" });
    notifyAutomationRunCompleted({ run, rule, outcome: "failed", habitatId });
    return { run, outcome: "failed" };
  }
}
