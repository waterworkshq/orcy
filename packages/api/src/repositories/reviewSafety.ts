/**
 * Review-safety requirement store (migration 0082) — the durable review
 * requirement state, claim-policy snapshots, append-only decisions and human
 * override evidence, plus the state transitions the accepted contract pins:
 *
 *   - capture on EVERY successful claim (one snapshot per claim generation)
 *   - ownership-end/reset invalidation in the SAME transaction as the Task
 *     mutation (override expiry restores effective = max(floors) immediately)
 *   - generation-aware effective reviewer projection (A's approval survives
 *     rounds; current-round rejection blocks; older-round rejection projects
 *     pending — a blocker that admits a fresh decision; pre-migration raw
 *     rows never auto-credit)
 *   - independent human resolution/relaxation as the ONLY unknown→known exit
 *     and the ONLY positive-baseline reduction
 *
 * Every primitive is client-scoped (`*WithClient`) and runs on the CALLER's
 * writer reservation (BEGIN IMMEDIATE) — none of these open their own
 * transaction or call getDb() for writes.
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  taskReviewRequirements,
  taskReviewSnapshots,
  taskReviewDecisions,
  taskReviewOverrides,
  reviewRules,
  taskReviewers,
  tasks,
} from "../db/schema/index.js";
import type { TaskPublicationDbClient } from "./taskPublication.js";
import type { ReviewRule } from "@orcy/shared";

export type ReviewRequirementRow = typeof taskReviewRequirements.$inferSelect;
export type ReviewSnapshotRow = typeof taskReviewSnapshots.$inferSelect;
export type ReviewDecisionInsert = typeof taskReviewDecisions.$inferInsert;
export type RequirementState = ReviewRequirementRow["state"];
export type ClaimantType = "local_agent" | "remote_participant";

export interface TypedClaimant {
  type: ClaimantType;
  id: string;
}

/** Client-scoped read; null when the Task has no requirement row (unknown). */
export function getRequirementWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
): ReviewRequirementRow | null {
  const row = tx
    .select()
    .from(taskReviewRequirements)
    .where(eq(taskReviewRequirements.taskId, taskId))
    .get();
  return row ?? null;
}

/**
 * Inserts the `uncaptured` row for a NEWLY CREATED pending Task — the only
 * birth-state a fresh Task may carry. Runs inside the creator's transaction
 * (kernel `createTaskWithClient` / `taskCrud.createTask`). Idempotent.
 */
export function insertUncapturedRequirementWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
  origin: "ordinary" | "preset_historical" = "ordinary",
): void {
  tx.insert(taskReviewRequirements)
    .values({
      taskId,
      origin,
      state: "uncaptured",
      nonOverriddenFloor: null,
      knownPolicyFloor: 0,
      effectiveCount: null,
      requirementVersion: 1,
      reviewGeneration: 0,
      reviewRound: 0,
      claimantType: null,
      claimantId: null,
      approvedGeneration: null,
      activeOverrideId: null,
      selectedRuleId: null,
    })
    .onConflictDoNothing()
    .run();
}

// ---------------------------------------------------------------------------
// Rule matching — tx-scoped mirror of reviewAssignmentService.matchRules
// (getEnabledRulesForHabitat ordering + doesRuleMatch semantics, byte-for-
// byte: first rule, domain equality, label any-intersection, priority
// equality). Reads on the caller's client so the frozen evidence is copied
// under the claim writer reservation, never reconstructed later.
// ---------------------------------------------------------------------------

function doesRuleMatchTx(
  rule: ReviewRule,
  task: { requiredDomain: string | null; labels: string[]; priority: string },
): boolean {
  if (rule.matchDomain && rule.matchDomain !== task.requiredDomain) return false;
  if (rule.matchLabels && rule.matchLabels.length > 0) {
    const taskLabels = new Set(task.labels ?? []);
    const hasMatch = rule.matchLabels.some((label) => taskLabels.has(label));
    if (!hasMatch) return false;
  }
  if (rule.matchPriority && rule.matchPriority !== task.priority) return false;
  return true;
}

function firstMatchingRuleWithClient(
  tx: TaskPublicationDbClient,
  habitatId: string,
  task: { requiredDomain: string | null; labels: string[]; priority: string },
): ReviewRule | null {
  const rules = tx
    .select()
    .from(reviewRules)
    .where(and(eq(reviewRules.habitatId, habitatId), eq(reviewRules.enabled, 1)))
    .orderBy(reviewRules.priority)
    .all() as ReviewRule[];
  for (const rule of rules) {
    if (doesRuleMatchTx(rule, task)) return rule;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claim capture — the claim kernel calls this AFTER the claim write verifies
// and BEFORE the daemon hook; a throw rolls back the ENTIRE claim.
// ---------------------------------------------------------------------------

/**
 * Captures the review requirement for a successful claim in the claim's own
 * transaction: advances generation once, writes exactly one append-only
 * snapshot for that generation (winning rule copy + winning task fields, or
 * the explicit no-match record), installs the typed claimant, and reapplies
 * the floor per state:
 *   - first capture from `uncaptured` (or a defensively missing row): floor
 *     initialized to the captured count (never SQL max(NULL,·)); state
 *     becomes `known_zero` (0) or `required` (>0).
 *   - `legacy_unknown` stays unknown: NULL floor/effective preserved, only
 *     `known_policy_floor` accumulates (max with the captured count).
 *   - `known_zero` tightens to `required` on a positive capture (floor
 *     max(0,new)); stays zero on no-match.
 *   - `required` reapplies baseline max(existing floor, new count) — a
 *     no-match can never lower a known positive floor; any active override
 *     expires HERE (claim generation change), effective restored to baseline.
 */
export function captureRequirementOnClaimWithClient(
  tx: TaskPublicationDbClient,
  input: {
    taskId: string;
    habitatId: string;
    claimant: TypedClaimant;
    task: { requiredDomain: string | null; labels: string[]; priority: string };
  },
): ReviewRequirementRow {
  const { taskId, habitatId, claimant, task } = input;
  const now = new Date().toISOString();

  const rule = firstMatchingRuleWithClient(tx, habitatId, task);
  const capturedCount = rule ? rule.requiredReviews : 0;

  const existing = getRequirementWithClient(tx, taskId);
  const prevGeneration = existing?.reviewGeneration ?? 0;
  const generation = prevGeneration + 1;

  if (!existing) {
    // B4 (binding correction): an ALREADY EXISTING Task missing its
    // requirement row is unknown/error — NEVER a fresh `uncaptured` (and
    // never known-zero). Only Task birth and the audited migration
    // classifier create `uncaptured` rows; the claim fails closed.
    throw new Error(
      `claim refused: task ${taskId} has no review requirement row (unknown state)`,
    );
  }

  let next: ReviewRequirementRow;
  if (existing.state === "uncaptured") {
    // First genuine capture from the birth/migration classification.
    next = {
      taskId,
      origin: "ordinary",
      state: capturedCount === 0 ? "known_zero" : "required",
      nonOverriddenFloor: capturedCount,
      knownPolicyFloor: 0,
      effectiveCount: capturedCount,
      requirementVersion: existing.requirementVersion + 1,
      reviewGeneration: generation,
      reviewRound: 0,
      claimantType: claimant.type,
      claimantId: claimant.id,
      approvedGeneration: null,
      activeOverrideId: null,
      selectedRuleId: rule?.id ?? null,
      updatedAt: now,
    };
  } else if (existing.state === "legacy_unknown") {
    // Historical uncertainty is not resolvable by a new policy match: the
    // prospective floor accumulates, finality stays denied.
    next = {
      ...existing,
      knownPolicyFloor: Math.max(existing.knownPolicyFloor, capturedCount),
      requirementVersion: existing.requirementVersion + 1,
      reviewGeneration: generation,
      reviewRound: 0,
      claimantType: claimant.type,
      claimantId: claimant.id,
      approvedGeneration: null,
      activeOverrideId: null,
      selectedRuleId: rule?.id ?? null,
      updatedAt: now,
    };
  } else if (existing.state === "known_zero") {
    const floor = Math.max(0, capturedCount);
    next = {
      ...existing,
      state: floor > 0 ? "required" : "known_zero",
      nonOverriddenFloor: floor,
      effectiveCount: floor,
      requirementVersion: existing.requirementVersion + 1,
      reviewGeneration: generation,
      reviewRound: 0,
      claimantType: claimant.type,
      claimantId: claimant.id,
      approvedGeneration: null,
      activeOverrideId: null,
      selectedRuleId: rule?.id ?? null,
      updatedAt: now,
    };
  } else {
    // required — reapplied baseline; a later no-match cannot erase the floor.
    const floor = Math.max(existing.nonOverriddenFloor ?? 0, capturedCount);
    const baseline = Math.max(floor, existing.knownPolicyFloor);
    next = {
      ...existing,
      state: "required",
      nonOverriddenFloor: floor,
      effectiveCount: baseline,
      requirementVersion: existing.requirementVersion + 1,
      reviewGeneration: generation,
      reviewRound: 0,
      claimantType: claimant.type,
      claimantId: claimant.id,
      approvedGeneration: null,
      activeOverrideId: null,
      selectedRuleId: rule?.id ?? null,
      updatedAt: now,
    };
  }

  tx.insert(taskReviewSnapshots)
    .values({
      id: uuid(),
      taskId,
      reviewGeneration: generation,
      claimantType: claimant.type,
      claimantId: claimant.id,
      matched: rule !== null,
      requiredCount: capturedCount,
      ruleId: rule?.id ?? null,
      ruleUpdatedAt: rule?.updatedAt ?? null,
      rulePriority: rule?.priority ?? null,
      ruleMatchDomain: rule?.matchDomain ?? null,
      ruleMatchLabels: rule?.matchLabels ?? null,
      ruleMatchPriority: rule?.matchPriority ?? null,
      ruleAssignmentStrategy: rule?.assignmentStrategy ?? null,
      ruleAntiSelfReview: rule?.antiSelfReview ?? null,
      ruleFixedReviewerIds: rule?.fixedReviewerIds ?? null,
      taskDomain: task.requiredDomain ?? null,
      taskLabels: task.labels ?? [],
      taskPriority: task.priority,
      capturedAt: now,
    })
    .run();

  if (existing) {
    tx.update(taskReviewRequirements)
      .set(next)
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
  } else {
    tx.insert(taskReviewRequirements).values(next).run();
  }
  return next;
}

// ---------------------------------------------------------------------------
// Ownership end / reset — same-transaction invalidation for every writer that
// actually ends an owner (release, fail, remote release, agent deletion,
// retry, import reset, claimant-changing delegation).
// ---------------------------------------------------------------------------

/**
 * Invalidates current-claim satisfaction for one Task on the caller's writer
 * reservation: clears the typed claimant and approval proof, expires any
 * active override restoring `effective_count = max(non_overridden_floor,
 * known_policy_floor)` IMMEDIATELY (never an override-free zero below a
 * positive baseline awaiting the next claim), and advances the generation
 * once. Floors, origin, decisions and history are preserved. `known_zero`
 * stays zero, `legacy_unknown` stays NULL, `uncaptured` stays uncaptured.
 *
 * `advanceGeneration:false` is for writers whose pre-image owner is already
 * null (defensive clears) — the row is normalized but the generation does not
 * move. No row → no-op.
 */
export function endOwnershipWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
  opts?: { advanceGeneration?: boolean },
): void {
  const existing = getRequirementWithClient(tx, taskId);
  if (!existing) return;
  const now = new Date().toISOString();
  const advance = opts?.advanceGeneration ?? true;

  let effective = existing.effectiveCount;
  if (existing.state === "required") {
    effective = Math.max(existing.nonOverriddenFloor ?? 0, existing.knownPolicyFloor);
  } else if (existing.state === "known_zero") {
    effective = 0;
  } else {
    effective = null;
  }

  const changed =
    existing.claimantType !== null ||
    existing.claimantId !== null ||
    existing.approvedGeneration !== null ||
    existing.activeOverrideId !== null ||
    existing.effectiveCount !== effective ||
    (advance && true);

  if (!changed) return;

  tx.update(taskReviewRequirements)
    .set({
      claimantType: null,
      claimantId: null,
      approvedGeneration: null,
      activeOverrideId: null,
      effectiveCount: effective,
      requirementVersion: existing.requirementVersion + 1,
      reviewGeneration: advance ? existing.reviewGeneration + 1 : existing.reviewGeneration,
      updatedAt: now,
    })
    .where(eq(taskReviewRequirements.taskId, taskId))
    .run();
}

/**
 * Import `tasks:reset` — the publication transaction resets execution state
 * on every task in the habitat; this applies the same invalidation per task
 * (generation advance, proof/claimant/override cleared, baseline restored,
 * floors/origin/history and the import audit markers preserved). Sticky
 * `legacy_unknown` and `preset_historical` origin survive; `uncaptured`
 * never-claimed rows stay `uncaptured`.
 */
export function resetRequirementsForImportWithClient(
  tx: TaskPublicationDbClient,
  taskIds: string[],
): void {
  if (taskIds.length === 0) return;
  const rows = tx
    .select()
    .from(taskReviewRequirements)
    .where(inArray(taskReviewRequirements.taskId, taskIds))
    .all();
  const now = new Date().toISOString();
  for (const existing of rows) {
    const effective =
      existing.state === "required"
        ? Math.max(existing.nonOverriddenFloor ?? 0, existing.knownPolicyFloor)
        : existing.state === "known_zero"
          ? 0
          : null;
    tx.update(taskReviewRequirements)
      .set({
        claimantType: null,
        claimantId: null,
        approvedGeneration: null,
        activeOverrideId: null,
        effectiveCount: effective,
        requirementVersion: existing.requirementVersion + 1,
        reviewGeneration: existing.reviewGeneration + 1,
        updatedAt: now,
      })
      .where(eq(taskReviewRequirements.taskId, existing.taskId))
      .run();
  }
}

/** Stamps the committed submitted→approved proof (guarded writers only). */
export function stampApprovedGenerationWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
  generation: number,
): void {
  tx.update(taskReviewRequirements)
    .set({ approvedGeneration: generation, updatedAt: new Date().toISOString() })
    .where(
      and(
        eq(taskReviewRequirements.taskId, taskId),
        eq(taskReviewRequirements.reviewGeneration, generation),
      ),
    )
    .run();
}

// ---------------------------------------------------------------------------
// Decisions — append-only evidence; never mutated, never deleted by
// assignment removal (identity is (reviewer_type, reviewer_id); the row set
// survives until the Task itself is deleted).
// ---------------------------------------------------------------------------

export function appendReviewDecisionWithClient(
  tx: TaskPublicationDbClient,
  input: {
    taskId: string;
    reviewGeneration: number;
    reviewRound: number;
    reviewerType: "human" | "agent";
    reviewerId: string;
    decision: "approved" | "rejected";
    actorType: "human" | "agent" | "system" | "remote_human" | "remote_orcy" | "remote_pod";
    actorId: string;
    provenance?: Record<string, unknown> | null;
  },
): void {
  tx.insert(taskReviewDecisions)
    .values({
      id: uuid(),
      taskId: input.taskId,
      reviewGeneration: input.reviewGeneration,
      reviewRound: input.reviewRound,
      reviewerType: input.reviewerType,
      reviewerId: input.reviewerId,
      decision: input.decision,
      decidedAt: new Date().toISOString(),
      actorType: input.actorType,
      actorId: input.actorId,
      provenance: input.provenance ?? null,
    })
    .run();
}

/** All decisions in the given generation (projection input). */
export function decisionsForGenerationWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
  generation: number,
): (typeof taskReviewDecisions.$inferSelect)[] {
  return tx
    .select()
    .from(taskReviewDecisions)
    .where(
      and(
        eq(taskReviewDecisions.taskId, taskId),
        eq(taskReviewDecisions.reviewGeneration, generation),
      ),
    )
    .all()
    .sort((a, b) => (a.decidedAt === b.decidedAt ? 0 : a.decidedAt < b.decidedAt ? -1 : 1));
}

// ---------------------------------------------------------------------------
// Effective reviewer projection — the authorization surface, never raw
// task_reviewers.status alone.
// ---------------------------------------------------------------------------

export type ProjectedReviewerStatus = "approved" | "rejected" | "pending" | "ineligible";

export interface ProjectedReviewer {
  reviewerType: "human" | "agent";
  reviewerId: string;
  rowStatus: string;
  projected: ProjectedReviewerStatus;
}

/**
 * Computes the effective assignment projection for the CURRENT generation:
 *
 *  - latest current-generation APPROVAL survives across rounds (never
 *    filtered by round);
 *  - a CURRENT-round rejection projects `rejected` (blocks finality; agents
 *    pending-only admission also refuses it);
 *  - a rejection from an OLDER round projects `pending` — a blocker that
 *    admits a fresh decision (the rework-resubmission contract);
 *  - no current-generation decision → raw-row legacy projection: a raw
 *    `rejected` row keeps its unverified veto in the LEGACY generation (0)
 *    until an eligible fresh decision or authorized repair; any newer
 *    generation projects it pending. A raw `approved` row NEVER auto-credits
 *    — it projects pending (fresh decision required) in every generation;
 *  - the typed current claimant's own slot is `ineligible`: excluded from
 *    both the approval count and the blocking set.
 */
export function projectReviewersWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
  requirement: ReviewRequirementRow,
): ProjectedReviewer[] {
  const rows = tx.select().from(taskReviewers).where(eq(taskReviewers.taskId, taskId)).all();
  const decisions = decisionsForGenerationWithClient(tx, taskId, requirement.reviewGeneration);
  const round = requirement.reviewRound;

  return rows.map((rawRow) => {
    const row = {
      reviewerType: rawRow.reviewerType as "human" | "agent",
      reviewerId: rawRow.reviewerId,
      status: rawRow.status,
    };
    const isClaimant =
      (requirement.claimantType === "local_agent" &&
        row.reviewerType === "agent" &&
        requirement.claimantId === row.reviewerId) ||
      (requirement.claimantType === "remote_participant" &&
        row.reviewerType === "agent" &&
        requirement.claimantId === row.reviewerId);
    if (isClaimant) {
      return {
        reviewerType: row.reviewerType,
        reviewerId: row.reviewerId,
        rowStatus: row.status,
        projected: "ineligible" as const,
      };
    }

    const own = decisions.filter(
      (d) => d.reviewerType === row.reviewerType && d.reviewerId === row.reviewerId,
    );
    const latest = own[own.length - 1];
    if (latest) {
      if (latest.decision === "approved") {
        return {
          reviewerType: row.reviewerType,
          reviewerId: row.reviewerId,
          rowStatus: row.status,
          projected: "approved" as const,
        };
      }
      // Rejection: current round keeps the veto; an older round's rejection is
      // superseded by the rework round change — pending blocker, fresh
      // decision admissible.
      return {
        reviewerType: row.reviewerType,
        reviewerId: row.reviewerId,
        rowStatus: row.status,
        projected: latest.reviewRound === round ? ("rejected" as const) : ("pending" as const),
      };
    }

    // No generation-tagged decision: legacy raw-row projection.
    if (row.status === "rejected" && requirement.reviewGeneration === 0) {
      return {
        reviewerType: row.reviewerType,
        reviewerId: row.reviewerId,
        rowStatus: row.status,
        projected: "rejected" as const,
      };
    }
    return {
      reviewerType: row.reviewerType,
      reviewerId: row.reviewerId,
      rowStatus: row.status,
      projected: "pending" as const,
    };
  });
}

// ---------------------------------------------------------------------------
// Finality evaluation — fresh reads under the caller's writer reservation.
// ---------------------------------------------------------------------------

export type FinalityEvaluation =
  | {
      eligible: true;
      state: "known_zero" | "required";
      effectiveCount: number;
      approvedCount: number;
    }
  | {
      eligible: false;
      reason: "missing_requirement" | "requirement_unknown" | "review_outstanding" | "quorum_unmet";
    };

/**
 * Prospective finality for a submitted Task: distinct current-generation
 * ELIGIBLE approvals (typed identity, active assignment, excluding the typed
 * claimant) must meet the effective count, and NO projected pending/rejected
 * slot may remain. `legacy_unknown`/`uncaptured`/missing rows are never
 * final. An empty assignment set passes only genuine `known_zero` (the
 * preserved review-free path); `required` with zero rows cannot pass.
 */
export function evaluateFinalityWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
): FinalityEvaluation {
  const requirement = getRequirementWithClient(tx, taskId);
  if (!requirement) return { eligible: false, reason: "missing_requirement" };
  if (requirement.state === "legacy_unknown" || requirement.state === "uncaptured") {
    return { eligible: false, reason: "requirement_unknown" };
  }
  const projected = projectReviewersWithClient(tx, taskId, requirement);
  const blocking = projected.filter((p) => p.projected === "pending" || p.projected === "rejected");
  if (blocking.length > 0) return { eligible: false, reason: "review_outstanding" };

  if (requirement.state === "known_zero") {
    return {
      eligible: true,
      state: "known_zero",
      effectiveCount: 0,
      approvedCount: projected.length,
    };
  }

  const approvedCount = projected.filter((p) => p.projected === "approved").length;
  const effective = requirement.effectiveCount ?? requirement.nonOverriddenFloor ?? 0;
  if (approvedCount < effective) return { eligible: false, reason: "quorum_unmet" };
  return { eligible: true, state: "required", effectiveCount: effective, approvedCount };
}

// ---------------------------------------------------------------------------
// Human resolution / relaxation — the ONLY unknown→known exit and the ONLY
// reduction of a positive baseline. Never approves or completes.
// ---------------------------------------------------------------------------

export type ResolutionOutcome =
  | { ok: true; requirement: ReviewRequirementRow; overrideId: string }
  | { ok: false; reason: string };

/**
 * Applies an authorized human resolution/relaxation on the caller's immediate
 * reservation. Authorization, expected-version checks and the state
 * transition all read persisted rows on the SAME client — JWT claims are not
 * authority. Append-only override evidence is written in the same
 * transaction; `requirement_version` bumps; the Task row itself is NOT
 * mutated (a resolution never approves/completes).
 *
 * `authorize` is resolved by the caller under the same reservation (the
 * service-layer check is persisted-role based; see reviewFinalityService).
 */
export function resolveRequirementWithClient(
  tx: TaskPublicationDbClient,
  input: {
    taskId: string;
    actorId: string;
    expectedTaskVersion: number;
    expectedRequirementVersion: number;
    effectiveCount: number;
    reason: string;
    authorized: boolean;
  },
): ResolutionOutcome {
  const { taskId, actorId } = input;
  if (!Number.isInteger(input.effectiveCount) || input.effectiveCount < 0) {
    return { ok: false, reason: "invalid_effective_count" };
  }
  if (!input.reason || input.reason.trim().length === 0) {
    return { ok: false, reason: "reason_required" };
  }
  const requirement = getRequirementWithClient(tx, taskId);
  if (!requirement) return { ok: false, reason: "missing_requirement" };
  if (requirement.requirementVersion !== input.expectedRequirementVersion) {
    return { ok: false, reason: "requirement_version_mismatch" };
  }
  const taskRow = tx
    .select({
      version: tasks.version,
      assignedAgentId: tasks.assignedAgentId,
      remoteAssignedParticipantId: tasks.remoteAssignedParticipantId,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  if (!taskRow) return { ok: false, reason: "task_not_found" };
  if (taskRow.version !== input.expectedTaskVersion) {
    return { ok: false, reason: "task_version_mismatch" };
  }
  if (!input.authorized) return { ok: false, reason: "not_authorized" };
  // Independence: the current typed claimant/executor and any actor who
  // decided review in the current generation can never resolve.
  if (requirement.claimantType === "local_agent" && requirement.claimantId === actorId) {
    return { ok: false, reason: "actor_is_executor" };
  }
  if (taskRow.assignedAgentId === actorId || taskRow.remoteAssignedParticipantId === actorId) {
    return { ok: false, reason: "actor_is_executor" };
  }
  const decidedInGeneration = tx
    .select({ id: taskReviewDecisions.id })
    .from(taskReviewDecisions)
    .where(
      and(
        eq(taskReviewDecisions.taskId, taskId),
        eq(taskReviewDecisions.reviewGeneration, requirement.reviewGeneration),
        eq(taskReviewDecisions.actorId, actorId),
      ),
    )
    .get();
  if (decidedInGeneration) return { ok: false, reason: "actor_decided_in_generation" };

  const now = new Date().toISOString();
  const overrideId = uuid();

  if (requirement.state === "legacy_unknown") {
    const baseline = Math.max(input.effectiveCount, requirement.knownPolicyFloor);
    const next: ReviewRequirementRow = {
      ...requirement,
      state: baseline === 0 ? "known_zero" : "required",
      nonOverriddenFloor: input.effectiveCount,
      effectiveCount: baseline,
      requirementVersion: requirement.requirementVersion + 1,
      activeOverrideId: null,
      updatedAt: now,
    };
    tx.insert(taskReviewOverrides)
      .values({
        id: overrideId,
        taskId,
        actorId,
        reviewGeneration: requirement.reviewGeneration,
        kind: "resolve_unknown",
        requirementVersionBefore: requirement.requirementVersion,
        taskVersion: taskRow.version,
        oldState: requirement.state,
        newState: next.state,
        oldEffectiveCount: requirement.effectiveCount,
        newEffectiveCount: next.effectiveCount,
        reason: input.reason,
        createdAt: now,
      })
      .run();
    tx.update(taskReviewRequirements)
      .set(next)
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
    return { ok: true, requirement: next, overrideId };
  }

  if (requirement.state === "required") {
    const baseline = Math.max(requirement.nonOverriddenFloor ?? 0, requirement.knownPolicyFloor);
    if (input.effectiveCount >= baseline) {
      return { ok: false, reason: "not_a_reduction" };
    }
    const next: ReviewRequirementRow = {
      ...requirement,
      state: "required",
      effectiveCount: input.effectiveCount,
      activeOverrideId: overrideId,
      requirementVersion: requirement.requirementVersion + 1,
      updatedAt: now,
    };
    tx.insert(taskReviewOverrides)
      .values({
        id: overrideId,
        taskId,
        actorId,
        reviewGeneration: requirement.reviewGeneration,
        kind: "relax_baseline",
        requirementVersionBefore: requirement.requirementVersion,
        taskVersion: taskRow.version,
        oldState: requirement.state,
        newState: "required",
        oldEffectiveCount: requirement.effectiveCount,
        newEffectiveCount: input.effectiveCount,
        reason: input.reason,
        createdAt: now,
      })
      .run();
    tx.update(taskReviewRequirements)
      .set(next)
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
    return { ok: true, requirement: next, overrideId };
  }

  return { ok: false, reason: "state_not_resolvable" };
}

/** The frozen claim snapshot for a generation (allocator's authoritative rule). */
export function getSnapshotWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
  generation: number,
): ReviewSnapshotRow | null {
  const row = tx
    .select()
    .from(taskReviewSnapshots)
    .where(
      and(
        eq(taskReviewSnapshots.taskId, taskId),
        eq(taskReviewSnapshots.reviewGeneration, generation),
      ),
    )
    .get();
  return row ?? null;
}

/** Bumps review_round (same-claimant rework start only; never the generation). */
export function bumpReviewRoundWithClient(tx: TaskPublicationDbClient, taskId: string): void {
  tx.update(taskReviewRequirements)
    .set({
      reviewRound: sql`${taskReviewRequirements.reviewRound} + 1`,
      requirementVersion: sql`${taskReviewRequirements.requirementVersion} + 1`,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(taskReviewRequirements.taskId, taskId))
    .run();
}

/**
 * Non-pending initial-status preset (template/inline publication): every
 * non-pending preset Task is persisted `origin=preset_historical,
 * state=legacy_unknown` with no claimant, no floor and no approval proof —
 * grandfathered display, never newly approved. Sticky after import reset; a
 * later claim captures prospective policy but finality requires independent
 * human resolution.
 */
export function markPresetHistoricalWithClient(
  tx: TaskPublicationDbClient,
  taskId: string,
): void {
  const now = new Date().toISOString();
  const existing = getRequirementWithClient(tx, taskId);
  if (existing) {
    tx.update(taskReviewRequirements)
      .set({
        origin: "preset_historical",
        state: "legacy_unknown",
        nonOverriddenFloor: null,
        knownPolicyFloor: 0,
        effectiveCount: null,
        claimantType: null,
        claimantId: null,
        approvedGeneration: null,
        activeOverrideId: null,
        selectedRuleId: null,
        requirementVersion: existing.requirementVersion + 1,
        updatedAt: now,
      })
      .where(eq(taskReviewRequirements.taskId, taskId))
      .run();
  } else {
    tx.insert(taskReviewRequirements)
      .values({
        taskId,
        origin: "preset_historical",
        state: "legacy_unknown",
        nonOverriddenFloor: null,
        knownPolicyFloor: 0,
        effectiveCount: null,
        requirementVersion: 1,
        reviewGeneration: 0,
        reviewRound: 0,
        claimantType: null,
        claimantId: null,
        approvedGeneration: null,
        activeOverrideId: null,
        selectedRuleId: null,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .run();
  }
}

/**
 * Current-generation projected-pending workload for one typed reviewer —
 * the allocator's occupied-slot/workload accounting input. Counts, across
 * every task holding a row for this reviewer identity, the rows whose
 * EFFECTIVE current-generation projection is `pending` (a raw pending row on
 * an advanced generation does not inflate workload; an uncredited raw
 * approved row does occupy — it projects pending until decided).
 */
export function projectedPendingCountByReviewer(
  tx: TaskPublicationDbClient,
  reviewerId: string,
  reviewerType: "human" | "agent",
): number {
  const rows = tx
    .select()
    .from(taskReviewers)
    .where(and(eq(taskReviewers.reviewerId, reviewerId), eq(taskReviewers.reviewerType, reviewerType)))
    .all();
  let count = 0;
  for (const row of rows) {
    const requirement = getRequirementWithClient(tx, row.taskId);
    if (!requirement) continue;
    const projected = projectReviewersWithClient(tx, row.taskId, requirement).find(
      (p) => p.reviewerType === reviewerType && p.reviewerId === reviewerId,
    );
    if (projected?.projected === "pending") count++;
  }
  return count;
}
