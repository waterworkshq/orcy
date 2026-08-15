import { sqliteTable, text, integer, index, uniqueIndex, check } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { habitats } from "./habitat.js";

export const automationRules = sqliteTable(
  "automation_rules",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    priority: integer("priority").notNull().default(0),
    trigger: text("trigger", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    condition: text("condition", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({ type: "always" })),
    actions: text("actions", { mode: "json" })
      .$type<Record<string, unknown>[]>()
      .notNull()
      .$defaultFn(() => []),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(300),
    maxRunsPerHour: integer("max_runs_per_hour").notNull().default(30),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
    lastRunAt: text("last_run_at"),
  },
  (table) => [
    index("idx_automation_rules_habitat").on(table.habitatId),
    index("idx_automation_rules_enabled").on(table.habitatId, table.enabled),
    index("idx_automation_rules_priority").on(table.habitatId, table.priority),
  ],
);

export const automationRuleRuns = sqliteTable(
  "automation_rule_runs",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id")
      .notNull()
      .references(() => automationRules.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type").notNull(),
    triggerEventId: text("trigger_event_id"),
    targetType: text("target_type"),
    targetId: text("target_id"),
    fingerprint: text("fingerprint").notNull(),
    eventDedupeKey: text("event_dedupe_key"),
    status: text("status").notNull(),
    skipReason: text("skip_reason"),
    conditionResult: text("condition_result", { mode: "json" }).$type<Record<
      string,
      unknown
    > | null>(),
    actionResults: text("action_results", { mode: "json" }).$type<
      Record<string, unknown>[] | null
    >(),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown> | null>(),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("idx_automation_runs_rule").on(table.ruleId, table.startedAt),
    index("idx_automation_runs_habitat").on(table.habitatId, table.startedAt),
    index("idx_automation_runs_fingerprint").on(table.fingerprint, table.startedAt),
    index("idx_automation_runs_status").on(table.habitatId, table.status),
    uniqueIndex("uq_automation_runs_event_dedupe")
      .on(table.eventDedupeKey, table.ruleId)
      .where(sql`event_dedupe_key IS NOT NULL`),
  ],
);

/**
 * Immutable executable snapshots of an automation rule. Created on every rule
 * create/mutation (and lazily for legacy rules at inbox admission). Deliberately
 * NOT foreign-keyed to `automation_rules` — deleting the live rule must not
 * delete revisions referenced by delivery history.
 */
export const automationRuleRevisions = sqliteTable(
  "automation_rule_revisions",
  {
    id: text("id").primaryKey(),
    ruleId: text("rule_id").notNull(),
    habitatId: text("habitat_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    enabled: integer("enabled", { mode: "boolean" }).notNull(),
    priority: integer("priority").notNull().default(0),
    trigger: text("trigger", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    condition: text("condition", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    actions: text("actions", { mode: "json" }).$type<Record<string, unknown>[]>().notNull(),
    cooldownSeconds: integer("cooldown_seconds").notNull().default(300),
    maxRunsPerHour: integer("max_runs_per_hour").notNull().default(30),
    digest: text("digest").notNull(),
    authorType: text("author_type").notNull(),
    authorId: text("author_id").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    uniqueIndex("uq_automation_rule_revisions_rule_number").on(table.ruleId, table.revisionNumber),
    index("idx_automation_rule_revisions_rule").on(table.ruleId, table.revisionNumber),
    index("idx_automation_rule_revisions_habitat").on(table.habitatId),
  ],
);

/**
 * Automation event inbox — unique `(event_type, event_id)` identity with an
 * immutable event payload. Admissions freeze the matched executable rule
 * revisions; the inbox entry is terminal only when every frozen revision's
 * delivery is terminal, durably skipped, or waived.
 */
export const automationEventInbox = sqliteTable(
  "automation_event_inbox",
  {
    id: text("id").primaryKey(),
    eventType: text("event_type").notNull(),
    eventId: text("event_id").notNull(),
    habitatId: text("habitat_id").notNull(),
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
    state: text("state").notNull().default("pending"),
    admittedAt: text("admitted_at").notNull().default("(datetime('now'))"),
    terminalAt: text("terminal_at"),
  },
  (table) => [
    uniqueIndex("uq_automation_event_inbox_identity").on(table.eventType, table.eventId),
    index("idx_automation_event_inbox_habitat").on(table.habitatId, table.state),
    check("automation_event_inbox_state_check", sql`state IN ('pending', 'terminal')`),
  ],
);

/**
 * Per-rule-generation deliveries for an inbox event. Replaces the release
 * path's `(event_dedupe_key, rule_id)` identity with
 * `(event_dedupe_key, rule_revision_id, generation)` while retaining stable
 * event/rule lineage (`event_dedupe_key`, `rule_id`).
 */
export const automationRuleDeliveries = sqliteTable(
  "automation_rule_deliveries",
  {
    id: text("id").primaryKey(),
    inboxId: text("inbox_id")
      .notNull()
      .references(() => automationEventInbox.id, { onDelete: "cascade" }),
    ruleRevisionId: text("rule_revision_id")
      .notNull()
      .references(() => automationRuleRevisions.id),
    ruleId: text("rule_id").notNull(),
    habitatId: text("habitat_id").notNull(),
    eventDedupeKey: text("event_dedupe_key").notNull(),
    generation: integer("generation").notNull().default(1),
    predecessorDeliveryId: text("predecessor_delivery_id"),
    retryReason: text("retry_reason"),
    state: text("state").notNull().default("pending"),
    leaseOwner: text("lease_owner"),
    leaseFence: text("lease_fence"),
    leaseExpiresAt: text("lease_expires_at"),
    automationRunId: text("automation_run_id"),
    proofClassification: text("proof_classification"),
    retryCount: integer("retry_count").notNull().default(0),
    terminalDisposition: text("terminal_disposition"),
    terminalDetail: text("terminal_detail"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
    terminalAt: text("terminal_at"),
  },
  (table) => [
    uniqueIndex("uq_automation_rule_deliveries_generation").on(
      table.eventDedupeKey,
      table.ruleRevisionId,
      table.generation,
    ),
    index("idx_automation_rule_deliveries_inbox").on(table.inboxId, table.state),
    index("idx_automation_rule_deliveries_drain").on(table.state, table.leaseExpiresAt),
    index("idx_automation_rule_deliveries_rule").on(table.ruleId),
    index("idx_automation_rule_deliveries_predecessor").on(table.predecessorDeliveryId),
    check(
      "automation_rule_deliveries_state_check",
      sql`state IN ('pending', 'leased', 'terminal', 'attention_required', 'waived')`,
    ),
  ],
);

/**
 * Ordered per-action authoritative checkpoints for one delivery generation.
 * A `proved` checkpoint carries a durable receipt and is never re-executed —
 * in this generation or any successor (predecessor carry-forward).
 */
export const automationDeliveryActionCheckpoints = sqliteTable(
  "automation_delivery_action_checkpoints",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => automationRuleDeliveries.id, { onDelete: "cascade" }),
    actionIndex: integer("action_index").notNull(),
    actionKey: text("action_key").notNull(),
    actionType: text("action_type").notNull(),
    idempotencyKey: text("idempotency_key"),
    state: text("state").notNull().default("pending"),
    receipt: text("receipt", { mode: "json" }).$type<Record<string, unknown> | null>(),
    terminalDisposition: text("terminal_disposition"),
    predecessorCheckpointId: text("predecessor_checkpoint_id"),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
    provedAt: text("proved_at"),
  },
  (table) => [
    uniqueIndex("uq_automation_delivery_checkpoints_index").on(table.deliveryId, table.actionIndex),
    index("idx_automation_delivery_checkpoints_delivery").on(table.deliveryId, table.actionIndex),
    check(
      "automation_delivery_checkpoints_state_check",
      sql`state IN ('pending', 'proved', 'failed')`,
    ),
    check(
      "automation_delivery_checkpoints_proved_receipt_check",
      sql`(state != 'proved') OR (receipt IS NOT NULL AND proved_at IS NOT NULL)`,
    ),
  ],
);

/**
 * Append-only operator audit ledger for waive / risk-acknowledged
 * successor-generation dispositions on `attention_required` deliveries.
 */
export const automationDeliveryDispositions = sqliteTable(
  "automation_delivery_dispositions",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id").notNull(),
    inboxId: text("inbox_id").notNull(),
    kind: text("kind").notNull(),
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id").notNull(),
    reason: text("reason").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_automation_delivery_dispositions_delivery").on(table.deliveryId),
    check("automation_delivery_dispositions_kind_check", sql`kind IN ('waive', 'successor_generation')`),
  ],
);

/**
 * Durable Automation rule-run completion outbox (FU2). One row per rule run,
 * written in the SAME immediate transaction that terminalizes a delivery; a
 * drain/boot pass delivers undelivered rows (retry-on-drain). Delivery is
 * at-least-once: a crash between the hook and the delivered CAS can replay.
 * Consumers must be idempotent (CAS on the satisfied/delivered predicate).
 * `UNIQUE (run_id)` is the outbox-row dedup key.
 */
export const automationRunCompletionOutbox = sqliteTable(
  "automation_run_completion_outbox",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => automationRuleRuns.id, { onDelete: "cascade" }),
    ruleId: text("rule_id").notNull(),
    habitatId: text("habitat_id").notNull(),
    outcome: text("outcome").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    deliveredAt: text("delivered_at"),
    deliveryAttempts: integer("delivery_attempts").notNull().default(0),
    lastError: text("last_error"),
  },
  (table) => [
    uniqueIndex("uq_automation_completion_outbox_run").on(table.runId),
    index("idx_automation_completion_outbox_undelivered").on(table.deliveredAt),
  ],
);
