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

export function findByRepoAndName(repositoryId: string | null, name: string) {
  const db = getDb();
  if (repositoryId) {
    const rows = db
      .select()
      .from(codeBranches)
      .where(and(eq(codeBranches.repositoryId, repositoryId), eq(codeBranches.name, name)))
      .all();
    return rows.length > 0 ? rows[0] : null;
  }
  logger.warn({ branchName: name }, "Finding code branch without repositoryId may be ambiguous");
  const rows = db.select().from(codeBranches).where(eq(codeBranches.name, name)).all();
  return rows.length > 0 ? rows[0] : null;
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
  const existing = findByRepoAndName(input.repositoryId ?? null, input.name);
  if (existing) {
    return updateById(existing.id, {
      headSha: input.headSha,
      url: input.url,
      verificationState: input.verificationState,
    });
  }
  return create(input);
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
