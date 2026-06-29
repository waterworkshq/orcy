import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { habitats } from "./board.js";

/**
 * Per-habitat plugin enrollment state. One row per (habitat, plugin, contribution)
 * trio — enforced by a unique index. `enabled` toggles whether the loader dispatches
 * to the contribution; `disabled_at` records the most recent disable transition.
 * System-scoped contributions (notificationChannel, customMcpTool, customHttpRoute)
 * do NOT enroll — only habitat-scoped kinds (signalDetector, lifecycleInterceptor).
 */
export const pluginEnrollments = sqliteTable(
  "plugin_enrollments",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    contributionId: text("contribution_id").notNull(),
    contributionKind: text("contribution_kind").notNull(),
    enabled: integer("enabled").notNull().default(0),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
    enrolledBy: text("enrolled_by").notNull(),
    enrolledAt: text("enrolled_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    disabledAt: text("disabled_at"),
    lastScannedAt: text("last_scanned_at"),
  },
  (table) => [
    uniqueIndex("idx_plugin_enrollments_unique").on(
      table.habitatId,
      table.pluginId,
      table.contributionId,
    ),
    index("idx_plugin_enrollments_habitat").on(table.habitatId, table.enabled),
    index("idx_plugin_enrollments_plugin").on(table.pluginId),
  ],
);

/**
 * Per-invocation plugin run telemetry. One row per handler dispatch; `status` transitions
 * `running → succeeded | failed | rate_limited | skipped` (terminal). `fingerprint` is the
 * deterministic `habitatId:pluginId:contributionId:triggerType:triggerEventId` key for future
 * cooldown/dedup (not enforced in v0.22.0). `id` is stamped on detected-signal
 * `metadata.detectorRunId` and joins plugin activity to Audit Trail V2.
 */
export const pluginRuns = sqliteTable(
  "plugin_runs",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    pluginId: text("plugin_id").notNull(),
    contributionId: text("contribution_id").notNull(),
    contributionKind: text("contribution_kind").notNull(),
    triggerEventId: text("trigger_event_id"),
    triggerType: text("trigger_type").notNull(),
    status: text("status").notNull(),
    fingerprint: text("fingerprint").notNull(),
    signalsEmitted: integer("signals_emitted"),
    error: text("error"),
    startedAt: text("started_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (table) => [
    index("idx_plugin_runs_habitat_plugin").on(table.habitatId, table.pluginId, table.startedAt),
    index("idx_plugin_runs_habitat_status").on(table.habitatId, table.status, table.startedAt),
  ],
);

export type PluginEnrollmentRow = typeof pluginEnrollments.$inferSelect;
export type PluginRunRow = typeof pluginRuns.$inferSelect;
export type PluginEnrollmentInsert = typeof pluginEnrollments.$inferInsert;
export type PluginRunInsert = typeof pluginRuns.$inferInsert;

/**
 * Persistent plugin quarantine state (ADR-0016, v0.22.3). One row per quarantined
 * `pluginKey` — loaded at boot to re-populate the in-memory `quarantineSet` so that
 * quarantined plugins stay quarantined across API restarts. Admin can clear via REST.
 */
export const pluginQuarantines = sqliteTable("plugin_quarantines", {
  pluginKey: text("plugin_key").primaryKey(),
  pluginId: text("plugin_id").notNull(),
  quarantinedAt: text("quarantined_at").notNull(),
  reason: text("reason"),
});

export type PluginQuarantineRow = typeof pluginQuarantines.$inferSelect;
export type PluginQuarantineInsert = typeof pluginQuarantines.$inferInsert;
