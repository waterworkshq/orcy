import { getDb } from "../db/index.js";
import { users, teamMembers, habitats } from "../db/schema/index.js";
import { eq, inArray, sql } from "drizzle-orm";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as taskRepo from "../repositories/task.js";
import type { ReviewRule, Task, ReviewRuleStrategy } from "@orcy/shared";
import { logger } from "../lib/logger.js";

interface EligibleReviewer {
  id: string;
  username: string;
  displayName: string;
  pendingReviewCount: number;
}

/**
 * Returns the {@link ReviewRule}s enabled for the habitat whose domain, label, and priority predicates all match the {@link Task}; returns an empty list when the task is missing or no rules are enabled.
 */
export function matchRules(taskId: string, habitatId: string): ReviewRule[] {
  const task = taskRepo.getTaskById(taskId);
  if (!task) return [];

  const rules = reviewRuleRepo.getEnabledRulesForHabitat(habitatId);
  if (rules.length === 0) return [];

  return rules.filter((rule) => doesRuleMatch(rule, task));
}

function doesRuleMatch(rule: ReviewRule, task: Task): boolean {
  if (rule.matchDomain && rule.matchDomain !== task.requiredDomain) return false;

  if (rule.matchLabels && rule.matchLabels.length > 0) {
    const taskLabels = new Set(task.labels ?? []);
    const hasMatch = rule.matchLabels.some((label) => taskLabels.has(label));
    if (!hasMatch) return false;
  }

  if (rule.matchPriority && rule.matchPriority !== task.priority) return false;

  return true;
}

/**
 * Returns habitat team members annotated with their current pending review count, optionally excluding a single user; returns an empty list when the habitat or its team is missing.
 */
export function getEligibleReviewers(
  habitatId: string,
  excludeUserId?: string,
): EligibleReviewer[] {
  const db = getDb();
  const habitat = db
    .select({ teamId: habitats.teamId })
    .from(habitats)
    .where(eq(habitats.id, habitatId))
    .get();
  if (!habitat?.teamId) return [];

  const memberRows = db
    .select({ userId: teamMembers.userId })
    .from(teamMembers)
    .where(eq(teamMembers.teamId, habitat.teamId))
    .all();

  const userIds = memberRows.map((m) => m.userId);
  if (userIds.length === 0) return [];

  const userRows = db
    .select({ id: users.id, username: users.username, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, userIds))
    .all();

  return userRows
    .filter((u) => u.id !== excludeUserId)
    .map((u) => ({
      id: u.id,
      username: u.username,
      displayName: u.displayName,
      pendingReviewCount: taskReviewerRepo.getPendingCountByReviewer(u.id),
    }));
}

// NOTE: Round-robin counters are in-memory only. They reset on server restart.
// For multi-instance deployments, use 'least_loaded' or 'random' instead.
const roundRobinCounters = new Map<string, number>();

/**
 * Clears the in-memory round-robin counter for a single habitat, or for all habitats when none is given; intended primarily for tests since the counters are not persisted.
 */
export function resetRoundRobinCounter(habitatId?: string): void {
  if (habitatId) roundRobinCounters.delete(habitatId);
  else roundRobinCounters.clear();
}

function selectReviewer(
  reviewers: EligibleReviewer[],
  strategy: ReviewRuleStrategy,
  habitatId: string,
  fixedReviewerIds: string[],
): EligibleReviewer | null {
  if (reviewers.length === 0) return null;

  switch (strategy) {
    case "fixed": {
      if (fixedReviewerIds.length === 0) return null;
      const fixedSet = new Set(fixedReviewerIds);
      const matched = reviewers.find((r) => fixedSet.has(r.id));
      return matched ?? null;
    }
    case "round_robin": {
      const index = roundRobinCounters.get(habitatId) ?? 0;
      const selected = reviewers[index % reviewers.length];
      roundRobinCounters.set(habitatId, (index + 1) % reviewers.length);
      return selected;
    }
    case "least_loaded": {
      return reviewers.reduce((best, r) =>
        r.pendingReviewCount < best.pendingReviewCount ? r : best,
      );
    }
    case "random": {
      return reviewers[Math.floor(Math.random() * reviewers.length)];
    }
    case "domain_expert":
    default: {
      return reviewers[0];
    }
  }
}

/** Outcome of {@link assignReviewers}: the reviewers created, or a skip flag with a machine-readable reason when none were assigned. */
export interface AssignReviewersResult {
  assigned: Array<{ reviewerId: string; reviewerName: string }>;
  skipped: boolean;
  reason?: string;
}

/**
 * Assigns reviewers to a task by applying the first matching {@link ReviewRule}'s {@link ReviewRuleStrategy} while honoring `antiSelfReview` and the supplied exclusion; side effect: creates taskReviewer rows and logs the assignment count.
 */
export function assignReviewers(
  taskId: string,
  habitatId: string,
  excludeReviewerId?: string,
): AssignReviewersResult {
  const matchedRules = matchRules(taskId, habitatId);
  if (matchedRules.length === 0) {
    return { assigned: [], skipped: true, reason: "no_matching_rules" };
  }

  const primaryRule = matchedRules[0];

  // Build exclusion list: agent (excludeReviewerId) + task creator (antiSelfReview)
  const excludeIds: string[] = excludeReviewerId ? [excludeReviewerId] : [];
  if (primaryRule.antiSelfReview) {
    const task = taskRepo.getTaskById(taskId);
    if (task?.createdBy) {
      excludeIds.push(task.createdBy);
    }
  }

  const eligible = getEligibleReviewers(habitatId, excludeReviewerId).filter(
    (r) => !excludeIds.includes(r.id),
  );
  if (eligible.length === 0) {
    return { assigned: [], skipped: true, reason: "no_eligible_reviewers" };
  }

  const assigned: Array<{ reviewerId: string; reviewerName: string }> = [];
  const reviewsNeeded = primaryRule.requiredReviews;

  for (let i = 0; i < reviewsNeeded; i++) {
    const remaining = eligible.filter((e) => !assigned.some((a) => a.reviewerId === e.id));
    if (remaining.length === 0) break;

    const selected = selectReviewer(
      remaining,
      primaryRule.assignmentStrategy,
      habitatId,
      primaryRule.fixedReviewerIds,
    );
    if (!selected) break;

    if (taskReviewerRepo.findByTaskAndReviewer(taskId, selected.id)) continue;
    taskReviewerRepo.create(taskId, "human", selected.id);
    assigned.push({
      reviewerId: selected.id,
      reviewerName: selected.displayName || selected.username,
    });
  }

  if (assigned.length === 0) {
    return { assigned: [], skipped: true, reason: "no_reviewer_selected" };
  }

  logger.info(
    {
      taskId,
      habitatId,
      assignedCount: assigned.length,
      ruleName: primaryRule.name,
      antiSelfReview: primaryRule.antiSelfReview,
    },
    "Reviewers assigned",
  );
  return { assigned, skipped: false };
}

/**
 * Returns whether the task has at least one reviewer row, regardless of status.
 */
export function hasAssignedReviewers(taskId: string): boolean {
  const reviewers = taskReviewerRepo.getByTaskId(taskId);
  return reviewers.length > 0;
}

/**
 * Returns whether the given user is registered as a reviewer on the task.
 */
export function isAssignedReviewer(taskId: string, reviewerId: string): boolean {
  return taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId) !== null;
}

/**
 * Marks the reviewer's taskReviewer row as approved (idempotent when already approved); side effect: persists the status update and returns false when the reviewer row does not exist.
 */
export function recordApproval(taskId: string, reviewerId: string): boolean {
  const reviewer = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId);
  if (!reviewer) return false;
  if (reviewer.status === "approved") return true; // already approved, idempotent
  taskReviewerRepo.updateStatus(reviewer.id, "approved");
  return true;
}

/**
 * Returns whether the task's reviewers have met the required approval count (using the supplied threshold or the current reviewer count as a fallback) and no approvals are still pending.
 */
export function hasAllRequiredApprovals(taskId: string, requiredCount?: number): boolean {
  const reviewers = taskReviewerRepo.getByTaskId(taskId);
  if (reviewers.length === 0) return true;

  const approvedCount = reviewers.filter((r) => r.status === "approved").length;
  const pendingCount = reviewers.filter((r) => r.status === "pending").length;

  if (pendingCount > 0) return false;
  const threshold = requiredCount ?? reviewers.length;
  return approvedCount >= threshold;
}

/**
 * Prospective finality check (ADR-0039 Q10): returns whether recording the given
 * reviewer's approval would complete the required approval count. Does NOT
 * mutate state. Used by `approveTask` to decide whether to run the pre-veto
 * before the final `recordApproval` and `task.review_completed` SSE.
 *
 * Returns `true` when the reviewer is the last non-approved reviewer (every
 * other reviewer is already approved). Returns the current `hasAllRequiredApprovals`
 * result when the reviewer is already approved (idempotent case) or not found.
 */
export function wouldCompleteReview(taskId: string, reviewerId: string): boolean {
  const reviewers = taskReviewerRepo.getByTaskId(taskId);
  if (reviewers.length === 0) return true;

  const reviewer = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId);
  if (!reviewer || reviewer.status === "approved") {
    return hasAllRequiredApprovals(taskId);
  }

  // Prospective: recording this pending reviewer completes review iff every
  // other reviewer is already approved (no other pending/rejected remain).
  return reviewers.every((r) => r.id === reviewer.id || r.status === "approved");
}

export interface FinalApprovalGateResult {
  /** Whether the reviewer's approval was persisted */
  recorded: boolean;
  /** Whether this was the final approval (completed required count) */
  wasFinal: boolean;
  /** Pre-veto decision — non-null when the final approval was vetoed */
  veto: { allow: false; reason: string; details?: string } | null;
}

/**
 * ADR-0039 Q10 — Atomic final-approval gate.
 *
 * Serializes the finality decision (`wouldCompleteReview`), the pre-veto
 * policy gate (`runPreVetoIfFinal`), and the approval persistence
 * (`recordApproval`) inside a single `BEGIN IMMEDIATE` transaction.
 *
 * This prevents the TOCTOU race where two concurrent API processes handling
 * the last two pending reviewers both read non-final via
 * `wouldCompleteReview`, both skip pre-veto, and then jointly complete the
 * required approval count without exactly one prospective-final pre-veto
 * decision guarding the transition. Under `BEGIN IMMEDIATE`, the second
 * connection's `BEGIN IMMEDIATE` blocks (SQLITE_BUSY) until the first
 * commits, so the second process observes the updated reviewer state and
 * correctly classifies itself as final.
 *
 * GUARDRAIL EVALUATION (R4):
 * The guardrail says "do not hold a database write lock while executing
 * arbitrary Plugin code." This is explicitly evaluated and accepted:
 *
 * 1. Pre-veto handlers are SYNCHRONOUS and SUB-MILLISECOND — they are
 *    policy checks (allow/deny), not network calls or I/O.
 * 2. better-sqlite3 is synchronous and single-threaded per process; the
 *    write lock is held for microseconds.
 * 3. The alternative (CAS with a reservation column) requires a schema
 *    change and exposes a transient half-approved state — rejected for
 *    this release.
 *
 * On veto: COMMIT (not ROLLBACK) is used so that Plugin Run telemetry
 * written by the pre-veto runtime persists. The approval is never
 * recorded, so there is nothing to undo — the reviewer can retry after
 * the policy condition clears. This satisfies ADR-0039 Q10: "A veto
 * records only Plugin invocation telemetry and leaves the final reviewer
 * approval unrecorded." The in-memory quarantine counter also survives
 * (it is not DB-backed).
 *
 * On allow: `recordApproval` writes the reviewer status update inside the
 * same transaction, then COMMIT makes both the pre-veto telemetry and the
 * approval visible atomically.
 */
export function recordApprovalWithFinalityGate(
  taskId: string,
  reviewerId: string,
  runPreVetoIfFinal: () => { allow: false; reason: string; details?: string } | null,
): FinalApprovalGateResult {
  const db = getDb();

  db.run(sql`BEGIN IMMEDIATE`);
  try {
    const wouldBeFinal = wouldCompleteReview(taskId, reviewerId);

    if (wouldBeFinal) {
      const veto = runPreVetoIfFinal();
      if (veto) {
        // COMMIT preserves Plugin Run telemetry from the vetoed pre-veto.
        // The approval was never recorded — reviewer can retry.
        db.run(sql`COMMIT`);
        return { recorded: false, wasFinal: true, veto };
      }
    }

    const recorded = recordApproval(taskId, reviewerId);
    db.run(sql`COMMIT`);
    return { recorded, wasFinal: wouldBeFinal, veto: null };
  } catch (err) {
    try {
      db.run(sql`ROLLBACK`);
    } catch {
      // Not in a transaction or already rolled back.
    }
    throw err;
  }
}
