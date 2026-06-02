import { getDb } from "../db/index.js";
import { codeBranches } from "../db/schema/index.js";
import { eq, and } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { CodeEvidenceVerificationState } from "@orcy/shared";
import { logger } from "../lib/logger.js";

export function getById(id: string) {
  const db = getDb();
  const rows = db.select().from(codeBranches).where(eq(codeBranches.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function findByRepoAndName(
  repositoryId: string | null,
  name: string,
): (typeof codeBranches.$inferSelect)[] {
  const db = getDb();
  if (repositoryId) {
    return db
      .select()
      .from(codeBranches)
      .where(and(eq(codeBranches.repositoryId, repositoryId), eq(codeBranches.name, name)))
      .all();
  }
  logger.warn({ branchName: name }, "Finding code branch without repositoryId may be ambiguous");
  return db.select().from(codeBranches).where(eq(codeBranches.name, name)).all();
}

export function create(input: {
  repositoryId?: string | null;
  provider: string;
  repoSlug?: string | null;
  name: string;
  baseBranch?: string | null;
  headSha?: string | null;
  url?: string | null;
  createdFromTaskId?: string | null;
  verificationState?: CodeEvidenceVerificationState;
}) {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(codeBranches)
    .values({
      id,
      repositoryId: input.repositoryId ?? null,
      provider: input.provider,
      repoSlug: input.repoSlug ?? null,
      name: input.name,
      baseBranch: input.baseBranch ?? null,
      headSha: input.headSha ?? null,
      url: input.url ?? null,
      createdFromTaskId: input.createdFromTaskId ?? null,
      verificationState: input.verificationState ?? "unverified",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  return getById(id);
}

export function upsertByRepoAndName(input: Parameters<typeof create>[0]) {
  const db = getDb();

  return db.transaction((tx) => {
    const conditions = input.repositoryId
      ? [eq(codeBranches.repositoryId, input.repositoryId), eq(codeBranches.name, input.name)]
      : [eq(codeBranches.name, input.name)];

    const matches = tx
      .select()
      .from(codeBranches)
      .where(and(...conditions))
      .all();

    if (matches.length > 0) {
      if (matches.length > 1) {
        logger.warn(
          { branchName: input.name, count: matches.length },
          "Multiple branches found, using first match",
        );
      }
      const now = new Date().toISOString();
      tx.update(codeBranches)
        .set({
          headSha: input.headSha ?? null,
          url: input.url ?? null,
          verificationState: input.verificationState ?? "unverified",
          updatedAt: now,
        })
        .where(eq(codeBranches.id, matches[0].id))
        .run();
      const rows = tx.select().from(codeBranches).where(eq(codeBranches.id, matches[0].id)).all();
      return rows.length > 0 ? rows[0] : null;
    }

    const id = uuid();
    const now = new Date().toISOString();
    tx.insert(codeBranches)
      .values({
        id,
        repositoryId: input.repositoryId ?? null,
        provider: input.provider,
        repoSlug: input.repoSlug ?? null,
        name: input.name,
        baseBranch: input.baseBranch ?? null,
        headSha: input.headSha ?? null,
        url: input.url ?? null,
        createdFromTaskId: input.createdFromTaskId ?? null,
        verificationState: input.verificationState ?? "unverified",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const rows = tx.select().from(codeBranches).where(eq(codeBranches.id, id)).all();
    return rows.length > 0 ? rows[0] : null;
  });
}

export function updateById(
  id: string,
  updates: {
    headSha?: string | null;
    url?: string | null;
    verificationState?: CodeEvidenceVerificationState;
  },
) {
  const db = getDb();
  const now = new Date().toISOString();
  const setValues: Partial<typeof codeBranches.$inferInsert> = { updatedAt: now };

  if (updates.headSha !== undefined) setValues.headSha = updates.headSha;
  if (updates.url !== undefined) setValues.url = updates.url;
  if (updates.verificationState !== undefined)
    setValues.verificationState = updates.verificationState;

  db.update(codeBranches).set(setValues).where(eq(codeBranches.id, id)).run();
  return getById(id);
}
