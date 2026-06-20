import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { missions, habitats } from "./board.js";
import { tasks } from "./task.js";
import type {
  WorkflowFailureHandlerConfig,
  FailureBundle,
  AutomationCondition,
  JoinMode,
} from "../../models/index.js";

/** Mission-scoped workflow definition; gates live in `taskWorkflowGates` and enforce claim constraints when status is active. */
export const workflows = sqliteTable(
  "workflows",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    resolvedVariables: text("resolved_variables", { mode: "json" })
      .$type<Record<string, string>>()
      .notNull()
      .$defaultFn(() => ({})),
    failureHandler: text("failure_handler", {
      mode: "json",
    }).$type<WorkflowFailureHandlerConfig | null>(),
    joinSpecs: text("join_specs", {
      mode: "json",
    }).$type<Record<string, { mode: JoinMode; n?: number }> | null>(),
    status: text("status", { enum: ["active", "detached"] })
      .notNull()
      .default("active"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    detachedAt: text("detached_at"),
    detachedBy: text("detached_by"),
    version: integer("version").notNull().default(1),
  },
  (table) => [
    index("idx_workflows_mission").on(table.missionId),
    index("idx_workflows_habitat").on(table.habitatId),
    index("idx_workflows_status").on(table.status),
  ],
);

/** Typed dependency edge between two tasks in a workflow; the `satisfied` flag is the only runtime-mutable field. */
export const taskWorkflowGates = sqliteTable(
  "task_workflow_gates",
  {
    id: text("id").primaryKey(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => workflows.id, { onDelete: "cascade" }),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    upstreamTaskId: text("upstream_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    downstreamTaskId: text("downstream_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    gateType: text("gate_type", {
      enum: ["on_complete", "on_approve", "on_signal", "on_automation", "on_manual", "on_fail"],
    }).notNull(),
    matchConfig: text("match_config", { mode: "json" }).$type<Record<string, unknown>>(),
    condition: text("condition", { mode: "json" }).$type<AutomationCondition | null>(),
    satisfied: integer("satisfied", { mode: "boolean" }).notNull().default(false),
    satisfiedAt: text("satisfied_at"),
    satisfiedByEventId: text("satisfied_by_event_id"),
    recoveryTaskId: text("recovery_task_id").references(() => tasks.id, { onDelete: "set null" }),
    recoveryDepth: integer("recovery_depth").notNull().default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_workflow_gates_workflow").on(table.workflowId),
    index("idx_workflow_gates_downstream").on(table.downstreamTaskId),
    index("idx_workflow_gates_upstream").on(table.upstreamTaskId),
    index("idx_workflow_gates_satisfied").on(table.satisfied),
    index("idx_workflow_gates_type").on(table.gateType),
  ],
);

/** Structured failure bundle persisted for recovery agents to consume when an `on_fail` gate fires. */
export const failureContexts = sqliteTable(
  "failure_contexts",
  {
    id: text("id").primaryKey(),
    failedTaskId: text("failed_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    workflowId: text("workflow_id").references(() => workflows.id, { onDelete: "set null" }),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    failureKind: text("failure_kind", {
      enum: ["lifecycle_failed", "lifecycle_rejected", "heartbeat_lost", "manual"],
    }).notNull(),
    failureReason: text("failure_reason").notNull().default(""),
    failedAt: text("failed_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    failedByAgentId: text("failed_by_agent_id"),
    bundle: text("bundle", { mode: "json" }).$type<FailureBundle>().notNull(),
    bundleSchemaVersion: integer("bundle_schema_version").notNull().default(1),
    recoveryTaskId: text("recovery_task_id").references(() => tasks.id, { onDelete: "set null" }),
    recoveryDepth: integer("recovery_depth").notNull().default(0),
    resolvedAt: text("resolved_at"),
    resolutionKind: text("resolution_kind", {
      enum: ["redeemed", "unrecoverable", "superseded", "manual_intervention"],
    }),
  },
  (table) => [
    index("idx_failure_contexts_task").on(table.failedTaskId),
    index("idx_failure_contexts_workflow").on(table.workflowId),
    index("idx_failure_contexts_unresolved").on(table.resolvedAt),
  ],
);
