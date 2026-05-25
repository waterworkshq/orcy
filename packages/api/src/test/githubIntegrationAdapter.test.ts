import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { normalizeGitHubIssue } from '../services/integrations/githubAdapter.js';
import type { GitHubIssue } from '../services/integrations/githubAdapter.js';

function makeGitHubIssue(overrides: Partial<GitHubIssue> = {}): GitHubIssue {
  return {
    id: 12345,
    node_id: 'MDU6SXNzdWUxMjM0NTY3ODk=',
    number: 42,
    title: 'Test Issue',
    body: 'Issue body text',
    state: 'open',
    html_url: 'https://github.com/acme/repo/issues/42',
    labels: [{ name: 'bug' }, { name: 'enhancement' }],
    user: { login: 'testuser' },
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-02T00:00:00Z',
    ...overrides,
  };
}

describe('normalizeGitHubIssue', () => {
  it('normalizes open issue', () => {
    const issue = makeGitHubIssue();
    const result = normalizeGitHubIssue('acme', 'repo', issue);

    expect(result.provider).toBe('github');
    expect(result.externalId).toBe('MDU6SXNzdWUxMjM0NTY3ODk=');
    expect(result.externalKey).toBe('acme/repo#42');
    expect(result.title).toBe('Test Issue');
    expect(result.body).toBe('Issue body text');
    expect(result.status).toBe('open');
    expect(result.labels).toEqual(['bug', 'enhancement']);
    expect(result.url).toBe('https://github.com/acme/repo/issues/42');
    expect(result.reporter).toBe('testuser');
  });

  it('normalizes closed issue', () => {
    const issue = makeGitHubIssue({ state: 'closed' });
    const result = normalizeGitHubIssue('acme', 'repo', issue);
    expect(result.status).toBe('closed');
  });

  it('handles null body', () => {
    const issue = makeGitHubIssue({ body: null });
    const result = normalizeGitHubIssue('acme', 'repo', issue);
    expect(result.body).toBe('');
  });

  it('falls back to numeric id when node_id missing', () => {
    const issue = makeGitHubIssue({ node_id: undefined as any });
    const result = normalizeGitHubIssue('acme', 'repo', issue);
    expect(result.externalId).toBe('12345');
  });

  it('handles missing user', () => {
    const issue = makeGitHubIssue({ user: null });
    const result = normalizeGitHubIssue('acme', 'repo', issue);
    expect(result.reporter).toBeUndefined();
  });
});
