import { getDb } from "../db/index.js";
import { codeReviews } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { CodeEvidenceVerificationState, CodeEvidenceReviewStatus } from "@orcy/shared";

export function getById(id: string) {
  const db = getDb();
  const rows = db.select().from(codeReviews).where(eq(codeReviews.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function create(input: {
  pullRequestId?: string | null;
  repositoryId?: string | null;
  provider: string;
  repoSlug?: string | null;
  reviewUrl?: string | null;
  reviewStatus?: CodeEvidenceReviewStatus;
  reviewerName?: string | null;
  reviewerId?: string | null;
  submittedAt?: string | null;
  verificationState?: CodeEvidenceVerificationState;
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(codeReviews)
    .values({
      id,
      pullRequestId: input.pullRequestId ?? null,
      repositoryId: input.repositoryId ?? null,
      provider: input.provider,
      repoSlug: input.repoSlug ?? null,
      reviewUrl: input.reviewUrl ?? null,
      reviewStatus: input.reviewStatus ?? "pending",
      reviewerName: input.reviewerName ?? null,
      reviewerId: input.reviewerId ?? null,
      submittedAt: input.submittedAt ?? null,
      verificationState: input.verificationState ?? "unverified",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getById(id);
}

export function updateById(
  id: string,
  updates: {
    reviewStatus?: CodeEvidenceReviewStatus;
    reviewerName?: string | null;
    reviewerId?: string | null;
    submittedAt?: string | null;
    reviewUrl?: string | null;
    verificationState?: CodeEvidenceVerificationState;
  },
) {
  const db = getDb();
  const now = new Date().toISOString();
  const setValues: Partial<typeof codeReviews.$inferInsert> = { updatedAt: now };

  if (updates.reviewStatus !== undefined) setValues.reviewStatus = updates.reviewStatus;
  if (updates.reviewerName !== undefined) setValues.reviewerName = updates.reviewerName;
  if (updates.reviewerId !== undefined) setValues.reviewerId = updates.reviewerId;
  if (updates.submittedAt !== undefined) setValues.submittedAt = updates.submittedAt;
  if (updates.reviewUrl !== undefined) setValues.reviewUrl = updates.reviewUrl;
  if (updates.verificationState !== undefined)
    setValues.verificationState = updates.verificationState;

  db.update(codeReviews).set(setValues).where(eq(codeReviews.id, id)).run();
  return getById(id);
}

export function getByPullRequestId(pullRequestId: string) {
  const db = getDb();
  return db.select().from(codeReviews).where(eq(codeReviews.pullRequestId, pullRequestId)).all();
}
