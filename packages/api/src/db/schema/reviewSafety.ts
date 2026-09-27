import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { tasks } from "./task.js";

/**
 * Durable review-safety first slice (migration 0082).
 *
 * One row per Task carrying the durable review requirement state. The full
 * per-state CHECK matrix (uncaptured / legacy_unknown / known_zero /
 * required, baseline positivity, override-or-effective>=baseline, typed
 * claimant pairing, approved_generation equality) is enforced in SQL — see
 * drizzle/0082_task_review_safety.sql. A missing row on a Task is
 * unknown/error, NEVER known_zero.
 */
export const taskReviewRequirements = sqliteTable("task_review_requirements", {
  taskId: text("task_id")
    .primaryKey()
    .references(() => tasks.id, { onDelete: "cascade" }),
  origin: text("origin", {
    enum: ["ordinary", "legacy_unverified", "preset_historical"],
  }).notNull(),
  state: text("state", {
    enum: ["uncaptured", "legacy_unknown", "known_zero", "required"],
  }).notNull(),
  nonOverriddenFloor: integer("non_overridden_floor"),
  knownPolicyFloor: integer("known_policy_floor").notNull().default(0),
  effectiveCount: integer("effective_count"),
  requirementVersion: integer("requirement_version").notNull().default(1),
  reviewGeneration: integer("review_generation").notNull().default(0),
  reviewRound: integer("review_round").notNull().default(0),
  claimantType: text("claimant_type", {
    enum: ["local_agent", "remote_participant"],
  }),
  claimantId: text("claimant_id"),
  approvedGeneration: integer("approved_generation"),
  activeOverrideId: text("active_override_id"),
  selectedRuleId: text("selected_rule_id"),
  updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
});

/**
 * Append-only immutable claim-policy evidence — exactly one row per
 * SUCCESSFUL-claim generation (UNIQUE task_id, review_generation). Copies the
 * winning rule's predicates/order/count/strategy/anti-self/fixed ids plus the
 * winning task's domain/labels/priority at claim time, or the explicit
 * no-match record. Generations advanced solely to invalidate an owner
 * (release/reset) produce NO snapshot.
 */
export const taskReviewSnapshots = sqliteTable(
  "task_review_snapshots",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    reviewGeneration: integer("review_generation").notNull(),
    claimantType: text("claimant_type", {
      enum: ["local_agent", "remote_participant"],
    }).notNull(),
    claimantId: text("claimant_id").notNull(),
    matched: integer("matched", { mode: "boolean" }).notNull(),
    requiredCount: integer("required_count").notNull(),
    ruleId: text("rule_id"),
    ruleUpdatedAt: text("rule_updated_at"),
    rulePriority: integer("rule_priority"),
    ruleMatchDomain: text("rule_match_domain"),
    ruleMatchLabels: text("rule_match_labels", { mode: "json" }).$type<string[]>(),
    ruleMatchPriority: text("rule_match_priority"),
    ruleAssignmentStrategy: text("rule_assignment_strategy"),
    ruleAntiSelfReview: integer("rule_anti_self_review"),
    ruleFixedReviewerIds: text("rule_fixed_reviewer_ids", { mode: "json" }).$type<string[]>(),
    taskDomain: text("task_domain"),
    taskLabels: text("task_labels", { mode: "json" }).$type<string[]>(),
    taskPriority: text("task_priority"),
    capturedAt: text("captured_at").notNull(),
  },
  (table) => [
    uniqueIndex("uq_task_review_snapshots_task_gen").on(table.taskId, table.reviewGeneration),
    index("idx_task_review_snapshots_task").on(table.taskId),
  ],
);

/**
 * Append-only typed reviewer decisions keyed to (generation, round). Identity
 * is (reviewer_type, reviewer_id). Deliberately NO FK to task_reviewers — a
 * removable assignment never deletes decision evidence; evidence survives
 * until the Task itself is deleted under its existing history policy.
 */
export const taskReviewDecisions = sqliteTable(
  "task_review_decisions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    reviewGeneration: integer("review_generation").notNull(),
    reviewRound: integer("review_round").notNull(),
    reviewerType: text("reviewer_type", { enum: ["human", "agent"] }).notNull(),
    reviewerId: text("reviewer_id").notNull(),
    decision: text("decision", { enum: ["approved", "rejected"] }).notNull(),
    decidedAt: text("decided_at").notNull(),
    actorType: text("actor_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }).notNull(),
    actorId: text("actor_id").notNull(),
    provenance: text("provenance", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("idx_task_review_decisions_task_gen").on(table.taskId, table.reviewGeneration),
    index("idx_task_review_decisions_reviewer").on(
      table.taskId,
      table.reviewGeneration,
      table.reviewerType,
      table.reviewerId,
      table.decidedAt,
    ),
  ],
);

/**
 * Append-only human recovery evidence: the ONLY legacy-unknown→known
 * resolution and the ONLY reduction of a positive baseline (current-generation
 * effective override, expiring at the next ownership end/reset/delegation).
 */
export const taskReviewOverrides = sqliteTable(
  "task_review_overrides",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    reviewGeneration: integer("review_generation").notNull(),
    kind: text("kind", { enum: ["resolve_unknown", "relax_baseline"] }).notNull(),
    requirementVersionBefore: integer("requirement_version_before").notNull(),
    taskVersion: integer("task_version").notNull(),
    oldState: text("old_state").notNull(),
    newState: text("new_state").notNull(),
    oldEffectiveCount: integer("old_effective_count"),
    newEffectiveCount: integer("new_effective_count"),
    reason: text("reason").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (table) => [index("idx_task_review_overrides_task").on(table.taskId)],
);
