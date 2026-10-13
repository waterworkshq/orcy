/**
 * Review-governance command service (first operational consumer of the local
 * authorization foundation).
 *
 * Migrated HTTP management operations:
 *   - review-rule PATCH/DELETE (review.configure, target Habitat)
 *   - task reviewer add/remove (review.assign, target Task)
 *
 * Every command runs under ONE BEGIN IMMEDIATE reservation performing, in
 * order: target existence → typed-identity persistence check → evaluator
 * authorization → optional CAS (rule expectedVersion / reviewersToken) →
 * mutation → audit append. Any failure rolls the whole command back.
 *
 * Compatibility (binding addendum, user decision):
 *   - Omitted expectations retain existing last-write-wins behavior.
 *   - Supplied expectations are compared BEFORE the mutation; mismatch is a
 *     409 conflict with no state change.
 *   - Authority (transaction-time) and typed independence are ALWAYS
 *     mandatory regardless of CAS.
 *
 * Preserved (never relabeled): internal allocation writers
 * (reviewAssignmentService strategy assigners), automation request_review
 * (automationExecutor), finality/rework status writers (reviewFinalityService),
 * and callerless removeAllForTask. The roster token is derived from actual
 * rows and projected state, so their effects are visible without counter
 * increments on their paths.
 *
 * House pattern: all mutations run on the CALLER's tx client (see
 * repositories/reviewSafety.ts and roleFoundation.ts). The legacy
 * getDb()-bound repository functions are never called inside these
 * reservations — that would write outside the transaction.
 */
import { createHash } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import { getDb } from "../db/index.js";
import { AppError } from "../errors.js";
import {
  agents,
  reviewRules,
  tasks,
  taskReviewers,
  users,
} from "../db/schema/index.js";
import type { ReviewRule, TaskReviewer } from "@orcy/shared";
import {
  getRequirementWithClient,
  projectReviewersWithClient,
} from "../repositories/reviewSafety.js";
import {
  authorizeWithClient,
  resolveScopeChainWithClient,
  type AuthorizationTarget,
  type LocalAuthorizationDbClient,
  type LocalPrincipal,
} from "./localAuthorization.js";
import {
  appendGovernanceAuditWithClient,
  materializeScopeWithClient,
  readScopeForWriterWithClient,
} from "../repositories/roleFoundation.js";

type Db = LocalAuthorizationDbClient;

// ---------------------------------------------------------------------------
// Errors — exact wire codes
// ---------------------------------------------------------------------------

const notFoundError = (what: string) => new AppError(404, "NOT_FOUND", `${what} not found`);
const deniedError = () => new AppError(403, "AUTHORIZATION_DENIED", "Authorization denied");
const ruleVersionConflict = () =>
  new AppError(409, "REVIEW_RULE_VERSION_CONFLICT", "Review rule version conflict");
const reviewersTokenConflict = () =>
  new AppError(409, "REVIEWERS_TOKEN_CONFLICT", "Reviewer roster changed since token was issued");

// ---------------------------------------------------------------------------
// Roster token — deterministic SHA-256 over the actual current state
// ---------------------------------------------------------------------------
//
// Covers: task ID, requirement (missing/state/generation/round/version),
// every actual reviewer row (typed identity + raw status) with its current
// projected status. Sorted by typed identity then row id.
//
// ABA limitation (disclosed, not hidden): if the entire recorded state
// genuinely returns to identical values, the token matches again. The
// authority check reads the current state at the write, so a coincidental
// token match cannot bypass it.
export function computeReviewersToken(
  tx: Db,
  taskId: string,
  preRead?: {
    rows: ReturnType<Db["select"]> extends never ? never : unknown[];
    requirement: ReturnType<typeof getRequirementWithClient>;
    projected: ReturnType<typeof projectReviewersWithClient>;
  },
): string {
  let rows: unknown[];
  let requirement: ReturnType<typeof getRequirementWithClient>;
  let projected: ReturnType<typeof projectReviewersWithClient>;
  if (preRead) {
    rows = preRead.rows;
    requirement = preRead.requirement;
    projected = preRead.projected;
  } else {
    rows = tx
      .select()
      .from(taskReviewers)
      .where(eq(taskReviewers.taskId, taskId))
      .all();
    requirement = getRequirementWithClient(tx, taskId);
    projected = requirement
      ? projectReviewersWithClient(tx, taskId, requirement)
      : [];
  }

  const entries = (rows as TaskReviewer[]).map((row) => {
    const p = projected.find(
      (x) => x.reviewerType === row.reviewerType && x.reviewerId === row.reviewerId,
    );
    return {
      id: row.id,
      type: row.reviewerType,
      reviewerId: row.reviewerId,
      raw: row.status,
      projected: p?.projected ?? row.status,
    };
  });
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type < b.type ? -1 : 1;
    if (a.reviewerId !== b.reviewerId) return a.reviewerId < b.reviewerId ? -1 : 1;
    return a.id < b.id ? -1 : 1;
  });

  const payload = {
    taskId,
    requirement: requirement
      ? {
          state: requirement.state,
          generation: requirement.reviewGeneration,
          round: requirement.reviewRound,
          version: requirement.requirementVersion,
        }
      : null,
    rows: entries,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

// ---------------------------------------------------------------------------
// Actor resolution — typed identity from request context
// ---------------------------------------------------------------------------

export interface CommandActor {
  type: "human" | "agent";
  id: string;
}

/**
 * Resolves the typed actor for a command from Fastify request context.
 * Humans: request.user (JWT). Agents: request.agent (API key).
 * Throws 401 when neither is present.
 */
export function resolveCommandActor(
  request: {
    user?: { id: string } | null;
    agent?: { id: string } | null;
  },
): CommandActor {
  if (request.agent) return { type: "agent", id: request.agent.id };
  if (request.user) return { type: "human", id: request.user.id };
  throw new AppError(401, "UNAUTHORIZED", "Authentication required");
}

function toPrincipal(actor: CommandActor): LocalPrincipal {
  return actor.type === "human"
    ? { type: "human", id: actor.id }
    : { type: "agent", id: actor.id };
}

/**
 * Scope-identity read for the audit record: materialize the never-materialized
 * live scope (one active incarnation at virtual 1/1) and return the recorded
 * (incarnation, version) pair. A RETIRED scope is an internal fault — a retired
 * resource cannot be mutated — and refuses loudly.
 */
function readScopeIdentityForWriter(
  db: Db,
  scopeKind: "habitat" | "task",
  scopeId: string,
): { incarnation: number; version: number } {
  const read = readScopeForWriterWithClient(db, scopeKind, scopeId);
  if (read.kind === "missing") throw notFoundError("Governance scope");
  if (read.kind === "retired") {
    throw new AppError(409, "RETIRED_SCOPE", "Governance scope is retired");
  }
  if (read.kind === "active" && !read.materialized) {
    materializeScopeWithClient(db, scopeKind, scopeId);
    return { incarnation: 1, version: 1 };
  }
  return { incarnation: read.incarnation, version: read.version };
}

function audit(
  db: Db,
  input: {
    actor: CommandActor;
    operation: string;
    scopeKind: "habitat" | "task";
    scopeId: string;
    objectKind: string;
    objectId: string;
    incarnation: number;
    versionBefore: number | null;
    versionAfter: number | null;
    details?: Record<string, unknown>;
  },
): void {
  appendGovernanceAuditWithClient(db, {
    id: uuid(),
    actorType: input.actor.type,
    actorId: input.actor.id,
    operation: input.operation,
    scopeKind: input.scopeKind,
    scopeId: input.scopeId,
    scopeIncarnation: input.incarnation,
    objectKind: input.objectKind,
    objectId: input.objectId,
    versionBefore: input.versionBefore,
    versionAfter: input.versionAfter,
    details: input.details ?? {},
  });
}

// ---------------------------------------------------------------------------
// Review-rule commands (review.configure)
// ---------------------------------------------------------------------------

export interface RuleCreateInput {
  habitatId: string;
  actor: CommandActor;
  /** Partial rule fields (Zod-parsed at the route). */
  fields: Partial<ReviewRule>;
}

/**
 * POST /habitats/:habitatId/review-rules.
 *
 * Creation has no prior object to CAS — the new row starts at version 1
 * (the addendum's "no prior object" clause governs CAS-optional only).
 * Same reservation shape as update: habitat existence → ancestry → evaluator
 * authorization → insert → audit. The insert rides the command's own
 * reservation rather than the legacy getDb()-bound repository create.
 */
export function createRuleCommand(input: RuleCreateInput): ReviewRule {
  const principal = toPrincipal(input.actor);

  return getDb().transaction(
    (tx) => {
      const db = tx as unknown as Db;

      const chain = resolveScopeChainWithClient(db, "habitat", input.habitatId);
      if (!chain) throw notFoundError("Habitat");

      const target: AuthorizationTarget = { scopeKind: "habitat", scopeId: input.habitatId };
      const allowed = authorizeWithClient(db, principal, "review.configure", target);
      if (!allowed) throw deniedError();

      const id = uuid();
      const now = new Date().toISOString();
      const source = input.fields;
      db.insert(reviewRules)
        .values({
          id,
          habitatId: input.habitatId,
          name: source.name ?? "",
          enabled: source.enabled ?? 1,
          priority: source.priority ?? 0,
          matchDomain: source.matchDomain ?? null,
          matchLabels: source.matchLabels ?? [],
          matchPriority: source.matchPriority ?? null,
          assignmentStrategy: source.assignmentStrategy ?? "domain_expert",
          requiredReviews: source.requiredReviews ?? 1,
          antiSelfReview: source.antiSelfReview ?? 1,
          fixedReviewerIds: source.fixedReviewerIds ?? [],
          createdAt: now,
          updatedAt: now,
        })
        .run();

      const created = db
        .select()
        .from(reviewRules)
        .where(eq(reviewRules.id, id))
        .get() as unknown as ReviewRule;

      const scope = readScopeIdentityForWriter(db, "habitat", input.habitatId);
      audit(db, {
        actor: input.actor,
        operation: "review_rule.create",
        scopeKind: "habitat",
        scopeId: input.habitatId,
        objectKind: "review_rule",
        objectId: id,
        incarnation: scope.incarnation,
        versionBefore: null,
        versionAfter: created.version,
        details: {},
      });

      return created;
    },
    { behavior: "immediate" },
  );
}

export interface RuleUpdateInput {
  ruleId: string;
  actor: CommandActor;
  /** Supplied expectation; omitted = legacy LWW. */
  expectedVersion?: number;
  /** Partial rule fields (Zod-parsed at the route). */
  fields: Partial<ReviewRule>;
}

/**
 * PATCH /review-rules/:id.
 *
 * Reservation order: rule existence → habitat ancestry → evaluator
 * authorization (review.configure on the Habitat target) → optional CAS →
 * native SQL increment update (version = version + 1, the single code path
 * every rule-update writer goes through) → audit.
 */
export function updateRuleCommand(input: RuleUpdateInput): ReviewRule {
  const principal = toPrincipal(input.actor);

  return getDb().transaction(
    (tx) => {
      const db = tx as unknown as Db;
      const ruleRow = db
        .select()
        .from(reviewRules)
        .where(eq(reviewRules.id, input.ruleId))
        .get() as unknown as ReviewRule | undefined;
      if (!ruleRow) throw notFoundError("Review rule");

      const habitatId = ruleRow.habitatId;
      const chain = resolveScopeChainWithClient(db, "habitat", habitatId);
      if (!chain) throw notFoundError("Habitat");

      const target: AuthorizationTarget = { scopeKind: "habitat", scopeId: habitatId };
      const allowed = authorizeWithClient(db, principal, "review.configure", target);
      if (!allowed) throw deniedError();

      const currentVersion = ruleRow.version;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw ruleVersionConflict();
      }

      const values: Record<string, unknown> = { updatedAt: new Date().toISOString() };
      const source = input.fields;
      if (source.name !== undefined) values.name = source.name;
      if (source.enabled !== undefined) values.enabled = source.enabled;
      if (source.priority !== undefined) values.priority = source.priority;
      if (source.matchDomain !== undefined) values.matchDomain = source.matchDomain;
      if (source.matchLabels !== undefined) values.matchLabels = source.matchLabels;
      if (source.matchPriority !== undefined) values.matchPriority = source.matchPriority;
      if (source.assignmentStrategy !== undefined)
        values.assignmentStrategy = source.assignmentStrategy;
      if (source.requiredReviews !== undefined) values.requiredReviews = source.requiredReviews;
      if (source.antiSelfReview !== undefined) values.antiSelfReview = source.antiSelfReview;
      if (source.fixedReviewerIds !== undefined) values.fixedReviewerIds = source.fixedReviewerIds;

      // Native increment — a read-derived value would collapse under two
      // concurrent writers observing the same prior version.
      db.update(reviewRules)
        .set({ ...values, version: sql`${reviewRules.version} + 1` } as never)
        .where(eq(reviewRules.id, input.ruleId))
        .run();

      const updated = db
        .select()
        .from(reviewRules)
        .where(eq(reviewRules.id, input.ruleId))
        .get() as unknown as ReviewRule;

      const scope = readScopeIdentityForWriter(db, "habitat", habitatId);
      audit(db, {
        actor: input.actor,
        operation: "review_rule.update",
        scopeKind: "habitat",
        scopeId: habitatId,
        objectKind: "review_rule",
        objectId: input.ruleId,
        incarnation: scope.incarnation,
        versionBefore: currentVersion,
        versionAfter: updated.version,
        details: {
          suppliedExpectedVersion: input.expectedVersion ?? null,
        },
      });

      return updated;
    },
    { behavior: "immediate" },
  );
}

export interface RuleDeleteInput {
  ruleId: string;
  actor: CommandActor;
  expectedVersion?: number;
}

/**
 * DELETE /review-rules/:id. Same reservation shape as update; deletion never
 * carries a version bump (the row is gone).
 */
export function deleteRuleCommand(input: RuleDeleteInput): void {
  const principal = toPrincipal(input.actor);

  getDb().transaction(
    (tx) => {
      const db = tx as unknown as Db;
      const ruleRow = db
        .select()
        .from(reviewRules)
        .where(eq(reviewRules.id, input.ruleId))
        .get() as unknown as ReviewRule | undefined;
      if (!ruleRow) throw notFoundError("Review rule");

      const habitatId = ruleRow.habitatId;
      const chain = resolveScopeChainWithClient(db, "habitat", habitatId);
      if (!chain) throw notFoundError("Habitat");

      const target: AuthorizationTarget = { scopeKind: "habitat", scopeId: habitatId };
      const allowed = authorizeWithClient(db, principal, "review.configure", target);
      if (!allowed) throw deniedError();

      const currentVersion = ruleRow.version;
      if (input.expectedVersion !== undefined && input.expectedVersion !== currentVersion) {
        throw ruleVersionConflict();
      }

      db.delete(reviewRules).where(eq(reviewRules.id, input.ruleId)).run();

      const scope = readScopeIdentityForWriter(db, "habitat", habitatId);
      audit(db, {
        actor: input.actor,
        operation: "review_rule.delete",
        scopeKind: "habitat",
        scopeId: habitatId,
        objectKind: "review_rule",
        objectId: input.ruleId,
        incarnation: scope.incarnation,
        versionBefore: currentVersion,
        versionAfter: null,
        details: {
          suppliedExpectedVersion: input.expectedVersion ?? null,
        },
      });
    },
    { behavior: "immediate" },
  );
}

// ---------------------------------------------------------------------------
// Reviewer add/remove commands (review.assign)
// ---------------------------------------------------------------------------

/**
 * Shared pre-checks for reviewer add: task existence, ancestry, evaluator
 * authorization, typed persistence and anti-self for agent rows, and the
 * optional roster token CAS (BEFORE any duplicate fast path or mutation).
 * Returns the reservation db client for the caller to continue on.
 */
function reviewerPrecheck(
  db: Db,
  input: {
    taskId: string;
    reviewerId: string;
    reviewerType: "human" | "agent";
    actor: CommandActor;
    expectedReviewersToken?: string;
  },
): TaskReviewer | null {
  const taskRow = db
    .select({ id: tasks.id, assignedAgentId: tasks.assignedAgentId })
    .from(tasks)
    .where(eq(tasks.id, input.taskId))
    .get();
  if (!taskRow) throw notFoundError("Task");

  const chain = resolveScopeChainWithClient(db, "task", input.taskId);
  if (!chain) throw notFoundError("Task ancestry");

  const target: AuthorizationTarget = { scopeKind: "task", scopeId: input.taskId };
  const allowed = authorizeWithClient(db, toPrincipal(input.actor), "review.assign", target);
  if (!allowed) throw deniedError();

  // Management own-Task denial (binding L18): the acting typed agent who IS
  // the task's current typed executor may not manage that task's roster —
  // typed identity comparison, distinct from the reviewer-target anti-self
  // checked below.
  if (input.actor.type === "agent" && taskRow.assignedAgentId === input.actor.id) {
    throw deniedError();
  }

  if (input.expectedReviewersToken !== undefined) {
    const current = computeReviewersToken(db, input.taskId);
    if (current !== input.expectedReviewersToken) throw reviewersTokenConflict();
  }

  if (input.reviewerType === "agent") {
    const agent = db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, input.reviewerId))
      .get();
    if (!agent) {
      throw new AppError(
        400,
        "BAD_REQUEST",
        `Reviewer "${input.reviewerId}" not found in the agent registry`,
      );
    }
    // Typed anti-self: an agent row may not name the task's current assignee.
    if (taskRow.assignedAgentId === input.reviewerId) {
      throw new AppError(
        400,
        "BAD_REQUEST",
        "Agent reviewer cannot be the task's current assignee (self-review)",
      );
    }
  } else {
    const user = db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.id, input.reviewerId))
      .get();
    if (!user) {
      throw new AppError(
        400,
        "BAD_REQUEST",
        `Reviewer "${input.reviewerId}" not found in the user registry`,
      );
    }
  }

  const existing = db
    .select()
    .from(taskReviewers)
    .where(
      and(
        eq(taskReviewers.taskId, input.taskId),
        eq(taskReviewers.reviewerId, input.reviewerId),
      ),
    )
    .get() as unknown as TaskReviewer | null;
  return existing;
}

export interface ReviewerAddInput {
  taskId: string;
  reviewerId: string;
  reviewerType: "human" | "agent";
  actor: CommandActor;
  expectedReviewersToken?: string;
}

/**
 * POST /tasks/:taskId/reviewers (add).
 *
 * Duplicate semantics preserved exactly: same typed identity returns the
 * existing row (200, idempotent, no new row); cross-type is 409. The token
 * CAS runs before the duplicate fast path — it is a concurrency expectation
 * on the prior state, not a substitute for authority.
 */
export function addReviewerCommand(input: ReviewerAddInput): {
  reviewer: TaskReviewer;
  token: string;
  duplicate: boolean;
} {
  return getDb().transaction(
    (tx) => {
      const db = tx as unknown as Db;
      const existing = reviewerPrecheck(db, input);

      if (existing && existing.reviewerType === input.reviewerType) {
        const token = computeReviewersToken(db, input.taskId);
        const scope = readScopeIdentityForWriter(db, "task", input.taskId);
        audit(db, {
          actor: input.actor,
          operation: "reviewer.add_duplicate",
          scopeKind: "task",
          scopeId: input.taskId,
          objectKind: "reviewer_assignment",
          objectId: existing.id,
          incarnation: scope.incarnation,
          versionBefore: null,
          versionAfter: null,
          details: { reviewerType: existing.reviewerType, duplicate: true },
        });
        return { reviewer: existing, token, duplicate: true };
      }
      if (existing) {
        throw new AppError(
          409,
          "REVIEWER_TYPE_CONFLICT",
          `Reviewer "${input.reviewerId}" is already assigned as type "${existing.reviewerType}"`,
        );
      }

      const id = uuid();
      const now = new Date().toISOString();
      db.insert(taskReviewers)
        .values({
          id,
          taskId: input.taskId,
          reviewerType: input.reviewerType,
          reviewerId: input.reviewerId,
          status: "pending",
          assignedAt: now,
          reviewedAt: null,
          reviewNote: null,
        })
        .run();
      const created = db
        .select()
        .from(taskReviewers)
        .where(eq(taskReviewers.id, id))
        .get() as unknown as TaskReviewer;

      const token = computeReviewersToken(db, input.taskId);
      const scope = readScopeIdentityForWriter(db, "task", input.taskId);
      audit(db, {
        actor: input.actor,
        operation: "reviewer.add",
        scopeKind: "task",
        scopeId: input.taskId,
        objectKind: "reviewer_assignment",
        objectId: id,
        incarnation: scope.incarnation,
        versionBefore: null,
        versionAfter: null,
        details: {
          reviewerId: input.reviewerId,
          reviewerType: input.reviewerType,
          suppliedToken: input.expectedReviewersToken ?? null,
        },
      });

      return { reviewer: created, token, duplicate: false };
    },
    { behavior: "immediate" },
  );
}

export interface ReviewerRemoveInput {
  taskId: string;
  reviewerId: string;
  actor: CommandActor;
  expectedReviewersToken?: string;
}

/**
 * DELETE /tasks/:taskId/reviewers/:reviewerId.
 *
 * Removal never lowers the durable floor or deletes decision history — it
 * only removes the live assignment row (existing shipped semantics).
 */
export function removeReviewerCommand(input: ReviewerRemoveInput): { token: string } {
  return getDb().transaction(
    (tx) => {
      const db = tx as unknown as Db;

      const taskRow = db
        .select({ id: tasks.id, assignedAgentId: tasks.assignedAgentId })
        .from(tasks)
        .where(eq(tasks.id, input.taskId))
        .get();
      if (!taskRow) throw notFoundError("Task");

      const chain = resolveScopeChainWithClient(db, "task", input.taskId);
      if (!chain) throw notFoundError("Task ancestry");

      const target: AuthorizationTarget = { scopeKind: "task", scopeId: input.taskId };
      const allowed = authorizeWithClient(db, toPrincipal(input.actor), "review.assign", target);
      if (!allowed) throw deniedError();

      // Management own-Task denial (binding L18) — same as add.
      if (input.actor.type === "agent" && taskRow.assignedAgentId === input.actor.id) {
        throw deniedError();
      }

      if (input.expectedReviewersToken !== undefined) {
        const current = computeReviewersToken(db, input.taskId);
        if (current !== input.expectedReviewersToken) throw reviewersTokenConflict();
      }

      const reviewer = db
        .select()
        .from(taskReviewers)
        .where(
          and(
            eq(taskReviewers.taskId, input.taskId),
            eq(taskReviewers.reviewerId, input.reviewerId),
          ),
        )
        .get() as unknown as TaskReviewer | null;
      if (!reviewer) throw notFoundError("Reviewer assignment");

      db.delete(taskReviewers).where(eq(taskReviewers.id, reviewer.id)).run();

      const token = computeReviewersToken(db, input.taskId);
      const scope = readScopeIdentityForWriter(db, "task", input.taskId);
      audit(db, {
        actor: input.actor,
        operation: "reviewer.remove",
        scopeKind: "task",
        scopeId: input.taskId,
        objectKind: "reviewer_assignment",
        objectId: reviewer.id,
        incarnation: scope.incarnation,
        versionBefore: null,
        versionAfter: null,
        details: {
          reviewerId: input.reviewerId,
          reviewerType: reviewer.reviewerType,
          suppliedToken: input.expectedReviewersToken ?? null,
        },
      });

      return { token };
    },
    { behavior: "immediate" },
  );
}

// ---------------------------------------------------------------------------
// Reviewer GET — roster + token (no materialization, pure read)
// ---------------------------------------------------------------------------

export interface ReviewerListing {
  reviewers: TaskReviewer[];
  token: string;
}

/**
 * GET /tasks/:taskId/reviewers. Preserves the shipped merge of raw rows and
 * projected status; adds the deterministic roster token. Reads only — an
 * authorized read never creates ledger rows.
 */
export function listReviewersWithToken(
  taskId: string,
  habitatId: string,
  db: Db = getDb() as unknown as Db,
): ReviewerListing {
  // ONE consistent read transaction: the served roster view AND the served
  // token derive from the same single read of rows + requirement +
  // projection, so they cannot describe different states (a fresh re-read
  // inside this function would be a second autocommit snapshot).
  return db.transaction(() => {
    const rows = db
      .select()
      .from(taskReviewers)
      .where(eq(taskReviewers.taskId, taskId))
      .all() as unknown as TaskReviewer[];

    const requirement = getRequirementWithClient(db, taskId);
    const projected = requirement
      ? projectReviewersWithClient(db, taskId, requirement)
      : [];
    const merged = rows.map((row) => {
      const p = projected.find(
        (x) => x.reviewerType === row.reviewerType && x.reviewerId === row.reviewerId,
      );
      return { ...row, projectedStatus: p?.projected ?? row.status };
    });

    // Same single read snapshot as the view above — no second read.
    const token = computeReviewersToken(db, taskId, {
      rows,
      requirement,
      projected,
    });
    return { reviewers: merged, token };
  });
}
