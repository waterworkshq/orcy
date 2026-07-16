import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as connectionRepo from '../repositories/integrationConnection.js';
import * as linkRepo from '../repositories/externalIssueLink.js';
import * as syncRunRepo from '../repositories/integrationSyncRun.js';
import * as missionRepo from '../repositories/mission.js';
import { tasks, columns as columnsTable, habitats } from '../db/schema/index.js';

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const col = columnRepo.createColumn({ habitatId, name: 'Todo', order: 0, requiresClaim: false });
  columnId = col.id;

  const mission = missionRepo.createMission({ habitatId, columnId, title: 'Test Mission', createdBy: 'test' });
  missionId = mission.id;
});

afterEach(() => {
  closeDb();
});

describe('integrationConnection repository', () => {
  it('creates a GitHub connection', () => {
    const conn = connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Test GitHub',
      authMethod: 'pat',
      accessToken: 'ghp_test123',
      repositoryOwner: 'acme',
      repositoryName: 'repo',
      createdBy: 'user1',
    });

    expect(conn.id).toBeDefined();
    expect(conn.provider).toBe('github');
    expect(conn.authMethod).toBe('pat');
    expect(conn.enabled).toBe(true);
    expect(conn.pullEnabled).toBe(true);
    expect(conn.autoImport).toBe(false);
    expect(conn.lastSyncStatus).toBe('never');
  });

  it('lists connections by habitat', () => {
    connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Repo A',
      authMethod: 'pat',
      repositoryOwner: 'acme',
      repositoryName: 'repo-a',
      createdBy: 'user1',
    });

    connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Repo B',
      authMethod: 'pat',
      repositoryOwner: 'acme',
      repositoryName: 'repo-b',
      createdBy: 'user1',
    });

    const conns = connectionRepo.listByHabitat(habitatId);
    expect(conns).toHaveLength(2);
  });

  it('masks token fields in view', () => {
    const conn = connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Test',
      authMethod: 'pat',
      accessToken: 'ghp_secret_token',
      createdBy: 'user1',
    });

    const view = connectionRepo.toView(conn);
    expect((view as any).accessToken).toBeUndefined();
    expect((view as any).refreshToken).toBeUndefined();
    expect((view as any).webhookSecret).toBeUndefined();
    expect(view.hasAccessToken).toBe(true);
    expect(view.hasRefreshToken).toBe(false);
  });

  it('updates sync status fields', () => {
    const conn = connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Test',
      authMethod: 'pat',
      createdBy: 'user1',
    });

    const now = new Date().toISOString();
    const updated = connectionRepo.update(conn.id, {
      lastSyncAt: now,
      lastSyncStatus: 'success',
      lastSyncError: null,
    });

    expect(updated?.lastSyncAt).toBe(now);
    expect(updated?.lastSyncStatus).toBe('success');
  });

  it('disables connection instead of deleting', () => {
    const conn = connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Test',
      authMethod: 'pat',
      createdBy: 'user1',
    });

    const disabled = connectionRepo.disable(conn.id);
    expect(disabled?.enabled).toBe(false);

    const found = connectionRepo.getById(conn.id);
    expect(found).not.toBeNull();
    expect(found?.enabled).toBe(false);
  });

  it('lists enabled connections by provider and repo', () => {
    connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Test',
      authMethod: 'pat',
      repositoryOwner: 'acme',
      repositoryName: 'repo',
      createdBy: 'user1',
    });

    const enabled = connectionRepo.listEnabledByProviderAndRepo('github', 'acme', 'repo');
    expect(enabled).toHaveLength(1);

    const disabled = connectionRepo.listEnabledByProviderAndRepo('github', 'other', 'repo');
    expect(disabled).toHaveLength(0);
  });
});

describe('externalIssueLink repository', () => {
  let connectionId: string;

  beforeEach(() => {
    const conn = connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Test',
      authMethod: 'pat',
      createdBy: 'user1',
    });
    connectionId = conn.id;
  });

  it('creates an external issue link', () => {
    const link = linkRepo.create({
      connectionId,
      habitatId,
      missionId,
      provider: 'github',
      externalId: '12345',
      externalKey: 'acme/repo#42',
      externalUrl: 'https://github.com/acme/repo/issues/42',
      externalStatus: 'open',
      providerLabels: ['bug', 'enhancement'],
    });

    expect(link.id).toBeDefined();
    expect(link.externalKey).toBe('acme/repo#42');
    expect(link.syncStatus).toBe('synced');
    expect(link.providerLabels).toEqual(['bug', 'enhancement']);
  });

  it('finds link by connection and external ID', () => {
    linkRepo.create({
      connectionId,
      habitatId,
      missionId,
      provider: 'github',
      externalId: '12345',
      externalKey: 'acme/repo#42',
      externalUrl: 'https://github.com/acme/repo/issues/42',
      externalStatus: 'open',
    });

    const found = linkRepo.findByConnectionAndExternalId(connectionId, '12345');
    expect(found).not.toBeNull();
    expect(found?.externalKey).toBe('acme/repo#42');
  });

  it('lists links by mission', () => {
    linkRepo.create({
      connectionId,
      habitatId,
      missionId,
      provider: 'github',
      externalId: '111',
      externalKey: 'acme/repo#1',
      externalUrl: 'https://github.com/acme/repo/issues/1',
      externalStatus: 'open',
    });

    const links = linkRepo.listByMissionId(missionId);
    expect(links).toHaveLength(1);
  });

  it('updates sync status and warning', () => {
    const link = linkRepo.create({
      connectionId,
      habitatId,
      missionId,
      provider: 'github',
      externalId: '12345',
      externalKey: 'acme/repo#42',
      externalUrl: 'https://github.com/acme/repo/issues/42',
      externalStatus: 'open',
    });

    const updated = linkRepo.update(link.id, {
      syncStatus: 'warning',
      syncWarning: 'External issue closed while Orcy mission has active tasks',
    });

    expect(updated?.syncStatus).toBe('warning');
    expect(updated?.syncWarning).toBe('External issue closed while Orcy mission has active tasks');
  });

  it('preserves provider labels on update', () => {
    const link = linkRepo.create({
      connectionId,
      habitatId,
      missionId,
      provider: 'github',
      externalId: '12345',
      externalKey: 'acme/repo#42',
      externalUrl: 'https://github.com/acme/repo/issues/42',
      externalStatus: 'open',
      providerLabels: ['bug', 'enhancement'],
    });

    const updated = linkRepo.update(link.id, {
      providerLabels: ['bug', 'feature'],
    });

    expect(updated?.providerLabels).toEqual(['bug', 'feature']);
  });
});

describe('integrationSyncRun repository', () => {
  let connectionId: string;

  beforeEach(() => {
    const conn = connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'Test',
      authMethod: 'pat',
      createdBy: 'user1',
    });
    connectionId = conn.id;
  });

  it('creates a running sync run', () => {
    const run = syncRunRepo.create({
      connectionId,
      habitatId,
      trigger: 'manual',
    });

    expect(run.id).toBeDefined();
    expect(run.status).toBe('running');
    expect(run.startedAt).toBeDefined();
    expect(run.finishedAt).toBeNull();
  });

  it('finishes with success', () => {
    const run = syncRunRepo.create({
      connectionId,
      habitatId,
      trigger: 'manual',
    });

    const finished = syncRunRepo.finish(run.id, {
      status: 'success',
      createdCount: 5,
      updatedCount: 3,
      skippedCount: 1,
    });

    expect(finished?.status).toBe('success');
    expect(finished?.finishedAt).toBeDefined();
    expect(finished?.createdCount).toBe(5);
    expect(finished?.updatedCount).toBe(3);
  });

  it('records errors', () => {
    const run = syncRunRepo.create({
      connectionId,
      habitatId,
      trigger: 'manual',
    });

    const finished = syncRunRepo.finish(run.id, {
      status: 'failed',
      error: 'GitHub API rate limit exceeded',
      failedCount: 10,
    });

    expect(finished?.status).toBe('failed');
    expect(finished?.error).toBe('GitHub API rate limit exceeded');
    expect(finished?.failedCount).toBe(10);
  });

  it('lists by connection', () => {
    const run1 = syncRunRepo.create({ connectionId, habitatId, trigger: 'manual' });
    syncRunRepo.finish(run1.id, { status: 'success' });

    const run2 = syncRunRepo.create({ connectionId, habitatId, trigger: 'webhook' });
    syncRunRepo.finish(run2.id, { status: 'success' });

    const runs = syncRunRepo.listByConnectionId(connectionId);
    expect(runs).toHaveLength(2);
    const triggers = runs.map(r => r.trigger);
    expect(triggers).toContain('manual');
    expect(triggers).toContain('webhook');
  });
});
