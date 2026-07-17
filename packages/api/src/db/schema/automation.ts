import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
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
