import { getDb } from "../db/index.js";
import { codeCommits } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { CodeEvidenceVerificationState } from "@orcy/shared";

export function getById(id: string) {
  const db = getDb();
  const rows = db.select().from(codeCommits).where(eq(codeCommits.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function findByRepoAndSha(repositoryId: string | null, sha: string) {
  const db = getDb();
  if (repositoryId) {
    const rows = db
      .select()
      .from(codeCommits)
      .where(and(eq(codeCommits.repositoryId, repositoryId), eq(codeCommits.sha, sha)))
      .all();
    return rows.length > 0 ? rows[0] : null;
  }
  const rows = db.select().from(codeCommits).where(eq(codeCommits.sha, sha)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function create(input: {
  repositoryId?: string | null;
  provider: string;
  repoSlug?: string | null;
  sha: string;
  branchId?: string | null;
  message?: string | null;
  authorName?: string | null;
  authorEmail?: string | null;
  authoredAt?: string | null;
  url?: string | null;
  verificationState?: CodeEvidenceVerificationState;
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(codeCommits)
    .values({
      id,
      repositoryId: input.repositoryId ?? null,
      provider: input.provider,
      repoSlug: input.repoSlug ?? null,
      sha: input.sha,
      branchId: input.branchId ?? null,
      message: input.message ?? null,
      authorName: input.authorName ?? null,
      authorEmail: input.authorEmail ?? null,
      authoredAt: input.authoredAt ?? null,
      url: input.url ?? null,
      verificationState: input.verificationState ?? "unverified",
      metadata: input.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getById(id);
}

export function upsertByRepoAndSha(input: Parameters<typeof create>[0]) {
  const existing = findByRepoAndSha(input.repositoryId ?? null, input.sha);
  if (existing) {
    const db = getDb();
    const now = new Date().toISOString();
    const setValues: Partial<typeof codeCommits.$inferInsert> = { updatedAt: now };

    if (input.message !== undefined) setValues.message = input.message;
    if (input.authorName !== undefined) setValues.authorName = input.authorName;
    if (input.authorEmail !== undefined) setValues.authorEmail = input.authorEmail;
    if (input.authoredAt !== undefined) setValues.authoredAt = input.authoredAt;
    if (input.url !== undefined) setValues.url = input.url;
    if (input.verificationState !== undefined)
      setValues.verificationState = input.verificationState;
    if (input.branchId !== undefined) setValues.branchId = input.branchId;

    db.update(codeCommits).set(setValues).where(eq(codeCommits.id, existing.id)).run();
    return getById(existing.id);
  }
  return create(input);
}
