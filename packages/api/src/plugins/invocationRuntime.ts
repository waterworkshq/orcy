/**
 * v0.28-T3 — Plugin Invocation Runtime foundation (ADR-0039).
 *
 * One deep module with two entry points for two genuine execution regimes:
 *
 *   1. **`checkPreVeto`** — synchronous, ordered, short-circuit. Runs before a
 *      Task change and can block it. Bounded fail-closed: throw, invalid result,
 *      or Promise return vetoes and counts; explicit `{ allow: false }` is an
 *      ordinary veto that does not count.
 *
 *   2. **`invokeManaged`** — asynchronous. Covers Signal Detectors, Automation
 *      Actions, Notification Channels, and post Lifecycle Interceptors.
 *
 * Both share the policy catalog, failure classifier, quarantine enforcement,
 * and Plugin Run lifecycle bookkeeping. Thin adapters (T4–T8) map runtime
 * outcomes to existing caller result shapes.
 *
 * This module is **purely additive** in T3: no production dispatch path is
 * migrated. The entry points are exercised through a dependency-injection
 * factory (`createInvocationRuntime`) so the foundation is testable in
 * isolation with mock infrastructure.
 *
 * Guardrails (ADR-0039 / ticket T3):
 *   - No managed handler may run before `startRun` succeeds.
 *   - Finish failure preserves the already-returned Plugin outcome and never
 *     counts against the Plugin.
 *   - Expected domain failures never increment counters; eligible runtime
 *     faults do.
 *   - Validators test raw malformed JavaScript, not only TypeScript fixtures.
 */
import type {
  DetectedSignalInput,
  PluginCapabilityName,
  PluginEvaluationContext,
  SignalDetectorContribution,
  AutomationActionContribution,
  NotificationChannelContribution,
  LifecycleInterceptorContribution,
  InterceptorEvent,
  NotificationDelivery,
  NotificationEvent,
} from "@orcy/shared";
import type {
  ActionListener,
  ChannelHandler,
  DetectorHandler,
  InterceptorHandler,
  PluginContext,
} from "./types.js";
import type { TransitionContext } from "../services/tasks/transition-emitter.js";
import type { PluginRunRow } from "../db/schema/index.js";
import type { PluginRunStatus } from "../repositories/pluginRun.js";

// ─────────────────────────────────────────────────────────────────────────────
// Managed kind (runtime discriminator — distinct from ContributionKind)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five managed invocation kinds at the runtime level. `lifecycleInterceptor`
 * splits into `preInterceptor` and `postInterceptor` because they have different
 * execution regimes (sync vs async) and different fault-accounting policies.
 */
export type ManagedKind =
  | "signalDetector"
  | "automationAction"
  | "notificationChannel"
  | "preInterceptor"
  | "postInterceptor";

/** Maps a {@link ManagedKind} to the storage-level `contribution_kind` string. */
export function contributionKindForStorage(kind: ManagedKind): string {
  if (kind === "preInterceptor" || kind === "postInterceptor") return "lifecycleInterceptor";
  return kind;
}

// ─────────────────────────────────────────────────────────────────────────────
// Managed invocation targets
// ─────────────────────────────────────────────────────────────────────────────

/** Fields every managed target carries (ADR-0039 Canonical Managed Target). */
export interface ManagedTargetBase {
  pluginId: string;
  /** Kind-local contribution id (detectorId / actionId / channelId / interceptorId). */
  contributionId: string;
  requires: PluginCapabilityName[];
  timeoutMs?: number;
  /** Kind-safe serialized identity (canonicalContributionKey output). */
  canonicalKey: string;
}

export interface DetectorTarget extends ManagedTargetBase {
  kind: "signalDetector";
  handler: DetectorHandler;
  contribution: SignalDetectorContribution;
}

export interface ActionTarget extends ManagedTargetBase {
  kind: "automationAction";
  handler: ActionListener;
  contribution: AutomationActionContribution;
}

export interface ChannelTarget extends ManagedTargetBase {
  kind: "notificationChannel";
  handler: ChannelHandler;
  contribution: NotificationChannelContribution;
}

export interface PostInterceptorTarget extends ManagedTargetBase {
  kind: "postInterceptor";
  handler: InterceptorHandler;
  contribution: LifecycleInterceptorContribution;
}

export interface PreInterceptorTarget extends ManagedTargetBase {
  kind: "preInterceptor";
  handler: InterceptorHandler;
  contribution: LifecycleInterceptorContribution;
}

/** Union of the four asynchronous managed targets (consumed by `invokeManaged`). */
export type AsyncManagedTarget =
  | DetectorTarget
  | ActionTarget
  | ChannelTarget
  | PostInterceptorTarget;

// ─────────────────────────────────────────────────────────────────────────────
// Requests, decisions, and outcomes
// ─────────────────────────────────────────────────────────────────────────────

/** Synchronous pre-veto request. Carries the target plus Task-transition context. */
export interface PreVetoRequest {
  target: PreInterceptorTarget;
  taskId: string;
  event: InterceptorEvent;
  habitatId: string;
  context: TransitionContext;
}

/**
 * Synchronous pre-veto decision (ADR-0039 Q1 — bounded fail-closed).
 *
 *   - `allow`                 — all clear; Task work may proceed.
 *   - `veto` / `explicit`     — plugin returned `{ allow: false }`; an ordinary
 *                               domain veto that does NOT count toward quarantine.
 *   - `veto` / `failure`      — handler threw, returned a Promise, returned an
 *                               invalid result, or `startRun` failed. A failure
 *                               veto DOES count toward quarantine (once not yet
 *                               quarantined). A quarantined pre target is skipped,
 *                               not failure-vetoed.
 */
export type PreVetoDecision = PreVetoAllow | PreVetoExplicit | PreVetoFailure;

export interface PreVetoAllow {
  decision: "allow";
  runId: string | null;
  startFailed: boolean;
  finishFailed: boolean;
}

export interface PreVetoExplicit {
  decision: "veto";
  vetoReason: "explicit";
  message: string;
  details?: string;
  runId: string | null;
  startFailed: boolean;
  finishFailed: boolean;
}

export interface PreVetoFailure {
  decision: "veto";
  vetoReason: "failure";
  message: string;
  runId: string | null;
  startFailed: boolean;
  finishFailed: boolean;
}

/**
 * Discriminated asynchronous managed invocation request. Each variant carries
 * the trigger metadata plus the kind-specific payload the handler needs. This
 * avoids a callback/flag bag — the payload is structurally tied to the target
 * kind.
 */
export type ManagedInvocationRequest =
  | DetectorInvocationRequest
  | ActionInvocationRequest
  | ChannelInvocationRequest
  | PostInterceptorInvocationRequest;

export interface DetectorInvocationRequest {
  target: DetectorTarget;
  habitatId: string;
  triggerEventId: string;
  triggerType: string;
  source: import("./types.js").EventSourceRef;
  /**
   * Server-owned side effect: persists validated signals AFTER validation
   * but BEFORE finishRun (BLOCKER 1). Returns the committed signal count.
   * If this throws, the run finishes `failed` (no counter increment —
   * infrastructure failure, not a plugin fault).
   */
  onResult?: (signals: DetectedSignalInput[]) => Promise<number>;
}

export interface ActionInvocationRequest {
  target: ActionTarget;
  habitatId: string;
  triggerType: string;
  evalCtx: PluginEvaluationContext;
  params: Record<string, unknown>;
}

export interface ChannelInvocationRequest {
  target: ChannelTarget;
  habitatId: string;
  triggerEventId: string;
  triggerType: string;
  delivery: NotificationDelivery;
  event: NotificationEvent;
}

export interface PostInterceptorInvocationRequest {
  target: PostInterceptorTarget;
  habitatId: string;
  triggerEventId: string;
  triggerType: string;
  taskId: string;
  event: InterceptorEvent;
  context: TransitionContext;
  /**
   * Server-owned side effect: persists validated signals atomically AFTER
   * validation but BEFORE finishRun (BLOCKER 1, ADR-0039 Q11). Returns the
   * committed signal count. If this throws, the run finishes `failed` and no
   * signals are committed (all-or-nothing).
   */
  onResult?: (signals: DetectedSignalInput[]) => Promise<number>;
}

/** Common metadata on every managed invocation outcome. */
export interface RunOutcomeBase {
  runId: string | null;
  status: PluginRunStatus;
  error?: string;
  /** Handler never ran — `startRun` infrastructure failure (never counts against Plugin). */
  startFailed: boolean;
  /** `finishRun` failed after the handler returned — handler outcome preserved (Q13). */
  finishFailed: boolean;
  /**
   * True only when the handler was durably invoked — a handler Promise existed
   * (ADR-0039 R2 BLOCKER 2). Pre-launch failures (start, quarantine, capacity,
   * context construction) set this `false` so `dispatchDetectorTarget` can
   * distinguish recovery-eligible outcomes from genuinely durably-launched ones
   * without inferring from a DB status that pre-launch failures can write or strand.
   */
  handlerLaunched: boolean;
}

export interface DetectorOutcome extends RunOutcomeBase {
  kind: "signalDetector";
  signals: DetectedSignalInput[];
  signalsEmitted: number;
}

export interface ActionOutcome extends RunOutcomeBase {
  kind: "automationAction";
  result: { status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string };
}

export interface ChannelOutcome extends RunOutcomeBase {
  kind: "notificationChannel";
  result: { success: boolean; error?: string; attemptId?: string; statusCode?: number };
}

export interface PostInterceptorOutcome extends RunOutcomeBase {
  kind: "postInterceptor";
  signals: DetectedSignalInput[];
  signalsEmitted: number;
}

export type ManagedInvocationOutcome =
  | DetectorOutcome
  | ActionOutcome
  | ChannelOutcome
  | PostInterceptorOutcome;

// ─────────────────────────────────────────────────────────────────────────────
// Per-kind invocation policy catalog (ADR-0039 Policy Matrix)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Declarative per-kind invocation policy. The runtime consults this catalog
 * rather than embedding kind-specific behavior in control flow.
 */
export interface KindInvocationPolicy {
  /**
   * Whether runtime faults (throw, timeout, invalid return, validator rejection)
   * increment the contribution's quarantine counter.
   *
   *   - `true`  — Signal Detector, Automation Action, pre Lifecycle Interceptor.
   *   - `false` — Notification Channel, post Lifecycle Interceptor (defensive
   *               quarantine gate only; can never reach the auto-threshold).
   */
  faultsCountTowardQuarantine: boolean;
  /**
   * Default watchdog timeout in milliseconds when the manifest does not declare
   * one. `0` disables the watchdog. A pre Interceptor has no timeout (it is
   * synchronous and must not delay the transition).
   */
  defaultTimeoutMs: number;
}

export const INVOCATION_POLICY: Readonly<Record<ManagedKind, KindInvocationPolicy>> = {
  signalDetector: {
    faultsCountTowardQuarantine: true,
    defaultTimeoutMs: 5000,
  },
  automationAction: {
    faultsCountTowardQuarantine: true,
    defaultTimeoutMs: 0,
  },
  notificationChannel: {
    faultsCountTowardQuarantine: false,
    defaultTimeoutMs: 0,
  },
  preInterceptor: {
    faultsCountTowardQuarantine: true,
    defaultTimeoutMs: 0,
  },
  postInterceptor: {
    faultsCountTowardQuarantine: false,
    defaultTimeoutMs: 0,
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Runtime validators — raw malformed JavaScript rejection (ADR-0039)
// ─────────────────────────────────────────────────────────────────────────────

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

/**
 * Narrows `unknown` to a plain record object. Rejects `null`, arrays, and
 * non-object primitives. Used by every validator so array-shaped or null
 * results are rejected before field inspection (MAJOR 2).
 */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validates a single `DetectedSignalInput` from a raw JavaScript value.
 * Shared by the Detector and post-Interceptor validators. Unknown fields are
 * stripped — only whitelisted fields survive into the validated value.
 */
function checkDetectedSignal(raw: unknown, index: number): ValidationResult<DetectedSignalInput> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: `signal[${index}]: must be an object` };
  }
  const s = raw;
  if (s.signalType !== "detected") {
    return { ok: false, error: `signal[${index}]: signalType must be "detected"` };
  }
  if (typeof s.subject !== "string" || s.subject.length === 0) {
    return { ok: false, error: `signal[${index}]: subject must be a non-empty string` };
  }
  const value: DetectedSignalInput = { signalType: "detected", subject: s.subject };
  if (s.body !== undefined) {
    if (typeof s.body !== "string") {
      return { ok: false, error: `signal[${index}]: body must be a string` };
    }
    value.body = s.body;
  }
  if (s.metadata !== undefined) {
    if (!isPlainObject(s.metadata)) {
      return { ok: false, error: `signal[${index}]: metadata must be an object` };
    }
    value.metadata = s.metadata;
  }
  if (s.taskId !== undefined) {
    if (typeof s.taskId !== "string")
      return { ok: false, error: `signal[${index}]: taskId must be a string` };
    value.taskId = s.taskId;
  }
  if (s.missionId !== undefined) {
    if (typeof s.missionId !== "string")
      return { ok: false, error: `signal[${index}]: missionId must be a string` };
    value.missionId = s.missionId;
  }
  if (s.replyToId !== undefined) {
    if (typeof s.replyToId !== "string")
      return { ok: false, error: `signal[${index}]: replyToId must be a string` };
    value.replyToId = s.replyToId;
  }
  return { ok: true, value };
}

/** Detector handler must return an array of valid `DetectedSignalInput` values. */
export function validateDetectorResult(raw: unknown): ValidationResult<DetectedSignalInput[]> {
  if (!Array.isArray(raw)) return { ok: false, error: "Detector handler must return an array" };
  const signals: DetectedSignalInput[] = [];
  for (let i = 0; i < raw.length; i++) {
    const checked = checkDetectedSignal(raw[i], i);
    if (!checked.ok) return checked;
    signals.push(checked.value);
  }
  return { ok: true, value: signals };
}

export interface ValidatedActionResult {
  status: "succeeded" | "failed";
  result?: Record<string, unknown>;
  error?: string;
}

/** Action handler must return `{ status: "succeeded" | "failed" }` with matching optional fields. */
export function validateActionResult(raw: unknown): ValidationResult<ValidatedActionResult> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "Action handler must return an object" };
  }
  const r = raw;
  if (r.status !== "succeeded" && r.status !== "failed") {
    return { ok: false, error: "Action result status must be 'succeeded' or 'failed'" };
  }
  // MAJOR 3: reject incompatible field combinations, not just strip them.
  if (r.status === "succeeded" && r.error !== undefined) {
    return { ok: false, error: "Action result.status 'succeeded' must not include error" };
  }
  if (r.status === "failed" && r.result !== undefined) {
    return { ok: false, error: "Action result.status 'failed' must not include result" };
  }
  const value: ValidatedActionResult = { status: r.status };
  if (r.status === "succeeded") {
    if (r.result !== undefined) {
      if (!isPlainObject(r.result)) {
        return { ok: false, error: "Action result.result must be an object" };
      }
      value.result = r.result;
    }
  } else {
    if (r.error !== undefined) {
      if (typeof r.error !== "string") {
        return { ok: false, error: "Action result.error must be a string" };
      }
      value.error = r.error;
    }
  }
  return { ok: true, value };
}

export interface ValidatedChannelResult {
  success: boolean;
  error?: string;
  attemptId?: string;
  statusCode?: number;
}

/** Channel handler must return `{ success: boolean }` with valid optional fields. */
export function validateChannelResult(raw: unknown): ValidationResult<ValidatedChannelResult> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "Channel handler must return an object" };
  }
  const r = raw;
  if (typeof r.success !== "boolean") {
    return { ok: false, error: "Channel result.success must be a boolean" };
  }
  const value: ValidatedChannelResult = { success: r.success };
  if (r.error !== undefined) {
    if (typeof r.error !== "string")
      return { ok: false, error: "Channel result.error must be a string" };
    value.error = r.error;
  }
  if (r.attemptId !== undefined) {
    if (typeof r.attemptId !== "string")
      return { ok: false, error: "Channel result.attemptId must be a string" };
    value.attemptId = r.attemptId;
  }
  if (r.statusCode !== undefined) {
    if (typeof r.statusCode !== "number")
      return { ok: false, error: "Channel result.statusCode must be a number" };
    value.statusCode = r.statusCode;
  }
  return { ok: true, value };
}

export type ValidatedPreResult =
  | { allow: true }
  | { allow: false; reason: string; details?: string };

/** Pre-interceptor must return `{ allow: true }` or `{ allow: false, reason, details? }`. */
export function validatePreResult(raw: unknown): ValidationResult<ValidatedPreResult> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "Pre-interceptor must return an object" };
  }
  const r = raw;
  if (r.allow === true) return { ok: true, value: { allow: true } };
  if (r.allow === false) {
    if (typeof r.reason !== "string" || r.reason.length === 0) {
      return { ok: false, error: "Pre-interceptor veto requires a non-empty reason string" };
    }
    const value: ValidatedPreResult = { allow: false, reason: r.reason };
    if (r.details !== undefined) {
      if (typeof r.details !== "string") {
        return { ok: false, error: "Pre-interceptor veto details must be a string" };
      }
      value.details = r.details;
    }
    return { ok: true, value };
  }
  return { ok: false, error: "Pre-interceptor result.allow must be true or false" };
}

export interface ValidatedPostResult {
  signals?: DetectedSignalInput[];
}

/** Post-interceptor must return an object with an optional array of valid signals. */
export function validatePostResult(raw: unknown): ValidationResult<ValidatedPostResult> {
  if (!isPlainObject(raw)) {
    return { ok: false, error: "Post-interceptor must return an object" };
  }
  const r = raw;
  if (r.signals === undefined) return { ok: true, value: {} };
  if (!Array.isArray(r.signals)) {
    return { ok: false, error: "Post-interceptor signals must be an array" };
  }
  const signals: DetectedSignalInput[] = [];
  for (let i = 0; i < r.signals.length; i++) {
    const checked = checkDetectedSignal(r.signals[i], i);
    if (!checked.ok) return checked;
    signals.push(checked.value);
  }
  return { ok: true, value: { signals } };
}

/** Dispatch table: kind → validator. Consumed by `invokeManaged`. */
const ASYNC_VALIDATORS: Record<
  AsyncManagedTarget["kind"],
  (raw: unknown) => ValidationResult<unknown>
> = {
  signalDetector: validateDetectorResult,
  automationAction: validateActionResult,
  notificationChannel: validateChannelResult,
  postInterceptor: validatePostResult,
};

/**
 * Determines the terminal run status for a **valid** handler result.
 * Expected domain failures (Action `failed`, Channel `success: false`) map to
 * `"failed"` run status but do NOT increment counters — the classifier is only
 * reached after validation succeeds, so this never applies to runtime faults.
 */
function terminalStatusForValidResult(
  kind: AsyncManagedTarget["kind"],
  value: unknown,
): PluginRunStatus {
  switch (kind) {
    case "signalDetector":
    case "postInterceptor":
      return "succeeded";
    case "automationAction":
      return (value as ValidatedActionResult).status === "failed" ? "failed" : "succeeded";
    case "notificationChannel":
      return (value as ValidatedChannelResult).success ? "succeeded" : "failed";
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Runtime dependency interface (dependency injection for testability)
// ─────────────────────────────────────────────────────────────────────────────

export interface StartRunDepsInput {
  habitatId: string;
  pluginId: string;
  contributionId: string;
  contributionKind: string;
  triggerEventId: string | null;
  triggerType: string;
}

export interface BuildContextDepsOpts {
  pluginId: string;
  contributionId: string;
  habitatId: string;
  runId: string;
  requires: PluginCapabilityName[];
}

export interface RuntimeLogger {
  error(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * Infrastructure dependencies injected into the runtime. T3 tests inject mocks;
 * T4–T8 wire the real `pluginManager.ts` infrastructure.
 *
 * `startRun` and `buildContext` are separate so that skipped/capacity attempts
 * can record a Plugin Run row without constructing an expensive capability
 * context (T3 scope #2 — split Plugin Run creation from context construction).
 */
export interface RuntimeDeps {
  /** Creates a Plugin Run row in `running` status. THROWS on infrastructure failure. */
  startRun: (input: StartRunDepsInput) => PluginRunRow;
  /** Transitions a run to terminal status. THROWS on infrastructure failure. */
  finishRun: (
    id: string,
    status: PluginRunStatus,
    signalsEmitted?: number,
    error?: string,
  ) => PluginRunRow | null;
  /**
   * Hard-deletes a Plugin Run row. Used as a fallback when `finishRun` fails
   * for a pre-launch outcome (R2 BLOCKER 2): a stranded `running` row whose
   * handler was never launched would falsely satisfy `existsForTriggerEvent`
   * dedup on the next catch-up scan.
   */
  deleteRun: (id: string) => boolean;
  /** Builds a per-invocation `PluginContext` with capability surfaces. */
  buildContext: (opts: BuildContextDepsOpts) => PluginContext;
  /** Returns `true` if the contribution is currently quarantined. */
  isQuarantined: (canonicalKey: string) => boolean;
  /** Increments the contribution's quarantine counter (threshold → quarantine). */
  incrementError: (canonicalKey: string, pluginId: string) => void;
  /** Watchdog race — `timeoutMs` of 0 disables. */
  withTimeout: <T>(promise: Promise<T>, timeoutMs: number, pluginKey: string) => Promise<T>;
  /** Detector concurrency slot acquisition. Returns `false` if capacity is full. */
  acquireDetectorSlot: (habitatId: string) => boolean;
  /** Detector concurrency slot release (attached to underlying handler settlement — Q12). */
  releaseDetectorSlot: (habitatId: string) => void;
  logger: RuntimeLogger;
}

export interface InvocationRuntime {
  checkPreVeto: (request: PreVetoRequest) => PreVetoDecision;
  invokeManaged: (request: ManagedInvocationRequest) => Promise<ManagedInvocationOutcome>;
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Creates the Plugin Invocation Runtime with injected infrastructure.
 * The runtime owns canonical contribution identity, applicability/admission,
 * Plugin Run lifecycle, capability construction, result validation, watchdog
 * handling, failure classification, quarantine accounting, and resource cleanup.
 */
export function createInvocationRuntime(deps: RuntimeDeps): InvocationRuntime {
  /**
   * Wraps `finishRun` to catch infrastructure failures without losing the
   * handler outcome (ADR-0039 Q13 — finish failure preserves the already-returned
   * Plugin outcome and never counts against the Plugin). Returns `true` on
   * success, `false` if the finish failed.
   */
  function safeFinishRun(
    runId: string,
    status: PluginRunStatus,
    signalsEmitted?: number,
    error?: string,
  ): boolean {
    try {
      const result = deps.finishRun(runId, status, signalsEmitted, error);
      // MAJOR 6: null (run not found) is a finalization failure, not success.
      if (result === null) {
        deps.logger.error("Plugin Run finishRun returned null — run not found", {
          runId,
          status,
        });
        return false;
      }
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error("Plugin Run finishRun failed — handler outcome preserved", {
        runId,
        status,
        errMessage: message,
      });
      return false;
    }
  }

  /**
   * Fallback for pre-launch finish failures (R2 BLOCKER 2): if `finishRun`
   * cannot transition the row away from `running`, delete it so the stranded
   * row does not falsely satisfy `existsForTriggerEvent` dedup on the next
   * catch-up scan. Returns `true` on success, `false` if deletion also failed.
   */
  function safeDeleteRun(runId: string): boolean {
    try {
      const deleted = deps.deleteRun(runId);
      if (!deleted) {
        deps.logger.error("Plugin Run deleteRun returned false — run not found", { runId });
      }
      return deleted;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error("Plugin Run deleteRun failed — stranded row may block next scan", {
        runId,
        errMessage: message,
      });
      return false;
    }
  }

  /**
   * accounting (ADR-0039 Q2). Channel and post-Interceptor faults never
   * increment.
   */
  function maybeIncrementError(kind: ManagedKind, target: ManagedTargetBase): void {
    if (INVOCATION_POLICY[kind].faultsCountTowardQuarantine) {
      deps.incrementError(target.canonicalKey, target.pluginId);
    }
  }

  // ─── checkPreVeto (synchronous) ──────────────────────────────────────────

  function checkPreVeto(request: PreVetoRequest): PreVetoDecision {
    const { target, taskId, event, habitatId, context } = request;
    const policy = INVOCATION_POLICY.preInterceptor;
    const baseFinishFlag = { startFailed: false, finishFailed: false };

    // 1. Start Plugin Run (the invocation gate — Q13).
    let runId: string | null = null;
    try {
      const run = deps.startRun({
        habitatId,
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        contributionKind: contributionKindForStorage("preInterceptor"),
        triggerEventId: taskId,
        triggerType: `${event}:pre`,
      });
      runId = run.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error("Pre-veto startRun failed — infrastructure failure", {
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        errMessage: message,
      });
      // start failure = no handler, no counter increment, failure veto.
      return {
        decision: "veto",
        vetoReason: "failure",
        message,
        runId: null,
        startFailed: true,
        finishFailed: false,
      };
    }

    // 2. Quarantine check — quarantined pre = skipped, Task continues.
    if (deps.isQuarantined(target.canonicalKey)) {
      const ff = safeFinishRun(runId, "skipped");
      return { decision: "allow", runId, startFailed: false, finishFailed: !ff };
    }

    // 3. Build read-only context — guarded (MEDIUM 6): infrastructure failure
    //    if this throws. No handler invocation, no counter increment — mirror
    //    the async path (invokeManaged buildContext catch). The run finishes
    //    `failed`; the caller receives a structured failure veto.
    let ctx: PluginContext;
    try {
      ctx = deps.buildContext({
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        habitatId,
        runId,
        requires: target.requires,
      });
      ctx.transition = { taskId, action: event, habitatId, context };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error("Pre-veto buildContext failed — infrastructure failure", {
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        errMessage: message,
      });
      const ff = safeFinishRun(runId, "failed", undefined, message);
      return {
        decision: "veto",
        vetoReason: "failure",
        message,
        runId,
        startFailed: false,
        finishFailed: !ff,
      };
    }

    // 4. Invoke synchronously.
    let raw: unknown;
    try {
      raw = target.handler(ctx, ctx.transition);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      maybeIncrementError("preInterceptor", target);
      const ff = safeFinishRun(runId, "failed", undefined, message);
      return {
        decision: "veto",
        vetoReason: "failure",
        message,
        runId,
        ...baseFinishFlag,
        finishFailed: !ff,
      };
    }

    // 5. Promise return on the synchronous pre path is a contract violation (Q1).
    //    MAJOR 1: consume the rejected promise to prevent unhandledRejection.
    if (
      raw !== null &&
      typeof raw === "object" &&
      typeof (raw as { then?: unknown }).then === "function"
    ) {
      (raw as Promise<unknown>).catch(() => {});
      const message =
        "Pre-phase interceptor returned a Promise — pre-phase handlers must be synchronous";
      maybeIncrementError("preInterceptor", target);
      const ff = safeFinishRun(runId, "failed", undefined, message);
      return {
        decision: "veto",
        vetoReason: "failure",
        message,
        runId,
        ...baseFinishFlag,
        finishFailed: !ff,
      };
    }

    // 6. Validate result.
    const validation = validatePreResult(raw);
    if (!validation.ok) {
      maybeIncrementError("preInterceptor", target);
      const ff = safeFinishRun(runId, "failed", undefined, validation.error);
      return {
        decision: "veto",
        vetoReason: "failure",
        message: validation.error,
        runId,
        ...baseFinishFlag,
        finishFailed: !ff,
      };
    }

    // 7. Expected outcome (explicit veto or allow — neither increments).
    const result = validation.value;
    if (result.allow) {
      const ff = safeFinishRun(runId, "succeeded");
      return { decision: "allow", runId, startFailed: false, finishFailed: !ff };
    }
    const ff = safeFinishRun(runId, "succeeded");
    return {
      decision: "veto",
      vetoReason: "explicit",
      message: result.reason,
      ...(result.details !== undefined ? { details: result.details } : {}),
      runId,
      startFailed: false,
      finishFailed: !ff,
    };
  }

  // ─── invokeManaged (asynchronous) ────────────────────────────────────────

  async function invokeManaged(
    request: ManagedInvocationRequest,
  ): Promise<ManagedInvocationOutcome> {
    const target = request.target;
    const kind = target.kind as AsyncManagedTarget["kind"];
    const policy = INVOCATION_POLICY[kind];
    const habitatId = request.habitatId;

    // 1. Start Plugin Run (the invocation gate — Q13).
    let runId: string | null = null;
    try {
      const run = deps.startRun({
        habitatId,
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        contributionKind: contributionKindForStorage(kind),
        triggerEventId: "triggerEventId" in request ? request.triggerEventId : null,
        triggerType: request.triggerType,
      });
      runId = run.id;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error("Managed invocation startRun failed — infrastructure failure", {
        kind,
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        errMessage: message,
      });
      return buildFaultOutcome(kind, null, message, true, false, target, false);
    }

    // 2. Quarantine check.
    if (deps.isQuarantined(target.canonicalKey)) {
      const ff = safeFinishRun(runId, "skipped");
      if (!ff) safeDeleteRun(runId);
      return buildSkippedOutcome(kind, runId, !ff);
    }

    // 3. Detector concurrency capacity (Q12, Q14 — rate_limited is capacity-only).
    let slotAcquired = false;
    if (kind === "signalDetector") {
      slotAcquired = deps.acquireDetectorSlot(habitatId);
      if (!slotAcquired) {
        const ff = safeFinishRun(runId, "rate_limited");
        if (!ff) safeDeleteRun(runId);
        return buildRateLimitedOutcome(kind, runId, !ff);
      }
    }

    // 4a. Build context — infrastructure failure if this throws (BLOCKER 2).
    //     No handler invocation, no counter increment.
    let ctx: PluginContext;
    try {
      ctx = deps.buildContext({
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        habitatId,
        runId,
        requires: target.requires,
      });
      populateKindPayload(ctx, request);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.logger.error("Managed invocation buildContext failed — infrastructure failure", {
        kind,
        pluginId: target.pluginId,
        contributionId: target.contributionId,
        errMessage: message,
      });
      // HIGH 3: release the slot acquired in step 3 — no handler Promise
      // will ever exist to attach cleanup to.
      if (kind === "signalDetector" && slotAcquired) {
        deps.releaseDetectorSlot(habitatId);
      }
      // BLOCKER 2: finish as "skipped" (NOT "failed") — the handler was
      // never launched, so the row must be recovery-eligible for the next
      // catch-up scan (existsForTriggerEvent excludes "skipped"). The
      // handlerLaunched: false flag in the outcome ensures
      // dispatchDetectorTarget returns recovery_deferred for this scan.
      const ff = safeFinishRun(runId, "skipped", undefined, message);
      if (!ff) safeDeleteRun(runId);
      return buildFaultOutcome(kind, runId, message, false, !ff, target, false);
    }

    const effectiveTimeout = target.timeoutMs ?? policy.defaultTimeoutMs;

    // 4b. Invoke handler + validate + onResult + finish — ALL inside try
    //     (BLOCKER 2: synchronous handler throw must not escape as unhandled
    //     rejection or leave the run "running").
    //
    //     handlerPromiseExists tracks whether invokeHandler returned a Promise.
    //     A synchronous throw leaves it false — the slot was acquired but no
    //     Promise exists to attach settlement-based cleanup to (HIGH 3).
    let handlerPromiseExists = false;
    try {
      const handlerPromise = invokeHandler(kind, target, ctx, request);
      handlerPromiseExists = true;

      // BLOCKER 3: attach slot release to the UNDERLYING handler Promise
      // settlement via .then(release, release) — both branches call release,
      // and the rejection is consumed (no unhandledRejection). This is Q12:
      // release on underlying settlement, not watchdog race winner.
      if (kind === "signalDetector" && slotAcquired) {
        handlerPromise.then(
          () => deps.releaseDetectorSlot(habitatId),
          () => deps.releaseDetectorSlot(habitatId),
        );
      }

      const raw = await deps.withTimeout(handlerPromise, effectiveTimeout, target.canonicalKey);

      // 5. Validate.
      const validation = ASYNC_VALIDATORS[kind](raw);
      if (!validation.ok) {
        maybeIncrementError(kind, target);
        const ff = safeFinishRun(runId, "failed", undefined, validation.error);
        return buildFaultOutcome(kind, runId, validation.error, false, !ff, target, true);
      }

      // 6. onResult side-effect hook (BLOCKER 1): for Detector/post kinds,
      //    server-owned signal persistence runs AFTER validation but BEFORE
      //    finishRun. If persistence throws, the run finishes failed (no
      //    counter increment — infrastructure failure, not a plugin fault).
      let signalsEmitted: number | undefined;
      const meta = extractKindMetadata(kind, validation.value);
      const onResult = getOnResult(request);
      if (onResult !== undefined) {
        const signals = extractValidatedSignals(kind, validation.value);
        try {
          signalsEmitted = await onResult(signals);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          deps.logger.error("Managed invocation onResult persistence failed", {
            kind,
            runId,
            errMessage: message,
          });
          const ff = safeFinishRun(runId, "failed", undefined, message);
          return buildFaultOutcome(kind, runId, message, false, !ff, target, true);
        }
      } else {
        signalsEmitted = meta.signalsEmitted;
      }

      // 7. Expected outcome — success or domain failure (neither increments).
      const status = terminalStatusForValidResult(kind, validation.value);
      const ff = safeFinishRun(runId, status, signalsEmitted, meta.error);
      return buildSuccessOutcome(kind, runId, status, validation.value, !ff);
    } catch (err) {
      // Handler synchronous throw, async rejection, or watchdog timeout.
      // HIGH 3: if invokeHandler threw synchronously (handlerPromiseExists
      // is false), the slot was acquired but no Promise was returned to
      // attach settlement-based cleanup to. Release it now.
      if (kind === "signalDetector" && slotAcquired && !handlerPromiseExists) {
        deps.releaseDetectorSlot(habitatId);
      }
      const message = err instanceof Error ? err.message : String(err);
      maybeIncrementError(kind, target);
      const ff = safeFinishRun(runId, "failed", undefined, message);
      // handlerLaunched: true — the handler was invoked (at-most-once).
      // A synchronous throw still counts as a durable invocation; the row
      // finishes "failed" and existsForTriggerEvent treats it as accounted.
      return buildFaultOutcome(kind, runId, message, false, !ff, target, true);
    }
  }

  return { checkPreVeto, invokeManaged };
}

// ─────────────────────────────────────────────────────────────────────────────
// Private helpers (not exported — used by the factory closure)
// ─────────────────────────────────────────────────────────────────────────────

/** Invokes the kind-specific handler and returns the underlying Promise. */
function invokeHandler(
  kind: AsyncManagedTarget["kind"],
  target: AsyncManagedTarget,
  ctx: PluginContext,
  request: ManagedInvocationRequest,
): Promise<unknown> {
  switch (kind) {
    case "signalDetector":
      return (target as DetectorTarget).handler(ctx, (request as DetectorInvocationRequest).source);
    case "automationAction": {
      const req = request as ActionInvocationRequest;
      return (target as ActionTarget).handler(ctx, req.evalCtx, req.params);
    }
    case "notificationChannel":
      return (target as ChannelTarget).handler(ctx, ctx.notificationPayload!);
    case "postInterceptor":
      return Promise.resolve((target as PostInterceptorTarget).handler(ctx, ctx.transition!));
  }
}

/** Populates the kind-specific context payload from the request. */
function populateKindPayload(ctx: PluginContext, request: ManagedInvocationRequest): void {
  switch (request.target.kind) {
    case "notificationChannel": {
      const req = request as ChannelInvocationRequest;
      ctx.notificationPayload = { delivery: req.delivery, event: req.event };
      break;
    }
    case "postInterceptor": {
      const req = request as PostInterceptorInvocationRequest;
      ctx.transition = {
        taskId: req.taskId,
        action: req.event,
        habitatId: req.habitatId,
        context: req.context,
      };
      break;
    }
    // Detector and Action payloads are passed directly to the handler, not via ctx.
  }
}

/** Extracts `signalsEmitted` and `error` from a validated result for `finishRun`. */
function extractKindMetadata(
  kind: AsyncManagedTarget["kind"],
  value: unknown,
): { signalsEmitted?: number; error?: string } {
  switch (kind) {
    case "signalDetector": {
      const signals = (value as DetectedSignalInput[]).length;
      return { signalsEmitted: signals };
    }
    case "postInterceptor": {
      const signals = (value as ValidatedPostResult).signals?.length ?? 0;
      return { signalsEmitted: signals };
    }
    case "automationAction": {
      const r = value as ValidatedActionResult;
      return r.status === "failed" && r.error !== undefined ? { error: r.error } : {};
    }
    case "notificationChannel": {
      const r = value as ValidatedChannelResult;
      return !r.success && r.error !== undefined ? { error: r.error } : {};
    }
  }
}

/**
 * Extracts the optional `onResult` hook from a request (BLOCKER 1).
 * Only Detector and Post requests carry it; returns `undefined` for others.
 */
function getOnResult(
  request: ManagedInvocationRequest,
): ((signals: DetectedSignalInput[]) => Promise<number>) | undefined {
  if (request.target.kind === "signalDetector" || request.target.kind === "postInterceptor") {
    return (request as DetectorInvocationRequest | PostInterceptorInvocationRequest).onResult;
  }
  return undefined;
}

/** Extracts the validated signal array for kinds that carry signals. */
function extractValidatedSignals(
  kind: AsyncManagedTarget["kind"],
  value: unknown,
): DetectedSignalInput[] {
  if (kind === "signalDetector") return value as DetectedSignalInput[];
  return (value as ValidatedPostResult).signals ?? [];
}

/** Builds a fault outcome (runtime fault — throw, timeout, invalid result). */
function buildFaultOutcome(
  kind: AsyncManagedTarget["kind"],
  runId: string | null,
  error: string,
  startFailed: boolean,
  finishFailed: boolean,
  _target: ManagedTargetBase,
  handlerLaunched: boolean,
): ManagedInvocationOutcome {
  const base = {
    runId,
    status: "failed" as PluginRunStatus,
    error,
    startFailed,
    finishFailed,
    handlerLaunched,
  };
  switch (kind) {
    case "signalDetector":
      return { kind: "signalDetector", ...base, signals: [], signalsEmitted: 0 };
    case "automationAction":
      return { kind: "automationAction", ...base, result: { status: "failed", error } };
    case "notificationChannel":
      return { kind: "notificationChannel", ...base, result: { success: false, error } };
    case "postInterceptor":
      return { kind: "postInterceptor", ...base, signals: [], signalsEmitted: 0 };
  }
}

/** Builds a skipped (quarantine) outcome. */
function buildSkippedOutcome(
  kind: AsyncManagedTarget["kind"],
  runId: string,
  finishFailed: boolean,
): ManagedInvocationOutcome {
  const base = {
    runId,
    status: "skipped" as PluginRunStatus,
    startFailed: false,
    finishFailed,
    handlerLaunched: false,
  };
  switch (kind) {
    case "signalDetector":
      return { kind: "signalDetector", ...base, signals: [], signalsEmitted: 0 };
    case "automationAction":
      return {
        kind: "automationAction",
        ...base,
        result: { status: "failed", error: "Plugin contribution quarantined" },
      };
    case "notificationChannel":
      return {
        kind: "notificationChannel",
        ...base,
        result: { success: false, error: "Plugin contribution quarantined" },
      };
    case "postInterceptor":
      return { kind: "postInterceptor", ...base, signals: [], signalsEmitted: 0 };
  }
}

/** Builds a rate-limited (Detector capacity denied) outcome. */
function buildRateLimitedOutcome(
  kind: AsyncManagedTarget["kind"],
  runId: string,
  finishFailed: boolean,
): ManagedInvocationOutcome {
  // Only Detectors reach this path; the signature accepts the union for type safety.
  return {
    kind: kind as "signalDetector",
    runId,
    status: "rate_limited" as PluginRunStatus,
    startFailed: false,
    finishFailed,
    handlerLaunched: false,
    signals: [],
    signalsEmitted: 0,
  };
}

/** Builds a success/domain-failure outcome from a validated handler result. */
function buildSuccessOutcome(
  kind: AsyncManagedTarget["kind"],
  runId: string,
  status: PluginRunStatus,
  value: unknown,
  finishFailed: boolean,
): ManagedInvocationOutcome {
  const base = { runId, status, startFailed: false, finishFailed, handlerLaunched: true };
  switch (kind) {
    case "signalDetector":
      return {
        kind: "signalDetector",
        ...base,
        signals: value as DetectedSignalInput[],
        signalsEmitted: (value as DetectedSignalInput[]).length,
      };
    case "automationAction": {
      const r = value as ValidatedActionResult;
      const result =
        r.status === "succeeded" && r.result !== undefined
          ? { status: "succeeded" as const, result: r.result }
          : r.status === "succeeded"
            ? { status: "succeeded" as const }
            : { status: "failed" as const, ...(r.error !== undefined ? { error: r.error } : {}) };
      return { kind: "automationAction", ...base, result };
    }
    case "notificationChannel": {
      const r = value as ValidatedChannelResult;
      const result: { success: boolean; error?: string; attemptId?: string; statusCode?: number } =
        { success: r.success };
      if (r.error !== undefined) result.error = r.error;
      if (r.attemptId !== undefined) result.attemptId = r.attemptId;
      if (r.statusCode !== undefined) result.statusCode = r.statusCode;
      return { kind: "notificationChannel", ...base, result };
    }
    case "postInterceptor": {
      const r = value as ValidatedPostResult;
      const signals = r.signals ?? [];
      return { kind: "postInterceptor", ...base, signals, signalsEmitted: signals.length };
    }
  }
}
