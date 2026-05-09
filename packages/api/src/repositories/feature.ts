import { getDb } from '../db/index.js';
import { features, featureDependencies, columns } from '../db/schema.js';
import { eq, and, or, not, inArray, sql, count, max, asc, desc, isNotNull, notInArray } from 'drizzle-orm';
import type { Feature, FeatureStatus, TaskPriority } from '../models/index.js';
import { v4 as uuid } from 'uuid';

function normalizeFeatureId(id: string): { exact: string; withPrefix: string | null } {
  if (id.startsWith('feat-')) {
    return { exact: id, withPrefix: null };
  }
  return { exact: id, withPrefix: `feat-${id}` };
}

export interface CreateFeatureInput {
  boardId: string;
  columnId?: string;
  title: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: TaskPriority;
  labels?: string[];
  dependsOn?: string[];
  blocks?: string[];
  dueAt?: string | null;
  slaMinutes?: number | null;
  createdBy: string;
  displayOrder?: number;
}

export interface UpdateFeatureInput {
  title?: string;
  description?: string;
  acceptanceCriteria?: string;
  priority?: TaskPriority;
  labels?: string[];
  columnId?: string;
  status?: FeatureStatus;
  dependsOn?: string[];
  blocks?: string[];
  dueAt?: string | null;
  slaMinutes?: number | null;
  slaDeadlineAt?: string | null;
  displayOrder?: number;
  isArchived?: boolean;
}

export function createFeature(input: CreateFeatureInput): Feature {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  let columnId = input.columnId;
  if (!columnId) {
    const boardColumns = db
      .select()
      .from(columns)
      .where(eq(columns.boardId, input.boardId))
      .orderBy(columns.order)
      .all();
    columnId = boardColumns[0]?.id;
    if (!columnId) throw new Error('Board has no columns');
  }

  let displayOrder = input.displayOrder;
  if (displayOrder === undefined) {
    const result = db
      .select({ maxOrder: max(features.displayOrder) })
      .from(features)
      .where(eq(features.columnId, columnId))
      .get();
    displayOrder = (result?.maxOrder ?? -1) + 1;
  }

  db.transaction((tx) => {
    tx.insert(features).values({
      id,
      boardId: input.boardId,
      columnId,
      title: input.title,
      description: input.description ?? '',
      acceptanceCriteria: input.acceptanceCriteria ?? '',
      priority: input.priority ?? 'medium',
      labels: input.labels ?? [],
      status: 'not_started',
      displayOrder,
      dependsOn: input.dependsOn ?? [],
      blocks: input.blocks ?? [],
      dueAt: input.dueAt ?? null,
      slaMinutes: input.slaMinutes ?? null,
      createdBy: input.createdBy,
      createdAt: now,
      updatedAt: now,
      version: 1,
    }).run();

    if (input.dependsOn && input.dependsOn.length > 0) {
      tx.insert(featureDependencies).values(
        input.dependsOn.map(depId => ({ featureId: id, dependsOnId: depId }))
      ).run();
    }

    if (input.blocks && input.blocks.length > 0) {
      tx.insert(featureDependencies).values(
        input.blocks.map(blockedId => ({ featureId: blockedId, dependsOnId: id }))
      ).run();
    }
  });

  return getFeatureById(id)!;
}

export function getFeatureById(id: string): Feature | null {
  const db = getDb();
  const { exact, withPrefix } = normalizeFeatureId(id);
  const result = db.select().from(features).where(eq(features.id, exact)).get() as Feature | null;
  if (result) return result;
  if (withPrefix) {
    return db.select().from(features).where(eq(features.id, withPrefix)).get() as Feature ?? null;
  }
  return null;
}

export function getFeaturesByBoardId(
  boardId: string,
  filters?: { columnId?: string; status?: FeatureStatus; priority?: TaskPriority; limit?: number; offset?: number; isArchived?: boolean }
): { features: Feature[]; total: number } {
  const db = getDb();

  const conditions = [eq(features.boardId, boardId)];
  if (filters?.columnId) conditions.push(eq(features.columnId, filters.columnId));
  if (filters?.status) conditions.push(eq(features.status, filters.status));
  if (filters?.priority) conditions.push(eq(features.priority, filters.priority));
  if (filters?.isArchived !== undefined) conditions.push(eq(features.isArchived, filters.isArchived));

  const where = and(...conditions);

  const countResult = db
    .select({ total: count() })
    .from(features)
    .where(where)
    .get();
  const total = countResult?.total ?? 0;

  const priorityOrder = sql`CASE ${features.priority} WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

  const query = db.select().from(features).where(where).orderBy(asc(features.displayOrder), priorityOrder, asc(features.createdAt));
  const results = filters?.limit !== undefined
    ? query.limit(filters.limit).offset(filters?.offset ?? 0).all()
    : query.all();

  return { features: results as Feature[], total };
}

export function updateFeature(id: string, input: UpdateFeatureInput, expectedVersion?: number):
  | { success: true; feature: Feature }
  | { success: false; notFound: true }
  | { success: false; versionMismatch: true; currentVersion: number } {
  const db = getDb();
  const now = new Date().toISOString();

  if (expectedVersion !== undefined) {
    const existing = db
      .select({ id: features.id, version: features.version })
      .from(features)
      .where(eq(features.id, id))
      .get();
    if (!existing) return { success: false, notFound: true };
    if (existing.version !== expectedVersion) {
      return { success: false, versionMismatch: true, currentVersion: existing.version };
    }
  } else {
    const existing = db.select({ id: features.id }).from(features).where(eq(features.id, id)).get();
    if (!existing) return { success: false, notFound: true };
  }

  const set: Partial<typeof features.$inferInsert> = { updatedAt: now };

  if (input.title !== undefined) set.title = input.title;
  if (input.description !== undefined) set.description = input.description;
  if (input.acceptanceCriteria !== undefined) set.acceptanceCriteria = input.acceptanceCriteria;
  if (input.priority !== undefined) set.priority = input.priority;
  if (input.labels !== undefined) set.labels = input.labels;
  if (input.columnId !== undefined) set.columnId = input.columnId;
  if (input.status !== undefined) set.status = input.status;
  if (input.dependsOn !== undefined) set.dependsOn = input.dependsOn;
  if (input.blocks !== undefined) set.blocks = input.blocks;
  if (input.dueAt !== undefined) set.dueAt = input.dueAt;
  if (input.slaMinutes !== undefined) set.slaMinutes = input.slaMinutes;
  if (input.slaDeadlineAt !== undefined) set.slaDeadlineAt = input.slaDeadlineAt;
  if (input.displayOrder !== undefined) set.displayOrder = input.displayOrder;
  if (input.isArchived !== undefined) set.isArchived = input.isArchived;

  db.transaction((tx) => {
    tx.update(features).set({ ...set, version: sql`${features.version} + 1` }).where(eq(features.id, id)).run();

    if (input.dependsOn !== undefined) {
      tx.delete(featureDependencies).where(eq(featureDependencies.featureId, id)).run();
      if (input.dependsOn.length > 0) {
        tx.insert(featureDependencies).values(
          input.dependsOn.map(depId => ({ featureId: id, dependsOnId: depId }))
        ).run();
      }
    }

    if (input.blocks !== undefined) {
      tx.delete(featureDependencies).where(eq(featureDependencies.dependsOnId, id)).run();
      if (input.blocks.length > 0) {
        tx.insert(featureDependencies).values(
          input.blocks.map(blockedId => ({ featureId: blockedId, dependsOnId: id }))
        ).run();
      }
    }
  });

  const feature = getFeatureById(id);
  return { success: true, feature: feature! };
}

export function deleteFeature(id: string): void {
  const db = getDb();
  db.delete(features).where(eq(features.id, id)).run();
}

export function moveFeature(featureId: string, toColumnId: string): Feature | null {
  const db = getDb();
  const now = new Date().toISOString();

  db.update(features)
    .set({ columnId: toColumnId, updatedAt: now, version: sql`${features.version} + 1` })
    .where(eq(features.id, featureId))
    .run();
  return getFeatureById(featureId);
}

export function reorderFeature(featureId: string, afterFeatureId: string | null, beforeFeatureId: string | null): Feature | null {
  const db = getDb();
  const now = new Date().toISOString();

  const feature = getFeatureById(featureId);
  if (!feature) return null;

  const columnId = feature.columnId;

  let newOrder: number;
  if (afterFeatureId === null && beforeFeatureId === null) {
    const result = db
      .select({ maxOrder: max(features.displayOrder) })
      .from(features)
      .where(eq(features.columnId, columnId))
      .get();
    newOrder = (result?.maxOrder ?? -1) + 1;
  } else if (afterFeatureId !== null) {
    const afterRow = db
      .select({ displayOrder: features.displayOrder })
      .from(features)
      .where(eq(features.id, afterFeatureId))
      .get();
    if (!afterRow) return null;
    newOrder = afterRow.displayOrder + 1;
    db.update(features)
      .set({ displayOrder: sql`${features.displayOrder} + 1` })
      .where(and(eq(features.columnId, columnId), sql`${features.displayOrder} > ${afterRow.displayOrder}`))
      .run();
  } else {
    const beforeRow = db
      .select({ displayOrder: features.displayOrder })
      .from(features)
      .where(eq(features.id, beforeFeatureId!))
      .get();
    if (!beforeRow) return null;
    newOrder = beforeRow.displayOrder;
    db.update(features)
      .set({ displayOrder: sql`${features.displayOrder} + 1` })
      .where(and(eq(features.columnId, columnId), sql`${features.displayOrder} >= ${beforeRow.displayOrder}`))
      .run();
  }

  db.update(features)
    .set({ displayOrder: newOrder, updatedAt: now, version: sql`${features.version} + 1` })
    .where(eq(features.id, featureId))
    .run();
  return getFeatureById(featureId);
}

export function addDependency(featureId: string, dependsOnId: string): void {
  const db = getDb();
  db.insert(featureDependencies).values({ featureId, dependsOnId }).run();
}

export function removeDependency(featureId: string, dependsOnId: string): void {
  const db = getDb();
  db.delete(featureDependencies)
    .where(and(eq(featureDependencies.featureId, featureId), eq(featureDependencies.dependsOnId, dependsOnId)))
    .run();
}

export function areAllFeatureDependenciesMet(featureId: string): boolean {
  const db = getDb();
  const result = db
    .select({ count: count() })
    .from(featureDependencies)
    .innerJoin(features, eq(featureDependencies.dependsOnId, features.id))
    .where(
      and(
        eq(featureDependencies.featureId, featureId),
        notInArray(features.status, ['done'])
      )
    )
    .get();
  return (result?.count ?? 0) === 0;
}

export function getFeaturesByDependency(dependsOnId: string): Feature[] {
  const db = getDb();
  return db
    .select()
    .from(features)
    .innerJoin(featureDependencies, eq(features.id, featureDependencies.featureId))
    .where(eq(featureDependencies.dependsOnId, dependsOnId))
    .all()
    .map((row: any) => row.features);
}
