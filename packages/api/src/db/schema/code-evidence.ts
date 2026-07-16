import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { habitats } from "./habitat.js";
import { tasks } from "./task.js";
import { pullRequests } from "./cicd.js";

export const habitatCodeRepositories = sqliteTable(
  "habitat_code_repositories",
  {
    id: text("id").primaryKey(),
    habitatId: text("habitat_id")
      .notNull()
      .references(() => habitats.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerBaseUrl: text("provider_base_url"),
    externalId: text("external_id"),
    repoSlug: text("repo_slug"),
    displayName: text("display_name"),
    localPath: text("local_path"),
    verificationState: text("verification_state", {
      enum: ["verified", "unverified", "stale", "failed"],
    })
      .notNull()
      .default("unverified"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    uniqueIndex("idx_habitat_code_repo_habitat").on(table.habitatId),
    index("idx_habitat_code_repo_provider_slug").on(table.provider, table.repoSlug),
  ],
);

export const codeBranches = sqliteTable(
  "code_branches",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id").references(() => habitatCodeRepositories.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    repoSlug: text("repo_slug"),
    name: text("name").notNull(),
    baseBranch: text("base_branch"),
    headSha: text("head_sha"),
    url: text("url"),
    createdFromTaskId: text("created_from_task_id").references(() => tasks.id, {
      onDelete: "set null",
    }),
    verificationState: text("verification_state", {
      enum: ["verified", "unverified", "stale", "failed"],
    })
      .notNull()
      .default("unverified"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_code_branches_repo_name").on(table.repositoryId, table.name),
    index("idx_code_branches_task").on(table.createdFromTaskId),
  ],
);

export const codeCommits = sqliteTable(
  "code_commits",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id").references(() => habitatCodeRepositories.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    repoSlug: text("repo_slug"),
    sha: text("sha").notNull(),
    branchId: text("branch_id").references(() => codeBranches.id, { onDelete: "set null" }),
    message: text("message"),
    authorName: text("author_name"),
    authorEmail: text("author_email"),
    authoredAt: text("authored_at"),
    url: text("url"),
    verificationState: text("verification_state", {
      enum: ["verified", "unverified", "stale", "failed"],
    })
      .notNull()
      .default("unverified"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_code_commits_repo_sha").on(table.repositoryId, table.sha),
    index("idx_code_commits_sha").on(table.sha),
    index("idx_code_commits_branch").on(table.branchId),
  ],
);

export const codeChangedFiles = sqliteTable(
  "code_changed_files",
  {
    id: text("id").primaryKey(),
    repositoryId: text("repository_id").references(() => habitatCodeRepositories.id, {
      onDelete: "set null",
    }),
    commitId: text("commit_id").references(() => codeCommits.id, { onDelete: "set null" }),
    pullRequestId: text("pull_request_id").references(() => pullRequests.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    repoSlug: text("repo_slug"),
    path: text("path").notNull(),
    previousPath: text("previous_path"),
    changeType: text("change_type", {
      enum: ["added", "modified", "deleted", "renamed"],
    }).notNull(),
    additions: integer("additions"),
    deletions: integer("deletions"),
    source: text("source").notNull(),
    capturedAt: text("captured_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
  },
  (table) => [
    index("idx_code_changed_files_repo_path").on(table.repositoryId, table.path),
    index("idx_code_changed_files_commit").on(table.commitId),
    index("idx_code_changed_files_pr").on(table.pullRequestId),
  ],
);

export const codeReviews = sqliteTable(
  "code_reviews",
  {
    id: text("id").primaryKey(),
    pullRequestId: text("pull_request_id").references(() => pullRequests.id, {
      onDelete: "set null",
    }),
    repositoryId: text("repository_id").references(() => habitatCodeRepositories.id, {
      onDelete: "set null",
    }),
    provider: text("provider").notNull(),
    repoSlug: text("repo_slug"),
    reviewUrl: text("review_url"),
    reviewStatus: text("review_status", {
      enum: ["pending", "approved", "changes_requested", "commented", "dismissed"],
    })
      .notNull()
      .default("pending"),
    reviewerName: text("reviewer_name"),
    reviewerId: text("reviewer_id"),
    submittedAt: text("submitted_at"),
    verificationState: text("verification_state", {
      enum: ["verified", "unverified", "stale", "failed"],
    })
      .notNull()
      .default("unverified"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [
    index("idx_code_reviews_pr").on(table.pullRequestId),
    index("idx_code_reviews_repo_status").on(table.repositoryId, table.reviewStatus),
  ],
);

export const codeEvidenceLinks = sqliteTable(
  "code_evidence_links",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type", { enum: ["task", "mission"] }).notNull(),
    targetId: text("target_id").notNull(),
    evidenceType: text("evidence_type", {
      enum: [
        "branch",
        "pull_request",
        "commit",
        "changed_file",
        "pipeline_run",
        "review",
        "external_url",
      ],
    }).notNull(),
    evidenceId: text("evidence_id"),
    externalUrl: text("external_url"),
    normalizedExternalUrl: text("normalized_external_url"),
    title: text("title"),
    description: text("description"),
    linkSource: text("link_source", {
      enum: [
        "webhook",
        "branch_pattern",
        "commit_trailer",
        "agent_reported",
        "human_manual",
        "migration",
        "api",
        "artifact_mirror",
        "remote",
      ],
    }).notNull(),
    linkSources: text("link_sources", { mode: "json" })
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'`)
      .$defaultFn(() => []),
    linkedByType: text("linked_by_type", {
      enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"],
    }).notNull(),
    linkedById: text("linked_by_id").notNull(),
    linkedAt: text("linked_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    verificationState: text("verification_state", {
      enum: ["verified", "unverified", "stale", "failed"],
    })
      .notNull()
      .default("unverified"),
    confidence: real("confidence"),
    status: text("status", { enum: ["active", "superseded", "incorrect", "removed"] })
      .notNull()
      .default("active"),
    correctedByType: text("corrected_by_type"),
    correctedById: text("corrected_by_id"),
    correctedAt: text("corrected_at"),
    correctionReason: text("correction_reason"),
    replacementLinkId: text("replacement_link_id").references((): any => codeEvidenceLinks.id, {
      onDelete: "set null",
    }),
    allowExternalRepository: integer("allow_external_repository", { mode: "boolean" })
      .notNull()
      .default(false),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
  },
  (table) => [
    index("idx_evidence_links_target_status").on(table.targetType, table.targetId, table.status),
    index("idx_evidence_links_evidence").on(table.evidenceType, table.evidenceId),
    index("idx_code_evidence_links_linked_by").on(table.linkedByType, table.linkedById),
  ],
);

export const codeEvidenceCompleteness = sqliteTable(
  "code_evidence_completeness",
  {
    targetType: text("target_type", { enum: ["task", "mission"] }).notNull(),
    targetId: text("target_id").notNull(),
    status: text("status", {
      enum: ["complete", "partial", "missing", "not_applicable", "unknown"],
    }).notNull(),
    reasonCode: text("reason_code"),
    reasonNote: text("reason_note"),
    markedByType: text("marked_by_type", { enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"] }).notNull(),
    markedById: text("marked_by_id").notNull(),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(datetime('now'))`),
  },
  (table) => [uniqueIndex("idx_evidence_completeness_target").on(table.targetType, table.targetId)],
);

export const codeEvidenceGaps = sqliteTable(
  "code_evidence_gaps",
  {
    id: text("id").primaryKey(),
    targetType: text("target_type", { enum: ["task", "mission"] }).notNull(),
    targetId: text("target_id").notNull(),
    reasonCode: text("reason_code").notNull(),
    reasonNote: text("reason_note"),
    status: text("status", { enum: ["active", "resolved"] })
      .notNull()
      .default("active"),
    reportedByType: text("reported_by_type", { enum: ["human", "agent", "system", "remote_human", "remote_orcy", "remote_pod"] }).notNull(),
    reportedById: text("reported_by_id").notNull(),
    reportedAt: text("reported_at")
      .notNull()
      .default(sql`(datetime('now'))`),
    resolvedByType: text("resolved_by_type"),
    resolvedById: text("resolved_by_id"),
    resolvedAt: text("resolved_at"),
    resolutionReason: text("resolution_reason"),
    metadata: text("metadata", { mode: "json" })
      .$type<Record<string, unknown>>()
      .notNull()
      .default(sql`'{}'`)
      .$defaultFn(() => ({})),
  },
  (table) => [
    index("idx_evidence_gaps_target_status").on(table.targetType, table.targetId, table.status),
    index("idx_evidence_gaps_reason_status").on(table.reasonCode, table.status),
    index("idx_code_evidence_gaps_reported_by").on(table.reportedByType, table.reportedById),
  ],
);
