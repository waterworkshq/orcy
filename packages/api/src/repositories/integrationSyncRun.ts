import { getDb } from '../db/index.js';
import { integrationSyncRuns } from '../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import type { IntegrationSyncRun, IntegrationSyncRunStatus, IntegrationSyncTrigger } from '@orcy/shared';
import { v4 as uuid } from 'uuid';

export function create(input: {
  connectionId: string;
  habitatId: string;
  trigger: IntegrationSyncTrigger;
}): IntegrationSyncRun {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(integrationSyncRuns).values({
    id,
    connectionId: input.connectionId,
    habitatId: input.habitatId,
    trigger: input.trigger,
    status: 'running',
    startedAt: now,
    finishedAt: null,
    createdCount: 0,
    updatedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    error: null,
  }).run();

  const result = getById(id);
  if (!result) throw new Error('Failed to create integration sync run');
  return result;
}

export function getById(id: string): IntegrationSyncRun | null {
  const db = getDb();
  return db.select().from(integrationSyncRuns).where(eq(integrationSyncRuns.id, id)).get() as IntegrationSyncRun | null;
}

export function finish(id: string, input: {
  status: IntegrationSyncRunStatus;
  createdCount?: number;
  updatedCount?: number;
  skippedCount?: number;
  failedCount?: number;
  error?: string | null;
}): IntegrationSyncRun | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = getById(id);
  if (!existing) return null;

  const values: Partial<typeof integrationSyncRuns.$inferInsert> = {
    finishedAt: now,
    status: input.status,
  };
  if (input.createdCount !== undefined) values.createdCount = input.createdCount;
  if (input.updatedCount !== undefined) values.updatedCount = input.updatedCount;
  if (input.skippedCount !== undefined) values.skippedCount = input.skippedCount;
  if (input.failedCount !== undefined) values.failedCount = input.failedCount;
  if (input.error !== undefined) values.error = input.error;

  db.update(integrationSyncRuns).set(values).where(eq(integrationSyncRuns.id, id)).run();
  return getById(id);
}

export function listByConnectionId(connectionId: string, limit = 20): IntegrationSyncRun[] {
  const db = getDb();
  return db.select().from(integrationSyncRuns)
    .where(eq(integrationSyncRuns.connectionId, connectionId))
    .orderBy(desc(integrationSyncRuns.startedAt))
    .limit(limit)
    .all() as IntegrationSyncRun[];
}
