import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type {
  RetryPolicy,
  AnomalySettings,
  AutoAssignSettings,
  AutomationSettings,
  CodeReviewSettings,
  CiCdSettings,
  GitWorktreeSettings,
  PrioritizationSettings,
  TaskTemplateEntry,
  TaskPriority,
  ScheduleType,
  WikiSettings,
  TriageSettings,
  WorkflowTemplateDefinition,
} from "../../models/index.js";
import { teams } from "./user.js";
import { users } from "./user.js";

export const habitats = sqliteTable(
  "habitats",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
    retrySettings: text("retry_settings", { mode: "json" }).$type<RetryPolicy | null>(),
    anomalySettings: text("anomaly_settings", { mode: "json" }).$type<AnomalySettings | null>(),
    autoAssignSettings: text("auto_assign_settings", {
      mode: "json",
    }).$type<AutoAssignSettings | null>(),
    codeReviewSettings: text("code_review_settings", {
      mode: "json",
    }).$type<CodeReviewSettings | null>(),
    eventRetentionDays: integer("event_retention_days").default(90),
    ciCdSettings: text("ci_cd_settings", { mode: "json" }).$type<CiCdSettings | null>(),
    gitWorktreeSettings: text("git_worktree_settings", {
      mode: "json",
    }).$type<GitWorktreeSettings | null>(),
    prioritizationSettings: text("prioritization_settings", {
      mode: "json",
    }).$type<PrioritizationSettings | null>(),
    automationSettings: text("automation_settings", {
      mode: "json",
    }).$type<AutomationSettings | null>(),
    wikiSettings: text("wiki_settings", { mode: "json" }).$type<WikiSettings | null>(),
    triageSettings: text("triage_settings", { mode: "json" }).$type<TriageSettings | null>(),
    teamId: text("team_id").references(() => teams.id, { onDelete: "set null" }),
    carryOverPolicy: text("carry_over_policy").notNull().default("backlog"),
  },
  (table) => [
    index("idx_habitats_name").on(table.name),
    index("idx_habitats_team_id").on(table.teamId),
  ],
);

export const missions = sqliteTable(
  "missions",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    columnId: text("column_id")
      .notNull()
      .references(() => columns.id),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    acceptanceCriteria: text("acceptance_criteria").notNull().default(""),
    priority: text("priority").notNull().default("medium"),
    labels: text("labels", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    status: text("status").notNull().default("not_started"),
    displayOrder: integer("display_order").notNull().default(0),
    dependsOn: text("depends_on", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    blocks: text("blocks", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    dueAt: text("due_at"),
    slaMinutes: integer("sla_minutes"),
    slaDeadlineAt: text("sla_deadline_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    version: integer("version").notNull().default(1),
    actualMinutes: integer("actual_minutes"),
    plannedMinutes: integer("planned_minutes"),
    planningAccuracy: real("planning_accuracy"),
    completedAt: text("completed_at"),
    isArchived: integer("is_archived", { mode: "boolean" }).notNull().default(false),
    sprintId: text("sprint_id"),
  },
  (table) => [
    index("idx_missions_habitat_column").on(table.habitatId, table.columnId),
    index("idx_missions_status").on(table.status),
    index("idx_missions_priority").on(table.priority),
    index("idx_missions_column_order").on(table.columnId, table.displayOrder),
    index("idx_missions_due_at").on(table.dueAt),
    index("idx_missions_sla_deadline_at").on(table.slaDeadlineAt),
    index("idx_missions_sprint").on(table.sprintId),
  ],
);

export const missionDependencies = sqliteTable(
  "mission_dependencies",
  {
    missionId: text("mission_id").notNull(),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.missionId, table.dependsOnId] }),
    index("idx_mission_deps_depends_on").on(table.dependsOnId),
  ],
);

export const missionEvents = sqliteTable(
  "mission_events",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id").notNull(),
    actorType: text("actor_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }).notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action", {
      enum: [
        "created",
        "updated",
        "moved",
        "status_changed",
        "completed",
        "deleted",
        "dependency_resolved",
        "code_evidence_linked",
        "code_evidence_corrected",
        "code_evidence_gap_reported",
        "code_evidence_gap_resolved",
        "code_evidence_marked_not_applicable",
        "code_evidence_cleared_not_applicable",
        "workflow_attached",
        "workflow_detached",
      ],
    }).notNull(),
    fromColumnId: text("from_column_id"),
    toColumnId: text("to_column_id"),
    fromStatus: text("from_status"),
    toStatus: text("to_status"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    timestamp: text("timestamp")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_mission_events_mission").on(table.missionId),
    index("idx_mission_events_timestamp").on(table.timestamp),
  ],
);

export const missionWatchers = sqliteTable(
  "mission_watchers",
  {
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    primaryKey({ columns: [table.missionId, table.userId] }),
    index("idx_mission_watchers_user").on(table.userId),
  ],
);

const missionCommentsColumns = {
  id: text("id").primaryKey(),
  missionId: text("mission_id").notNull(),
  parentId: text("parent_id").references(
    (): ReturnType<typeof text> => missionComments.id as ReturnType<typeof text>,
    { onDelete: "cascade" },
  ),
  authorType: text("author_type", {
    enum: ["human", "agent", "remote_human", "remote_orcy"],
  }).notNull(),
  authorId: text("author_id").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at")
    .notNull()
    .default(sql`(datetime('now'))`),
  updatedAt: text("updated_at")
    .notNull()
    .default(sql`(datetime('now'))`),
};

export const missionComments = sqliteTable("mission_comments", missionCommentsColumns, (table) => [
  index("idx_mission_comments_mission_id").on(table.missionId, table.createdAt),
  index("idx_mission_comments_parent").on(table.parentId),
]);

export const missionCommentMentions = sqliteTable(
  "mission_comment_mentions",
  {
    id: text("id").primaryKey(),
    commentId: text("comment_id")
      .notNull()
      .references(() => missionComments.id, { onDelete: "cascade" }),
    mentionedType: text("mentioned_type", {
      enum: ["human", "agent", "remote_human", "remote_orcy"],
    }).notNull(),
    mentionedId: text("mentioned_id").notNull(),
    mentionText: text("mention_text").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_mission_mentions_comment_id").on(table.commentId),
    index("idx_mission_mentions_target").on(table.mentionedType, table.mentionedId),
    uniqueIndex("idx_mission_mentions_unique").on(
      table.commentId,
      table.mentionedType,
      table.mentionedId,
      table.mentionText,
    ),
  ],
);

const columnsColumns = {
  id: text("id").primaryKey(),
  habitatId: text("habitat_id")
    .notNull()
    .references(() => habitats.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  order: integer("order").notNull(),
  wipLimit: integer("wip_limit"),
  autoAdvance: integer("auto_advance", { mode: "boolean" }).notNull().default(false),
  requiresClaim: integer("requires_claim", { mode: "boolean" }).notNull().default(true),
  nextColumnId: text("next_column_id").references(
    (): ReturnType<typeof text> => columns.id as ReturnType<typeof text>,
  ),
  isTerminal: integer("is_terminal", { mode: "boolean" }).notNull().default(false),
};

export const columns = sqliteTable("columns", columnsColumns, (table) => [
  uniqueIndex("idx_columns_habitat_order").on(table.habitatId, table.order),
  index("idx_columns_habitat_id").on(table.habitatId),
  index("idx_columns_next").on(table.nextColumnId),
]);

export const missionTemplates = sqliteTable(
  "mission_templates",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id").references(() => habitats.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    titlePattern: text("title_pattern").notNull().default(""),
    descriptionPattern: text("description_pattern").notNull().default(""),
    priority: text("priority", { enum: ["low", "medium", "high", "critical"] }).default("medium"),
    labels: text("labels", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    requiredDomain: text("required_domain"),
    requiredCapabilities: text("required_capabilities", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    usageCount: integer("usage_count").notNull().default(0),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    tasksTemplate: text("tasks_template", { mode: "json" })
      .$type<TaskTemplateEntry[]>()
      .notNull()
      .$defaultFn(() => []),
    workflowTemplate: text("workflow_template", {
      mode: "json",
    }).$type<WorkflowTemplateDefinition | null>(),
  },
  (table) => [
    index("idx_templates_habitat").on(table.habitatId),
    index("idx_templates_default").on(table.isDefault),
  ],
);

export const savedFilters = sqliteTable("saved_filters", {
  id: text("id").primaryKey(),
  habitatId: text("habitat_id")
    .notNull()
    .references(() => habitats.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull(),
  name: text("name").notNull(),
  filterConfig: text("filter_config", { mode: "json" }).$type<Record<string, unknown>>().notNull(),
  isBuiltin: integer("is_builtin", { mode: "boolean" }).default(false),
  createdAt: text("created_at").default("(datetime('now'))"),
});

export const chatIntegrations = sqliteTable(
  "chat_integrations",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["slack", "discord"] }).notNull(),
    webhookUrl: text("webhook_url").notNull(),
    channelId: text("channel_id"),
    botToken: text("bot_token"),
    enabled: integer("enabled").notNull().default(1),
    events: text("events", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => [
        "task_created",
        "task_claimed",
        "task_submitted",
        "task_approved",
        "task_rejected",
        "task_overdue",
      ]),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_chat_integrations_habitat").on(table.habitatId),
    index("idx_chat_integrations_provider").on(table.provider),
    index("idx_chat_integrations_enabled").on(table.enabled),
  ],
);

export const auditExportSchedules = sqliteTable(
  "audit_export_schedules",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    format: text("format", { enum: ["csv", "json", "jsonl"] }).notNull(),
    filters: text("filters", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    schedule: text("schedule").notNull(),
    destination: text("destination").notNull().default("local"),
    destinationConfig: text("destination_config", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .$defaultFn(() => ({})),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastRunAt: text("last_run_at"),
    nextRunAt: text("next_run_at").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_audit_schedules_habitat").on(table.habitatId),
    index("idx_audit_schedules_next").on(table.nextRunAt),
  ],
);

export const scheduledTasks = sqliteTable(
  "scheduled_tasks",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    templateId: text("template_id").references(() => missionTemplates.id, { onDelete: "set null" }),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    scheduleType: text("schedule_type", { enum: ["once", "interval", "cron"] })
      .$type<ScheduleType>()
      .notNull(),
    cronExpression: text("cron_expression"),
    intervalMinutes: integer("interval_minutes"),
    scheduledAt: text("scheduled_at"),
    timezone: text("timezone").notNull().default("UTC"),
    missionTitle: text("mission_title").notNull(),
    missionDescription: text("mission_description").notNull().default(""),
    missionPriority: text("mission_priority").$type<TaskPriority>().notNull().default("medium"),
    missionLabels: text("mission_labels", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    missionDomain: text("mission_domain"),
    handlerKey: text("handler_key"),
    tasksTemplate: text("tasks_template", { mode: "json" })
      .$type<TaskTemplateEntry[]>()
      .notNull()
      .$defaultFn(() => []),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    lastRunAt: text("last_run_at"),
    nextRunAt: text("next_run_at").notNull(),
    runCount: integer("run_count").notNull().default(0),
    lastCreatedMissionId: text("last_created_mission_id"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_scheduled_tasks_habitat").on(table.habitatId),
    index("idx_scheduled_tasks_next").on(table.nextRunAt),
    index("idx_scheduled_tasks_enabled").on(table.enabled),
  ],
);

export const habitatHealthSnapshots = sqliteTable(
  "habitat_health_snapshots",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    score: integer("score").notNull(),
    grade: text("grade", { enum: ["A", "B", "C", "D", "F"] }).notNull(),
    dimensions: text("dimensions").notNull(),
    metrics: text("metrics").notNull(),
    recommendations: text("recommendations").notNull().default("[]"),
    snapshotAt: text("snapshot_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_health_snapshots_habitat").on(table.habitatId),
    index("idx_health_snapshots_time").on(table.habitatId, table.snapshotAt),
  ],
);

export const cumulativeFlowSnapshots = sqliteTable(
  "cumulative_flow_snapshots",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    snapshotDate: text("snapshot_date").notNull(),
    countsByColumn: text("counts_by_column", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .$defaultFn(() => ({})),
    countsByStatus: text("counts_by_status", { mode: "json" })
      .$type<Record<string, number>>()
      .notNull()
      .$defaultFn(() => ({})),
    source: text("source", { enum: ["generated", "backfilled", "current_state"] })
      .notNull()
      .default("generated"),
    completeness: text("completeness", { enum: ["complete", "partial"] })
      .notNull()
      .default("complete"),
    warnings: text("warnings", { mode: "json" })
      .$type<Array<{ code: string; message: string; severity: "info" | "warning" | "critical" }>>()
      .notNull()
      .$defaultFn(() => []),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_cumulative_flow_snapshot_unique").on(table.habitatId, table.snapshotDate),
  ],
);

export const sprints = sqliteTable(
  "sprints",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    goal: text("goal").notNull().default(""),
    startDate: text("start_date").notNull(),
    endDate: text("end_date").notNull(),
    status: text("status").notNull().default("planning"),
    committedMissionIds: text("committed_mission_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    completedMissionIds: text("completed_mission_ids", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    capacityMinutes: integer("capacity_minutes"),
    notes: text("notes").notNull().default(""),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_sprints_habitat").on(table.habitatId),
    index("idx_sprints_status").on(table.status),
    index("idx_sprints_dates").on(table.startDate, table.endDate),
  ],
);
