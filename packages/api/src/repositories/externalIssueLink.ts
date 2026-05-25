import { getDb } from '../db/index.js';
import { externalIssueLinks } from '../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import type { ExternalIssueLink, ExternalIssueStatus, ExternalIssueLinkSyncStatus, IntegrationProvider } from '@orcy/shared';
import { v4 as uuid } from 'uuid';

export function create(input: {
  connectionId: string;
  habitatId: string;
  missionId: string;
  provider: IntegrationProvider;
  externalId: string;
  externalKey: string;
  externalUrl: string;
  externalStatus: ExternalIssueStatus;
  externalUpdatedAt?: string | null;
  providerLabels?: string[];
}): ExternalIssueLink {
  const db = getDb();
  const id = uuid();
  const now = new Date().toISOString();

  db.insert(externalIssueLinks).values({
    id,
    connectionId: input.connectionId,
    habitatId: input.habitatId,
    missionId: input.missionId,
    provider: input.provider,
    externalId: input.externalId,
    externalKey: input.externalKey,
    externalUrl: input.externalUrl,
    externalStatus: input.externalStatus,
    externalUpdatedAt: input.externalUpdatedAt ?? null,
    providerLabels: input.providerLabels ?? [],
    lastSyncedAt: now,
    syncStatus: 'synced',
    syncWarning: null,
    createdAt: now,
    updatedAt: now,
  }).run();

  const result = getById(id);
  if (!result) throw new Error('Failed to create external issue link');
  return result;
}

export function getById(id: string): ExternalIssueLink | null {
  const db = getDb();
  return db.select().from(externalIssueLinks).where(eq(externalIssueLinks.id, id)).get() as ExternalIssueLink | null;
}

export function findByConnectionAndExternalId(connectionId: string, externalId: string): ExternalIssueLink | null {
  const db = getDb();
  return db.select().from(externalIssueLinks)
    .where(and(eq(externalIssueLinks.connectionId, connectionId), eq(externalIssueLinks.externalId, externalId)))
    .get() as ExternalIssueLink | null;
}

export function listByMissionId(missionId: string): ExternalIssueLink[] {
  const db = getDb();
  return db.select().from(externalIssueLinks)
    .where(eq(externalIssueLinks.missionId, missionId))
    .all() as ExternalIssueLink[];
}

export function update(id: string, input: {
  externalStatus?: ExternalIssueStatus;
  externalUpdatedAt?: string | null;
  providerLabels?: string[];
  lastSyncedAt?: string | null;
  syncStatus?: ExternalIssueLinkSyncStatus;
  syncWarning?: string | null;
}): ExternalIssueLink | null {
  const db = getDb();
  const now = new Date().toISOString();

  const existing = getById(id);
  if (!existing) return null;

  const values: Partial<typeof externalIssueLinks.$inferInsert> = { updatedAt: now };
  if (input.externalStatus !== undefined) values.externalStatus = input.externalStatus;
  if (input.externalUpdatedAt !== undefined) values.externalUpdatedAt = input.externalUpdatedAt;
  if (input.providerLabels !== undefined) values.providerLabels = input.providerLabels;
  if (input.lastSyncedAt !== undefined) values.lastSyncedAt = input.lastSyncedAt;
  if (input.syncStatus !== undefined) values.syncStatus = input.syncStatus;
  if (input.syncWarning !== undefined) values.syncWarning = input.syncWarning;

  db.update(externalIssueLinks).set(values).where(eq(externalIssueLinks.id, id)).run();
  return getById(id);
}
