import * as connectionRepo from '../../repositories/integrationConnection.js';
import * as linkRepo from '../../repositories/externalIssueLink.js';
import * as syncRunRepo from '../../repositories/integrationSyncRun.js';
import * as missionRepo from '../../repositories/feature.js';
import * as taskRepo from '../../repositories/task.js';
import { resolveImportColumn } from './columnResolver.js';
import type { IntegrationConnection } from '@orcy/shared';
import type { IssueProviderAdapter, IntegrationSyncResult, ExternalIssueSyncResult } from './types.js';
import type { ExternalIssue, IntegrationSyncTrigger } from '@orcy/shared';
import { logger } from '../../lib/logger.js';

const TERMINAL_TASK_STATUSES = ['done', 'approved', 'failed'];

export async function syncConnection(
  connectionId: string,
  trigger: IntegrationSyncTrigger,
  adapter: IssueProviderAdapter,
): Promise<IntegrationSyncResult> {
  const connection = connectionRepo.getById(connectionId);
  if (!connection) throw new Error(`Connection ${connectionId} not found`);
  if (!connection.enabled) throw new Error('Connection is disabled');
  if (!connection.pullEnabled) throw new Error('Pull sync is disabled for this connection');

  const syncRun = syncRunRepo.create({
    connectionId,
    habitatId: connection.habitatId,
    trigger,
  });

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  let overallError: string | undefined;

  try {
    const issues = await adapter.listIssues(connection);

    for (const issue of issues) {
      try {
        const result = syncExternalIssue(connection, issue);
        if (result.action === 'created') createdCount++;
        else if (result.action === 'updated' || result.action === 'closed') updatedCount++;
        else skippedCount++;
      } catch (err: any) {
        failedCount++;
        logger.warn({ err, externalId: issue.externalId }, 'Failed to sync external issue');
      }
    }

    const status = failedCount > 0 ? (createdCount + updatedCount > 0 ? 'partial' : 'failed') : 'success';

    syncRunRepo.finish(syncRun.id, {
      status: status as any,
      createdCount,
      updatedCount,
      skippedCount,
      failedCount,
      error: overallError,
    });

    const now = new Date().toISOString();
    connectionRepo.update(connectionId, {
      lastSyncAt: now,
      lastSyncStatus: status as any,
      lastSyncError: status === 'failed' ? overallError ?? null : null,
    });

    return { syncRunId: syncRun.id, status: status as any, createdCount, updatedCount, skippedCount, failedCount };
  } catch (err: any) {
    overallError = err.message ?? String(err);

    syncRunRepo.finish(syncRun.id, {
      status: 'failed',
      createdCount,
      updatedCount,
      skippedCount,
      failedCount,
      error: overallError,
    });

    connectionRepo.update(connectionId, {
      lastSyncAt: new Date().toISOString(),
      lastSyncStatus: 'failed',
      lastSyncError: overallError,
    });

    return { syncRunId: syncRun.id, status: 'failed', createdCount, updatedCount, skippedCount, failedCount, error: overallError };
  }
}

export function syncExternalIssue(
  connection: IntegrationConnection,
  issue: ExternalIssue,
): ExternalIssueSyncResult {
  const existingLink = linkRepo.findByConnectionAndExternalId(connection.id, issue.externalId);

  if (existingLink) {
    return updateLinkedMission(connection, issue, existingLink.missionId, existingLink.id);
  }

  if (issue.status === 'closed') {
    return { action: 'skipped', missionId: '', linkId: '' };
  }

  const col = resolveImportColumn(connection.habitatId);
  if (!col) {
    throw new Error(`No non-terminal column found for habitat ${connection.habitatId}`);
  }

  const labels = [...issue.labels, `external:${issue.provider}`];

  const mission = missionRepo.createMission({
    habitatId: connection.habitatId,
    columnId: col.columnId,
    title: issue.title,
    description: issue.body || '',
    priority: 'medium',
    labels,
    createdBy: connection.createdBy,
  });

  const link = linkRepo.create({
    connectionId: connection.id,
    habitatId: connection.habitatId,
    missionId: mission.id,
    provider: issue.provider,
    externalId: issue.externalId,
    externalKey: issue.externalKey,
    externalUrl: issue.url,
    externalStatus: issue.status,
    externalUpdatedAt: issue.updatedAt,
    providerLabels: issue.labels,
  });

  return { action: 'created', missionId: mission.id, linkId: link.id };
}

function updateLinkedMission(
  connection: IntegrationConnection,
  issue: ExternalIssue,
  missionId: string,
  linkId: string,
): ExternalIssueSyncResult {
  const existingLink = linkRepo.getById(linkId);
  if (!existingLink) throw new Error(`Link ${linkId} not found`);

  const currentLabels = missionRepo.getMissionById(missionId)?.labels ?? [];
  const previousProviderLabels = existingLink.providerLabels ?? [];

  const orcyOnlyLabels = currentLabels.filter(l => !previousProviderLabels.includes(l));
  const newLabels = [...orcyOnlyLabels, ...issue.labels];
  if (!newLabels.includes(`external:${issue.provider}`)) {
    newLabels.push(`external:${issue.provider}`);
  }

  missionRepo.updateMission(missionId, {
    title: issue.title,
    description: issue.body || '',
    labels: newLabels,
  });

  if (issue.status === 'closed') {
    return handleExternalClose(missionId, linkId, issue);
  }

  linkRepo.update(linkId, {
    externalStatus: issue.status,
    externalUpdatedAt: issue.updatedAt,
    providerLabels: issue.labels,
    syncStatus: 'synced',
    syncWarning: null,
    lastSyncedAt: new Date().toISOString(),
  });

  return { action: 'updated', missionId, linkId };
}

function handleExternalClose(
  missionId: string,
  linkId: string,
  issue: ExternalIssue,
): ExternalIssueSyncResult {
  const tasks = taskRepo.getTasksByMissionId(missionId);

  const allTerminal = tasks.every(t => TERMINAL_TASK_STATUSES.includes(t.status));

  if (allTerminal) {
    missionRepo.updateMission(missionId, { status: 'done' });

    linkRepo.update(linkId, {
      externalStatus: 'closed',
      externalUpdatedAt: issue.updatedAt,
      syncStatus: 'synced',
      syncWarning: null,
      lastSyncedAt: new Date().toISOString(),
    });

    return { action: 'closed', missionId, linkId };
  }

  const currentLabels = missionRepo.getMissionById(missionId)?.labels ?? [];
  if (!currentLabels.includes('external-closed')) {
    missionRepo.updateMission(missionId, { labels: [...currentLabels, 'external-closed'] });
  }

  linkRepo.update(linkId, {
    externalStatus: 'closed',
    externalUpdatedAt: issue.updatedAt,
    syncStatus: 'warning',
    syncWarning: 'External issue closed while Orcy mission has active tasks',
    lastSyncedAt: new Date().toISOString(),
  });

  return { action: 'warning', missionId, linkId };
}
