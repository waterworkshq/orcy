import { getDb } from "../../db/index.js";
import { workflows, taskWorkflowGates } from "../../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { logger } from "../../lib/logger.js";
import { stableHash, stableStringify } from "@orcy/shared";
import { createEventWithClient, type EventDbClient } from "../../repositories/events/event-crud.js";
import { emitTaskAuditEvent } from "../auditEventEmitter.js";
import type { WorkflowFailureHandlerConfig, EventAction } from "../../models/index.js";
import type { GateEvaluationDecision } from "./workflowGateEvaluator.js";
import type { WorkflowGateRecord } from "./workflowGateStore.js";

/**
 * Maximum `recoveryDepth` before recovery-handoff eligibility is suppressed
 * (two-attempts cap). Canonical home is the advancement module, which owns the
 * eligibility computation; {@link workflowService} re-exports it for the spawn
 * path.
 */
export const MAX_RECOVERY_DEPTH = 2;

/**
 * Discriminated trigger that identifies the cause of an advancement. Every kind
 * carries the real causal `eventId`:
 * - `lifecycle` — a Task Event id forwarded through the `notifyTransition` seam.
 * - `pulse` — the Pulse id.
 * - `automation` — the Automation Run id.
 * - `recovery_redemption` — the recovery context id (the redemption's causal event).
 * - `manual` — the audit event's OWN id (self-referential; manual unblock has no
 *   external trigger event). The lifecycle adapter asserts the forwarded id is
 *   present before constructing a `lifecycle` trigger (the five gate-mapped
 *   actions always produce one).
 */
export type GateTrigger =
  | { kind: "lifecycle"; eventId: string; action: string; actorType: string; actorId: string }
  | { kind: "pulse"; eventId: string }
  | { kind: "automation"; eventId: string; ruleId: string }
  | { kind: "recovery_redemption"; eventId: string; contextId: string }
  | { kind: "manual"; eventId: string; unblockerId: string };

/**
 * Per-gate advancement outcome. One per input decision, positionally aligned.
 * `not_found`/`wrong_gate_type` are eligibility refusals emitted by the manual
 * adapter (WG-7), NOT by this module — the non-manual trigger kinds receive
 * pre-filtered gates from their `findActiveXGates` queries, and the manual
 * adapter performs its own `on_manual`-type check before calling `advanceGates`.
 */
export type AdvancementResult = {
  gateId: string;
  status:
    | "satisfied"
    | "already_satisfied"
    | "skip"
    | "evaluation_error"
    | "write_error"
    | "not_found"
    | "wrong_gate_type";
  satisfiedAt?: string;
  skipReason?: string;
  triggerKind: GateTrigger["kind"];
  triggerEventId: string;
  error?: string;
};

/**
 * Recovery handoff input. The advancer computes eligibility + freezes the
 * resolved handler config INSIDE the per-gate tx, then hands the frozen
 * snapshot to the registered writer. WG-4 owns the durable
 * `task_recovery_handoffs` table + the boot-only coordinator; the default
 * writer is a no-op so WG-3 ships the atomicity contract without the table.
 */
export interface HandoffWriterInput {
  tx: EventDbClient;
  gate: WorkflowGateRecord;
  trigger: GateTrigger;
  frozenHandler: WorkflowFailureHandlerConfig;
  handlerFingerprint: string;
}

/** Durable recovery-handoff writer. WG-4 registers the real table INSERT. */
export type RecoveryHandoffWriter = (input: HandoffWriterInput) => void;

let registeredHandoffWriter: RecoveryHandoffWriter = () => {
  /* no-op default; WG-4 registers the durable handoff INSERT */
};

/** Registers the recovery handoff writer (WG-4). */
export function registerRecoveryHandoffWriter(writer: RecoveryHandoffWriter): void {
  registeredHandoffWriter = writer;
}

/** Resets the handoff writer to the no-op default (test isolation). */
export function resetRecoveryHandoffWriter(): void {
  registeredHandoffWriter = () => {};
}

const AUDIT_SOURCE = { source: "workflow" } as const;

/** phase label per trigger kind, for `workflow_evaluation_error` audits. */
function evaluationPhase(kind: GateTrigger["kind"]): string {
  switch (kind) {
    case "lifecycle":
      return "gate_satisfaction";
    case "pulse":
      return "signal_gate_evaluation";
    case "automation":
      return "automation_gate_evaluation";
    case "recovery_redemption":
      return "redemption_gate_evaluation";
    case "manual":
      return "manual_gate_evaluation";
  }
}

/** Audit action for the `satisfied` result — manual unblock keeps its distinct provenance. */
function satisfiedAuditAction(kind: GateTrigger["kind"]): EventAction {
  return kind === "manual" ? "workflow_gate_unblocked" : "workflow_gate_satisfied";
}

/** Builds the canonical audit metadata for a `satisfied`/`already_satisfied` result. */
function buildSatisfiedMetadata(
  gate: WorkflowGateRecord,
  trigger: GateTrigger,
  alreadySatisfied: boolean,
): Record<string, unknown> {
  const meta: Record<string, unknown> = {
    audit: AUDIT_SOURCE,
    gateId: gate.id,
    workflowId: gate.workflowId,
    upstreamTaskId: gate.upstreamTaskId,
    downstreamTaskId: gate.downstreamTaskId,
    gateType: gate.gateType,
  };
  switch (trigger.kind) {
    case "lifecycle":
      meta.triggeredBy = trigger.action;
      break;
    case "pulse":
      meta.triggeredBy = "pulse";
      meta.pulseId = trigger.eventId;
      break;
    case "automation":
      meta.triggeredBy = "automation_run";
      meta.runId = trigger.eventId;
      meta.ruleId = trigger.ruleId;
      break;
    case "recovery_redemption":
      meta.triggeredBy = "recovery_redemption";
      meta.contextId = trigger.contextId;
      break;
    case "manual":
      meta.unblockedBy = trigger.unblockerId;
      break;
  }
  if (alreadySatisfied) meta.alreadySatisfied = true;
  return meta;
}

/**
 * Reads the effective failure handler for a gate using the supplied client
 * (the per-gate tx client OR the default `getDb()` client). Lives here so the
 * advancement tx can freeze the handler config inside its own consistent
 * snapshot; the `matchConfig`/`failureHandler` JSON columns are not modified
 * inside this tx, so the read is stable.
 */
export function resolveEffectiveFailureHandlerWithClient(
  db: EventDbClient,
  gate: { matchConfig: Record<string, unknown> | null; workflowId: string },
): WorkflowFailureHandlerConfig | null {
  // Per-gate override lives in matchConfig.{failureHandlerOverride}:
  //   - present and null -> explicit disable (returns null)
  //   - present and an object -> use that handler
  //   - absent (no key) -> fall back to workflow-level failureHandler
  const matchConfig = gate.matchConfig as {
    failureHandlerOverride?: WorkflowFailureHandlerConfig | null;
  } | null;
  if (matchConfig && Object.prototype.hasOwnProperty.call(matchConfig, "failureHandlerOverride")) {
    return matchConfig.failureHandlerOverride ?? null;
  }
  const workflow = db
    .select({ failureHandler: workflows.failureHandler })
    .from(workflows)
    .where(eq(workflows.id, gate.workflowId))
    .get();
  return (workflow?.failureHandler as WorkflowFailureHandlerConfig | null) ?? null;
}

/**
 * Advances a batch of pre-evaluated gates under one closed contract. One
 * per-gate `db.transaction` owns the guarded CAS satisfaction UPDATE, the
 * tx-aware audit INSERT ({@link createEventWithClient}), and — for eligible
 * `on_fail` gates only — the recovery handoff write. An INSERT/UPDATE/handoff
 * throw rolls back ALL three writes inside that gate's tx; the gate stays
 * unsatisfied and the result carries `write_error`. Per-gate, NOT batch — one
 * gate's failure never blocks a later independent gate.
 *
 * Returns exactly `decisions.length` results, positionally aligned. `skip`
 * decisions DO produce a `skip` result; the adapter zips results to decisions.
 */
export function advanceGates(
  decisions: GateEvaluationDecision[],
  trigger: GateTrigger,
): AdvancementResult[] {
  const results: AdvancementResult[] = [];
  for (const decision of decisions) {
    results.push(advanceOne(decision, trigger));
  }
  return results;
}

function advanceOne(decision: GateEvaluationDecision, trigger: GateTrigger): AdvancementResult {
  const gate = decision.gate;
  const common = {
    gateId: gate.id,
    triggerKind: trigger.kind,
    triggerEventId: trigger.eventId,
  };

  if (decision.status === "skip") {
    return { status: "skip", ...common, skipReason: decision.reason };
  }

  if (decision.status === "error") {
    const message =
      decision.error instanceof Error ? decision.error.message : String(decision.error);
    emitEvaluationErrorAudit(gate, trigger, message);
    return { status: "evaluation_error", ...common, error: message };
  }

  // decision.status === "satisfy"
  try {
    return satisfyOne(gate, trigger, common);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "write_error", ...common, error: message };
  }
}

/**
 * Emits the out-of-tx evaluator-error audit. No satisfaction happened (the
 * evaluator threw before any write), so there is nothing to roll back; a failed
 * audit INSERT is logged and swallowed so one gate's evaluator error cannot
 * block later independent gates.
 */
function emitEvaluationErrorAudit(
  gate: WorkflowGateRecord,
  trigger: GateTrigger,
  message: string,
): void {
  try {
    emitTaskAuditEvent({
      taskId: gate.downstreamTaskId,
      actorType: "system",
      actorId: "workflow-service",
      action: "workflow_evaluation_error",
      metadata: {
        audit: AUDIT_SOURCE,
        gateId: gate.id,
        workflowId: gate.workflowId,
        error: message,
        phase: evaluationPhase(trigger.kind),
      },
    });
  } catch (auditErr) {
    logger.error(
      { err: auditErr, gateId: gate.id },
      "advanceGates: failed to emit workflow_evaluation_error audit",
    );
  }
}

function satisfyOne(
  gate: WorkflowGateRecord,
  trigger: GateTrigger,
  common: { gateId: string; triggerKind: GateTrigger["kind"]; triggerEventId: string },
): AdvancementResult {
  const db = getDb();
  return db.transaction((tx) => {
    // SELECT-before-UPDATE discriminator — sql.js-safe (does not rely on
    // `run().changes`, which is undefined under the test driver). Classifies
    // satisfied vs already_satisfied inside the tx.
    const current = tx
      .select({ satisfied: taskWorkflowGates.satisfied })
      .from(taskWorkflowGates)
      .where(eq(taskWorkflowGates.id, gate.id))
      .get();

    if (current?.satisfied === true) {
      return alreadySatisfiedBranch(tx, gate, trigger, common);
    }

    // Preallocate the audit id BEFORE the tx body uses it (Fork A resolution:
    // caller-supplied preallocation — driver-agnostic, no `lastInsertRowid`
    // dependency).
    // For manual: the audit event's OWN id IS the causal id (self-referential).
    // For others: mint a distinct audit-row id; the gate stamp uses trigger.eventId.
    const auditId = trigger.kind === "manual" ? trigger.eventId : crypto.randomUUID();
    const now = new Date().toISOString();
    // Manual unblock is self-referential: the audit event's own id is the causal
    // id stamped onto `satisfiedByEventId`. The other kinds stamp the trigger's
    // real causal event id.
    const causalEventId = trigger.kind === "manual" ? auditId : trigger.eventId;

    // Guarded CAS satisfaction. `WHERE satisfied = false` is preserved as
    // defense-in-depth (Finding 2) — a concurrent writer flipping the row
    // between the SELECT and UPDATE matches zero rows here.
    tx.update(taskWorkflowGates)
      .set({
        satisfied: true,
        satisfiedAt: now,
        satisfiedByEventId: causalEventId,
      })
      .where(and(eq(taskWorkflowGates.id, gate.id), eq(taskWorkflowGates.satisfied, false)))
      .run();

    // Tx-aware audit INSERT — a failure here propagates and rolls back the
    // satisfaction UPDATE above (fail-closed contract, NOT the legacy swallow).
    createEventWithClient(tx, {
      id: auditId,
      taskId: gate.downstreamTaskId,
      actorType: "system",
      actorId: "workflow-service",
      action: satisfiedAuditAction(trigger.kind),
      metadata: buildSatisfiedMetadata(gate, trigger, false),
    });

    // Recovery handoff for eligible `on_fail` gates only. WG-4 owns the durable
    // table; the registered writer defaults to a no-op. A throw here rolls back
    // the satisfaction + audit (same atomicity contract).
    maybeWriteRecoveryHandoff(tx, gate, trigger);

    return { status: "satisfied", ...common, satisfiedAt: now };
  });
}

/**
 * already_satisfied branch. Manual unblock is the ONLY trigger kind that emits
 * an audit on `already_satisfied` — the CR-13/TG-1 attempt audit: a NEW
 * `workflow_gate_unblocked` with an `alreadySatisfied` marker. It NEVER mutates
 * the gate and NEVER overwrites the original `satisfiedByEventId`. The other
 * four kinds emit NO audit (preserving the legacy `continue` on already_satisfied).
 */
function alreadySatisfiedBranch(
  tx: EventDbClient,
  gate: WorkflowGateRecord,
  trigger: GateTrigger,
  common: { gateId: string; triggerKind: GateTrigger["kind"]; triggerEventId: string },
): AdvancementResult {
  if (trigger.kind !== "manual") {
    return { status: "already_satisfied", ...common };
  }
  createEventWithClient(tx, {
    id: trigger.eventId,
    taskId: gate.downstreamTaskId,
    actorType: "system",
    actorId: "workflow-service",
    action: "workflow_gate_unblocked",
    metadata: buildSatisfiedMetadata(gate, trigger, true),
  });
  return { status: "already_satisfied", ...common };
}

/**
 * For an eligible `on_fail` gate, freezes the resolved handler config and hands
 * off to the registered writer inside the per-gate tx. Eligibility
 * (`effectiveHandler !== null` AND `recoveryDepth < MAX_RECOVERY_DEPTH`) is
 * computed inside the tx so the freeze reflects a consistent snapshot.
 */
function maybeWriteRecoveryHandoff(
  tx: EventDbClient,
  gate: WorkflowGateRecord,
  trigger: GateTrigger,
): void {
  if (gate.gateType !== "on_fail") return;
  const effectiveHandler = resolveEffectiveFailureHandlerWithClient(tx, gate);
  if (effectiveHandler === null) return;
  if (gate.recoveryDepth >= MAX_RECOVERY_DEPTH) return;
  const fingerprint = "handler:" + stableHash(stableStringify(effectiveHandler));
  registeredHandoffWriter({
    tx,
    gate,
    trigger,
    frozenHandler: effectiveHandler,
    handlerFingerprint: fingerprint,
  });
}
