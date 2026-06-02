import { getDb } from "../db/index.js";
import { taskReviewers } from "../db/schema/index.js";
import { eq, and, sql } from "drizzle-orm";
import type { TaskReviewer, ReviewerStatus } from "@orcy/shared";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export function getByTaskId(taskId: string): TaskReviewer[] {
  const db = getDb();
  return db
    .select()
    .from(taskReviewers)
    .where(eq(taskReviewers.taskId, taskId))
    .all() as TaskReviewer[];
}

export function getById(id: string): TaskReviewer | null {
  const db = getDb();
  return db
    .select()
    .from(taskReviewers)
    .where(eq(taskReviewers.id, id))
    .get() as TaskReviewer | null;
}

export function create(
  taskId: string,
  reviewerType: "human" | "agent",
  reviewerId: string,
): TaskReviewer {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(taskReviewers)
      .values({
        id,
        taskId,
        reviewerType,
        reviewerId,
        status: "pending",
        assignedAt: now,
        reviewedAt: null,
        reviewNote: null,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("taskReviewer", err as Error, id);
  }

  const result = getById(id);
  if (!result) throw repositoryNotFoundError("taskReviewer", id);
  return result;
}

export function updateStatus(
  id: string,
  status: ReviewerStatus,
  reviewNote?: string,
): TaskReviewer | null {
  const db = getDb();
  const now = new Date().toISOString();

  const values: Record<string, unknown> = { status, reviewedAt: now };
  if (reviewNote !== undefined) values.reviewNote = reviewNote;

  try {
    db.update(taskReviewers)
      .set(values as any)
      .where(eq(taskReviewers.id, id))
      .run();
  } catch (err) {
    throw repositoryUpdateError("taskReviewer", err as Error, id);
  }
  return getById(id);
}

export function getApprovedCount(taskId: string): number {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(taskReviewers)
    .where(and(eq(taskReviewers.taskId, taskId), eq(taskReviewers.status, "approved")))
    .get();
  return result?.count ?? 0;
}

export function getPendingCountByReviewer(reviewerId: string): number {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`count(*)` })
    .from(taskReviewers)
    .where(and(eq(taskReviewers.reviewerId, reviewerId), eq(taskReviewers.status, "pending")))
    .get();
  return result?.count ?? 0;
}

export function getPendingReviewers(taskId: string): TaskReviewer[] {
  const db = getDb();
  return db
    .select()
    .from(taskReviewers)
    .where(and(eq(taskReviewers.taskId, taskId), eq(taskReviewers.status, "pending")))
    .all() as TaskReviewer[];
}

export function findByTaskAndReviewer(taskId: string, reviewerId: string): TaskReviewer | null {
  const db = getDb();
  const row = db
    .select()
    .from(taskReviewers)
    .where(and(eq(taskReviewers.taskId, taskId), eq(taskReviewers.reviewerId, reviewerId)))
    .get();
  return (row as TaskReviewer) ?? null;
}

export function remove(id: string): boolean {
  const db = getDb();
  try {
    const result = db.delete(taskReviewers).where(eq(taskReviewers.id, id)).run();
    return result.changes > 0;
  } catch (err) {
    throw repositoryDeleteError("taskReviewer", err as Error, id);
  }
}

export function removeAllForTask(taskId: string): number {
  const db = getDb();
  try {
    const result = db.delete(taskReviewers).where(eq(taskReviewers.taskId, taskId)).run();
    return result.changes;
  } catch (err) {
    throw repositoryDeleteError("taskReviewer", err as Error, taskId);
  }
}
