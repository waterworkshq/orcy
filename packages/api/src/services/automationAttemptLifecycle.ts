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
import {
  materializeRuleFromRevision,
  type AutomationRuleRevision,
} from "../repositories/automationRuleRevision.js";
import * as deliveryRepo from "../repositories/automationRuleDelivery.js";
import { validatePersistedCondition } from "../models/automationConditionSchema.js";
import { buildEvaluationContext, buildTriggerContext } from "./automationContextBuilder.js";
import { evaluateCondition } from "./automationEvaluator.js";
import {
  executeAction,
  executeActions,
  notifyAutomationRunCompleted,
  shouldExecuteActions,
  calculateRunStatus,
} from "./automationExecutor.js";
import { logger } from "../lib/logger.js";
import { isSqliteError } from "../errors/sqlite.js";

/** Origin of this attempt — used for guarded-skip metadata and future counter derivation. */
export type AutomationAttemptSource = "event" | "scan" | "manual";

/** Maximum number of causal hops before the chain is considered too deep. */
export const CAUSAL_DEPTH_LIMIT = 32;

/**
 * Structured input for the canonical lifecycle. Callers supply the rule,
 * already-normalized trigger identity, the optional trusted-envelope
 * dedupe key, and the source label for diagnostics.
 *
 * `frozen` (additive overload) routes the attempt down the frozen-revision
 * delivery pipeline: the rule input MUST already be the materialization of
 * `frozen.revision` (the consumer does this), and persistence lands on the
 * delivery/checkpoint tables instead of the live run row alone. Existing
 * callers omit `frozen` and keep the original behavior byte-for-byte.
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
  /**
   * Statically excluded on the live-rule input shape — pass a frozen
   * revision via the `AutomationFrozenAttemptInput` overload instead.
   */
  frozen?: undefined;
}

/** Input of the frozen-revision delivery overload of {@link attemptRuleRun}. */
export interface AutomationFrozenAttemptInput extends Omit<AutomationAttemptInput, "frozen"> {
  frozen: AutomationFrozenAttemptContext;
}

/** Identity of the leased delivery generation this frozen attempt executes. */
export interface AutomationFrozenDeliveryRef {
  id: string;
  generation: number;
  /** The lease fence this worker holds; every persisted transition is CAS'd on it. */
  fence: string;
  /** Stable event lineage key of the delivery row. */
  eventDedupeKey: string;
}

/** Inbox lineage needed for terminality bookkeeping after the attempt. */
export interface AutomationFrozenInboxRef {
  id: string;
  eventType: string;
  eventId: string;
}

/** Frozen-revision delivery context consumed by the canonical lifecycle. */
export interface AutomationFrozenAttemptContext {
  delivery: AutomationFrozenDeliveryRef;
  inbox: AutomationFrozenInboxRef;
  /** The FULL immutable executable revision — never the mutable live rule. */
  revision: AutomationRuleRevision;
}

/**
 * Frozen-delivery disposition. A delivery generation is terminal
 * (`executed`/`skipped`/`failed`), needs an operator (`attention`), or was
 * lost to a newer fence/generation (`fenced_out` — this worker changed
 * nothing and must not complete anything).
 */
export type AutomationFrozenAttemptDisposition =
  | {
      kind: "executed";
      outcome: AutomationRunStatus;
      actionResults: AutomationActionResult[];
      runId: string | null;
    }
  | { kind: "skipped"; reason: AutomationSkipReason; runId: string | null }
  | { kind: "failed"; stage: "condition" | "actions"; runId: string | null }
  | { kind: "attention"; reason: string; runId: string | null }
  | { kind: "fenced_out" };

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
  | {
      kind: "executed";
      run: AutomationRuleRun;
      outcome: AutomationRunStatus;
      actionResults: AutomationActionResult[];
    }
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
/** Input shape accepted by the shared pure-guard helpers (live or frozen). */
type AnyAttemptInput = AutomationAttemptInput | AutomationFrozenAttemptInput;

function validateTarget(input: AnyAttemptInput): TargetValidation {
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
function inCooldown(rule: AutomationRule, input: AnyAttemptInput, nowIso: string): boolean {
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
 *
 * Overloads (additive — hub asymmetry honored):
 *  - without `frozen`: the original live-rule pipeline, unchanged;
 *  - with `frozen`: the frozen-revision delivery pipeline, which mirrors the
 *    same 10-step ordering but persists through the delivery/checkpoint
 *    tables under lease/fence CAS. No caller may bypass this seam — both
 *    pipelines live behind it.
 */
export async function attemptRuleRun(
  input: AutomationAttemptInput,
): Promise<AutomationAttemptDisposition>;
export async function attemptRuleRun(
  input: AutomationFrozenAttemptInput,
): Promise<AutomationFrozenAttemptDisposition>;
export async function attemptRuleRun(
  input: AutomationAttemptInput | AutomationFrozenAttemptInput,
): Promise<AutomationAttemptDisposition | AutomationFrozenAttemptDisposition> {
  if (input.frozen) {
    return attemptFrozenRuleDelivery(input);
  }
  return attemptLiveRuleRun(input);
}

async function attemptLiveRuleRun(
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

// ---------------------------------------------------------------------------
// Frozen-revision delivery pipeline
// ---------------------------------------------------------------------------

const FOREIGN_KEY_RE = /FOREIGN KEY constraint failed/i;

function isForeignKeyViolation(err: unknown): boolean {
  if (err instanceof Error && FOREIGN_KEY_RE.test(err.message)) return true;
  const cause = (err as { cause?: unknown } | null)?.cause;
  if (cause instanceof Error && FOREIGN_KEY_RE.test(cause.message)) return true;
  if (isSqliteError(err) || isSqliteError(cause)) {
    const code =
      (err as { code?: string } | null)?.code ?? (cause as { code?: string } | null)?.code;
    if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") return true;
  }
  return false;
}

/**
 * Frozen-revision delivery pipeline. Mirrors the live pipeline's 10-step
 * ordering EXACTLY (target → cooldown → rate → reservation → condition
 * validation → condition → causal → kill switch → ordered actions →
 * terminalization + completion), with the persistence deltas the durable
 * handoff requires:
 *
 *  - the executable rule is the PERSISTED immutable revision, never the
 *    mutable live rule (later live-rule edit/delete cannot change execution);
 *  - the delivery lease IS the reservation (step 4's CAS already happened in
 *    the consumer's `leaseDelivery`); a run row is additionally recorded when
 *    the live rule still exists, keyed by the delivery id so each generation
 *    owns at most one run (a deleted live rule has no run row — the delivery
 *    and its checkpoints are the durable history);
 *  - every action outcome lands in an authoritative fenced checkpoint; a
 *    proved checkpoint (this generation or carried forward from a
 *    predecessor) is NEVER re-executed;
 *  - terminalization is a lease-fence CAS on the delivery — a stale worker
 *    can never complete a generation (or a successor) it no longer owns.
 *
 * Guard skips (missing_target / cooldown / rate_limited / condition_false /
 * causal / disabled) are DURABLE terminal skips on the delivery: a one-shot
 * inbox event is not re-queued for a guard state that the frozen revision
 * itself produced.
 */
async function attemptFrozenRuleDelivery(
  input: AutomationFrozenAttemptInput,
): Promise<AutomationFrozenAttemptDisposition> {
  const frozen = input.frozen;
  const trigger = input.trigger;
  const habitatId = trigger.habitatId;
  const nowIso = input.now ?? new Date().toISOString();

  // The persisted revision is the ONLY executable intent on this path —
  // `input.rule` is advisory lineage only.
  const rule = materializeRuleFromRevision(frozen.revision);

  let run: AutomationRuleRun | null = null;

  /** Attempt to record a run row; null when the live rule is gone. */
  const tryReserveRun = (): AutomationRuleRun | null => {
    try {
      const { run: reserved } = runRepo.startRuleRun({
        ruleId: rule.id,
        habitatId,
        triggerType: String(trigger.triggerType),
        triggerEventId: trigger.triggerEventId,
        targetType: trigger.targetType,
        targetId: trigger.targetId,
        // Per-delivery-generation reservation: the delivery id is unique per
        // (event, revision, generation), so each generation owns exactly one
        // run row and a crash-before-terminalization replays onto it.
        eventDedupeKey: frozen.delivery.id,
        now: nowIso,
      });
      // A dedupe loser means THIS generation's run row already exists (a
      // prior worker crashed after run insert, before delivery
      // terminalization). Reusing it is correct: run terminalization is a
      // status='running' CAS, so an already-terminal row stays untouched.
      return reserved;
    } catch (err) {
      if (isForeignKeyViolation(err)) {
        // The live rule was deleted after admission. The frozen revision
        // still executes; the delivery + checkpoints are the durable record.
        logger.info(
          { deliveryId: frozen.delivery.id, ruleId: rule.id },
          "Frozen delivery executing without a live rule row (revision is authoritative)",
        );
        return null;
      }
      throw err;
    }
  };

  /** Durable terminal skip for a pre-admission guard rejection. */
  const skipDelivery = async (
    reason: AutomationSkipReason,
    metadata: Record<string, unknown>,
  ): Promise<AutomationFrozenAttemptDisposition> => {
    run = tryReserveRun();
    const transitioned = deliveryRepo.transitionLeasedDelivery({
      deliveryId: frozen.delivery.id,
      fence: frozen.delivery.fence,
      targetState: "terminal",
      terminalDisposition: `skipped:${reason}`,
      terminalDetail: JSON.stringify({ source: input.source, ...metadata }),
      automationRunId: run?.id ?? null,
      now: nowIso,
    });
    if (!transitioned) return { kind: "fenced_out" };
    if (run) {
      const { run: finalRun } = runRepo.terminalizeRuleRun({
        runId: run.id,
        status: "skipped",
        skipReason: reason,
        metadata: { source: input.source, ...metadata },
        finishedAt: nowIso,
      });
      notifyAutomationRunCompleted({
        run: finalRun,
        rule,
        habitatId,
        outcome: "skipped",
      });
    }
    deliveryRepo.markInboxTerminalIfComplete(frozen.inbox.id, nowIso);
    return { kind: "skipped", reason, runId: run?.id ?? null };
  };

  // Step 1 — target validation.
  const targetCheck = validateTarget(input);
  if (!targetCheck.valid) {
    return skipDelivery("missing_target", targetCheck.metadata ?? {});
  }

  // Step 2 — cooldown (fingerprint over the revision's stable rule lineage).
  if (inCooldown(rule, input, nowIso)) {
    return skipDelivery("cooldown", { guard: "cooldown" });
  }

  // Step 3 — admitted-attempt hourly cap.
  const admitted = runRepo.countAdmittedAttemptsInWindow(rule.id, nowIso);
  if (admitted >= rule.maxRunsPerHour) {
    return skipDelivery("rate_limited", { guard: "rate_limited" });
  }

  // Step 4 — reservation. The lease is the delivery reservation; the run row
  // is supplementary lineage (created here so guard skips above never strand
  // a `running` row).
  run = tryReserveRun();

  // Steps 5-8 share the live pipeline's pure logic.
  const validation = validatePersistedCondition(rule.condition);
  if (!validation.valid) {
    const synthetic = syntheticInvalidConditionResult(validation.diagnostic);
    return finishFrozenFailure("condition", {
      conditionResult: synthetic,
      detail: { stage: "condition", diagnostic: validation.diagnostic },
    });
  }

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
    return skipDelivery("condition_false", { conditionResult });
  }

  const causalCheck = checkCausalChain(rule.id, trigger.causalContext);
  if (causalCheck.cycle) {
    return skipDelivery("causal_cycle", { conditionResult });
  }
  if (causalCheck.depthExceeded) {
    return skipDelivery("causal_depth_limit", { conditionResult });
  }

  if (!shouldExecuteActions(habitatId)) {
    return skipDelivery("disabled", { conditionResult });
  }

  // Step 9 — ordered actions under authoritative checkpoints. A proved
  // checkpoint (this generation or a carried-forward predecessor row with the
  // SAME action key) is never re-executed.
  const actionResults: AutomationActionResult[] = [];
  let succeededCount = 0;
  let failedCount = 0;
  const existingCheckpoints = deliveryRepo.listCheckpointsForDelivery(frozen.delivery.id);

  for (let i = 0; i < (rule.actions ?? []).length; i++) {
    const action = rule.actions![i];
    const actionRecord = action as unknown as Record<string, unknown>;
    const actionKey = deliveryRepo.computeActionKey(actionRecord);

    const prior = existingCheckpoints.find(
      (c) => c.actionIndex === i && c.actionKey === actionKey && c.state === "proved",
    );
    if (prior) {
      // Carried-forward or already-proved in this generation: NEVER rerun.
      actionResults.push({
        actionType: action.type,
        actionIndex: i,
        status: "skipped",
        result: prior.receipt ?? undefined,
      });
      succeededCount++;
      continue;
    }

    const checkpoint = deliveryRepo.ensureCheckpointRow({
      deliveryId: frozen.delivery.id,
      actionIndex: i,
      actionKey,
      actionType: action.type,
      now: nowIso,
    });

    let result: AutomationActionResult;
    try {
      result = await executeAction(
        action,
        i,
        rule,
        run ?? syntheticRunForExecution(input, rule),
        evalCtx,
      );
    } catch (err) {
      result = {
        actionType: action.type,
        actionIndex: i,
        status: "failed",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Fenced checkpoint write: if this worker's fence was superseded
    // mid-execution, the recorded outcome must be rejected — the newer
    // owner re-classifies this action from its unproved state (fail-safe).
    const recorded = deliveryRepo.recordCheckpointOutcome({
      checkpointId: checkpoint.id,
      deliveryId: frozen.delivery.id,
      fence: frozen.delivery.fence,
      state: result.status === "succeeded" ? "proved" : "failed",
      receipt: (result.result ?? null) as Record<string, unknown> | null,
      terminalDisposition: result.status,
      now: nowIso,
    });
    if (!recorded) {
      return { kind: "fenced_out" };
    }

    actionResults.push(result);
    if (result.status === "succeeded") succeededCount++;
    else failedCount++;
  }

  const composite = calculateRunStatus(succeededCount, failedCount, actionResults.length);
  const transitioned = deliveryRepo.transitionLeasedDelivery({
    deliveryId: frozen.delivery.id,
    fence: frozen.delivery.fence,
    targetState: "terminal",
    terminalDisposition: composite,
    terminalDetail: null,
    automationRunId: run?.id ?? null,
    now: nowIso,
  });
  if (!transitioned) return { kind: "fenced_out" };
  if (run) {
    const terminalStatus = composite as "succeeded" | "partial_failed" | "failed";
    const { run: finalRun } = runRepo.terminalizeRuleRun({
      runId: run.id,
      status: terminalStatus,
      conditionResult,
      actionResults,
      finishedAt: nowIso,
    });
    notifyAutomationRunCompleted({
      run: finalRun,
      rule,
      habitatId,
      outcome: composite,
    });
  }
  deliveryRepo.markInboxTerminalIfComplete(frozen.inbox.id, nowIso);
  return { kind: "executed", outcome: composite, actionResults, runId: run?.id ?? null };

  /** Shared terminal-failure path for condition-stage failures. */
  function finishFrozenFailure(
    stage: "condition" | "actions",
    detail: {
      conditionResult: AutomationConditionResult;
      detail: Record<string, unknown>;
    },
  ): AutomationFrozenAttemptDisposition {
    const transitionedFailure = deliveryRepo.transitionLeasedDelivery({
      deliveryId: frozen.delivery.id,
      fence: frozen.delivery.fence,
      targetState: "terminal",
      terminalDisposition: `failed:${stage}`,
      terminalDetail: JSON.stringify({ source: input.source, ...detail.detail }),
      automationRunId: run?.id ?? null,
      now: nowIso,
    });
    if (!transitionedFailure) return { kind: "fenced_out" };
    if (run) {
      const { run: finalRun } = runRepo.terminalizeRuleRun({
        runId: run.id,
        status: "failed",
        conditionResult: detail.conditionResult,
        metadata: { source: input.source, stage, ...detail.detail },
        finishedAt: nowIso,
      });
      notifyAutomationRunCompleted({
        run: finalRun,
        rule,
        habitatId,
        outcome: "failed",
      });
    }
    deliveryRepo.markInboxTerminalIfComplete(frozen.inbox.id, nowIso);
    return { kind: "failed", stage, runId: run?.id ?? null };
  }
}

/**
 * Minimal run-shaped object for executor actions that only read run identity
 * (e.g., the create_task publication attempt key derives from run id + action
 * index). Used ONLY when the live rule is gone and no run row exists; the
 * delivery id stands in so attempt identity stays unique per generation.
 */
function syntheticRunForExecution(
  input: AutomationFrozenAttemptInput,
  rule: AutomationRule,
): AutomationRuleRun {
  return {
    id: `delivery:${input.frozen.delivery.id}`,
    ruleId: rule.id,
    habitatId: input.trigger.habitatId,
    triggerType: String(input.trigger.triggerType),
    triggerEventId: input.trigger.triggerEventId,
    targetType: input.trigger.targetType,
    targetId: input.trigger.targetId,
    fingerprint: `delivery:${input.frozen.delivery.id}`,
    status: "running",
    skipReason: null,
    conditionResult: null,
    actionResults: null,
    metadata: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
}
