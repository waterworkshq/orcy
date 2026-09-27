import { getDb } from "../db/index.js";
import { users, teamMembers, habitats } from "../db/schema/index.js";
import { eq, inArray, sql } from "drizzle-orm";
import * as reviewRuleRepo from "../repositories/reviewRule.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import {
  appendReviewDecisionWithClient,
  getRequirementWithClient,
  getSnapshotWithClient,
  projectReviewersWithClient,
  projectedPendingCountByReviewer,
  evaluateFinalityWithClient,
} from "../repositories/reviewSafety.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
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
      // Typed workload (B3): the EFFECTIVE current-generation projection —
      // stale rows on advanced generations do not inflate workload.
      pendingReviewCount: projectedPendingCountByReviewer(getDb(), u.id, "human"),
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
    default: {
      return reviewers[0];
    }
  }
}

/** Outcome of {@link assignReviewers}: the reviewers created, or a skip flag with a machine-readable reason when none were assigned. */
export interface AssignReviewersResult {
  assigned: Array<{ reviewerId: string; reviewerName: string; reviewerType: "human" | "agent" }>;
  skipped: boolean;
  reason?: string;
}

/**
 * `domain_expert` selection: agent reviewers from the global live registry
 * whose `domain` exactly matches the task's CURRENT `requiredDomain` —
 * never a human pick, no team-pool involvement, no fullstack wildcard.
 *
 * Slot accounting (E): existing agent rows count toward `requiredReviews`
 * only when their live registry agent still exact-matches the CURRENT
 * domain and is not the current assignee (any row status). Deleted-agent,
 * other-domain, and assignee rows stay untouched completion requirements
 * that never fulfill a domain slot. Existing rows of any type are never
 * re-picked (type-blind collision skip). Ordering: non-offline before
 * offline (preference, never admission), least agent-typed pending
 * reviews, `createdAt` DESC, `id` ASC.
 */
function assignDomainExpertReviewers(taskId: string, rule: ReviewRule): AssignReviewersResult {
  // BEGIN IMMEDIATE (native drizzle transaction helper, `behavior: "immediate"`
  // — better-sqlite3 `.immediate()` / sql.js `begin immediate` alike): the
  // ENTIRE read(task/E/pool) + insert phase runs as one write-locked unit.
  // Under the acknowledged multi-process deployment shape (submit racing
  // automation `request_review`), a second assigner's BEGIN IMMEDIATE waits
  // (busy_timeout) and then re-reads post-commit state — fresh E, fresh
  // taken-set — instead of over-filling slots on stale counts. No caller
  // wraps this in an outer transaction (verified at all three call sites),
  // so top-level immediate transactions nest nowhere; repository reads and
  // writes inside the callback share the same connection as the transaction.
  // No awaits inside — synchronous SQLite only.
  return getDb().transaction((_tx) => assignDomainExpertReviewersLocked(taskId, rule), {
    behavior: "immediate",
  });
}

function assignDomainExpertReviewersLocked(
  taskId: string,
  rule: ReviewRule,
): AssignReviewersResult {
  const task = taskRepo.getTaskById(taskId);
  const domain = task?.requiredDomain;
  if (!task || !domain) {
    // No resolvable domain → the agent pool can never match → no assignment.
    return { assigned: [], skipped: true, reason: "no_eligible_reviewers" };
  }

  // Existing rows: slot accounting (E) + the type-blind duplicate guard.
  const existingRows = taskReviewerRepo.getByTaskId(taskId);
  const taken = new Set(existingRows.map((row) => row.reviewerId));

  let existingDomainSlots = 0;
  const requirement = getRequirementWithClient(getDb(), taskId);
  const projection = requirement
    ? projectReviewersWithClient(getDb(), taskId, requirement)
    : [];
  for (const row of existingRows) {
    if (row.reviewerType !== "agent") continue;
    if (row.reviewerId === task.assignedAgentId) continue;
    const agent = agentRepo.getAgentById(row.reviewerId);
    if (!agent || agent.domain !== domain) continue;
    // B3: occupancy is the effective projection — a slot whose latest
    // current-generation decision is a rejection does not occupy (it needs
    // replacement), while pending/uncredited slots do.
    const p = projection.find(
      (x) => x.reviewerType === "agent" && x.reviewerId === row.reviewerId,
    );
    if (p && (p.projected === "pending" || p.projected === "approved")) existingDomainSlots++;
  }

  const remaining = Math.max(0, rule.requiredReviews - existingDomainSlots);
  if (remaining === 0) {
    return { assigned: [], skipped: true, reason: "no_reviewer_selected" };
  }

  const pool = agentRepo
    .listAgents()
    .filter((a) => a.domain === domain && a.id !== task.assignedAgentId)
    .toSorted((a, b) => {
      if ((a.status === "offline") !== (b.status === "offline")) {
        return a.status === "offline" ? 1 : -1;
      }
      const pendingDiff =
        projectedPendingCountByReviewer(getDb(), a.id, "agent") -
        projectedPendingCountByReviewer(getDb(), b.id, "agent");
      if (pendingDiff !== 0) return pendingDiff;
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? -1 : 1;
    });

  const assigned: AssignReviewersResult["assigned"] = [];
  for (const agent of pool) {
    if (assigned.length >= remaining) break;
    if (taken.has(agent.id)) continue;
    const createdRow = taskReviewerRepo.create(taskId, "agent", agent.id);
    taken.add(agent.id);
    assigned.push({
      reviewerId: agent.id,
      reviewerName: agent.name,
      reviewerType: createdRow.reviewerType,
    });
  }

  if (assigned.length === 0) {
    return {
      assigned: [],
      skipped: true,
      reason: pool.length === 0 ? "no_eligible_reviewers" : "no_reviewer_selected",
    };
  }

  logger.info(
    {
      taskId,
      habitatId: rule.habitatId,
      assignedCount: assigned.length,
      ruleName: rule.name,
    },
    "Reviewers assigned",
  );
  return { assigned, skipped: false };
}

/**
 * Assigns reviewers to a task by applying the first matching {@link ReviewRule}'s {@link ReviewRuleStrategy} while honoring `antiSelfReview` and the supplied exclusion; side effect: creates taskReviewer rows and logs the assignment count.
 *
 * `domain_expert` routes to {@link assignDomainExpertReviewers} (the global
 * live agent registry by exact domain match) before any human team-pool
 * logic runs; every other strategy keeps the human team-pool behavior.
 */
export function assignReviewers(
  taskId: string,
  habitatId: string,
  excludeReviewerId?: string,
): AssignReviewersResult {
  // Review-safety cutover: allocation reads the FROZEN winning claim rule
  // (immutable snapshot evidence), never a re-match against today's mutable
  // rules — post-claim rule edits are future-facing only and can neither
  // raise nor lower the captured requirement. Tasks without a requirement
  // row (legacy/test fixtures that never claimed through the kernel) keep
  // the historical re-match behavior.
  const db = getDb();
  const requirement = getRequirementWithClient(db, taskId);
  const snapshot = requirement
    ? getSnapshotWithClient(db, taskId, requirement.reviewGeneration)
    : null;

  let primaryRule: ReviewRule;
  if (requirement && snapshot) {
    if (!snapshot.matched) {
      return { assigned: [], skipped: true, reason: "no_matching_rules" };
    }
    primaryRule = {
      id: snapshot.ruleId ?? "snapshot",
      habitatId,
      name: "claim-snapshot",
      enabled: 1,
      priority: snapshot.rulePriority ?? 0,
      matchDomain: snapshot.ruleMatchDomain ?? null,
      matchLabels: (snapshot.ruleMatchLabels ?? []) as string[],
      matchPriority: snapshot.ruleMatchPriority ?? null,
      assignmentStrategy: (snapshot.ruleAssignmentStrategy ?? "domain_expert") as ReviewRuleStrategy,
      requiredReviews: snapshot.requiredCount,
      antiSelfReview: snapshot.ruleAntiSelfReview ?? 1,
      fixedReviewerIds: (snapshot.ruleFixedReviewerIds ?? []) as string[],
      createdAt: snapshot.capturedAt,
      updatedAt: snapshot.ruleUpdatedAt ?? snapshot.capturedAt,
    };
  } else {
    const matchedRules = matchRules(taskId, habitatId);
    if (matchedRules.length === 0) {
      return { assigned: [], skipped: true, reason: "no_matching_rules" };
    }
    primaryRule = matchedRules[0];
  }

  if (primaryRule.assignmentStrategy === "domain_expert") {
    return assignDomainExpertReviewers(taskId, primaryRule);
  }

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

  const assigned: AssignReviewersResult["assigned"] = [];
  const reviewsNeeded = primaryRule.requiredReviews;

  // Fixup-2 blocker 3: slots are filled with DIFFERENT eligible identities —
  // a candidate already holding a typed row (any status, incl. a rejected
  // veto slot whose history must be retained) is filtered BEFORE selection,
  // so a duplicate pick can never consume a required slot; when no fresh
  // identity remains the allocation stops and finality stays blocked on the
  // retained veto (authorized removal/rework is the repair path).
  for (let i = 0; i < reviewsNeeded; i++) {
    const remaining = eligible.filter(
      (e) =>
        !assigned.some((a) => a.reviewerId === e.id) &&
        // Typed dedupe BEFORE selection: only a human row excludes a human
        // candidate (an agent row sharing the id string is a different
        // reviewer).
        !taskReviewerRepo.findByTaskAndReviewer(taskId, e.id, "human"),
    );
    if (remaining.length === 0) break;

    const selected = selectReviewer(
      remaining,
      primaryRule.assignmentStrategy,
      habitatId,
      primaryRule.fixedReviewerIds,
    );
    if (!selected) break;
    const createdRow = taskReviewerRepo.create(taskId, "human", selected.id);
    assigned.push({
      reviewerId: selected.id,
      reviewerName: selected.displayName || selected.username,
      reviewerType: createdRow.reviewerType,
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
 * Returns whether the given reviewer (typed identity) is registered on the task.
 * With `reviewerType`, a row of the other type is not this reviewer's row.
 */
export function isAssignedReviewer(
  taskId: string,
  reviewerId: string,
  reviewerType?: "human" | "agent",
): boolean {
  return taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId, reviewerType) !== null;
}

/**
 * Returns whether the agent's reviewer slot ADMITS a fresh decision — the
 * effective-assignment projection, never raw row status alone. A pending
 * projection (unassigned slot, older-round rejection superseded by rework, or
 * an uncredited legacy raw approval) admits; a current-round rejection, a
 * still-current legacy raw rejection (generation 0 veto) and the typed
 * current claimant's own slot do not.
 */
export function hasPendingAgentReviewerRow(taskId: string, reviewerId: string): boolean {
  const db = getDb();
  const requirement = getRequirementWithClient(db, taskId);
  if (!requirement) {
    // No requirement row (unknown): fall back to the raw pending-row check —
    // never admit on an ambiguous state, preserving the pre-cutover default.
    const row = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId, "agent");
    return row !== null && row.status === "pending";
  }
  const projected = projectReviewersWithClient(db, taskId, requirement).find(
    (p) => p.reviewerType === "agent" && p.reviewerId === reviewerId,
  );
  return projected?.projected === "pending";
}

/**
 * Marks the reviewer's taskReviewer row as approved (idempotent when already approved); side effect: persists the status update and returns false when the reviewer row does not exist.
 * `reviewerType` scopes the lookup to the caller's registry — a row of the
 * other type is never the caller's row (no id coercion).
 */
export function recordApproval(
  taskId: string,
  reviewerId: string,
  reviewerType?: "human" | "agent",
): boolean {
  const reviewer = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId, reviewerType);
  if (!reviewer) return false;
  if (reviewer.status === "approved") return true; // already approved, idempotent
  taskReviewerRepo.updateStatus(reviewer.id, "approved");
  // Review safety: the raw row flip is UI compatibility only — the durable
  // credit is the append-only generation-tagged decision.
  const db = getDb();
  const requirement = getRequirementWithClient(db, taskId);
  if (requirement) {
    appendReviewDecisionWithClient(db, {
      taskId,
      reviewGeneration: requirement.reviewGeneration,
      reviewRound: requirement.reviewRound,
      reviewerType: reviewer.reviewerType as "human" | "agent",
      reviewerId,
      decision: "approved",
      actorType: reviewer.reviewerType as "human" | "agent",
      actorId: reviewerId,
    });
  }
  return true;
}

/**
 * Returns whether the task's review requirement is fully satisfied — the
 * durable requirement + effective projection decide, never raw row status
 * alone. An empty assignment set passes only when the captured requirement
 * is genuine known-zero (or no requirement exists yet — legacy fallback to
 * the old all-approved-row behavior).
 */
export function hasAllRequiredApprovals(taskId: string, _requiredCount?: number): boolean {
  const db = getDb();
  const requirement = getRequirementWithClient(db, taskId);
  if (!requirement) {
    const reviewers = taskReviewerRepo.getByTaskId(taskId);
    if (reviewers.length === 0) return true;
    const approvedCount = reviewers.filter((r) => r.status === "approved").length;
    const pendingCount = reviewers.filter((r) => r.status === "pending").length;
    if (pendingCount > 0) return false;
    return approvedCount >= reviewers.length;
  }
  return evaluateFinalityWithClient(db, taskId).eligible;
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
export function wouldCompleteReview(
  taskId: string,
  reviewerId: string,
  reviewerType?: "human" | "agent",
): boolean {
  const reviewers = taskReviewerRepo.getByTaskId(taskId);
  if (reviewers.length === 0) return true;

  const reviewer = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId, reviewerType);
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
  /**
   * Machine-readable admission refusal from the in-transaction recheck —
   * non-null when the decision was refused under the write lock (never
   * together with `recorded: true`):
   *   not_assigned — no reviewer row for this typed identity
   *   not_pending  — agent decisions require a still-pending row
   *   self_review  — typed anti-self: agent reviewer is the current assignee
   */
  refusedFor?: "not_assigned" | "not_pending" | "self_review";
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
  reviewerType: "human" | "agent",
  runPreVetoIfFinal: () => { allow: false; reason: string; details?: string } | null,
): FinalApprovalGateResult {
  const db = getDb();

  db.run(sql`BEGIN IMMEDIATE`);
  try {
    // Decision-time revalidation under the same write lock as the finality
    // decision (prehandler checks alone do not suffice): typed identity,
    // pending-only agent admission, and the typed anti-self check against
    // the CURRENT assignee — a release/reclaim that raced the precheck
    // cannot turn into an approval decided on stale state.
    const row = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId, reviewerType);
    if (!row) {
      db.run(sql`COMMIT`);
      return { recorded: false, wasFinal: false, veto: null, refusedFor: "not_assigned" };
    }
    if (reviewerType === "agent" && row.status !== "pending") {
      db.run(sql`COMMIT`);
      return { recorded: false, wasFinal: false, veto: null, refusedFor: "not_pending" };
    }
    if (reviewerType === "agent") {
      const current = taskRepo.getTaskById(taskId);
      if (current && current.assignedAgentId === reviewerId) {
        db.run(sql`COMMIT`);
        return { recorded: false, wasFinal: false, veto: null, refusedFor: "self_review" };
      }
    }

    const wouldBeFinal = wouldCompleteReview(taskId, reviewerId, reviewerType);

    if (wouldBeFinal) {
      const veto = runPreVetoIfFinal();
      if (veto) {
        // COMMIT preserves Plugin Run telemetry from the vetoed pre-veto.
        // The approval was never recorded — reviewer can retry.
        db.run(sql`COMMIT`);
        return { recorded: false, wasFinal: true, veto };
      }
    }

    const recorded = recordApproval(taskId, reviewerId, reviewerType);
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
