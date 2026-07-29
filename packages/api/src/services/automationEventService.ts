/**
 * CS-56 T4 — Event ingestion cut-over to the canonical attempt lifecycle.
 *
 * After T4, every event candidate is normalized ONCE (target + full payload
 * + dedupe identity + trusted causal context) and routed through
 * `attemptRuleRun`. The event path no longer owns:
 *   - cooldown / hourly / causal / missing-target guards (lifecycle owns them),
 *   - skip finalization (lifecycle owns it),
 *   - completion emission (lifecycle owns it).
 *
 * The event path keeps only:
 *   - the EVENT_ALLOWLIST runtime gate,
 *   - the trusted-envelope `task.created` dormancy gate,
 *   - source-specific target resolution (the technical-plan target matrix),
 *   - Habitat-ownership validation (so cross-Habitat targets fail closed
 *     BEFORE condition/action work),
 *   - caller-counter aggregation from the returned disposition.
 *
 * Counters derive SOLELY from the disposition kind:
 *   - `executed`     → `matched`
 *   - `skipped`      → `skipped`
 *   - `deduplicated` → `deduplicated` (NEW — was misclassified as matched)
 *   - `failed`       → recorded in `errors` only.
 *
 * After T5: every production caller (event + 7 scan families) routes
 * through the canonical lifecycle. The legacy `executeAndRecordRuleRun`
 * was retired in T5 — its production callers are gone and test fixtures
 * were migrated to `attemptRuleRun` directly.
 */
import { and, eq, inArray } from "drizzle-orm";
import { missions, tasks } from "../db/schema/index.js";
import { getDb } from "../db/index.js";
import * as ruleRepo from "../repositories/automationRule.js";
import * as missionRepo from "../repositories/mission.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as sprintRepo from "../repositories/sprint.js";
import * as taskRepo from "../repositories/taskCrud.js";
import {
  attemptRuleRun,
  type AutomationAttemptInput,
} from "./automationAttemptLifecycle.js";
import { ACTIVE_TASK_STATUSES, tallyDisposition } from "./automationScanService.js";
import type {
  AutomationEventType,
  AutomationTargetType,
  CausalContext,
} from "@orcy/shared";

/** Runtime allowlist of event types this service will dispatch. New types in the `AutomationEventType` union still won't fire rules without an allowlist entry. */
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
  /** Count of duplicate trusted deliveries whose reservation already owned a terminal row. */
  deduplicated: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Target resolution — the approved technical-plan target matrix.
// ---------------------------------------------------------------------------

interface NormalizedTrigger {
  triggerType: AutomationEventType;
  triggerEventId: string | null;
  targetType: AutomationTargetType | null;
  /**
   * Null when the owned entity is missing or belongs to a different Habitat.
   * The canonical lifecycle will reject the attempt as `missing_target`.
   */
  targetId: string | null;
}

/**
 * Check whether the agent has any *active* task assigned in a mission owned
 * by the rule Habitat. Agents are global, so the rule needs this signal
 * before accepting an Agent target — without it, every rule in every Habitat
 * would fire on every global Agent anomaly.
 *
 * "Active" follows the settled CS-56 contract: `claimed` / `in_progress` /
 * `submitted`. Terminal statuses (`done` / `approved` / `rejected` /
 * `failed`) intentionally do NOT count. The shared
 * {@link ACTIVE_TASK_STATUSES} list is also the one
 * `listSilentAgentsInHabitat` uses; both must agree so a global Agent whose
 * only Habitat work is a `done` Task cannot become a candidate or satisfy an
 * Agent-target request.
 *
 * Exported (CS-56 T6) so the manual-run route can validate the same
 * Habitat-relevance signal for caller-supplied Agent targets.
 */
export function agentHasHabitatWork(agentId: string, habitatId: string): boolean {
  const rows = getDb()
    .select({ id: tasks.id })
    .from(tasks)
    .innerJoin(missions, eq(missions.id, tasks.missionId))
    .where(
      and(
        eq(tasks.assignedAgentId, agentId),
        eq(missions.habitatId, habitatId),
        inArray(tasks.status, ACTIVE_TASK_STATUSES),
      ),
    )
    .limit(1)
    .all();
  return rows.length > 0;
}

/**
 * Habitat-ownership verdict for a normalized target.
 *
 * Exported (CS-56 T6) so the manual-run route can re-verify the same
 * ownership signal for caller-supplied targets before invoking the
 * canonical lifecycle.
 *  - `valid`         — entity loaded and belongs to the rule Habitat. The
 *                      targetId passes through.
 *  - `cross_habitat` — entity loaded and belongs to a DIFFERENT Habitat.
 *                      Direct entity targets must be treated as
 *                      `missing_target` BEFORE condition/action work.
 *  - `missing`       — entity not found. Direct entity targets must be
 *                      treated as `missing_target` BEFORE condition/action
 *                      work (the lifecycle's structural step-2 check will
 *                      finalize `missing_target` with null `conditionResult`
 *                      and no actions; letting a missing entity reach the
 *                      evaluator would let `{type:"always"}` rules fire
 *                      actions against a non-existent target, which the
 *                      plan explicitly forbids).
 *
 * The 3-state verdict also drives `anomaly.detected`'s candidate chain
 * (Task → Mission → Agent → Habitat fallback). Each candidate is checked
 * with `=== "valid"`; a `missing` or `cross_habitat` candidate naturally
 * falls through to the next, so anomaly's fallback semantics are preserved.
 */
type HabitatOwnership = "valid" | "cross_habitat" | "missing";

export function checkHabitatOwnership(
  habitatId: string,
  targetType: AutomationTargetType,
  targetId: string,
): HabitatOwnership {
  switch (targetType) {
    case "task": {
      const entityHabitat = taskRepo.getHabitatIdForTask(targetId);
      if (entityHabitat === null) return "missing";
      return entityHabitat === habitatId ? "valid" : "cross_habitat";
    }
    case "mission": {
      const m = missionRepo.getMissionById(targetId);
      if (!m) return "missing";
      return m.habitatId === habitatId ? "valid" : "cross_habitat";
    }
    case "sprint": {
      const s = sprintRepo.getById(targetId);
      if (!s) return "missing";
      return s.habitatId === habitatId ? "valid" : "cross_habitat";
    }
    case "pulse": {
      const p = pulseRepo.getPulseById(targetId);
      if (!p) return "missing";
      return p.habitatId === habitatId ? "valid" : "cross_habitat";
    }
    case "habitat":
      return targetId === habitatId ? "valid" : "cross_habitat";
    case "agent":
      // Already validated by the resolver via agentHasHabitatWork.
      return "valid";
    default:
      return "cross_habitat";
  }
}

/**
 * One event normalizer — replaces the duplicated `resolveTargetType` and
 * target-id expressions across `ingestEvent` / `checkFingerprintGuard` /
 * `recordSkippedRun`. Implements the approved target matrix from the
 * technical plan and validates Habitat ownership up front.
 *
 * Returns a fully normalized trigger ready to feed `attemptRuleRun`'s
 * `trigger` field. Returns `null` ONLY when the event type cannot be
 * resolved at all (e.g., `code_evidence.updated` with a payload
 * `targetType` outside `{task, mission}`).
 */
function normalizeEventTrigger(
  habitatId: string,
  event: IncomingEvent,
): NormalizedTrigger | null {
  const data = event.data ?? {};
  const triggerEventId = (data.eventId as string | null) ?? null;

  /**
   * Resolve targetId for a DIRECT entity target (the event explicitly names
   * a specific Task / Mission / Sprint / Pulse / code-evidence target).
   * Returns the candidate id only when the entity is `valid` — both
   * `cross_habitat` AND `missing` are nulled so the lifecycle's structural
   * step-2 check finalizes `missing_target` with null `conditionResult`
   * and no actions. This prevents the evaluator from firing actions for
   * `{type:"always"}` rules against a missing or cross-Habitat target.
   *
   * `anomaly.detected` does NOT use this helper — its candidate chain
   * checks `=== "valid"` directly and falls through to the next candidate
   * (Task → Mission → Agent → Habitat fallback) when a candidate is
   * missing or cross-Habitat.
   */
  const ownedTargetId = (
    targetType: AutomationTargetType,
    candidateId: string | null,
  ): string | null => {
    if (!candidateId) return null;
    const ownership = checkHabitatOwnership(habitatId, targetType, candidateId);
    return ownership === "valid" ? candidateId : null;
  };

  switch (event.type) {
    // task.* → target task
    case "task.created":
    case "task.rejected":
    case "task.overdue":
    case "task.priority_changed":
    case "task.review_assigned":
    case "task.review_completed": {
      const candidateId = (data.taskId as string | null) ?? null;
      return {
        triggerType: event.type,
        triggerEventId,
        targetType: "task",
        targetId: ownedTargetId("task", candidateId),
      };
    }

    // mission.* → target mission
    case "mission.status_changed":
    case "mission.progress": {
      const candidateId = (data.missionId as string | null) ?? null;
      return {
        triggerType: event.type,
        triggerEventId,
        targetType: "mission",
        targetId: ownedTargetId("mission", candidateId),
      };
    }

    // sprint.* → target sprint
    case "sprint.started":
    case "sprint.completed": {
      const candidateId = (data.sprintId as string | null) ?? null;
      return {
        triggerType: event.type,
        triggerEventId,
        targetType: "sprint",
        targetId: ownedTargetId("sprint", candidateId),
      };
    }

    // pulse.signal_posted → target pulse + pulseId
    case "pulse.signal_posted": {
      const candidateId = (data.pulseId as string | null) ?? null;
      return {
        triggerType: event.type,
        triggerEventId,
        targetType: "pulse",
        targetId: ownedTargetId("pulse", candidateId),
      };
    }

    // code_evidence.updated → payload targetType (task|mission) / payload targetId
    case "code_evidence.updated": {
      const payloadTargetType = data.targetType;
      if (payloadTargetType !== "task" && payloadTargetType !== "mission") {
        return null;
      }
      const targetType = payloadTargetType as AutomationTargetType;
      const candidateId = (data.targetId as string | null) ?? null;
      return {
        triggerType: event.type,
        triggerEventId,
        targetType,
        targetId: ownedTargetId(targetType, candidateId),
      };
    }

    // anomaly.detected → first Habitat-valid domain target (Task, Mission,
    // Agent); otherwise normalize to Habitat while retaining Agent facts in
    // the payload (which is forwarded as `raw` to the lifecycle).
    case "anomaly.detected": {
      const taskId = data.taskId as string | undefined;
      const missionId = data.missionId as string | undefined;
      const agentId = data.agentId as string | undefined;

      if (taskId && checkHabitatOwnership(habitatId, "task", taskId) === "valid") {
        return {
          triggerType: event.type,
          triggerEventId,
          targetType: "task",
          targetId: taskId,
        };
      }
      if (
        missionId &&
        checkHabitatOwnership(habitatId, "mission", missionId) === "valid"
      ) {
        return {
          triggerType: event.type,
          triggerEventId,
          targetType: "mission",
          targetId: missionId,
        };
      }
      if (agentId && agentHasHabitatWork(agentId, habitatId)) {
        return {
          triggerType: event.type,
          triggerEventId,
          targetType: "agent",
          targetId: agentId,
        };
      }
      // Unrelated global Agent anomaly → Habitat target. Agent facts stay
      // under `raw` via the full-payload forward below.
      return {
        triggerType: event.type,
        triggerEventId,
        targetType: "habitat",
        targetId: habitatId,
      };
    }

    // scheduled_task.failed → Habitat target; scheduleId stays in raw
    case "scheduled_task.failed":
      return {
        triggerType: event.type,
        triggerEventId,
        targetType: "habitat",
        targetId: habitatId,
      };

    // release.shipped → Habitat target; releaseId stays in raw
    case "release.shipped":
      return {
        triggerType: event.type,
        triggerEventId,
        targetType: "habitat",
        targetId: habitatId,
      };

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Ingestion seam
// ---------------------------------------------------------------------------

/**
 * Matches an incoming event against a habitat's enabled automation rules and
 * routes each match through the canonical lifecycle (`attemptRuleRun`).
 *
 * Counters derive SOLELY from the returned disposition; this method does
 * NOT apply guards, evaluate conditions, or finalize runs. It owns only the
 * allowlist / dormancy gates, target normalization, Habitat-ownership
 * validation, and caller-counter aggregation.
 */
export async function ingestEvent(
  habitatId: string,
  event: IncomingEvent,
): Promise<IngestionResult> {
  const empty: IngestionResult = {
    eventType: event.type,
    matched: 0,
    skipped: 0,
    deduplicated: 0,
    errors: [],
  };

  if (!EVENT_ALLOWLIST.has(event.type)) {
    return empty;
  }

  // Envelope-signature gate for task.created (dormancy mechanism):
  // Process task.created ONLY when the data carries the trusted committed-
  // envelope signature (data.causalContext). This field is set exclusively by
  // the T4B automationAdapter (which forwards envelope.causalContext — a NOT
  // NULL column); the legacy SSE Task DTO has no causalContext. Legacy SSE
  // task.created events remain a no-op, preserving pre-T11 production behavior.
  if (event.type === "task.created" && event.data?.causalContext === undefined) {
    return empty;
  }

  const trigger = normalizeEventTrigger(habitatId, event);
  if (!trigger) {
    // Unresolvable event type (e.g., code_evidence.updated with an unknown
    // payload targetType). No rules can fire, no reservation is taken.
    return empty;
  }

  const rules = ruleRepo.getEnabledRulesByHabitatAndTrigger(habitatId, trigger.triggerType);
  if (rules.length === 0) {
    return empty;
  }

  // Trusted-envelope `(eventDedupeKey, ruleId)` reservation engages ONLY for
  // trusted `task.created`. Other event types pass null → the column stays
  // null → every call inserts unconditionally (zero behavior change for
  // scans / manual / non-trusted events).
  const eventDedupeKey =
    event.type === "task.created" ? ((event.data?.eventId as string | null) ?? null) : null;

  // The trusted-envelope causalContext (task.created only). Server-derived
  // from the producer's committed envelope — clients cannot inject chain
  // identity. Non-task.created events have no inherited chain → undefined.
  const causalContext =
    event.type === "task.created"
      ? (event.data?.causalContext as CausalContext | undefined)
      : undefined;

  // The FULL producer payload becomes `trigger.payload`. Live `raw.*`
  // conditions observe the same data as simulation for an identical
  // normalized trigger.
  const payload = event.data ?? {};

  // Single mutable accumulator passed by reference to `tallyDisposition`.
  // The shorthand `{ matched, skipped, deduplicated, errors }` works
  // because JS object property assignment IS mutation (numbers stored as
  // properties). Reading from the accumulator avoids the
  // destructured-then-discarded bug that would silently lose increments.
  const acc = { matched: 0, skipped: 0, deduplicated: 0, errors: [] as string[] };

  for (const rule of rules) {
    try {
      const input: AutomationAttemptInput = {
        rule,
        source: "event",
        trigger: {
          triggerType: trigger.triggerType,
          triggerEventId: trigger.triggerEventId,
          habitatId,
          targetType: trigger.targetType,
          targetId: trigger.targetId,
          payload,
          causalContext,
        },
        eventDedupeKey,
      };

      const disposition = await attemptRuleRun(input);
      tallyDisposition(rule, disposition, acc);
    } catch (err) {
      // Anything thrown from attemptRuleRun that escaped its try/catch (e.g.,
      // terminal persistence failure) is surfaced as an error; no row exists
      // in that path so we cannot count it as matched / skipped.
      acc.errors.push(`Rule ${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    eventType: event.type,
    matched: acc.matched,
    skipped: acc.skipped,
    deduplicated: acc.deduplicated,
    errors: acc.errors,
  };
}
