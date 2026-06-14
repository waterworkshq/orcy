import {
  sqliteTable,
  text,
  integer,
  real,
  index,
  uniqueIndex,
  primaryKey,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import type { Artifact, RetryPolicy } from "../../models/index.js";
import { missions } from "./board.js";
import { agents } from "./agent.js";

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    missionId: text("mission_id")
      .notNull()
      .references(() => missions.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    labels: text("labels", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    priority: text("priority", { enum: ["low", "medium", "high", "critical"] })
      .notNull()
      .default("medium"),
    assignedAgentId: text("assigned_agent_id").references(() => agents.id),
    remoteAssignedParticipantId: text("remote_assigned_participant_id"),
    requiredDomain: text("required_domain"),
    requiredCapabilities: text("required_capabilities", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .$defaultFn(() => []),
    status: text("status", {
      enum: [
        "pending",
        "claimed",
        "in_progress",
        "submitted",
        "approved",
        "rejected",
        "done",
        "failed",
      ],
    })
      .notNull()
      .default("pending"),
    claimedAt: text("claimed_at"),
    startedAt: text("started_at"),
    submittedAt: text("submitted_at"),
    completedAt: text("completed_at"),
    rejectedCount: integer("rejected_count").notNull().default(0),
    rejectionReason: text("rejection_reason"),
    result: text("result"),
    artifacts: text("artifacts", { mode: "json" })
      .$type<Artifact[]>()
      .notNull()
      .$defaultFn(() => []),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
    version: integer("version").notNull().default(1),
    order: integer("order").notNull().default(0),
    delegatedToAgentId: text("delegated_to_agent_id").references(() => agents.id),
    estimatedMinutes: integer("estimated_minutes"),
    retryPolicy: text("retry_policy", { mode: "json" }).$type<RetryPolicy | null>(),
    retryCount: integer("retry_count").notNull().default(0),
    nextRetryAt: text("next_retry_at"),
    actualMinutes: integer("actual_minutes"),
    cycleTimeMinutes: integer("cycle_time_minutes"),
    leadTimeMinutes: integer("lead_time_minutes"),
    estimationAccuracy: real("estimation_accuracy"),
  },
  (table) => [
    index("idx_tasks_mission").on(table.missionId),
    index("idx_tasks_mission_order").on(table.missionId, table.order),
    index("idx_tasks_status").on(table.status),
    index("idx_tasks_assigned_agent").on(table.assignedAgentId),
    index("idx_tasks_required_domain").on(table.requiredDomain),
    index("idx_tasks_priority").on(table.priority),
    index("idx_tasks_delegated").on(table.delegatedToAgentId),
    index("idx_tasks_remote_assigned_participant").on(table.remoteAssignedParticipantId),
  ],
);

export const taskEvents = sqliteTable(
  "task_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorType: text("actor_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }).notNull(),
    actorId: text("actor_id").notNull(),
    action: text("action", {
      enum: [
        "created",
        "claimed",
        "started",
        "submitted",
        "approved",
        "rejected",
        "completed",
        "failed",
        "moved",
        "released",
        "dependency_resolved",
        "updated",
        "delegated",
        "effort_logged",
        "effort_corrected",
        "cloned",
        "retry_scheduled",
        "retry_executed",
        "escalated",
        "code_evidence_linked",
        "code_evidence_corrected",
        "code_evidence_gap_reported",
        "code_evidence_gap_resolved",
        "code_evidence_marked_not_applicable",
        "code_evidence_cleared_not_applicable",
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
    timestamp: text("timestamp").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_task_events_task_id").on(table.taskId),
    index("idx_task_events_timestamp").on(table.timestamp),
    index("idx_task_events_actor").on(table.actorType, table.actorId),
    index("idx_task_events_from_column_time").on(table.fromColumnId, table.timestamp),
    index("idx_task_events_to_column_time").on(table.toColumnId, table.timestamp),
    index("idx_task_events_transition_time").on(
      table.fromColumnId,
      table.toColumnId,
      table.timestamp,
    ),
  ],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    dependsOnId: text("depends_on_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.dependsOnId] }),
    index("idx_task_dependencies_depends_on").on(table.dependsOnId),
    index("idx_task_dependencies_task_id").on(table.taskId),
  ],
);

const taskCommentsColumns = {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  parentId: text("parent_id").references(
    (): ReturnType<typeof text> => taskComments.id as ReturnType<typeof text>,
    { onDelete: "cascade" },
  ),
  authorType: text("author_type", {
    enum: ["human", "agent", "remote_human", "remote_orcy"],
  }).notNull(),
  authorId: text("author_id").notNull(),
  content: text("content").notNull(),
  createdAt: text("created_at").notNull().default("(datetime('now'))"),
  updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
};

export const taskComments = sqliteTable("task_comments", taskCommentsColumns, (table) => [
  index("idx_comments_task_id").on(table.taskId, table.createdAt),
  index("idx_comments_parent").on(table.parentId),
]);

export const taskSubtasks = sqliteTable(
  "task_subtasks",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    completed: integer("completed", { mode: "boolean" }).notNull().default(false),
    order: integer("order").notNull().default(0),
    assigneeId: text("assignee_id").references(() => agents.id),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
    updatedAt: text("updated_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_subtasks_task_id").on(table.taskId, table.order),
    index("idx_subtasks_assignee").on(table.assigneeId),
  ],
);

export const taskWatchers = sqliteTable(
  "task_watchers",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    primaryKey({ columns: [table.taskId, table.userId] }),
    index("idx_task_watchers_user_id").on(table.userId),
  ],
);

export const taskCommentMentions = sqliteTable(
  "task_comment_mentions",
  {
    id: text("id").primaryKey(),
    commentId: text("comment_id")
      .notNull()
      .references(() => taskComments.id, { onDelete: "cascade" }),
    mentionedType: text("mentioned_type", {
      enum: ["human", "agent", "remote_human", "remote_orcy"],
    }).notNull(),
    mentionedId: text("mentioned_id").notNull(),
    mentionText: text("mention_text").notNull(),
    createdAt: text("created_at").notNull().default("(datetime('now'))"),
  },
  (table) => [
    index("idx_comment_mentions_comment_id").on(table.commentId),
    index("idx_comment_mentions_target").on(table.mentionedType, table.mentionedId),
    uniqueIndex("idx_comment_mentions_unique").on(
      table.commentId,
      table.mentionedType,
      table.mentionedId,
      table.mentionText,
    ),
  ],
);

export const taskAttachments = sqliteTable(
  "task_attachments",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    filename: text("filename").notNull(),
    originalName: text("original_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    uploadedBy: text("uploaded_by"),
    createdAt: text("created_at").default("(datetime('now'))"),
  },
  (table) => [index("idx_attachments_task_id").on(table.taskId)],
);

export const taskTimeRecords = sqliteTable(
  "task_time_records",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    agentId: text("agent_id").references(() => agents.id, { onDelete: "set null" }),
    minutesSpent: integer("minutes_spent").notNull(),
    recordedAt: text("recorded_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    statusDuringWork: text("status_during_work").notNull(),
  },
  (table) => [
    index("idx_time_records_task").on(table.taskId),
    index("idx_time_records_agent").on(table.agentId),
  ],
);

export const effortEntries = sqliteTable(
  "effort_entries",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    actorType: text("actor_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }).notNull(),
    actorId: text("actor_id"),
    minutes: integer("minutes").notNull(),
    source: text("source").notNull(),
    note: text("note"),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
    recordedAt: text("recorded_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    correctsEntryId: text("corrects_entry_id").references((): AnySQLiteColumn => effortEntries.id, {
      onDelete: "set null",
    }),
    correctionReason: text("correction_reason"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (table) => [
    index("idx_effort_entries_task").on(table.taskId),
    index("idx_effort_entries_actor").on(table.actorType, table.actorId),
    index("idx_effort_entries_source").on(table.source),
    index("idx_effort_entries_corrects").on(table.correctsEntryId),
  ],
);
