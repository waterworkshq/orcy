import { getDb } from "../db/index.js";
import { pipelineEvents } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { PipelineEvent } from "../models/index.js";

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

  return getById(id)!;
}

export function getById(id: string): PipelineEvent | null {
  const db = getDb();
  const rows = db.select().from(pipelineEvents).where(eq(pipelineEvents.id, id)).all();
  return rows.length > 0 ? (rows[0] as PipelineEvent) : null;
}

export function getAll(): PipelineEvent[] {
  const db = getDb();
  return db.select().from(pipelineEvents).all() as PipelineEvent[];
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

  db.update(pipelineEvents).set(setValues).where(eq(pipelineEvents.id, id)).run();
  return getById(id);
}

export function deleteByTaskId(taskId: string): void {
  const db = getDb();
  db.delete(pipelineEvents).where(eq(pipelineEvents.taskId, taskId)).run();
}
