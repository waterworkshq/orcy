/**
 * One-reservation review finality service (review-safety cutover, B1 design).
 *
 * The ONLY reachable terminal approval/completion writes. This module exports
 * exactly two operations — `approveWithReservation` and
 * `completeWithReservation` — and NOTHING that grants terminal authority:
 * no capability object, no tx/client parameter, no exported terminal CAS.
 * The terminal writes are closures created INSIDE this service's own
 * `BEGIN IMMEDIATE` reservation, closing over the service-owned tx, taskId
 * and generation, and are minted at exactly one point: AFTER fresh
 * task/requirement/assignment reads, projection-aware ACTOR admission,
 * prospective finality, and the single final-only pre-veto. Quorum-met alone
 * can never reach the CAS — admission and veto precede minting on the only
 * code path. A lost CAS throws so the decision, proof and status roll back
 * together; a veto COMMITS plugin telemetry only (no decision/status/proof).
 *
 * The signed known-zero merge path lives entirely inside the webhook trust
 * boundary (`services/webhooks/mergeApproval.ts`) with its own private CAS —
 * this module exports nothing for it.
 */
import { getDb } from "../db/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { habitatIdForTaskWithClient } from "./tasks/transitionBudget.js";
import { tasks, taskReviewers, taskReviewRequirements } from "../db/schema/index.js";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { Task } from "../models/index.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import {
  appendReviewDecisionWithClient,
  evaluateFinalityWithClient,
  getRequirementWithClient,
  projectReviewersWithClient,
  stampApprovedGenerationWithClient,
  type ProjectedReviewerStatus,
  type ReviewRequirementRow,
} from "../repositories/reviewSafety.js";

export interface PreVetoDecision {
  allow: false;
  reason: string;
  details?: string;
}

export type ApproveReservationOutcome =
  | { outcome: "refused"; reason: string }
  | { outcome: "recorded_partial"; task: Task }
  | { outcome: "vetoed"; veto: PreVetoDecision }
  | { outcome: "approved"; task: Task };

/**
 * The production final-only pre-veto, OWNED by this service (fixup-4
 * blocker 1): invoked inside the reservation with the REAL caller identity
 * and the fresh preimage task — never caller-supplied. Plugin telemetry the
 * runtime writes commits with the reservation; on veto NO decision/status/
 * proof is written.
 */
function runProductionPreVeto(input: {
  taskId: string;
  habitatId: string;
  reviewerId: string;
  reviewerType: "human" | "agent";
  current: typeof tasks.$inferSelect;
}): PreVetoDecision | null {
  return pluginManager.runPreInterceptors(input.taskId, "taskApproved", input.habitatId, {
    actorType: input.reviewerType,
    actorId: input.reviewerId,
    reviewerId: input.reviewerId,
    oldStatus: input.current.status,
    newStatus: "approved",
    task: input.current,
  });
}

/** Provenance shape persisted on the decision row (chat review decisions). */
export type DecisionProvenance = Record<string, unknown> | null | undefined;

/**
 * The module-private terminal context — never exported, never accepted as a
 * parameter from outside; constructed only by {@link mintTerminal} below.
 */
interface TerminalContext {
  readonly tx: ReturnType<typeof getDb>;
  readonly taskId: string;
  readonly generation: number;
}

/**
 * Mints the terminal context. Called at exactly one point per reservation:
 * after admission + finality + pre-veto (approve) or after the completion
 * predicates (done). The closures below close over this context and the
 * reservation's own tx — there is no other constructor in the program.
 */
function mintTerminal(
  tx: ReturnType<typeof getDb>,
  taskId: string,
  generation: number,
): TerminalContext {
  return { tx, taskId, generation };
}

/** Private terminal approve CAS — submitted→approved + proof stamp. */
function terminalApproveCas(ctx: TerminalContext): Task | null {
  const now = new Date().toISOString();
  const runResult = ctx.tx
    .update(tasks)
    .set({
      status: "approved",
      completedAt: now,
      executionToken: null,
      lastFailureEventId: null,
      lastReleaseEventId: null,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, ctx.taskId), eq(tasks.status, "submitted")))
    .run();
  const changes = (runResult as { changes?: number } | undefined)?.changes;
  if (changes === 0) return null;
  // Proof stamp pinned to the reservation's generation: a generation that
  // moved under the reservation matches zero rows → mismatch below.
  const stamped = ctx.tx
    .update(taskReviewRequirements)
    .set({ approvedGeneration: ctx.generation, updatedAt: now })
    .where(
      and(
        eq(taskReviewRequirements.taskId, ctx.taskId),
        eq(taskReviewRequirements.reviewGeneration, ctx.generation),
      ),
    )
    .run();
  const stampChanges = (stamped as { changes?: number } | undefined)?.changes;
  const updated = ctx.tx.select().from(tasks).where(eq(tasks.id, ctx.taskId)).get() as
    | typeof tasks.$inferSelect
    | undefined;
  if (!updated || updated.status !== "approved" || stampChanges === 0) return null;
  return updated as unknown as Task;
}

/** Private terminal done CAS — submitted|approved→done (predicates checked by the caller). */
function terminalDoneCas(ctx: TerminalContext): Task | null {
  const now = new Date().toISOString();
  const runResult = ctx.tx
    .update(tasks)
    .set({
      status: "done",
      completedAt: now,
      executionToken: null,
      lastFailureEventId: null,
      lastReleaseEventId: null,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, ctx.taskId), inArray(tasks.status, ["submitted", "approved"])))
    .run();
  const changes = (runResult as { changes?: number } | undefined)?.changes;
  if (changes === 0) return null;
  const updated = ctx.tx.select().from(tasks).where(eq(tasks.id, ctx.taskId)).get() as
    | typeof tasks.$inferSelect
    | undefined;
  if (!updated || updated.status !== "done") return null;
  return updated as unknown as Task;
}

function admissionForReviewer(
  projected: ProjectedReviewerStatus | undefined,
  reviewerType: "human" | "agent",
  assigneeId: string | null,
  reviewerId: string,
): string | null {
  if (projected === undefined) return "not_assigned";
  if (projected === "ineligible") return "not_assigned";
  if (reviewerType === "agent") {
    if (assigneeId === reviewerId) return "self_review";
    if (projected === "rejected") return "not_pending";
  }
  return null;
}

/** UI-compatibility raw-row status sync (never authority — projection is). */
function updateRawReviewerRow(
  tx: ReturnType<typeof getDb>,
  taskId: string,
  reviewerType: "human" | "agent",
  reviewerId: string,
  status: "approved",
): void {
  const row = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId, reviewerType);
  if (row && row.status !== status) {
    tx.update(taskReviewers)
      .set({ status, reviewedAt: new Date().toISOString() })
      .where(eq(taskReviewers.id, row.id))
      .run();
  }
}

/**
 * The single guarded approval entry point. The final-only production plugin
 * pre-veto runs INSIDE the reservation, owned by this service (fixup-4) —
 * no caller-supplied policy callback exists on this interface; the veto
 * path commits plugin telemetry but never a decision/status/proof.
 */
export function approveWithReservation(input: {
  taskId: string;
  reviewerId: string;
  reviewerType: "human" | "agent";
  provenance?: DecisionProvenance;
}): ApproveReservationOutcome {
  const { taskId, reviewerId, reviewerType } = input;
  const db = getDb();

  return db.transaction(
    (tx) => {
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | typeof tasks.$inferSelect
        | undefined;
      if (!row) return { outcome: "refused", reason: "not_found" } as const;
      if (row.status !== "submitted")
        return { outcome: "refused", reason: "not_submitted" } as const;

      const requirement = getRequirementWithClient(tx, taskId);
      if (!requirement) return { outcome: "refused", reason: "missing_requirement" } as const;
      if (requirement.state === "legacy_unknown" || requirement.state === "uncaptured") {
        // Deliberate operational hold: historical uncertainty never finalizes
        // without independent human resolution.
        return { outcome: "refused", reason: "requirement_unknown" } as const;
      }

      const reviewerRows = tx
        .select()
        .from(taskReviewers)
        .where(eq(taskReviewers.taskId, taskId))
        .all();

      // ── Known-zero direct path (no assignment rows) ──────────────────────
      if (reviewerRows.length === 0) {
        if (requirement.state !== "known_zero") {
          return { outcome: "refused", reason: "review_required" } as const;
        }
        const habitatId = habitatIdForTaskWithClient(tx, taskId);
        const veto = runProductionPreVeto({
          taskId,
          habitatId: habitatId ?? "",
          reviewerId,
          reviewerType,
          current: row,
        });
        if (veto) return { outcome: "vetoed", veto } as const;
        const ctx = mintTerminal(tx, taskId, requirement.reviewGeneration);
        const approved = terminalApproveCas(ctx);
        if (!approved) throw new Error("approve_terminal_cas_lost");
        return { outcome: "approved", task: approved } as const;
      }

      // ── Assigned-reviewer path: ACTOR admission first, always ────────────
      const projected = projectReviewersWithClient(tx, taskId, requirement);
      const own = projected.find(
        (p) => p.reviewerType === reviewerType && p.reviewerId === reviewerId,
      );
      const refusal = admissionForReviewer(
        own?.projected,
        reviewerType,
        row.assignedAgentId,
        reviewerId,
      );
      if (refusal) return { outcome: "refused", reason: refusal } as const;

      // Prospective finality: this decision recorded as approved in the
      // CURRENT round; everything else keeps its projection.
      const after = projected.map((p) =>
        p.reviewerType === reviewerType && p.reviewerId === reviewerId
          ? { ...p, projected: "approved" as ProjectedReviewerStatus }
          : p,
      );
      const blocking = after.filter((p) => p.projected === "pending" || p.projected === "rejected");
      const wouldBeFinal =
        blocking.length === 0 &&
        (requirement.state === "known_zero" ||
          after.filter((p) => p.projected === "approved").length >=
            (requirement.effectiveCount ?? 0));

      if (!wouldBeFinal) {
        // Non-final decision: commit the decision only (idempotent-safe — a
        // reviewer already projected approved records nothing new).
        if (own?.projected !== "approved") {
          appendReviewDecisionWithClient(tx, {
            taskId,
            reviewGeneration: requirement.reviewGeneration,
            reviewRound: requirement.reviewRound,
            reviewerType,
            reviewerId,
            decision: "approved",
            actorType: reviewerType,
            actorId: reviewerId,
            provenance: input.provenance ?? null,
          });
          updateRawReviewerRow(tx, taskId, reviewerType, reviewerId, "approved");
        }
        const fresh = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
          | typeof tasks.$inferSelect
          | undefined;
        return { outcome: "recorded_partial", task: fresh as unknown as Task } as const;
      }

      // Final: ONE pre-veto under this reservation — the PRODUCTION plugin
      // gate, owned by this service. Quorum-met alone never reaches the CAS
      // without passing this gate; no caller can supply or suppress it.
      // Veto → COMMIT telemetry only (no decision, no status, no proof).
      const habitatId = habitatIdForTaskWithClient(tx, taskId);
      const veto = runProductionPreVeto({
        taskId,
        habitatId: habitatId ?? "",
        reviewerId,
        reviewerType,
        current: row,
      });
      if (veto) return { outcome: "vetoed", veto } as const;

      if (own?.projected !== "approved") {
        appendReviewDecisionWithClient(tx, {
          taskId,
          reviewGeneration: requirement.reviewGeneration,
          reviewRound: requirement.reviewRound,
          reviewerType,
          reviewerId,
          decision: "approved",
          actorType: reviewerType,
          actorId: reviewerId,
          provenance: input.provenance ?? null,
        });
        updateRawReviewerRow(tx, taskId, reviewerType, reviewerId, "approved");
      }

      const ctx = mintTerminal(tx, taskId, requirement.reviewGeneration);
      const approved = terminalApproveCas(ctx);
      if (!approved) throw new Error("approve_terminal_cas_lost");
      return { outcome: "approved", task: approved } as const;
    },
    { behavior: "immediate" },
  );
}

// ---------------------------------------------------------------------------
// Completion — the guarded terminal `done` reservation (B2: fresh projection
// re-check on BOTH arms; the approved→done arm re-evaluates the requirement,
// proof, claimant and the CURRENT assignment projection, so a reviewer added
// between approval and completion blocks the done write).
// ---------------------------------------------------------------------------

export type CompletionReservationOutcome =
  | {
      outcome: "refused";
      reason:
        | "not_found"
        | "not_completable"
        | "review_required"
        | "requirement_unknown"
        | "proof_invalid"
        | "cas_lost";
    }
  | { outcome: "done"; task: Task };

/**
 * Fresh-completion predicate for the approved→done arm (B2): the committed
 * proof must equal the current generation AND the CURRENT assignment
 * projection must be fully satisfied (every slot approved or ineligible) —
 * a reviewer added after the approval blocks completion.
 */
function approvedCompletionStillValid(
  tx: ReturnType<typeof getDb>,
  taskId: string,
  requirement: ReviewRequirementRow,
): boolean {
  if (requirement.approvedGeneration === null) return false;
  if (requirement.approvedGeneration !== requirement.reviewGeneration) return false;
  // Fixup-2 blocker 2: the FULL fresh finality predicate — eligible
  // approvals vs effective_count on the CURRENT projection. An assignment
  // removed after approval leaves a positive floor unmet (empty projection,
  // zero approvals) and refuses; a genuine known-zero passes.
  const evaluation = evaluateFinalityWithClient(tx, taskId);
  if (!evaluation.eligible) return false;
  // Typed claimant consistency: a drifted assignee since the proof refuses.
  if (requirement.claimantType !== null) {
    const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
      | typeof tasks.$inferSelect
      | undefined;
    if (!row) return false;
    if (
      requirement.claimantType === "local_agent" &&
      row.assignedAgentId !== requirement.claimantId
    ) {
      return false;
    }
    if (
      requirement.claimantType === "remote_participant" &&
      row.remoteAssignedParticipantId !== requirement.claimantId
    ) {
      return false;
    }
  }
  return true;
}

export function completeWithReservation(taskId: string): CompletionReservationOutcome {
  const db = getDb();
  return db.transaction(
    (tx) => {
      const row = tx.select().from(tasks).where(eq(tasks.id, taskId)).get() as
        | typeof tasks.$inferSelect
        | undefined;
      if (!row) return { outcome: "refused", reason: "not_found" } as const;
      if (row.status !== "submitted" && row.status !== "approved") {
        return { outcome: "refused", reason: "not_completable" } as const;
      }

      const requirement = getRequirementWithClient(tx, taskId);
      if (!requirement) return { outcome: "refused", reason: "requirement_unknown" } as const;

      if (row.status === "submitted") {
        if (requirement.state !== "known_zero") {
          return { outcome: "refused", reason: "review_required" } as const;
        }
        const evaluation = evaluateFinalityWithClient(tx, taskId);
        if (!evaluation.eligible) {
          return { outcome: "refused", reason: "review_required" } as const;
        }
      } else if (!approvedCompletionStillValid(tx, taskId, requirement)) {
        return { outcome: "refused", reason: "proof_invalid" } as const;
      }

      const ctx = mintTerminal(tx, taskId, requirement.reviewGeneration);
      const done = terminalDoneCas(ctx);
      if (!done) return { outcome: "refused", reason: "cas_lost" } as const;
      return { outcome: "done", task: done } as const;
    },
    { behavior: "immediate" },
  );
}
