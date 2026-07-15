import { getDb } from "../db/index.js";
import { columns, missions } from "../db/schema/index.js";
import { eq, and, max, count, asc, sql, inArray } from "drizzle-orm";
import type { Column } from "../models/index.js";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
  repositoryTransactionError,
} from "../errors/repository.js";

export interface CreateColumnInput {
  habitatId: string;
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
      .where(eq(columns.habitatId, input.habitatId))
      .get();
    order = (result?.maxOrder ?? -1) + 1;
  }

  try {
    db.insert(columns)
      .values({
        id,
        habitatId: input.habitatId,
        name: input.name,
        order,
        wipLimit: input.wipLimit ?? null,
        autoAdvance: input.autoAdvance ?? false,
        requiresClaim: input.requiresClaim !== false,
        nextColumnId: input.nextColumnId ?? null,
        isTerminal: input.isTerminal ?? false,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("column", err as Error, id);
  }

  const column = getColumnById(id);
  if (!column) throw repositoryNotFoundError("column", id);
  return column;
}

export function getColumnById(id: string): Column | null {
  const db = getDb();
  const row = db.select().from(columns).where(eq(columns.id, id)).get();
  return row ?? null;
}

export function getColumnByName(habitatId: string, name: string): Column | null {
  const db = getDb();
  const row = db
    .select()
    .from(columns)
    .where(and(eq(columns.habitatId, habitatId), eq(columns.name, name)))
    .get();
  return row ?? null;
}

export function getColumnsByHabitatId(habitatId: string): Column[] {
  const db = getDb();
  return db
    .select()
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
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

  try {
    db.update(columns).set(values).where(eq(columns.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("column", err as Error, id);
  }
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

  const allColumns = getColumnsByHabitatId(column.habitatId);
  const predecessor = allColumns.find((c) => c.nextColumnId === id);

  if (predecessor) {
    updateColumn(predecessor.id, { nextColumnId: column.nextColumnId });
  }

  try {
    db.delete(columns).where(eq(columns.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("column", err as Error, id);
  }
  return true;
}

export function getTaskCountForColumn(columnId: string): number {
  const db = getDb();
  const result = db
    .select({ count: count() })
    .from(missions)
    .where(eq(missions.columnId, columnId))
    .get();
  return result?.count ?? 0;
}

export function resolveImportColumn(
  habitatId: string,
): { columnId: string; warning?: string } | null {
  const db = getDb();

  const todoCol = db
    .select()
    .from(columns)
    .where(and(eq(columns.habitatId, habitatId), eq(columns.name, "Todo")))
    .get();

  if (todoCol) {
    return { columnId: todoCol.id };
  }

  const caseInsensitive = db
    .select()
    .from(columns)
    .where(and(eq(columns.habitatId, habitatId)))
    .all()
    .find((c) => c.name.toLowerCase() === "todo");

  if (caseInsensitive) {
    return { columnId: caseInsensitive.id };
  }

  const nonTerminal = db
    .select()
    .from(columns)
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

/**
 * Result of {@link reorderColumns}. On a stale `expectedOrder` (an intervening
 * actor changed column order), the call returns `{ success: false, versionConflict: true }`
 * WITHOUT performing any write — the unique `(habitatId, order)` index is never
 * touched, so no partial state can leak.
 */
export type ReorderColumnsResult =
  | { success: true; columns: Column[] }
  | { success: false; versionConflict: true; currentOrder: string[] }
  | { success: false; notFound: true }
  | { success: false; invalid: true; reason: string };

/**
 * Atomically reorders all columns in a habitat using an OCC expected/desired
 * contract. Both arrays must contain exactly the same unique column IDs and
 * every ID must belong to the habitat. Inside one transaction, the current
 * ordered ID list is compared to `expectedOrder`; on mismatch the transaction
 * rolls back without writes and returns `versionConflict`. On match, the
 * columns are persisted with a collision-safe two-phase write: first shift
 * every column's order below 0 (by `maxOrder + 1`, so every staged order is
 * `<= -1`, strictly disjoint from the `0..N-1` final range even when the
 * current orders are non-contiguous), then assign the final `0..N-1` orders
 * via individual parameterized updates. The freshly committed rows are
 * returned in canonical order.
 */
export function reorderColumns(
  habitatId: string,
  expectedOrder: string[],
  desiredOrder: string[],
): ReorderColumnsResult {
  if (expectedOrder.length !== desiredOrder.length) {
    return {
      success: false,
      invalid: true,
      reason: "expectedOrder and desiredOrder must have the same length",
    };
  }
  const expectedSet = new Set(expectedOrder);
  const desiredSet = new Set(desiredOrder);
  if (expectedSet.size !== expectedOrder.length) {
    return { success: false, invalid: true, reason: "expectedOrder must be unique" };
  }
  if (desiredSet.size !== desiredOrder.length) {
    return { success: false, invalid: true, reason: "desiredOrder must be unique" };
  }
  for (const id of expectedSet) {
    if (!desiredSet.has(id)) {
      return {
        success: false,
        invalid: true,
        reason: "expectedOrder and desiredOrder must contain the same column IDs",
      };
    }
  }

  const db = getDb();
  const habitatColumns = db
    .select({ id: columns.id })
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .all();
  if (habitatColumns.length === 0) return { success: false, notFound: true };
  const habitatColumnIds = new Set(habitatColumns.map((c) => c.id));
  for (const id of expectedSet) {
    if (!habitatColumnIds.has(id)) {
      return {
        success: false,
        invalid: true,
        reason: `Column ${id} does not belong to habitat ${habitatId}`,
      };
    }
  }
  if (habitatColumns.length !== expectedOrder.length) {
    return {
      success: false,
      invalid: true,
      reason: "expectedOrder must list every column in the habitat",
    };
  }

  try {
    db.transaction((tx) => {
      const currentRows = tx
        .select({ id: columns.id, order: columns.order })
        .from(columns)
        .where(eq(columns.habitatId, habitatId))
        .orderBy(asc(columns.order))
        .all();
      const currentOrder = currentRows.map((c) => c.id);
      const matchesExpected =
        currentOrder.length === expectedOrder.length &&
        currentOrder.every((id, i) => id === expectedOrder[i]);
      if (!matchesExpected) {
        throw new ReorderConflict(currentOrder);
      }

      const maxOrder = currentRows[currentRows.length - 1]?.order ?? -1;
      const shift = maxOrder + 1;

      tx.update(columns)
        .set({ order: sql`${columns.order} - ${shift}` })
        .where(and(eq(columns.habitatId, habitatId), inArray(columns.id, desiredOrder)))
        .run();

      desiredOrder.forEach((id, i) => {
        tx.update(columns)
          .set({ order: i })
          .where(and(eq(columns.id, id), eq(columns.habitatId, habitatId)))
          .run();
      });
    });
  } catch (err) {
    if (err instanceof ReorderConflict) {
      return { success: false, versionConflict: true, currentOrder: err.currentOrder };
    }
    throw repositoryTransactionError("columns", err as Error, habitatId);
  }

  const refreshed = db
    .select()
    .from(columns)
    .where(eq(columns.habitatId, habitatId))
    .orderBy(asc(columns.order))
    .all();
  return { success: true, columns: refreshed };
}

/** Internal sentinel thrown inside the reorder transaction to trigger a clean rollback on expected-order mismatch. */
class ReorderConflict extends Error {
  constructor(readonly currentOrder: string[]) {
    super("REORDER_VERSION_CONFLICT");
    this.name = "ReorderConflict";
  }
}
