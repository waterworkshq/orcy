import { getDb } from "../db/index.js";
import { taskSubtasks } from "../db/schema/index.js";
import { and, eq, sql, inArray, asc } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface Subtask {
  id: string;
  taskId: string;
  title: string;
  completed: boolean;
  order: number;
  assigneeId: string | null;
  createdAt: string;
  updatedAt: string;
}

export function createSubtask(input: {
  taskId: string;
  title: string;
  order?: number;
  assigneeId?: string | null;
}): Subtask {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(taskSubtasks)
      .values({
        id,
        taskId: input.taskId,
        title: input.title,
        completed: false,
        order: input.order ?? 0,
        assigneeId: input.assigneeId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("subtask", err as Error, id);
  }

  const subtask = getSubtaskById(id);
  if (!subtask) throw repositoryNotFoundError("subtask", id);
  return subtask;
}

export function getSubtasksByTaskId(taskId: string): Subtask[] {
  const db = getDb();
  return db
    .select()
    .from(taskSubtasks)
    .where(eq(taskSubtasks.taskId, taskId))
    .orderBy(asc(taskSubtasks.order))
    .all() as Subtask[];
}

export function getSubtaskById(subtaskId: string): Subtask | null {
  const db = getDb();
  const row = db.select().from(taskSubtasks).where(eq(taskSubtasks.id, subtaskId)).get();
  return (row as Subtask) ?? null;
}

/**
 * Updates a subtask ONLY under its required parent Task: the actual UPDATE
 * statement matches `id = subtaskId AND task_id = taskId` and returns the
 * rows THIS statement matched via `UPDATE ... RETURNING` (the cross-driver
 * pattern from `removeTaskDependency`), so a zero-match — absent child or a
 * child that now belongs to another Task — is a null result, never a false
 * success. There is deliberately no unconditional post-write ID refetch.
 */
export function updateSubtask(
  taskId: string,
  subtaskId: string,
  data: { title?: string; completed?: boolean; order?: number; assigneeId?: string | null },
): Subtask | null {
  const db = getDb();
  const now = new Date().toISOString();

  const set: Record<string, unknown> = { updatedAt: now };
  if (data.title !== undefined) set.title = data.title;
  if (data.completed !== undefined) set.completed = data.completed;
  if (data.order !== undefined) set.order = data.order;
  if (data.assigneeId !== undefined) set.assigneeId = data.assigneeId;

  try {
    const matched = db
      .update(taskSubtasks)
      .set(set)
      .where(and(eq(taskSubtasks.id, subtaskId), eq(taskSubtasks.taskId, taskId)))
      .returning()
      .all();
    return (matched[0] as Subtask | undefined) ?? null;
  } catch (err) {
    throw repositoryUpdateError("subtask", err as Error, subtaskId);
  }
}

/**
 * Deletes a subtask ONLY under its required parent Task via
 * `DELETE ... WHERE id = subtaskId AND task_id = taskId RETURNING id`, so
 * success reflects the rows THIS statement actually removed — on both the
 * sql.js (test) and better-sqlite3 (production) drivers.
 */
export function deleteSubtask(taskId: string, subtaskId: string): boolean {
  const db = getDb();
  try {
    const matched = db
      .delete(taskSubtasks)
      .where(and(eq(taskSubtasks.id, subtaskId), eq(taskSubtasks.taskId, taskId)))
      .returning({ id: taskSubtasks.id })
      .all();
    return matched.length > 0;
  } catch (err) {
    throw repositoryDeleteError("subtask", err as Error, subtaskId);
  }
}

export function getSubtaskCounts(
  taskIds: string[],
): Record<string, { total: number; completed: number }> {
  if (taskIds.length === 0) return {};

  const db = getDb();
  const rows = db
    .select({
      taskId: taskSubtasks.taskId,
      total: sql<number>`COUNT(*)`,
      completed: sql<number>`SUM(CASE WHEN ${taskSubtasks.completed} = 1 THEN 1 ELSE 0 END)`,
    })
    .from(taskSubtasks)
    .where(inArray(taskSubtasks.taskId, taskIds))
    .groupBy(taskSubtasks.taskId)
    .all();

  const result: Record<string, { total: number; completed: number }> = {};
  for (const row of rows) {
    result[row.taskId] = { total: row.total, completed: row.completed };
  }
  return result;
}
