/**
 * CS-56 T3 — Canonical rule-attempt lifecycle.
 *
 * Owns the full pipeline from admission through terminal persistence and
 * live-process completion. Callers (event/scan/manual) supply only a
 * normalized {@link AutomationAttemptInput}; this seam enforces the
 * settled 10-step ordering and returns a discriminated
 * {@link AutomationAttemptDisposition}.
 *
 * The 10 steps, executed in order:
 *   1.  Normalize + validate target   (rejects missing target as `missing_target`)
 *   2.  Cooldown                      (pre-admission rejection, not admitted)
 *   3.  Admitted-attempt hourly cap   (pre-admission rejection, not admitted)
 *   4.  Reserve/start, or return `deduplicated`
 *   5.  Build context + runtime-validate the persisted condition
 *   6.  Evaluate the condition        (false → `skipped/condition_false`)
 *   7.  Causal cycle/depth guard      (only after a TRUE condition)
 *   8.  Global/Habitat action kill switch (disabled → `skipped/disabled`)
 *   9.  Ordered actions               (composite action status)
 *   10. Owned terminalization + completion
 *
 * Completion delivery is exactly once per owned `running → terminal`
 * transition: `terminalizeRuleRun` returns `transitioned: false` when a
 * concurrent finalizer wins the race, and we emit only on `true`.
 *
 * As of CS-56 ship (post-T6), every production caller — event ingestion,
 * all seven scheduled-scan families, and the manual-run route — flows
 * through `attemptRuleRun`. The pre-CS-56 one-shot seam
 * `executeAndRecordRuleRun` was retired in T5.
 */
import type {
  AutomationRule,
  AutomationRuleRun,
  AutomationConditionResult,
  AutomationActionResult,
  AutomationSkipReason,
  AutomationTargetType,
  AutomationRunStatus,
  CausalContext,
} from "@orcy/shared";
import * as runRepo from "../repositories/automationRuleRun.js";
import { validatePersistedCondition } from "../models/automationConditionSchema.js";
import {
  buildEvaluationContext,
  buildTriggerContext,
} from "./automationContextBuilder.js";
import { evaluateCondition } from "./automationEvaluator.js";
import {
  executeActions,
  notifyAutomationRunCompleted,
  shouldExecuteActions,
} from "./automationExecutor.js";

/** Origin of this attempt — used for guarded-skip metadata and future counter derivation. */
export type AutomationAttemptSource = "event" | "scan" | "manual";

/** Maximum number of causal hops before the chain is considered too deep. */
export const CAUSAL_DEPTH_LIMIT = 32;

/**
 * Structured input for the canonical lifecycle. Callers supply the rule,
 * already-normalized trigger identity, the optional trusted-envelope
 * dedupe key, and the source label for diagnostics.
 */
export interface AutomationAttemptInput {
  rule: AutomationRule;
  source: AutomationAttemptSource;
  trigger: {
    triggerType: string;
    triggerEventId: string | null;
    habitatId: string;
    targetType: AutomationTargetType | null;
    targetId: string | null;
    payload?: Record<string, unknown>;
    causalContext?: CausalContext;
  };
  /** Trusted-envelope dedupe key (`(eventId, ruleId)` reservation). Null for scans/manual. */
  eventDedupeKey?: string | null;
  /** Override for the "now" timestamp (used by tests for deterministic cooldown). */
  now?: string;
}

/**
 * The 4-kind discriminated result. The disposition is the only basis for
 * ingestion and scan counters (T4/T5 will derive them from this).
 *
 *  - `executed`     — actions ran; `outcome` is the composite action status.
 *  - `skipped`      — terminal skip; `reason` is the {@link AutomationSkipReason}.
 *  - `failed`       — failed-evaluation or action executor throw; `stage` pinpoints the cause.
 *  - `deduplicated` — duplicate trusted delivery; the returned run is the
 *                     EXISTING owned row, not mutated by this call.
 */
export type AutomationAttemptDisposition =
  | { kind: "executed"; run: AutomationRuleRun; outcome: AutomationRunStatus; actionResults: AutomationActionResult[] }
  | { kind: "skipped"; run: AutomationRuleRun; reason: AutomationSkipReason }
  | { kind: "failed"; run: AutomationRuleRun; stage: "condition" | "actions" }
  | { kind: "deduplicated"; run: AutomationRuleRun };

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface TargetValidation {
  valid: boolean;
  /** Diagnostic metadata persisted alongside an owned `missing_target` skip. */
  metadata?: Record<string, unknown>;
}

/**
 * Step 1 — target normalization + validation.
 *
 * A "specified" target type with a null/missing id is rejected. Cross-Habitat
 * ownership rejection is intentionally NOT implemented in T3 — that's part of
 * the trigger-normalization cutover (T4) which centralizes the resolver.
 */
function validateTarget(input: AutomationAttemptInput): TargetValidation {
  const { targetType, targetId } = input.trigger;
  if (targetType && targetType !== "none" && !targetId) {
    return {
      valid: false,
      metadata: { reason: "missing_target", targetType: String(targetType) },
    };
  }
  return { valid: true };
}

/**
 * Step 2 — cooldown check.
 *
 * Mirrors the legacy `checkFingerprintGuard` in `automationEventService.ts`:
 * a successful run for the same fingerprint within `rule.cooldownSeconds`
 * blocks the attempt. Non-admitting: rejection rows do not count toward the
 * hourly budget.
 */
function inCooldown(rule: AutomationRule, input: AutomationAttemptInput, nowIso: string): boolean {
  const { trigger } = input;
  const last = runRepo.getLastSuccessfulRunForFingerprint({
    habitatId: trigger.habitatId,
    ruleId: rule.id,
    triggerType: String(trigger.triggerType),
    triggerEventId: trigger.triggerEventId,
    targetType: trigger.targetType ?? null,
    targetId: trigger.targetId ?? null,
  });
  if (!last) return false;
  const windowMs = rule.cooldownSeconds * 1000;
  const elapsed = new Date(nowIso).getTime() - new Date(last.startedAt).getTime();
  return elapsed < windowMs;
}

/**
 * Step 7 — causal cycle / depth guard. Mirrors `checkCausalChain` in
 * `automationEventService.ts`. Only invoked after a TRUE condition.
 */
function checkCausalChain(
  ruleId: string,
  causalContext: CausalContext | undefined,
): { cycle: boolean; depthExceeded: boolean } {
  const hops = causalContext?.hops;
  if (!hops || !Array.isArray(hops)) return { cycle: false, depthExceeded: false };
  const cycle = hops.some((hop) => hop.type === "automation" && hop.id === ruleId);
  const depthExceeded = hops.length >= CAUSAL_DEPTH_LIMIT;
  return { cycle, depthExceeded };
}

/**
 * Reserve a run row for a pre-admission rejection. We reserve BEFORE
 * writing the terminal skip so a duplicate trusted delivery resolves as
 * `deduplicated` (one row), not as a second skip.
 */
function reserveGuardedRun(
  input: AutomationAttemptInput,
  nowIso: string,
): ReturnType<typeof runRepo.startRuleRun> {
  return runRepo.startRuleRun({
    ruleId: input.rule.id,
    habitatId: input.trigger.habitatId,
    triggerType: String(input.trigger.triggerType),
    triggerEventId: input.trigger.triggerEventId,
    targetType: input.trigger.targetType,
    targetId: input.trigger.targetId,
    eventDedupeKey: input.eventDedupeKey ?? null,
    now: nowIso,
  });
}

/**
 * Build the shared `terminalizeRuleRun` input from a branch's terminal state.
 * Keeps call sites tidy and ensures `finishedAt` is the controlled `nowIso`
 * (so the T2 sql.js ownership probe — comparing against this same value —
 * matches by construction).
 */
function buildTerminalizeInput(
  args: {
    runId: string;
    status: Extract<
      AutomationRunStatus,
      "skipped" | "succeeded" | "partial_failed" | "failed" | "simulated"
    >;
    skipReason?: AutomationSkipReason | null;
    conditionResult?: AutomationConditionResult | null;
    actionResults?: AutomationActionResult[] | null;
    metadata?: Record<string, unknown> | null;
  },
  nowIso: string,
): Parameters<typeof runRepo.terminalizeRuleRun>[0] {
  return {
    runId: args.runId,
    status: args.status,
    skipReason: args.skipReason ?? null,
    conditionResult: args.conditionResult ?? null,
    actionResults: args.actionResults ?? null,
    metadata: args.metadata ?? null,
    finishedAt: nowIso,
  };
}

/**
 * Emit one in-process completion callback. Guarded by `transitioned === true`
 * so a double-finalization (or a concurrent terminalizer winning the race)
 * never emits a second completion. Returns the refreshed run for the
 * disposition.
 */
function terminalizeAndEmit(
  args: {
    terminalize: Parameters<typeof runRepo.terminalizeRuleRun>[0];
    rule: AutomationRule;
    habitatId: string;
    outcome: AutomationRunStatus;
  },
  nowIso: string,
): { run: AutomationRuleRun; transitioned: boolean } {
  const { run, transitioned } = runRepo.terminalizeRuleRun({
    ...args.terminalize,
    finishedAt: nowIso,
  });
  if (transitioned) {
    notifyAutomationRunCompleted({
      run,
      rule: args.rule,
      outcome: args.outcome,
      habitatId: args.habitatId,
    });
  }
  return { run, transitioned };
}

/**
 * Synthetic unmatched `invalid` condition result for runtime-validated
 * malformed/depth-exceeded trees. The decision doc and schema persist this
 * shape so operators can see which attempt failed validation.
 */
function syntheticInvalidConditionResult(diagnostic: string | null): AutomationConditionResult {
  return {
    matched: false,
    conditionType: "invalid",
    reason: diagnostic ?? "invalid condition",
  };
}

// ---------------------------------------------------------------------------
// Canonical seam
// ---------------------------------------------------------------------------

/**
 * Run the canonical rule-attempt lifecycle for one input.
 *
 * The returned disposition is the only authoritative source for the run's
 * outcome; ingestion and scan counters (T4/T5) derive solely from it.
 * Dedupe losers never emit completion and never mutate the existing run.
 */
export async function attemptRuleRun(
  input: AutomationAttemptInput,
): Promise<AutomationAttemptDisposition> {
  const { rule, trigger } = input;
  const habitatId = trigger.habitatId;
  const nowIso = input.now ?? new Date().toISOString();

  // Step 1 — normalize + validate target.
  const targetCheck = validateTarget(input);
  if (!targetCheck.valid) {
    const { run, created } = reserveGuardedRun(input, nowIso);
    if (!created) {
      return { kind: "deduplicated", run };
    }
    const { run: finalRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "skipped",
            skipReason: "missing_target",
            metadata: { source: input.source, ...targetCheck.metadata },
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "skipped",
      },
      nowIso,
    );
    return { kind: "skipped", run: finalRun, reason: "missing_target" };
  }

  // Step 2 — cooldown.
  if (inCooldown(rule, input, nowIso)) {
    const { run, created } = reserveGuardedRun(input, nowIso);
    if (!created) {
      return { kind: "deduplicated", run };
    }
    const { run: finalRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "skipped",
            skipReason: "cooldown",
            metadata: { source: input.source, guard: "cooldown" },
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "skipped",
      },
      nowIso,
    );
    return { kind: "skipped", run: finalRun, reason: "cooldown" };
  }

  // Step 3 — admitted-attempt hourly cap.
  const admitted = runRepo.countAdmittedAttemptsInWindow(rule.id, nowIso);
  if (admitted >= rule.maxRunsPerHour) {
    const { run, created } = reserveGuardedRun(input, nowIso);
    if (!created) {
      return { kind: "deduplicated", run };
    }
    const { run: finalRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "skipped",
            skipReason: "rate_limited",
            metadata: { source: input.source, guard: "rate_limited" },
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "skipped",
      },
      nowIso,
    );
    return { kind: "skipped", run: finalRun, reason: "rate_limited" };
  }

  // Step 4 — reserve/start the run. Dedupe losers return immediately.
  const { run, created } = runRepo.startRuleRun({
    ruleId: rule.id,
    habitatId,
    triggerType: String(trigger.triggerType),
    triggerEventId: trigger.triggerEventId,
    targetType: trigger.targetType,
    targetId: trigger.targetId,
    eventDedupeKey: input.eventDedupeKey ?? null,
    now: nowIso,
  });
  if (!created) {
    return { kind: "deduplicated", run };
  }

  // Step 5 — runtime-validate the persisted condition. Fail closed on
  // malformed or depth-exceeded trees with a synthetic unmatched `invalid`
  // result + bounded diagnostic.
  const validation = validatePersistedCondition(rule.condition);
  if (!validation.valid) {
    const synthetic = syntheticInvalidConditionResult(validation.diagnostic);
    const { run: failedRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "failed",
            conditionResult: synthetic,
            metadata: {
              source: input.source,
              stage: "condition",
              diagnostic: validation.diagnostic,
            },
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "failed",
      },
      nowIso,
    );
    return { kind: "failed", run: failedRun, stage: "condition" };
  }

  // Step 6 — evaluate the condition.
  const evalCtx = buildEvaluationContext(
    buildTriggerContext({
      triggerType: String(trigger.triggerType),
      triggerEventId: trigger.triggerEventId,
      habitatId,
      targetType: trigger.targetType,
      targetId: trigger.targetId,
      payload: trigger.payload,
      causalContext: trigger.causalContext,
    }),
  );
  const conditionResult = evaluateCondition(rule.condition, evalCtx);
  if (!conditionResult.matched) {
    const { run: skippedRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "skipped",
            skipReason: "condition_false",
            conditionResult,
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "skipped",
      },
      nowIso,
    );
    return { kind: "skipped", run: skippedRun, reason: "condition_false" };
  }

  // Step 7 — causal cycle / depth (only after a TRUE condition).
  const causalCheck = checkCausalChain(rule.id, trigger.causalContext);
  if (causalCheck.cycle) {
    const { run: skippedRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "skipped",
            skipReason: "causal_cycle",
            conditionResult,
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "skipped",
      },
      nowIso,
    );
    return { kind: "skipped", run: skippedRun, reason: "causal_cycle" };
  }
  if (causalCheck.depthExceeded) {
    const { run: skippedRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "skipped",
            skipReason: "causal_depth_limit",
            conditionResult,
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "skipped",
      },
      nowIso,
    );
    return { kind: "skipped", run: skippedRun, reason: "causal_depth_limit" };
  }

  // Step 8 — global/Habitat action kill switch. The persisted
  // conditionResult is the TRUE tree.
  if (!shouldExecuteActions(habitatId)) {
    const { run: skippedRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "skipped",
            skipReason: "disabled",
            conditionResult,
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "skipped",
      },
      nowIso,
    );
    return { kind: "skipped", run: skippedRun, reason: "disabled" };
  }

  // Step 9 — execute the ordered actions.
  let execution: { status: AutomationRunStatus; actionResults: AutomationActionResult[] };
  try {
    execution = await executeActions(rule, run, evalCtx);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const { run: failedRun } = terminalizeAndEmit(
      {
        terminalize: buildTerminalizeInput(
          {
            runId: run.id,
            status: "failed",
            conditionResult,
            metadata: {
              source: input.source,
              stage: "actions",
              error: message,
            },
          },
          nowIso,
        ),
        rule,
        habitatId,
        outcome: "failed",
      },
      nowIso,
    );
    return { kind: "failed", run: failedRun, stage: "actions" };
  }

  // Step 10 — terminalize + completion. The disposition's `run` is the
  // refreshed terminal row (not the stale `running` object).
  // `execution.status` is logically one of succeeded/partial_failed/failed
  // (per `calculateRunStatus`), but the static type widens to the full
  // `AutomationRunStatus`. The terminalize seam only accepts the 5 terminal
  // statuses, so we narrow with the same cast the legacy executor uses.
  const terminalStatus = execution.status as "succeeded" | "partial_failed" | "failed";
  const { run: finalRun } = terminalizeAndEmit(
    {
      terminalize: buildTerminalizeInput(
        {
          runId: run.id,
          status: terminalStatus,
          conditionResult,
          actionResults: execution.actionResults,
        },
        nowIso,
      ),
      rule,
      habitatId,
      outcome: execution.status,
    },
    nowIso,
  );
  return {
    kind: "executed",
    run: finalRun,
    outcome: execution.status,
    actionResults: execution.actionResults,
  };
}
