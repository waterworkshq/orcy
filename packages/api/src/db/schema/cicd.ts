import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";
import { tasks } from "./task.js";
import { habitatCodeRepositories } from "./code-evidence.js";
import { codeBranches } from "./code-evidence.js";
import { codeCommits } from "./code-evidence.js";

export const pullRequests = sqliteTable(
  "pull_requests",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["github", "gitlab"] }).notNull(),
    repo: text("repo").notNull(),
    prNumber: integer("pr_number").notNull(),
    prTitle: text("pr_title"),
    prUrl: text("pr_url").notNull(),
    branchName: text("branch_name"),
    state: text("state").default("open"),
    reviewStatus: text("review_status").default("pending"),
    repositoryId: text("repository_id").references(() => habitatCodeRepositories.id, {
      onDelete: "set null",
    }),
    branchId: text("branch_id").references(() => codeBranches.id, { onDelete: "set null" }),
    verificationState: text("verification_state", {
      enum: ["verified", "unverified", "stale", "failed"],
    }),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").default("(datetime('now'))"),
    updatedAt: text("updated_at").default("(datetime('now'))"),
  },
  (table) => [
    index("idx_pull_requests_task_id").on(table.taskId),
    index("idx_pull_requests_repository_id").on(table.repositoryId),
    index("idx_pull_requests_branch_id").on(table.branchId),
  ],
);

export const pipelineEvents = sqliteTable(
  "pipeline_events",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: ["github", "gitlab"] }).notNull(),
    repo: text("repo").notNull(),
    runId: text("run_id").notNull(),
    status: text("status", {
      enum: ["queued", "in_progress", "success", "failure", "cancelled"],
    }).notNull(),
    branch: text("branch").notNull(),
    commitSha: text("commit_sha"),
    repositoryId: text("repository_id").references(() => habitatCodeRepositories.id, {
      onDelete: "set null",
    }),
    commitId: text("commit_id").references(() => codeCommits.id, { onDelete: "set null" }),
    branchEvidenceId: text("branch_evidence_id").references(() => codeBranches.id, {
      onDelete: "set null",
    }),
    verificationState: text("verification_state", {
      enum: ["verified", "unverified", "stale", "failed"],
    }),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    createdAt: text("created_at").default("(datetime('now'))"),
    updatedAt: text("updated_at").default("(datetime('now'))"),
  },
  (table) => [
    index("idx_pipeline_events_task_id").on(table.taskId),
    index("idx_pipeline_events_repository_id").on(table.repositoryId),
    index("idx_pipeline_events_commit_id").on(table.commitId),
  ],
);
