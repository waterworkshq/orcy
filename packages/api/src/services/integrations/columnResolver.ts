import { getDb } from '../../db/index.js';
import { columns } from '../../db/schema/index.js';
import { eq, and, asc } from 'drizzle-orm';
import type { Column } from '../../models/index.js';

export function resolveImportColumn(habitatId: string): { columnId: string; warning?: string } | null {
  const db = getDb();

  const todoCol = db.select().from(columns)
    .where(and(eq(columns.habitatId, habitatId), eq(columns.name, 'Todo')))
    .get();

  if (todoCol) {
    return { columnId: todoCol.id };
  }

  const caseInsensitive = db.select().from(columns)
    .where(and(eq(columns.habitatId, habitatId)))
    .all()
    .find(c => c.name.toLowerCase() === 'todo');

  if (caseInsensitive) {
    return { columnId: caseInsensitive.id };
  }

  const nonTerminal = db.select().from(columns)
    .where(and(eq(columns.habitatId, habitatId), eq(columns.isTerminal, false)))
    .orderBy(asc(columns.order))
    .get();

  if (nonTerminal) {
    return {
      columnId: nonTerminal.id,
      warning: `No 'Todo' column found; using '${nonTerminal.name}' as import target`,
    };
  }

  return null;
}
