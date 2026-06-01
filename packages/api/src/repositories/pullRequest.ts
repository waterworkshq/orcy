import { getDb } from "../db/index.js";
import { pullRequests } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { PullRequest } from "../models/index.js";

export function createPullRequest(pr: {
  taskId: string;
  provider: "github" | "gitlab";
  repo: string;
  prNumber: number;
  prTitle?: string;
  prUrl: string;
  branchName?: string;
  state?: "open" | "merged" | "closed";
  reviewStatus?: "pending" | "approved" | "changes_requested";
}): PullRequest {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(pullRequests)
    .values({
      id,
      taskId: pr.taskId,
      provider: pr.provider,
      repo: pr.repo,
      prNumber: pr.prNumber,
      prTitle: pr.prTitle ?? null,
      prUrl: pr.prUrl,
      branchName: pr.branchName ?? null,
      state: pr.state ?? "open",
      reviewStatus: pr.reviewStatus ?? "pending",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const created = getById(id);
  if (!created) {
    throw new Error(`Failed to retrieve pull_request after insert: id=${id}`);
  }
  return created;
}

export function getById(id: string): PullRequest | null {
  const db = getDb();
  const rows = db.select().from(pullRequests).where(eq(pullRequests.id, id)).all();
  return rows.length > 0 ? (rows[0] as PullRequest) : null;
}

export function getAll(options?: { limit?: number }): PullRequest[] {
  const db = getDb();
  const limit = options?.limit ?? 1000;
  return db
    .select()
    .from(pullRequests)
    .orderBy(sql`${pullRequests.createdAt} DESC`)
    .limit(limit)
    .all() as PullRequest[];
}

export function getByTaskId(taskId: string): PullRequest[] {
  const db = getDb();
  return db
    .select()
    .from(pullRequests)
    .where(eq(pullRequests.taskId, taskId))
    .orderBy(sql`${pullRequests.createdAt} DESC`)
    .all() as PullRequest[];
}

export function findByProviderAndNumber(
  provider: "github" | "gitlab",
  repo: string,
  prNumber: number,
): PullRequest | null {
  const db = getDb();
  const rows = db
    .select()
    .from(pullRequests)
    .where(
      and(
        eq(pullRequests.provider, provider),
        eq(pullRequests.repo, repo),
        eq(pullRequests.prNumber, prNumber),
      ),
    )
    .all();
  return rows.length > 0 ? (rows[0] as PullRequest) : null;
}

export function updatePullRequest(
  id: string,
  updates: {
    prTitle?: string;
    state?: "open" | "merged" | "closed";
    reviewStatus?: "pending" | "approved" | "changes_requested";
  },
): PullRequest | null {
  const db = getDb();
  const now = new Date().toISOString();
  const setValues: Partial<typeof pullRequests.$inferInsert> = { updatedAt: now };

  if (updates.prTitle !== undefined) setValues.prTitle = updates.prTitle;
  if (updates.state !== undefined) setValues.state = updates.state;
  if (updates.reviewStatus !== undefined) setValues.reviewStatus = updates.reviewStatus;

  db.update(pullRequests).set(setValues).where(eq(pullRequests.id, id)).run();
  return getById(id);
}

export function deleteByTaskId(taskId: string): void {
  const db = getDb();
  db.delete(pullRequests).where(eq(pullRequests.taskId, taskId)).run();
}

const MAX_PATTERN_LENGTH = 256;

function isUnsafeRegexPattern(pattern: string): boolean {
  if (/[+*]\s*[+*]/.test(pattern)) return true;
  if (/\)\s*[+*]\s*[+*]/.test(pattern)) return true;
  if (/\([^)]*[+*]\s*\)\s*[+*]/.test(pattern)) return true;
  if (/\([^)]*\|[^)]*\)\s*[+*]/.test(pattern)) return true;
  return false;
}

export function findTaskIdByPattern(text: string, pattern: string): string | null {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_PATTERN_LENGTH) {
    return null;
  }

  if (isUnsafeRegexPattern(pattern)) {
    return null;
  }

  try {
    const re = new RegExp(pattern);
    const execResult = re.exec(text);
    if (execResult && execResult[1]) return execResult[1];
    if (execResult) return execResult[0];
  } catch {
    return null;
  }
  return null;
}
