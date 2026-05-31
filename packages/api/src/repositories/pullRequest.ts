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

  return getById(id)!;
}

export function getById(id: string): PullRequest | null {
  const db = getDb();
  const rows = db.select().from(pullRequests).where(eq(pullRequests.id, id)).all();
  return rows.length > 0 ? (rows[0] as PullRequest) : null;
}

export function getAll(): PullRequest[] {
  const db = getDb();
  return db.select().from(pullRequests).all() as PullRequest[];
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

export function findTaskIdByPattern(text: string, pattern: string): string | null {
  try {
    const re = new RegExp(pattern);
    const match = re.exec(text);
    if (match && match[1]) return match[1];
    if (match) return match[0];
  } catch {
    return null;
  }
  return null;
}
