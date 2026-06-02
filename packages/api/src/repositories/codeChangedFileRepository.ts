import { getDb } from "../db/index.js";
import { codeChangedFiles } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { v4 as uuid } from "uuid";

const DEFAULT_CHANGED_FILE_LIST_LIMIT = 500;

export function getById(id: string) {
  const db = getDb();
  const rows = db.select().from(codeChangedFiles).where(eq(codeChangedFiles.id, id)).all();
  return rows.length > 0 ? rows[0] : null;
}

export function create(input: {
  repositoryId?: string | null;
  commitId?: string | null;
  pullRequestId?: string | null;
  provider: string;
  repoSlug?: string | null;
  path: string;
  previousPath?: string | null;
  changeType: "added" | "modified" | "deleted" | "renamed";
  additions?: number | null;
  deletions?: number | null;
  source: string;
  capturedAt?: string;
  metadata?: Record<string, unknown>;
}) {
  const db = getDb();
  const id = uuid();
  const now = input.capturedAt ?? new Date().toISOString();

  db.insert(codeChangedFiles)
    .values({
      id,
      repositoryId: input.repositoryId ?? null,
      commitId: input.commitId ?? null,
      pullRequestId: input.pullRequestId ?? null,
      provider: input.provider,
      repoSlug: input.repoSlug ?? null,
      path: input.path,
      previousPath: input.previousPath ?? null,
      changeType: input.changeType,
      additions: input.additions ?? null,
      deletions: input.deletions ?? null,
      source: input.source,
      capturedAt: now,
      metadata: input.metadata ?? {},
    })
    .run();

  return getById(id);
}

export function createMany(files: Array<Parameters<typeof create>[0]>) {
  if (files.length === 0) return;

  const db = getDb();
  const now = new Date().toISOString();

  db.insert(codeChangedFiles)
    .values(
      files.map((input) => ({
        id: uuid(),
        repositoryId: input.repositoryId ?? null,
        commitId: input.commitId ?? null,
        pullRequestId: input.pullRequestId ?? null,
        provider: input.provider,
        repoSlug: input.repoSlug ?? null,
        path: input.path,
        previousPath: input.previousPath ?? null,
        changeType: input.changeType,
        additions: input.additions ?? null,
        deletions: input.deletions ?? null,
        source: input.source,
        capturedAt: input.capturedAt ?? now,
        metadata: input.metadata ?? {},
      })),
    )
    .run();
}

export function getByCommitId(commitId: string, options?: { limit?: number }) {
  const db = getDb();
  const limit = options?.limit ?? DEFAULT_CHANGED_FILE_LIST_LIMIT;
  return db
    .select()
    .from(codeChangedFiles)
    .where(eq(codeChangedFiles.commitId, commitId))
    .limit(limit)
    .all();
}

export function getByPullRequestId(pullRequestId: string, options?: { limit?: number }) {
  const db = getDb();
  const limit = options?.limit ?? DEFAULT_CHANGED_FILE_LIST_LIMIT;
  return db
    .select()
    .from(codeChangedFiles)
    .where(eq(codeChangedFiles.pullRequestId, pullRequestId))
    .limit(limit)
    .all();
}
