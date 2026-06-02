import { getDb } from "../db/index.js";
import { taskSubtasks } from "../db/schema/index.js";
import { eq, sql, inArray, asc } from "drizzle-orm";
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

export function updateSubtask(
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
    db.update(taskSubtasks).set(set).where(eq(taskSubtasks.id, subtaskId)).run();
  } catch (err) {
    throw repositoryUpdateError("subtask", err as Error, subtaskId);
  }

  return getSubtaskById(subtaskId);
}

export function deleteSubtask(subtaskId: string): boolean {
  const db = getDb();
  try {
    db.delete(taskSubtasks).where(eq(taskSubtasks.id, subtaskId)).run();
  } catch (err) {
    throw repositoryDeleteError("subtask", err as Error, subtaskId);
  }
  return true;
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
