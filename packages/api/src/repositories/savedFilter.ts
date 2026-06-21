import { getDb } from "../db/index.js";
import { savedFilters } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import { v4 as uuid } from "uuid";
import {
  repositoryCreateError,
  repositoryNotFoundError,
  repositoryUpdateError,
  repositoryDeleteError,
} from "../errors/repository.js";

export interface SavedFilter {
  id: string;
  habitatId: string;
  userId: string;
  name: string;
  filterConfig: Record<string, unknown>;
  isBuiltin: boolean;
  createdAt: string;
}

export function createSavedFilter(
  habitatId: string,
  userId: string,
  name: string,
  filterConfig: Record<string, unknown>,
): SavedFilter {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  try {
    db.insert(savedFilters)
      .values({
        id,
        habitatId,
        userId,
        name,
        filterConfig,
        isBuiltin: false,
        createdAt: now,
      })
      .run();
  } catch (err) {
    throw repositoryCreateError("savedFilter", err as Error, id);
  }

  const filter = getSavedFilterById(id);
  if (!filter) throw repositoryNotFoundError("savedFilter", id);
  return filter;
}

export function getSavedFilterById(id: string): SavedFilter | null {
  const db = getDb();
  const rows = db.select().from(savedFilters).where(eq(savedFilters.id, id)).all();
  return rows.length > 0 ? (rows[0] as SavedFilter) : null;
}

export function getSavedFilters(habitatId: string, userId: string): SavedFilter[] {
  const db = getDb();
  return db
    .select()
    .from(savedFilters)
    .where(
      sql`${savedFilters.habitatId} = ${habitatId} AND (${savedFilters.userId} = ${userId} OR ${savedFilters.isBuiltin} = 1)`,
    )
    .orderBy(sql`${savedFilters.isBuiltin} DESC, ${savedFilters.createdAt} ASC`)
    .all() as SavedFilter[];
}

export function updateSavedFilter(
  id: string,
  name: string,
  filterConfig: Record<string, unknown>,
): SavedFilter | null {
  const existing = getSavedFilterById(id);
  if (!existing) return null;

  const db = getDb();
  try {
    db.update(savedFilters).set({ name, filterConfig }).where(eq(savedFilters.id, id)).run();
  } catch (err) {
    throw repositoryUpdateError("savedFilter", err as Error, id);
  }
  return getSavedFilterById(id);
}

export function deleteSavedFilter(id: string): boolean {
  const existing = getSavedFilterById(id);
  if (!existing) return false;

  const db = getDb();
  try {
    db.delete(savedFilters).where(eq(savedFilters.id, id)).run();
  } catch (err) {
    throw repositoryDeleteError("savedFilter", err as Error, id);
  }
  return true;
}

export function seedBuiltinFilters(habitatId: string): void {
  const db = getDb();
  const now = new Date().toISOString();

  const builtins: Array<{ name: string; config: Record<string, unknown> }> = [
    { name: "High Priority", config: { priority: "critical" } },
    { name: "Blocked", config: { status: "pending", hasUnmetDeps: true } },
    { name: "Blocked by Workflow", config: { status: "pending", hasUnmetWorkflowGates: true } },
  ];

  for (const builtin of builtins) {
    const id = uuid();
    try {
      db.insert(savedFilters)
        .values({
          id,
          habitatId,
          userId: "system",
          name: builtin.name,
          filterConfig: builtin.config,
          isBuiltin: true,
          createdAt: now,
        })
        .run();
    } catch (err) {
      throw repositoryCreateError("savedFilter", err as Error, id);
    }
  }
}

export function deleteSavedFiltersByHabitat(habitatId: string): void {
  const db = getDb();
  try {
    db.delete(savedFilters).where(eq(savedFilters.habitatId, habitatId)).run();
  } catch (err) {
    throw repositoryDeleteError("savedFilter", err as Error, habitatId);
  }
}
