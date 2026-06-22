import { getDb } from "../db/index.js";
import { failureContexts } from "../db/schema/index.js";
import { eq, and, desc, isNull } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import type { FailureBundle } from "../models/index.js";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
} from "../errors/repository.js";

/** Failure categories captured by the recovery subsystem, mirroring the `failureContexts.failureKind` enum. */
export type FailureKind = "lifecycle_failed" | "lifecycle_rejected" | "heartbeat_lost" | "manual";

/** Terminal states for a `failureContexts` row, mirroring the `failureContexts.resolutionKind` enum. */
export type ResolutionKind = "redeemed" | "unrecoverable" | "superseded" | "manual_intervention";

/** Row shape returned by failure-context repository reads; the `bundle` column is typed via `$type<FailureBundle>`. */
export interface FailureContextRow {
  id: string;
  failedTaskId: string;
  workflowId: string | null;
  habitatId: string;
  failureKind: FailureKind;
  failureReason: string;
  failedAt: string;
  failedByAgentId: string | null;
  bundle: FailureBundle;
  bundleSchemaVersion: number;
  recoveryTaskId: string | null;
  recoveryDepth: number;
  resolvedAt: string | null;
  resolutionKind: ResolutionKind | null;
}

/** Input shape for creating a failure context row with a pre-built FailureBundle. */
export interface CreateFailureContextInput {
  failedTaskId: string;
  workflowId?: string | null;
  habitatId: string;
  failureKind: FailureKind;
  failureReason?: string;
  failedByAgentId?: string | null;
  bundle: FailureBundle;
  bundleSchemaVersion?: number;
  recoveryDepth?: number;
}

function rowToFailureContext(row: Record<string, unknown>): FailureContextRow {
  return {
    id: row.id as string,
    failedTaskId: row.failedTaskId as string,
    workflowId: (row.workflowId as string | null) ?? null,
    habitatId: row.habitatId as string,
    failureKind: row.failureKind as FailureKind,
    failureReason: (row.failureReason as string) ?? "",
    failedAt: row.failedAt as string,
    failedByAgentId: (row.failedByAgentId as string | null) ?? null,
    bundle: row.bundle as FailureBundle,
    bundleSchemaVersion: (row.bundleSchemaVersion as number) ?? 1,
    recoveryTaskId: (row.recoveryTaskId as string | null) ?? null,
    recoveryDepth: (row.recoveryDepth as number) ?? 0,
    resolvedAt: (row.resolvedAt as string | null) ?? null,
    resolutionKind: (row.resolutionKind as ResolutionKind | null) ?? null,
  };
}

/** Inserts a `failureContexts` row with `bundleSchemaVersion=1` and returns the persisted row. */
export function createFailureContext(input: CreateFailureContextInput): FailureContextRow {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(failureContexts)
      .values({
        id,
        failedTaskId: input.failedTaskId,
        workflowId: input.workflowId ?? null,
        habitatId: input.habitatId,
        failureKind: input.failureKind,
        failureReason: input.failureReason ?? "",
        failedAt: now,
        failedByAgentId: input.failedByAgentId ?? null,
        bundle: input.bundle,
        bundleSchemaVersion: input.bundleSchemaVersion ?? 1,
        recoveryDepth: input.recoveryDepth ?? 0,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("failureContext", err as Error, id);
  }

  const row = getFailureContextById(id);
  if (!row) throw repositoryNotFoundError("failureContext", id);
  return row;
}

/** Returns a `failureContexts` row by id, or null when missing. */
export function getFailureContextById(id: string): FailureContextRow | null {
  const db = getDb();
  const row = db.select().from(failureContexts).where(eq(failureContexts.id, id)).get();
  return row ? rowToFailureContext(row) : null;
}

/** Returns the most recent unresolved `failureContexts` row for a task, or null when none exist. */
export function getUnresolvedFailureContextByTaskId(taskId: string): FailureContextRow | null {
  const db = getDb();
  const row = db
    .select()
    .from(failureContexts)
    .where(and(eq(failureContexts.failedTaskId, taskId), isNull(failureContexts.resolvedAt)))
    .orderBy(desc(failureContexts.failedAt))
    .get();
  return row ? rowToFailureContext(row) : null;
}

/** Returns every `failureContexts` row for a task (resolved or not), newest first. */
export function getFailureContextsByTaskId(taskId: string): FailureContextRow[] {
  const db = getDb();
  return db
    .select()
    .from(failureContexts)
    .where(eq(failureContexts.failedTaskId, taskId))
    .orderBy(desc(failureContexts.failedAt))
    .all()
    .map(rowToFailureContext);
}

/** Returns every `failureContexts` row attached to a workflow (resolved or not), newest first. */
export function getFailureContextsByWorkflowId(workflowId: string): FailureContextRow[] {
  const db = getDb();
  return db
    .select()
    .from(failureContexts)
    .where(eq(failureContexts.workflowId, workflowId))
    .orderBy(desc(failureContexts.failedAt))
    .all()
    .map(rowToFailureContext);
}

/** Partial update shape for modifying a failure context row (e.g., linking a recovery task or resolving). */
export interface UpdateFailureContextInput {
  workflowId?: string | null;
  failureReason?: string;
  bundle?: FailureBundle;
  bundleSchemaVersion?: number;
  recoveryTaskId?: string | null;
  recoveryDepth?: number;
  resolvedAt?: string | null;
  resolutionKind?: ResolutionKind | null;
}

/** Updates a `failureContexts` row by id; only the provided fields are written. */
export function updateFailureContext(id: string, updates: UpdateFailureContextInput): void {
  const db = getDb();

  type FailureContextUpdate = Partial<typeof failureContexts.$inferInsert>;
  const set: FailureContextUpdate = {};

  if (updates.workflowId !== undefined) set.workflowId = updates.workflowId;
  if (updates.failureReason !== undefined) set.failureReason = updates.failureReason;
  if (updates.bundle !== undefined) set.bundle = updates.bundle;
  if (updates.bundleSchemaVersion !== undefined)
    set.bundleSchemaVersion = updates.bundleSchemaVersion;
  if (updates.recoveryTaskId !== undefined) set.recoveryTaskId = updates.recoveryTaskId;
  if (updates.recoveryDepth !== undefined) set.recoveryDepth = updates.recoveryDepth;
  if (updates.resolvedAt !== undefined) set.resolvedAt = updates.resolvedAt;
  if (updates.resolutionKind !== undefined) set.resolutionKind = updates.resolutionKind;

  try {
    db.update(failureContexts).set(set).where(eq(failureContexts.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("failureContext", err as Error, id);
  }
}

/** Marks a `failureContexts` row as resolved with the given resolution kind and a current timestamp. */
export function resolveFailureContext(id: string, resolution: ResolutionKind): void {
  updateFailureContext(id, {
    resolvedAt: new Date().toISOString(),
    resolutionKind: resolution,
  });
}

/** Convenience: links a spawned recovery task back to its failure context row. */
export function linkRecoveryTask(contextId: string, recoveryTaskId: string): void {
  updateFailureContext(contextId, { recoveryTaskId });
}
