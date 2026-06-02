import { getDb } from "../db/index.js";
import { pipelineEvents } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { PipelineEvent } from "../models/index.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export function createPipelineEvent(pe: {
  taskId: string;
  provider: "github" | "gitlab";
  repo: string;
  runId: string;
  status: PipelineEvent["status"];
  branch: string;
  commitSha?: string | null;
}): PipelineEvent {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(pipelineEvents)
      .values({
        id,
        taskId: pe.taskId,
        provider: pe.provider,
        repo: pe.repo,
        runId: pe.runId,
        status: pe.status,
        branch: pe.branch,
        commitSha: pe.commitSha ?? null,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("pipelineEvent", err as Error, id);
  }

  const created = getById(id);
  if (!created) {
    throw repositoryNotFoundError("pipelineEvent", id);
  }
  return created;
}

export function getById(id: string): PipelineEvent | null {
  const db = getDb();
  const rows = db.select().from(pipelineEvents).where(eq(pipelineEvents.id, id)).all();
  return rows.length > 0 ? (rows[0] as PipelineEvent) : null;
}

export function getAll(options?: { limit?: number }): PipelineEvent[] {
  const db = getDb();
  const limit = options?.limit ?? 1000;
  return db
    .select()
    .from(pipelineEvents)
    .orderBy(sql`${pipelineEvents.createdAt} DESC`)
    .limit(limit)
    .all() as PipelineEvent[];
}

export function getByTaskId(taskId: string): PipelineEvent[] {
  const db = getDb();
  return db
    .select()
    .from(pipelineEvents)
    .where(eq(pipelineEvents.taskId, taskId))
    .orderBy(sql`${pipelineEvents.createdAt} DESC`)
    .all() as PipelineEvent[];
}

export function findByProviderAndRunId(
  provider: "github" | "gitlab",
  repo: string,
  runId: string,
): PipelineEvent | null {
  const db = getDb();
  const rows = db
    .select()
    .from(pipelineEvents)
    .where(
      and(
        eq(pipelineEvents.provider, provider),
        eq(pipelineEvents.repo, repo),
        eq(pipelineEvents.runId, runId),
      ),
    )
    .all();
  return rows.length > 0 ? (rows[0] as PipelineEvent) : null;
}

export function updatePipelineEvent(
  id: string,
  updates: {
    status?: PipelineEvent["status"];
    commitSha?: string;
  },
): PipelineEvent | null {
  const db = getDb();
  const setValues: Partial<typeof pipelineEvents.$inferInsert> = {};

  if (updates.status !== undefined) setValues.status = updates.status;
  if (updates.commitSha !== undefined) setValues.commitSha = updates.commitSha;

  if (Object.keys(setValues).length === 0) return getById(id);

  try {
    db.update(pipelineEvents).set(setValues).where(eq(pipelineEvents.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("pipelineEvent", err as Error, id);
  }
  return getById(id);
}

export function deleteByTaskId(taskId: string): boolean {
  const db = getDb();
  const existing = db.select().from(pipelineEvents).where(eq(pipelineEvents.taskId, taskId)).all();
  if (existing.length === 0) return false;
  try {
    db.delete(pipelineEvents).where(eq(pipelineEvents.taskId, taskId)).run();
  } catch (err) {
    throw repositoryDeleteError("pipelineEvent", err as Error, taskId);
  }
  return true;
}
