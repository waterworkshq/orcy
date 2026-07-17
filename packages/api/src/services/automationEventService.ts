import * as ruleRepo from "../repositories/automationRule.js";
import * as runRepo from "../repositories/automationRuleRun.js";
import { buildTriggerContext } from "./automationContextBuilder.js";
import { executeAndRecordRuleRun } from "./automationExecutor.js";
import type {
  AutomationEventType,
  AutomationTriggerType,
  AutomationTriggerContext,
  AutomationTargetType,
} from "@orcy/shared";

const EVENT_ALLOWLIST: Set<string> = new Set([
  "task.created",
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
  "release.shipped",
]);

interface IncomingEvent {
  type: string;
  data?: Record<string, unknown>;
}

/** Outcome of matching a single incoming event against a habitat's enabled automation rules. */
export interface IngestionResult {
  eventType: string;
  matched: number;
  skipped: number;
  errors: string[];
}

/** Matches an incoming event against a habitat's enabled automation rules, applying cooldown, rate-limit, and self-loop guards before starting a run for each matched rule. */
export async function ingestEvent(
  habitatId: string,
  event: IncomingEvent,
): Promise<IngestionResult> {
  const errors: string[] = [];

  if (!EVENT_ALLOWLIST.has(event.type)) {
    return { eventType: event.type, matched: 0, skipped: 0, errors: [] };
  }

  // Envelope-signature gate for task.created (dormancy mechanism):
  // Process task.created ONLY when the data carries the trusted committed-
  // envelope signature (data.causalContext). This field is set exclusively by
  // the T4B automationAdapter (which forwards envelope.causalContext — a NOT
  // NULL column); the legacy SSE Task DTO has no causalContext. Legacy SSE
  // task.created events remain a no-op, preserving pre-T11 production behavior.
  if (event.type === "task.created" && event.data?.causalContext === undefined) {
    return { eventType: event.type, matched: 0, skipped: 0, errors: [] };
  }

  const triggerType = event.type as AutomationEventType;
  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, triggerType);

  if (rules.length === 0) {
    return { eventType: event.type, matched: 0, skipped: 0, errors: [] };
  }

  let matched = 0;
  let skipped = 0;

  // The Phase 2 (eventId, ruleId) reservation engages only for trusted-envelope
  // task.created delivery. Other event types pass null → column stays null →
  // every call inserts unconditionally (zero behavior change for scans/manual).
  const eventDedupeKey =
    event.type === "task.created" ? ((event.data?.eventId as string | null) ?? null) : null;

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
          eventDedupeKey,
        );
        skipped++;
        continue;
      }

      const hourlyGuard = checkHourlyCap(rule.id);
      if (hourlyGuard.shouldSkip) {
        recordSkippedRun(rule.id, habitatId, triggerType, event, "rate_limited", eventDedupeKey);
        skipped++;
        continue;
      }

      const causalGuard = checkCausalChain(rule.id, event.data);
      if (causalGuard.cycle) {
        recordSkippedRun(rule.id, habitatId, triggerType, event, "causal_cycle", eventDedupeKey);
        skipped++;
        continue;
      }
      if (causalGuard.depthExceeded) {
        recordSkippedRun(
          rule.id,
          habitatId,
          triggerType,
          event,
          "causal_depth_limit",
          eventDedupeKey,
        );
        skipped++;
        continue;
      }

      const targetType = resolveTargetType(event);
      const targetId = (event.data?.taskId ??
        event.data?.missionId ??
        event.data?.agentId ??
        event.data?.sprintId) as string | null;

      await executeAndRecordRuleRun(
        rule,
        habitatId,
        triggerType,
        (event.data?.eventId as string | null) ?? null,
        targetType as AutomationTargetType | null,
        targetId,
        undefined,
        eventDedupeKey,
      );
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
  const rule = ruleRepo.getAutomationRuleById(ruleId);
  if (!rule) return { shouldSkip: true, skipReason: "missing_target" };

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

/** Maximum number of causal hops before the chain is considered too deep (prevents unbounded causal recursion). */
const CAUSAL_DEPTH_LIMIT = 32;

/**
 * Causal-chain membership inspection — replaces the old `isSelfLoop` guard.
 *
 * A rule hop is encoded as `{type:"automation", id:ruleId}` (consistent with
 * the legacy `provenanceType==="automation"` / `provenanceRuleId` semantics).
 * T8B (the producer migration) will append real hops matching this encoding.
 *
 * Returns `{cycle:true}` if the triggering rule already appears in the chain
 * (self-re-entry), and `{depthExceeded:true}` if the chain has reached
 * {@link CAUSAL_DEPTH_LIMIT} hops. For events with NO causalContext (all
 * legacy events), this is a no-op — behavior-equivalent to the old isSelfLoop
 * returning false.
 */
function checkCausalChain(
  ruleId: string,
  data?: Record<string, unknown>,
): { cycle: boolean; depthExceeded: boolean } {
  if (!data) return { cycle: false, depthExceeded: false };
  const causalContext = data.causalContext as
    | { hops?: Array<{ type: string; id: string }> }
    | undefined;
  const hops = causalContext?.hops;
  if (!hops || !Array.isArray(hops)) return { cycle: false, depthExceeded: false };

  const cycle = hops.some((hop) => hop.type === "automation" && hop.id === ruleId);
  const depthExceeded = hops.length >= CAUSAL_DEPTH_LIMIT;

  return { cycle, depthExceeded };
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
  eventDedupeKey?: string | null,
): void {
  const { run, created } = runRepo.startRuleRun({
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
    eventDedupeKey,
  });

  if (!created) return;

  runRepo.skipRuleRun(run.id, reason as any, {
    eventType: event.type,
    guard: reason,
  });
}
