import { getDb } from '../db/index.js';
import { savedFilters } from '../db/schema.js';
import { eq, or, sql } from 'drizzle-orm';
import { v4 as uuid } from 'uuid';

export interface SavedFilter {
  id: string;
  boardId: string;
  userId: string;
  name: string;
  filterConfig: Record<string, unknown>;
  isBuiltin: boolean;
  createdAt: string;
}

export function createSavedFilter(boardId: string, userId: string, name: string, filterConfig: Record<string, unknown>): SavedFilter {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(savedFilters).values({
    id,
    boardId,
    userId,
    name,
    filterConfig,
    isBuiltin: false,
    createdAt: now,
  }).run();

  return getSavedFilterById(id)!;
}

export function getSavedFilterById(id: string): SavedFilter | null {
  const db = getDb();
  const rows = db.select().from(savedFilters).where(eq(savedFilters.id, id)).all();
  return rows.length > 0 ? rows[0] as SavedFilter : null;
}

export function getSavedFilters(boardId: string, userId: string): SavedFilter[] {
  const db = getDb();
  return db.select().from(savedFilters).where(
    sql`${savedFilters.boardId} = ${boardId} AND (${savedFilters.userId} = ${userId} OR ${savedFilters.isBuiltin} = 1)`
  ).orderBy(
    sql`${savedFilters.isBuiltin} DESC, ${savedFilters.createdAt} ASC`
  ).all() as SavedFilter[];
}

export function updateSavedFilter(id: string, name: string, filterConfig: Record<string, unknown>): SavedFilter | null {
  const existing = getSavedFilterById(id);
  if (!existing) return null;

  const db = getDb();
  db.update(savedFilters).set({ name, filterConfig }).where(eq(savedFilters.id, id)).run();
  return getSavedFilterById(id);
}

export function deleteSavedFilter(id: string): boolean {
  const existing = getSavedFilterById(id);
  if (!existing) return false;

  const db = getDb();
  db.delete(savedFilters).where(eq(savedFilters.id, id)).run();
  return true;
}

export function seedBuiltinFilters(boardId: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  const builtins: Array<{ name: string; config: Record<string, unknown> }> = [
    { name: 'High Priority', config: { priority: 'critical' } },
    { name: 'Blocked', config: { status: 'pending', hasUnmetDeps: true } },
  ];

  for (const builtin of builtins) {
    const id = uuid();
    db.insert(savedFilters).values({
      id,
      boardId,
      userId: 'system',
      name: builtin.name,
      filterConfig: builtin.config,
      isBuiltin: true,
      createdAt: now,
    }).run();
  }
}

export function deleteSavedFiltersByBoard(boardId: string): void {
  const db = getDb();
  db.delete(savedFilters).where(eq(savedFilters.boardId, boardId)).run();
}
