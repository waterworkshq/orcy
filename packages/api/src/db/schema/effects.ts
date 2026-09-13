import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { habitats } from "./habitat.js";
import { tasks } from "./task.js";

/**
 * T2 — durable failure-effect receipt outbox (authority-and-effects contract
 * §B, ticket rev 6).
 *
 * One row per (subject, consumer) required effect. `subject_type` is
 * `task_event` (subject_id = the task_events row id) or `pulse` (subject_id =
 * the pulse id — failure-generated detected batches compose per-pulse effect
 * intents in the detector composer tx, §F1). States are exactly
 * `pending | delivered | dead_letter`.
 *
 * Receipts are retained indefinitely (S-3): no delete API exists (admin
 * requeue only) so scanner delegation's ownership EXISTS check stays sound
 * across disabled→re-enabled enrollment rescans.
 */
export const effectReceipts = sqliteTable(
  "effect_receipts",
  {
    id: text("id").primaryKey(),
    subjectType: text("subject_type", { enum: ["task_event", "pulse"] }).notNull(),
    subjectId: text("subject_id").notNull(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    taskId: text("task_id"),
    consumer: text("consumer", {
      enum: [
        "workflow_gates",
        "failure_context",
        "retry_ladder",
        "detector_dispatch",
        "skill_ingestion",
        "pulse_workflow_gates",
        "pulse_skill_ingest",
      ],
    }).notNull(),
    state: text("state", { enum: ["pending", "delivered", "dead_letter"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    /** Immutable causal snapshot written by the act-tx (or pulse composer tx). */
    causalSnapshot: text("causal_snapshot", { mode: "json" }).$type<Record<
      string,
      unknown
    > | null>(),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (table) => [
    uniqueIndex("idx_effect_receipts_subject_consumer").on(
      table.subjectType,
      table.subjectId,
      table.consumer,
    ),
    index("idx_effect_receipts_state_created").on(table.state, table.createdAt),
  ],
);

/**
 * Frozen per-target detector delivery unit (B.3 / S-4). One row per
 * (receipt, target) — the target set is frozen at act time; later enrollment
 * never widens it. `target_key` is the canonical JSON encoding
 * `["signalDetector",<pluginId>,<contributionId>]` (same collision guarantee
 * as the run-row dispatch key). Attempt budgets and leases live HERE; the
 * parent `detector_dispatch` receipt is derived, never reserved.
 */
export const effectReceiptTargets = sqliteTable(
  "effect_receipt_targets",
  {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => effectReceipts.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    targetKey: text("target_key").notNull(),
    pluginId: text("plugin_id").notNull(),
    contributionId: text("contribution_id").notNull(),
    state: text("state", { enum: ["pending", "delivered", "dead_letter"] })
      .notNull()
      .default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastErrorCode: text("last_error_code"),
    leaseOwner: text("lease_owner"),
    leaseToken: text("lease_token"),
    leaseExpiresAt: text("lease_expires_at"),
    createdAt: text("created_at").notNull(),
    deliveredAt: text("delivered_at"),
  },
  (table) => [
    uniqueIndex("idx_effect_receipt_targets_unique").on(table.receiptId, table.targetKey),
    index("idx_effect_receipt_targets_state_created").on(table.state, table.createdAt),
  ],
);

/** Append-only attempt history. Never mutated, never deleted. */
export const effectReceiptAttempts = sqliteTable(
  "effect_receipt_attempts",
  {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => effectReceipts.id, { onDelete: "cascade" }),
    targetId: text("target_id"),
    attempt: integer("attempt").notNull(),
    /** Fixed allowlisted error code (B7) — never a raw handler message. */
    code: text("code").notNull(),
    actor: text("actor").notNull().default("deliverer"),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [index("idx_effect_receipt_attempts_receipt").on(table.receiptId, table.occurredAt)],
);

/** Append-only admin action history (requeue). Never mutated, never deleted. */
export const effectReceiptAdminActions = sqliteTable(
  "effect_receipt_admin_actions",
  {
    id: text("id").primaryKey(),
    receiptId: text("receipt_id")
      .notNull()
      .references(() => effectReceipts.id, { onDelete: "cascade" }),
    targetId: text("target_id"),
    action: text("action", { enum: ["requeue"] }).notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    occurredAt: text("occurred_at").notNull(),
  },
  (table) => [
    index("idx_effect_receipt_admin_actions_receipt").on(table.receiptId, table.occurredAt),
  ],
);

export type EffectReceiptRow = typeof effectReceipts.$inferSelect;
export type EffectReceiptInsert = typeof effectReceipts.$inferInsert;
export type EffectReceiptTargetRow = typeof effectReceiptTargets.$inferSelect;
export type EffectReceiptTargetInsert = typeof effectReceiptTargets.$inferInsert;
export type EffectReceiptAttemptRow = typeof effectReceiptAttempts.$inferSelect;
export type EffectReceiptAdminActionRow = typeof effectReceiptAdminActions.$inferSelect;
