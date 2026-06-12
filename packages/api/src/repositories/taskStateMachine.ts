import { getDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import { eq, and, inArray, sql } from "drizzle-orm";
import type { Task, Artifact } from "../models/index.js";
import { logger } from "../lib/logger.js";
import { isSqliteError } from "../errors/sqlite.js";
import { repositoryTransactionError } from "../errors/repository.js";
import { getTaskById } from "./taskCrud.js";
import { areAllDependenciesMet } from "./taskQueries.js";

export function claimTask(
  taskId: string,
  agentId: string,
): { success: true; task: Task } | { success: false; reason: string } {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    return db.transaction((tx: any) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) return { success: false as const, reason: "not_found" };

      if (task.status !== "pending" || task.assignedAgentId) {
        return { success: false as const, reason: "already_claimed" };
      }

      if (!areAllDependenciesMet(taskId)) {
        return { success: false as const, reason: "dependencies_unmet" };
      }

      tx.update(tasks)
        .set({
          assignedAgentId: agentId,
          status: "claimed",
          claimedAt: now,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        } as unknown as Partial<typeof tasks.$inferInsert>)
        .where(and(eq(tasks.id, taskId), eq(tasks.status, "pending")))
        .run();

      const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      return { success: true as const, task: updated! };
    });
  } catch (err) {
    logger.warn({ err, taskId, agentId }, "Transaction failed during claimTask");
    return { success: false, reason: "already_claimed" };
  }
}

export function claimDelegatedTask(
  taskId: string,
  agentId: string,
): { success: true; task: Task } | { success: false; reason: string } {
  const db = getDb();
  const now = new Date().toISOString();

  try {
    return db.transaction((tx: any) => {
      const task = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      if (!task) return { success: false as const, reason: "not_found" };

      if (task.delegatedToAgentId !== agentId) {
        return { success: false as const, reason: "not_delegated_to_you" };
      }

      if (task.status !== "claimed" && task.status !== "in_progress") {
        return { success: false as const, reason: "invalid_status" };
      }

      tx.update(tasks)
        .set({
          assignedAgentId: agentId,
          delegatedToAgentId: null,
          status: "claimed",
          claimedAt: sql`COALESCE(${tasks.claimedAt}, ${now})`,
          updatedAt: now,
          version: sql`${tasks.version} + 1`,
        } as unknown as Partial<typeof tasks.$inferInsert>)
        .where(eq(tasks.id, taskId))
        .run();

      const updated = tx.select().from(tasks).where(eq(tasks.id, taskId)).get();
      return { success: true as const, task: updated! };
    });
  } catch (err) {
    if (isSqliteError(err) && err.code === "SQLITE_BUSY") {
      logger.warn({ err, taskId, agentId }, "Delegated claim lost race on busy database");
      return { success: false, reason: "claim_failed" };
    }
    if (isSqliteError(err) && err.code.startsWith("SQLITE_CONSTRAINT")) {
      logger.warn({ err, taskId, agentId }, "Delegated claim failed due to constraint violation");
      return { success: false, reason: "claim_failed" };
    }
    logger.error({ err, taskId, agentId }, "Unexpected error during claimDelegatedTask");
    throw repositoryTransactionError("task", err as Error, taskId);
  }
}

export function startTask(taskId: string, agentId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "claimed" || task.assignedAgentId !== agentId) return null;

  db.update(tasks)
    .set({
      status: "in_progress",
      startedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(
      and(eq(tasks.id, taskId), eq(tasks.assignedAgentId, agentId), eq(tasks.status, "claimed")),
    )
    .run();

  return getTaskById(taskId);
}

export function submitTask(
  taskId: string,
  agentId: string,
  result: string,
  artifacts: Artifact[],
): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "in_progress" || task.assignedAgentId !== agentId) return null;

  db.update(tasks)
    .set({
      status: "submitted",
      submittedAt: now,
      result,
      artifacts,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(
      and(
        eq(tasks.id, taskId),
        eq(tasks.assignedAgentId, agentId),
        eq(tasks.status, "in_progress"),
      ),
    )
    .run();

  return getTaskById(taskId);
}

export function releaseTask(taskId: string, _reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "claimed" && task.status !== "in_progress") return null;

  db.update(tasks)
    .set({
      assignedAgentId: null,
      status: "pending",
      claimedAt: null,
      startedAt: null,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(eq(tasks.id, taskId))
    .run();

  return getTaskById(taskId);
}

export function failTask(taskId: string, _reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  const task = getTaskById(taskId);
  if (!task) return null;
  if (task.status !== "in_progress" && task.status !== "claimed") return null;

  db.update(tasks)
    .set({
      status: "failed",
      assignedAgentId: null,
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(eq(tasks.id, taskId))
    .run();

  return getTaskById(taskId);
}

export function approveTask(taskId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: "approved",
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "submitted")))
    .run();

  return getTaskById(taskId);
}

export function markTaskDone(taskId: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: "done",
      completedAt: now,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), inArray(tasks.status, ["submitted", "approved"])))
    .run();

  return getTaskById(taskId);
}

export function rejectTask(taskId: string, reason: string): Task | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(tasks)
    .set({
      status: "rejected",
      rejectionReason: reason,
      rejectedCount: sql`${tasks.rejectedCount} + 1`,
      updatedAt: now,
      version: sql`${tasks.version} + 1`,
    })
    .where(and(eq(tasks.id, taskId), eq(tasks.status, "submitted")))
    .run();

  return getTaskById(taskId);
}
