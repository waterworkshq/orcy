import { describe, it, expect, vi, beforeEach } from 'vitest';
import { jiraAdapter, normalizeJiraIssue, extractAdfText } from '../services/integrations/jiraAdapter.js';
import type { JiraIssue, AdfNode } from '../services/integrations/jiraAdapter.js';
import type { IntegrationConnection } from '@orcy/shared';

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

function mockResponse(status: number, data: unknown) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  };
}

function makeConnection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    id: 'conn-1',
    habitatId: 'hab-1',
    provider: 'jira',
    name: 'Test Jira',
    authMethod: 'oauth_code',
    accessToken: 'test-token',
    refreshToken: 'rt-test',
    tokenExpiresAt: null,
    externalAccountId: null,
    externalAccountName: null,
    externalTenantId: 'cloud-123',
    externalTenantName: 'mysite',
    externalBaseUrl: 'https://mysite.atlassian.net',
    repositoryOwner: null,
    repositoryName: null,
    projectKey: 'ORCY',
    teamId: null,
    providerConfig: {},
    enabled: true,
    pullEnabled: true,
    autoImport: false,
    webhookSecret: null,
    webhookExternalId: null,
    lastSyncAt: null,
    lastSyncStatus: 'never',
    lastSyncError: null,
    createdBy: 'user-1',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

function makeJiraIssue(overrides: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10002',
    key: 'ORCY-123',
    self: 'https://mysite.atlassian.net/rest/api/3/issue/10002',
    fields: {
      summary: 'Fix login bug',
      description: {
        type: 'doc',
        content: [
          {
            type: 'paragraph',
            content: [{ type: 'text', text: 'Login fails on mobile' }],
          },
        ],
      },
      status: { name: 'In Progress', statusCategory: { name: 'In Progress' } },
      priority: { name: 'High', id: '2' },
      issuetype: { name: 'Bug', id: '10004' },
      labels: ['backend', 'urgent'],
      components: [{ name: 'Auth' }],
      assignee: { accountId: 'u-1', displayName: 'Jane Smith' },
      reporter: { accountId: 'u-2', displayName: 'John Doe' },
      project: { key: 'ORCY', name: 'Orcy Project', id: '10000' },
      created: '2026-01-15T10:00:00.000+0000',
      updated: '2026-03-20T14:30:00.000+0000',
    },
    ...overrides,
  };
}

describe('extractAdfText', () => {
  it('extracts text from simple ADF document', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Hello world' }],
        },
      ],
    };
    expect(extractAdfText(doc)).toBe('Hello world');
  });

  it('extracts text from multi-paragraph ADF', () => {
    const doc: AdfNode = {
      type: 'doc',
      content: [
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'First paragraph' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: 'Second paragraph' }],
        },
      ],
    };
    expect(extractAdfText(doc)).toBe('First paragraph\nSecond paragraph');
  });

  it('returns empty string for null', () => {
    expect(extractAdfText(null)).toBe('');
  });

  it('handles empty content', () => {
    expect(extractAdfText({ type: 'doc', content: [] })).toBe('');
  });

  it('handles text node without text property', () => {
    expect(extractAdfText({ type: 'text' })).toBe('');
  });
});

describe('normalizeJiraIssue', () => {
  it('normalizes issue with all fields', () => {
    const connection = makeConnection();
    const issue = makeJiraIssue();

    const result = normalizeJiraIssue(issue, connection);

    expect(result.provider).toBe('jira');
    expect(result.externalId).toBe('10002');
    expect(result.externalKey).toBe('ORCY-123');
    expect(result.title).toBe('Fix login bug');
    expect(result.body).toBe('Login fails on mobile');
    expect(result.status).toBe('open');
    expect(result.labels).toEqual(['backend', 'urgent', 'Auth']);
    expect(result.sourceKind).toBe('Bug');
    expect(result.priority).toBe('High');
    expect(result.assignees).toEqual(['Jane Smith']);
    expect(result.reporter).toBe('John Doe');
    expect(result.url).toBe('https://mysite.atlassian.net/browse/ORCY-123');
    expect(result.updatedAt).toBe('2026-03-20T14:30:00.000+0000');
    expect(result.rawProviderPayload).toBeDefined();
  });

  it('maps Done status category to closed', () => {
    const issue = makeJiraIssue({
      fields: {
        ...makeJiraIssue().fields,
        status: { name: 'Done', statusCategory: { name: 'Done' } },
      },
    });
    const result = normalizeJiraIssue(issue, makeConnection());
    expect(result.status).toBe('closed');
  });

  it('handles null fields gracefully', () => {
    const fields = makeJiraIssue().fields;
    const issue = makeJiraIssue({
      fields: {
        ...fields,
        description: null,
        assignee: null,
        reporter: null,
        priority: null,
        issuetype: null,
        status: null,
      },
    });

    const result = normalizeJiraIssue(issue, makeConnection());

    expect(result.body).toBe('');
    expect(result.assignees).toEqual([]);
    expect(result.reporter).toBeUndefined();
    expect(result.priority).toBeUndefined();
    expect(result.sourceKind).toBeUndefined();
    expect(result.status).toBe('open');
  });

  it('falls back to self URL when no baseUrl', () => {
    const connection = makeConnection({ externalBaseUrl: null });
    const issue = makeJiraIssue();

    const result = normalizeJiraIssue(issue, connection);
    expect(result.url).toBe(issue.self);
  });
});

describe('jiraAdapter API token auth', () => {
  it('uses site REST API with Basic auth for API token connections', async () => {
    const issue = makeJiraIssue();
    mockFetch.mockResolvedValue(mockResponse(200, {
      isLast: true,
      issues: [issue],
    }));

    const connection = makeConnection({
      authMethod: 'api_key',
      accessToken: 'jira-token',
      refreshToken: null,
      tokenExpiresAt: null,
      externalAccountName: 'dev@example.com',
      externalTenantId: null,
      externalBaseUrl: 'https://mysite.atlassian.net/',
    });

    const issues = await jiraAdapter.listIssues(connection);

    expect(issues).toHaveLength(1);
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('https://mysite.atlassian.net/rest/api/3/search/jql'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from('dev@example.com:jira-token').toString('base64')}`,
        }),
      }),
    );
  });

  it('throws a setup error when API token email is missing', async () => {
    const connection = makeConnection({
      authMethod: 'api_key',
      externalAccountName: null,
      externalTenantId: null,
    });

    await expect(jiraAdapter.listIssues(connection)).rejects.toThrow('account email');
  });
});
