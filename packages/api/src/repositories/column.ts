import { getDb } from '../db/index.js';
import { columns, features } from '../db/schema/index.js';
import { eq, and, max, count } from 'drizzle-orm';
import type { Column } from '../models/index.js';
import { v4 as uuid } from 'uuid';

export interface CreateColumnInput {
  boardId: string;
  name: string;
  order?: number;
  wipLimit?: number | null;
  autoAdvance?: boolean;
  requiresClaim?: boolean;
  nextColumnId?: string | null;
  isTerminal?: boolean;
}

export interface UpdateColumnInput {
  name?: string;
  order?: number;
  wipLimit?: number | null;
  autoAdvance?: boolean;
  requiresClaim?: boolean;
  nextColumnId?: string | null;
  isTerminal?: boolean;
}

export function createColumn(input: CreateColumnInput): Column {
  const db = getDb();
  const id = uuid();

  let order = input.order;
  if (order === undefined) {
    const result = db
      .select({ maxOrder: max(columns.order) })
      .from(columns)
      .where(eq(columns.boardId, input.boardId))
      .get();
    order = (result?.maxOrder ?? -1) + 1;
  }

  db.insert(columns).values({
    id,
    boardId: input.boardId,
    name: input.name,
    order,
    wipLimit: input.wipLimit ?? null,
    autoAdvance: input.autoAdvance ?? false,
    requiresClaim: input.requiresClaim !== false,
    nextColumnId: input.nextColumnId ?? null,
    isTerminal: input.isTerminal ?? false,
  }).run();

  return getColumnById(id)!;
}

export function getColumnById(id: string): Column | null {
  const db = getDb();
  const row = db
    .select()
    .from(columns)
    .where(eq(columns.id, id))
    .get();
  return row ?? null;
}

export function getColumnByName(boardId: string, name: string): Column | null {
  const db = getDb();
  const row = db
    .select()
    .from(columns)
    .where(and(eq(columns.boardId, boardId), eq(columns.name, name)))
    .get();
  return row ?? null;
}

export function getColumnsByBoardId(boardId: string): Column[] {
  const db = getDb();
  return db
    .select()
    .from(columns)
    .where(eq(columns.boardId, boardId))
    .orderBy(columns.order)
    .all();
}

export function updateColumn(id: string, input: UpdateColumnInput): Column | null {
  const db = getDb();
  const values: Partial<typeof columns.$inferInsert> = {};

  if (input.name !== undefined) values.name = input.name;
  if (input.order !== undefined) values.order = input.order;
  if (input.wipLimit !== undefined) values.wipLimit = input.wipLimit;
  if (input.autoAdvance !== undefined) values.autoAdvance = input.autoAdvance;
  if (input.requiresClaim !== undefined) values.requiresClaim = input.requiresClaim;
  if (input.nextColumnId !== undefined) values.nextColumnId = input.nextColumnId;
  if (input.isTerminal !== undefined) values.isTerminal = input.isTerminal;

  if (Object.keys(values).length === 0) return getColumnById(id);

  db.update(columns)
    .set(values)
    .where(eq(columns.id, id))
    .run();
  return getColumnById(id);
}

export function deleteColumn(id: string): boolean {
  const db = getDb();
  const column = getColumnById(id);
  if (!column) return false;

  const taskCount = getTaskCountForColumn(id);
  if (taskCount > 0) {
    throw new Error(`Cannot delete column with ${taskCount} tasks. Move or delete tasks first.`);
  }

  const allColumns = getColumnsByBoardId(column.boardId);
  const predecessor = allColumns.find(c => c.nextColumnId === id);

  if (predecessor) {
    updateColumn(predecessor.id, { nextColumnId: column.nextColumnId });
  }

  db.delete(columns).where(eq(columns.id, id)).run();
  return true;
}

export function getTaskCountForColumn(columnId: string): number {
  const db = getDb();
  const result = db
    .select({ count: count() })
    .from(features)
    .where(eq(features.columnId, columnId))
    .get();
  return result?.count ?? 0;
}
