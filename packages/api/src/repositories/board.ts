import { getDb } from '../db/index.js';
import { boards, columns, features } from '../db/schema/index.js';
import { eq, and, like, or, isNull, inArray, sql, desc } from 'drizzle-orm';
import type { Board, Column, RetryPolicy, AnomalySettings, AutoAssignSettings, GitWorktreeSettings } from '../models/index.js';
import { v4 as uuid } from 'uuid';

export interface CreateBoardInput {
  name: string;
  description?: string;
  teamId?: string | null;
}

export interface UpdateBoardInput {
  name?: string;
  description?: string;
  retrySettings?: RetryPolicy | null;
  anomalySettings?: AnomalySettings | null;
  autoAssignSettings?: AutoAssignSettings | null;
  gitWorktreeSettings?: GitWorktreeSettings | null;
  eventRetentionDays?: number;
}

export function createBoard(input: CreateBoardInput): Board {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(boards).values({
    id,
    name: input.name,
    description: input.description ?? '',
    createdAt: now,
    updatedAt: now,
    teamId: input.teamId ?? null,
  }).run();

  return getBoardById(id)!;
}

export function getBoardById(id: string): Board | null {
  const db = getDb();
  const row = db
    .select()
    .from(boards)
    .where(eq(boards.id, id))
    .get();
  return row ?? null;
}

export function listBoards(name?: string, teamIds?: string[]): Board[] {
  const db = getDb();

  const conditions = [];

  if (teamIds && teamIds.length > 0) {
    conditions.push(or(inArray(boards.teamId, teamIds), isNull(boards.teamId)));
  }
  if (name) {
    conditions.push(like(sql`LOWER(${boards.name})`, `%${name.toLowerCase()}%`));
  }

  if (conditions.length === 0) {
    return db.select().from(boards).orderBy(desc(boards.createdAt)).all();
  }

  return db
    .select()
    .from(boards)
    .where(and(...conditions))
    .orderBy(desc(boards.createdAt))
    .all();
}

export function updateBoard(id: string, input: UpdateBoardInput): Board | null {
  const db = getDb();
  const values: Partial<typeof boards.$inferInsert> = {};
  values.updatedAt = new Date().toISOString();

  if (input.name !== undefined) values.name = input.name;
  if (input.description !== undefined) values.description = input.description;
  if (input.retrySettings !== undefined) values.retrySettings = input.retrySettings;
  if (input.anomalySettings !== undefined) values.anomalySettings = input.anomalySettings;
  if (input.autoAssignSettings !== undefined) values.autoAssignSettings = input.autoAssignSettings;
  if (input.gitWorktreeSettings !== undefined) values.gitWorktreeSettings = input.gitWorktreeSettings;
  if (input.eventRetentionDays !== undefined) values.eventRetentionDays = input.eventRetentionDays;

  db.update(boards)
    .set(values)
    .where(eq(boards.id, id))
    .run();
  return getBoardById(id);
}

export function deleteBoard(id: string): void {
  const db = getDb();
  db.delete(boards).where(eq(boards.id, id)).run();
}

export function getBoardWithColumnsAndTasks(boardId: string): { board: Board; columns: Column[] } | null {
  const db = getDb();
  const result = db.query.boards.findFirst({
    where: eq(boards.id, boardId),
    with: {
      columns: {
        orderBy: columns.order,
        with: {
          features: true,
        },
      },
    },
  }).prepare().get();

  if (!result) return null;

  const cols = result.columns.map((c: Record<string, unknown>) => {
    const { features: _, ...col } = c;
    return col as unknown as Column;
  });
  const { columns: _, ...boardData } = result;
  return { board: boardData as unknown as Board, columns: cols };
}
