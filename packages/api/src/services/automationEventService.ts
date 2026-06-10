import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import { buildTriggerContext } from "./automationContextBuilder.js";
import { buildFingerprint } from "@orcy/shared";
import type {
  AutomationEventType,
  AutomationTriggerType,
  AutomationTriggerContext,
  AutomationTargetType,
} from "@orcy/shared";

const EVENT_ALLOWLIST: Set<string> = new Set([
  "task.rejected",
  "task.overdue",
  "task.priority_changed",
  "task.review_assigned",
  "task.review_completed",
  "mission.status_changed",
  "mission.progress",
  "pulse.signal_posted",
  "scheduled_task.failed",
  "code_evidence.updated",
  "anomaly.detected",
  "sprint.started",
  "sprint.completed",
]);

interface IncomingEvent {
  type: string;
  data?: Record<string, unknown>;
}

export interface IngestionResult {
  eventType: string;
  matched: number;
  skipped: number;
  errors: string[];
}

export function ingestEvent(habitatId: string, event: IncomingEvent): IngestionResult {
  const errors: string[] = [];

  if (!EVENT_ALLOWLIST.has(event.type)) {
    return { eventType: event.type, matched: 0, skipped: 0, errors: [] };
  }

  const triggerType = event.type as AutomationEventType;
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, triggerType);

  if (rules.length === 0) {
    return { eventType: event.type, matched: 0, skipped: 0, errors: [] };
  }

  let matched = 0;
  let skipped = 0;

  for (const rule of rules) {
    try {
      const fingerprintGuard = checkFingerprintGuard(rule.id, habitatId, triggerType, event);
      if (fingerprintGuard.shouldSkip) {
        recordSkippedRun(
          rule.id,
          habitatId,
          triggerType,
          event,
          fingerprintGuard.skipReason ?? "unknown",
        );
        skipped++;
        continue;
      }

      const hourlyGuard = checkHourlyCap(rule.id);
      if (hourlyGuard.shouldSkip) {
        recordSkippedRun(rule.id, habitatId, triggerType, event, "rate_limited");
        skipped++;
        continue;
      }

      if (isSelfLoop(rule.id, event.data)) {
        recordSkippedRun(rule.id, habitatId, triggerType, event, "loop_guard");
        skipped++;
        continue;
      }

      const run = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId,
        triggerType,
        triggerEventId: (event.data?.eventId as string | null) ?? null,
        targetType: resolveTargetType(event) as AutomationTargetType | null,
        targetId: (event.data?.taskId ??
          event.data?.missionId ??
          event.data?.agentId ??
          event.data?.sprintId) as string | null,
      });

      runRepo.finishRuleRun(run.id, { status: "succeeded" });
      matched++;
    } catch (err) {
      errors.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { eventType: event.type, matched, skipped, errors };
}

function checkFingerprintGuard(
  ruleId: string,
  habitatId: string,
  triggerType: AutomationTriggerType,
  event: IncomingEvent,
): { shouldSkip: boolean; skipReason?: string } {
  const fp = buildFingerprint(
    habitatId,
    ruleId,
    triggerType,
    (event.data?.eventId as string) ?? null,
    resolveTargetType(event) ?? null,
    ((event.data?.taskId ??
      event.data?.missionId ??
      event.data?.agentId ??
      event.data?.sprintId) as string) ?? null,
  );

  const rule = ruleRepo.getAutomationRuleById(ruleId);
  if (!rule) return { shouldSkip: true, skipReason: "missing_target" };

  if (!rule.enabled) return { shouldSkip: true, skipReason: "disabled" };

  const lastSuccess = runRepo.getLastSuccessfulRunForFingerprint({
    habitatId,
    ruleId,
    triggerType,
    triggerEventId: (event.data?.eventId as string) ?? null,
    targetType: resolveTargetType(event),
    targetId:
      ((event.data?.taskId ??
        event.data?.missionId ??
        event.data?.agentId ??
        event.data?.sprintId) as string) ?? null,
  });

  if (lastSuccess) {
    const cooldownWindow = rule.cooldownSeconds * 1000;
    const lastTime = new Date(lastSuccess.startedAt).getTime();
    const now = Date.now();
    if (now - lastTime < cooldownWindow) {
      return { shouldSkip: true, skipReason: "cooldown" };
    }
  }

  return { shouldSkip: false };
}

function checkHourlyCap(ruleId: string): { shouldSkip: boolean } {
  const rule = ruleRepo.getAutomationRuleById(ruleId);
  if (!rule) return { shouldSkip: false };

  const now = new Date().toISOString();
  const count = runRepo.getHourlyRunCount(ruleId, now);
  return { shouldSkip: count >= rule.maxRunsPerHour };
}

function isSelfLoop(ruleId: string, data?: Record<string, unknown>): boolean {
  if (!data) return false;
  if (data.provenanceType === "automation" && data.provenanceRuleId === ruleId) return true;
  return false;
}

function resolveTargetType(event: IncomingEvent): AutomationTargetType | null {
  if (event.type.startsWith("task.")) return "task";
  if (event.type.startsWith("mission.")) return "mission";
  if (event.type.startsWith("sprint.")) return "sprint";
  if (event.type.startsWith("pulse.")) return "pulse";
  if (event.type === "anomaly.detected") return "agent";
  if (event.type === "code_evidence.updated") return "integration";
  return null;
}

function recordSkippedRun(
  ruleId: string,
  habitatId: string,
  triggerType: AutomationTriggerType,
  event: IncomingEvent,
  reason: string,
): void {
  const run = runRepo.startRuleRun({
    ruleId,
    habitatId,
    triggerType,
    triggerEventId: (event.data?.eventId as string) ?? null,
    targetType: resolveTargetType(event) as AutomationTargetType | null,
    targetId:
      ((event.data?.taskId ??
        event.data?.missionId ??
        event.data?.agentId ??
        event.data?.sprintId) as string) ?? null,
  });

  runRepo.skipRuleRun(run.id, reason as any, {
    eventType: event.type,
    guard: reason,
  });
}
