import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as connectionRepo from '../repositories/integrationConnection.js';
import * as linkRepo from '../repositories/externalIssueLink.js';
import * as missionRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as candidateRepo from '../repositories/externalIntakeCandidate.js';
import { syncConnection, syncExternalIssue } from '../services/integrations/syncService.js';
import type { IssueProviderAdapter } from '../services/integrations/types.js';
import type { ExternalIssue } from '@orcy/shared';
import { tasks, columns as columnsTable, habitats } from '../db/schema/index.js';

let habitatId: string;
let columnId: string;
let connectionId: string;

function makeFakeAdapter(issues: ExternalIssue[]): IssueProviderAdapter {
  return {
    provider: 'github',
    listIssues: async () => issues,
    getIssue: async (_conn, externalId) => issues.find(i => i.externalId === externalId) ?? null,
  };
}

function makeIssue(overrides: Partial<ExternalIssue> = {}): ExternalIssue {
  return {
    provider: 'github',
    externalId: '12345',
    externalKey: 'acme/repo#42',
    title: 'Test Issue',
    body: 'Issue body',
    status: 'open',
    labels: ['bug'],
    url: 'https://github.com/acme/repo/issues/42',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeJiraIssue(overrides: Partial<ExternalIssue> = {}): ExternalIssue {
  return {
    provider: 'jira',
    externalId: 'JIRA-101',
    externalKey: 'PROJ-101',
    title: 'Jira Bug',
    body: 'Something broke',
    status: 'open',
    labels: ['bug'],
    url: 'https://mysite.atlassian.net/browse/PROJ-101',
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

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

  const conn = connectionRepo.create({
    habitatId,
    provider: 'github',
    name: 'Test GitHub',
    authMethod: 'pat',
    accessToken: 'ghp_test',
    repositoryOwner: 'acme',
    repositoryName: 'repo',
    autoImport: true,
    createdBy: 'user1',
  });
  connectionId = conn.id;
});

afterEach(() => {
  closeDb();
});

describe('syncService', () => {
  it('creates a mission in Todo for open issue', async () => {
    const adapter = makeFakeAdapter([makeIssue()]);
    const result = await syncConnection(connectionId, 'manual', adapter);

    expect(result.status).toBe('success');
    expect(result.createdCount).toBe(1);

    const { missions } = missionRepo.getMissionsByHabitatId(habitatId);
    expect(missions).toHaveLength(1);
    expect(missions[0].title).toBe('Test Issue');
    expect(missions[0].labels).toContain('external:github');
    expect(missions[0].labels).toContain('bug');
  });

  it('second sync updates same mission without duplicating', async () => {
    const adapter1 = makeFakeAdapter([makeIssue()]);
    await syncConnection(connectionId, 'manual', adapter1);

    const adapter2 = makeFakeAdapter([makeIssue({ title: 'Updated Title' })]);
    const result = await syncConnection(connectionId, 'manual', adapter2);

    expect(result.createdCount).toBe(0);
    expect(result.updatedCount).toBe(1);

    const { missions } = missionRepo.getMissionsByHabitatId(habitatId);
    expect(missions).toHaveLength(1);
    expect(missions[0].title).toBe('Updated Title');
  });

  it('edited issue updates mission title and body', async () => {
    const adapter1 = makeFakeAdapter([makeIssue()]);
    await syncConnection(connectionId, 'manual', adapter1);

    const adapter2 = makeFakeAdapter([makeIssue({ title: 'New Title', body: 'New body' })]);
    await syncConnection(connectionId, 'manual', adapter2);

    const { missions } = missionRepo.getMissionsByHabitatId(habitatId);
    expect(missions[0].title).toBe('New Title');
    expect(missions[0].description).toBe('New body');
  });

  it('labels preserve Orcy-only labels', async () => {
    const adapter1 = makeFakeAdapter([makeIssue({ labels: ['bug'] })]);
    await syncConnection(connectionId, 'manual', adapter1);

    const mission = missionRepo.getMissionsByHabitatId(habitatId).missions[0];
    missionRepo.updateMission(mission.id, { labels: [...mission.labels, 'orcy-custom'] });

    const adapter2 = makeFakeAdapter([makeIssue({ labels: ['enhancement'] })]);
    await syncConnection(connectionId, 'manual', adapter2);

    const updated = missionRepo.getMissionById(mission.id)!;
    expect(updated.labels).toContain('orcy-custom');
    expect(updated.labels).toContain('enhancement');
    expect(updated.labels).not.toContain('bug');
  });

  it('no Todo column falls back to first non-terminal column', async () => {
    const db = getDb();
    db.delete(columnsTable).run();

    columnRepo.createColumn({ habitatId, name: 'In Progress', order: 0, requiresClaim: false, isTerminal: false });
    columnRepo.createColumn({ habitatId, name: 'Done', order: 1, requiresClaim: false, isTerminal: true });

    const adapter = makeFakeAdapter([makeIssue()]);
    const result = await syncConnection(connectionId, 'manual', adapter);

    expect(result.createdCount).toBe(1);
    const { missions } = missionRepo.getMissionsByHabitatId(habitatId);
    expect(missions[0].title).toBe('Test Issue');
  });

  it('closed issue with no tasks marks mission done', async () => {
    const adapter1 = makeFakeAdapter([makeIssue()]);
    await syncConnection(connectionId, 'manual', adapter1);

    const mission = missionRepo.getMissionsByHabitatId(habitatId).missions[0];

    const adapter2 = makeFakeAdapter([makeIssue({ status: 'closed' })]);
    await syncConnection(connectionId, 'manual', adapter2);

    const updated = missionRepo.getMissionById(mission.id)!;
    expect(updated.status).toBe('done');
  });

  it('closed issue with active tasks adds external-closed label and warning', async () => {
    const adapter1 = makeFakeAdapter([makeIssue()]);
    await syncConnection(connectionId, 'manual', adapter1);

    const mission = missionRepo.getMissionsByHabitatId(habitatId).missions[0];
    taskRepo.createTask({ missionId: mission.id, title: 'Active task', createdBy: 'test' });

    const adapter2 = makeFakeAdapter([makeIssue({ status: 'closed' })]);
    await syncConnection(connectionId, 'manual', adapter2);

    const updated = missionRepo.getMissionById(mission.id)!;
    expect(updated.status).not.toBe('done');
    expect(updated.labels).toContain('external-closed');

    const link = linkRepo.listByMissionId(mission.id)[0];
    expect(link.syncStatus).toBe('warning');
    expect(link.syncWarning).toBe('External issue closed while Orcy mission has active tasks');
  });

  it('rejects disabled connection', async () => {
    connectionRepo.disable(connectionId);

    const adapter = makeFakeAdapter([makeIssue()]);
    await expect(syncConnection(connectionId, 'manual', adapter)).rejects.toThrow('disabled');
  });

  it('records sync run with counts', async () => {
    const adapter = makeFakeAdapter([
      makeIssue({ externalId: '1', externalKey: 'a#1' }),
      makeIssue({ externalId: '2', externalKey: 'a#2' }),
    ]);

    const result = await syncConnection(connectionId, 'manual', adapter);
    expect(result.createdCount).toBe(2);
    expect(result.status).toBe('success');
  });

  it('syncExternalIssue skips closed unlinked issues', () => {
    const connection = connectionRepo.getById(connectionId)!;
    const result = syncExternalIssue(connection, makeIssue({ status: 'closed' }));
    expect(result.action).toBe('skipped');
  });
});

describe('syncService — intake candidate path', () => {
  let jiraConnectionId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(columnsTable).run();
    db.delete(habitats).run();

    const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
    habitatId = habitat.id;
    columnId = columnRepo.createColumn({ habitatId, name: 'Todo', order: 0, requiresClaim: false }).id;

    const conn = connectionRepo.create({
      habitatId,
      provider: 'jira',
      name: 'Test Jira',
      authMethod: 'api_key',
      accessToken: 'jira-test',
      externalTenantId: 'cloud-1',
      externalTenantName: 'MySite',
      externalBaseUrl: 'https://mysite.atlassian.net',
      projectKey: 'PROJ',
      pullEnabled: true,
      autoImport: false,
      createdBy: 'user1',
    });
    jiraConnectionId = conn.id;
  });

  afterEach(() => {
    closeDb();
  });

  it('creates intake candidate for non-GitHub provider', () => {
    const connection = connectionRepo.getById(jiraConnectionId)!;
    const result = syncExternalIssue(connection, makeJiraIssue());

    expect(result.action).toBe('created');
    expect(result.missionId).toBe('');

    const candidates = candidateRepo.listByHabitat(habitatId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceTitle).toBe('Jira Bug');
    expect(candidates[0].provider).toBe('jira');
    expect(candidates[0].reviewStatus).toBe('new');
  });

  it('updates existing candidate on second sync', () => {
    const connection = connectionRepo.getById(jiraConnectionId)!;
    syncExternalIssue(connection, makeJiraIssue());
    const result = syncExternalIssue(connection, makeJiraIssue({ title: 'Updated Jira Bug' }));

    expect(result.action).toBe('updated');

    const candidates = candidateRepo.listByHabitat(habitatId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].sourceTitle).toBe('Updated Jira Bug');
  });

  it('skips closed issue that has no existing candidate', () => {
    const connection = connectionRepo.getById(jiraConnectionId)!;
    const result = syncExternalIssue(connection, makeJiraIssue({ status: 'closed' }));

    expect(result.action).toBe('skipped');

    const candidates = candidateRepo.listByHabitat(habitatId);
    expect(candidates).toHaveLength(0);
  });

  it('auto-ignores existing candidate when source issue closes', () => {
    const connection = connectionRepo.getById(jiraConnectionId)!;
    syncExternalIssue(connection, makeJiraIssue());

    let candidates = candidateRepo.listByHabitat(habitatId);
    expect(candidates[0].reviewStatus).toBe('new');

    syncExternalIssue(connection, makeJiraIssue({ status: 'closed' }));

    candidates = candidateRepo.listByHabitat(habitatId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].reviewStatus).toBe('ignored');
  });

  it('does not auto-ignore candidate that is already promoted', () => {
    const connection = connectionRepo.getById(jiraConnectionId)!;
    syncExternalIssue(connection, makeJiraIssue());

    const candidates = candidateRepo.listByHabitat(habitatId);
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: 'Promoted',
      description: '',
      priority: 'medium',
      labels: [],
      createdBy: 'test',
    });
    candidateRepo.update(candidates[0].id, { reviewStatus: 'promoted', promotedMissionId: mission.id });

    syncExternalIssue(connection, makeJiraIssue({ status: 'closed' }));

    const updated = candidateRepo.getById(candidates[0].id)!;
    expect(updated.reviewStatus).toBe('promoted');
  });

  it('GitHub connection without autoImport creates intake candidate', () => {
    const conn = connectionRepo.create({
      habitatId,
      provider: 'github',
      name: 'GitHub No Auto',
      authMethod: 'pat',
      accessToken: 'ghp_test2',
      repositoryOwner: 'acme',
      repositoryName: 'repo2',
      autoImport: false,
      pullEnabled: true,
      createdBy: 'user1',
    });

    const connection = connectionRepo.getById(conn.id)!;
    const result = syncExternalIssue(connection, {
      provider: 'github',
      externalId: 'gh-999',
      externalKey: 'acme/repo2#999',
      title: 'GH Issue',
      body: 'body',
      status: 'open',
      labels: [],
      url: 'https://github.com/acme/repo2/issues/999',
      updatedAt: new Date().toISOString(),
    });

    expect(result.action).toBe('created');
    expect(result.missionId).toBe('');

    const candidates = candidateRepo.listByHabitat(habitatId);
    expect(candidates).toHaveLength(1);
    expect(candidates[0].provider).toBe('github');
  });
});
