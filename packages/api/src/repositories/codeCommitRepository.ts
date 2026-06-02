import { getDb } from "../db/index.js";
import { codeCommits } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { CodeEvidenceVerificationState } from "@orcy/shared";
import { logger } from "../lib/logger.js";

export function getById(id: string) {
  const db = getDb();
  const rows = db.select().from(codeCommits).where(eq(codeCommits.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function findByRepoAndSha(
  repositoryId: string | null,
  sha: string,
): (typeof codeCommits.$inferSelect)[] {
  const db = getDb();
  if (repositoryId) {
    return db
      .select()
      .from(codeCommits)
      .where(and(eq(codeCommits.repositoryId, repositoryId), eq(codeCommits.sha, sha)))
      .all();
  }
  logger.warn({ sha }, "Finding code commit without repositoryId may be ambiguous");
  return db.select().from(codeCommits).where(eq(codeCommits.sha, sha)).all();
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
  const db = getDb();

  return db.transaction((tx) => {
    const conditions = input.repositoryId
      ? [eq(codeCommits.repositoryId, input.repositoryId), eq(codeCommits.sha, input.sha)]
      : [eq(codeCommits.sha, input.sha)];

    const matches = tx
      .select()
      .from(codeCommits)
      .where(and(...conditions))
      .all();

    if (matches.length > 0) {
      if (matches.length > 1) {
        logger.warn(
          { sha: input.sha, count: matches.length },
          "Multiple commits found, using first match",
        );
      }
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

      tx.update(codeCommits).set(setValues).where(eq(codeCommits.id, matches[0].id)).run();
      const rows = tx.select().from(codeCommits).where(eq(codeCommits.id, matches[0].id)).all();
      return rows.length > 0 ? rows[0] : null;
    }

    const id = uuid();
    const now = new Date().toISOString();
    tx.insert(codeCommits)
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

    const rows = tx.select().from(codeCommits).where(eq(codeCommits.id, id)).all();
    return rows.length > 0 ? rows[0] : null;
  });
}
