import { and, eq } from "drizzle-orm";
import type { WorkflowFailureHandlerConfig } from "@orcy/shared";
import { getDb } from "../../db/index.js";
import {
  taskCreationAttempts,
  taskRecoveryHandoffs,
  taskWorkflowGates,
  tasks,
} from "../../db/schema/index.js";
import { emitTaskAuditEvent } from "../auditEventEmitter.js";
import { logger } from "../../lib/logger.js";
import * as agentRepo from "../../repositories/agent.js";
import * as failureContextService from "../failureContextService.js";
import { emitRecoveryNotification, substituteTemplate } from "./recoveryNotifications.js";
import {
  publishRecoveryTask,
  type RecoveryTaskPublicationResult,
} from "../taskRecoveryPublication.js";

const RECOVERY_ATTEMPT_SOURCE = "workflow";
const RECOVERY_ATTEMPT_SCOPE = "recovery_run";
const RECOVERY_ATTEMPT_KEY = "spawn_recovery";

const TERMINAL_SUCCESS_STATES = new Set(["created", "created_unassigned"]);
const TERMINAL_REFUSAL_STATES = new Set([
  "vetoed",
  "rejected_validation",
  "batch_rejected",
  // Reservation-time refusal is not an attempt state in the current ledger,
  // but keeping it here makes the coordinator defensive if a caller stores it.
  "rejected_fingerprint",
]);

type RecoveryHandoffRow = typeof taskRecoveryHandoffs.$inferSelect;
type RecoveryAttemptRow = typeof taskCreationAttempts.$inferSelect;
type RecoveryTaskRow = Pick<
  typeof tasks.$inferSelect,
  "id" | "missionId" | "title" | "rejectionReason" | "assignedAgentId"
>;
type RecoveryGateRow = Pick<typeof taskWorkflowGates.$inferSelect, "downstreamTaskId" | "recoveryTaskId">;
type ReconciliationOutcome = "spawned" | "resumed" | "consumed" | "blocked" | "deferred";

export interface RecoveryReconciliationSummary {
  scanned: number;
  spawned: number;
  resumed: number;
  consumed: number;
  blocked: number;
}

/**
 * Reconciles durable workflow recovery handoffs with the creation-attempt
 * ledger. This pass is intentionally bounded and idempotent: boot, the
 * lifecycle adapter, and operators/tests may invoke it, but there is no
 * periodic timer. The immutable handler payload on the handoff is the source
 * of truth for every spawn/resume attempt.
 */
export function runRecoveryReconciliationPass(): RecoveryReconciliationSummary {
  const db = getDb();
  const rows = db
    .select({
      handoff: taskRecoveryHandoffs,
      gate: {
        downstreamTaskId: taskWorkflowGates.downstreamTaskId,
        recoveryTaskId: taskWorkflowGates.recoveryTaskId,
      },
      upstreamTask: {
        id: tasks.id,
        missionId: tasks.missionId,
        title: tasks.title,
        rejectionReason: tasks.rejectionReason,
        assignedAgentId: tasks.assignedAgentId,
      },
      attempt: taskCreationAttempts,
    })
    .from(taskRecoveryHandoffs)
    .innerJoin(taskWorkflowGates, eq(taskWorkflowGates.id, taskRecoveryHandoffs.gateId))
    .innerJoin(tasks, eq(tasks.id, taskWorkflowGates.upstreamTaskId))
    .leftJoin(
      taskCreationAttempts,
      and(
        eq(taskCreationAttempts.source, RECOVERY_ATTEMPT_SOURCE),
        eq(taskCreationAttempts.sourceScopeKind, RECOVERY_ATTEMPT_SCOPE),
        eq(taskCreationAttempts.sourceScopeId, taskRecoveryHandoffs.gateId),
        eq(taskCreationAttempts.attemptKey, RECOVERY_ATTEMPT_KEY),
      ),
    )
    .where(eq(taskRecoveryHandoffs.status, "expected"))
    .all();

  const summary: RecoveryReconciliationSummary = {
    scanned: rows.length,
    spawned: 0,
    resumed: 0,
    consumed: 0,
    blocked: 0,
  };

  for (const row of rows) {
    const handoff = row.handoff;
    const attempt = row.attempt;

    if (!attempt) {
      const outcome = publishFromHandoff(handoff, row.gate, row.upstreamTask, "spawn");
      if (outcome === "spawned") summary.spawned += 1;
      if (outcome === "resumed") summary.resumed += 1;
      if (outcome === "consumed") summary.consumed += 1;
      if (outcome === "blocked") summary.blocked += 1;
      continue;
    }

    if (TERMINAL_SUCCESS_STATES.has(attempt.state)) {
      consumeHandoff(handoff.id);
      summary.consumed += 1;
      continue;
    }

    if (TERMINAL_REFUSAL_STATES.has(attempt.state)) {
      const reason = terminalBlockedReason(attempt);
      blockHandoff(handoff, row.gate.downstreamTaskId, attempt.id, reason);
      summary.blocked += 1;
      continue;
    }

    // A pending attempt has reserved the deterministic key but has not made a
    // publication checkpoint. No worker scans this state, so the coordinator
    // must retry the prepare/govern/publish chain under the same key.
    if (attempt.state === "pending") {
      const outcome = publishFromHandoff(handoff, row.gate, row.upstreamTask, "resume");
      if (outcome === "resumed") summary.resumed += 1;
      if (outcome === "consumed") summary.consumed += 1;
      if (outcome === "blocked") summary.blocked += 1;
      continue;
    }

    // These states are already past publication. The dispatcher and targeted
    // assignment worker own their forward progress; in particular,
    // published_pending_observation must never be selected for another spawn.
    if (
      attempt.state === "published_pending_observation" ||
      attempt.state === "published_pending_assignment"
    ) {
      summary.resumed += 1;
      continue;
    }

    logger.warn(
      { handoffId: handoff.id, attemptId: attempt.id, state: attempt.state },
      "Recovery coordinator encountered an unknown attempt state",
    );
  }

  return summary;
}

function publishFromHandoff(
  handoff: RecoveryHandoffRow,
  gate: RecoveryGateRow,
  failedTask: RecoveryTaskRow,
  mode: "spawn" | "resume",
): ReconciliationOutcome {
  let handler: WorkflowFailureHandlerConfig;
  try {
    handler = parseFrozenHandler(handoff.frozenHandlerConfig);
  } catch (err) {
    const reason = "invalid_frozen_handler_config";
    blockHandoff(handoff, gate.downstreamTaskId, null, reason);
    logger.error({ err, handoffId: handoff.id }, "Recovery handoff contains invalid handler JSON");
    return "blocked";
  }

  const failureContext = failureContextService.getFailureContext(failedTask.id);
  const variables = collectSubstitutionVariables(failedTask, failureContext?.failureReason);
  const assignedAgentId = handler.agentSelector?.assignedAgentId ?? null;

  try {
    const result = publishRecoveryTask({
      runId: handoff.gateId,
      actionKey: RECOVERY_ATTEMPT_KEY,
      habitatId: handoff.habitatId,
      targetMissionId: handoff.missionId,
      title: substituteTemplate(handler.recoveryTaskTemplate.title, variables),
      description: handler.recoveryTaskTemplate.description
        ? substituteTemplate(handler.recoveryTaskTemplate.description, variables)
        : "",
      requiredDomain: handler.agentSelector?.requiredDomain ?? null,
      requiredCapabilities: handler.agentSelector?.requiredCapabilities,
      assignment: assignedAgentId
        ? { kind: "targeted", agentId: assignedAgentId }
        : { kind: "auto" },
      linkage: {
        gateId: handoff.gateId,
        workflowId: handoff.workflowId,
        habitatId: handoff.habitatId,
        missionId: handoff.missionId,
        downstreamTaskId: handoff.downstreamTaskId,
        recoveryDepth: handoff.recoveryDepth,
        // The handoff intentionally does not carry failureContextId. When a
        // context was captured before the immediate pass, derive it from the
        // failed task; boot reconciliation safely omits it when absent.
        ...(failureContext ? { failureContextId: failureContext.id } : {}),
      },
    });

    if (isTerminalPublicationRefusal(result)) {
      const reason = publicationBlockedReason(result);
      blockHandoff(handoff, gate.downstreamTaskId, result.attemptId, reason);
      return "blocked";
    }

    if (result.outcome === "replayed") {
      const terminalOutcome = result.terminal.outcome;
      if (TERMINAL_SUCCESS_STATES.has(terminalOutcome)) {
        consumeHandoff(handoff.id);
        return "consumed";
      }
      if (TERMINAL_REFUSAL_STATES.has(terminalOutcome)) {
        blockHandoff(
          handoff,
          gate.downstreamTaskId,
          result.attemptId,
          terminalResultBlockedReason(result.terminal as TerminalResultLike, terminalOutcome),
        );
        return "blocked";
      }
      logger.warn(
        { handoffId: handoff.id, attemptId: result.attemptId, outcome: terminalOutcome },
        "Recovery coordinator encountered an unknown replayed terminal outcome",
      );
      return "deferred";
    }

    if (result.outcome === "created") {
      // The attempt row is now at published_pending_observation. Keep the
      // handoff expected so later passes classify it after the workers advance
      // the checkpoint. Only the first successful publication emits the
      // started notification; the gate CAS/link is the idempotency marker.
      if (gate.recoveryTaskId === null) {
        emitRecoveryNotification(
          handoff.habitatId,
          "workflow.recovery_started",
          `Recovery task spawned for: ${failedTask.title}`,
          {
            gateId: handoff.gateId,
            failedTaskId: failedTask.id,
            recoveryTaskId: result.publication.task.id,
            recoveryDepth: handoff.recoveryDepth + 1,
          },
        );
      }
      return mode === "spawn" ? "spawned" : "resumed";
    }

    // guard_mismatch and governance_denied are resumable. The handoff stays
    // expected and the pending attempt remains eligible for the next pass.
    return mode === "spawn" ? "spawned" : "resumed";
  } catch (err) {
    // Infrastructure failure leaves the durable intent expected so a later
    // boot/on-demand pass can retry under the same deterministic key.
    logger.error(
      { err, handoffId: handoff.id, gateId: handoff.gateId },
      "Recovery handoff spawn failed; leaving handoff expected",
    );
    return "deferred";
  }
}

function parseFrozenHandler(raw: string): WorkflowFailureHandlerConfig {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object") {
    throw new Error("frozen handler is not an object");
  }
  const handler = parsed as Partial<WorkflowFailureHandlerConfig>;
  if (!handler.recoveryTaskTemplate || typeof handler.recoveryTaskTemplate.title !== "string") {
    throw new Error("frozen handler is missing recoveryTaskTemplate.title");
  }
  return parsed as WorkflowFailureHandlerConfig;
}

function collectSubstitutionVariables(
  task: RecoveryTaskRow,
  capturedFailureReason?: string,
): Record<string, string> {
  const failedAgentId = task.assignedAgentId ?? "";
  let failedAgentName = "";
  if (failedAgentId) {
    const agent = agentRepo.getAgentById(failedAgentId);
    failedAgentName = agent?.name ?? "";
  }

  return {
    failedTaskId: task.id,
    failedTaskTitle: task.title,
    failureReason: capturedFailureReason ?? task.rejectionReason ?? "",
    failedAgentId,
    failedAgentName,
  };
}

function isTerminalPublicationRefusal(
  result: RecoveryTaskPublicationResult,
): result is Extract<
  RecoveryTaskPublicationResult,
  { outcome: "vetoed" | "rejected_validation" | "rejected_fingerprint" }
> {
  return (
    result.outcome === "vetoed" ||
    result.outcome === "rejected_validation" ||
    result.outcome === "rejected_fingerprint"
  );
}

function publicationBlockedReason(
  result: Extract<
    RecoveryTaskPublicationResult,
    { outcome: "vetoed" | "rejected_validation" | "rejected_fingerprint" }
  >,
): string {
  if (result.outcome === "vetoed") return result.veto.reason || result.outcome;
  if (result.outcome === "rejected_validation") {
    const first = result.errors[0];
    if (first) return first.message || first.code || result.outcome;
  }
  return result.outcome;
}

function terminalBlockedReason(attempt: RecoveryAttemptRow): string {
  return terminalResultBlockedReason(
    attempt.terminalResult as TerminalResultLike | null | undefined,
    attempt.terminalOutcome ?? attempt.state,
  );
}

type TerminalResultLike = {
  outcome?: string;
  reason?: string;
  veto?: { reason?: string };
  errors?: Array<{ message?: string; code?: string; reason?: string }>;
};

function terminalResultBlockedReason(
  terminal: TerminalResultLike | null | undefined,
  fallback: string,
): string {
  const firstError = terminal?.errors?.[0];
  return (
    terminal?.veto?.reason ??
    terminal?.reason ??
    firstError?.reason ??
    firstError?.message ??
    firstError?.code ??
    terminal?.outcome ??
    fallback
  );
}

function consumeHandoff(handoffId: string): void {
  getDb()
    .update(taskRecoveryHandoffs)
    .set({ status: "consumed", consumedAt: new Date().toISOString() })
    .where(and(eq(taskRecoveryHandoffs.id, handoffId), eq(taskRecoveryHandoffs.status, "expected")))
    .run();
}

function blockHandoff(
  handoff: RecoveryHandoffRow,
  downstreamTaskId: string,
  attemptId: string | null,
  reason: string,
): void {
  getDb()
    .update(taskRecoveryHandoffs)
    .set({ status: "blocked", blockedReason: reason })
    .where(and(eq(taskRecoveryHandoffs.id, handoff.id), eq(taskRecoveryHandoffs.status, "expected")))
    .run();

  try {
    emitTaskAuditEvent({
      taskId: downstreamTaskId,
      actorType: "system",
      actorId: "workflow-recovery-coordinator",
      action: "workflow_evaluation_error",
      metadata: {
        audit: { source: "workflow" },
        phase: "recovery_reconciliation",
        handoffId: handoff.id,
        gateId: handoff.gateId,
        attemptId,
        blockedReason: reason,
      },
    });
  } catch (err) {
    logger.error(
      { err, handoffId: handoff.id, gateId: handoff.gateId },
      "Failed to emit blocked recovery handoff audit",
    );
  }
}
