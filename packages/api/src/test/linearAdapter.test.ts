import { describe, it, expect } from 'vitest';
import { normalizeLinearIssue } from '../services/integrations/linearAdapter.js';
import type { LinearIssueNode } from '../services/integrations/linearAdapter.js';

function makeLinearIssue(overrides: Partial<LinearIssueNode> = {}): LinearIssueNode {
  return {
    id: 'issue-uuid-1',
    identifier: 'ORC-42',
    title: 'Fix API rate limiting',
    description: 'Rate limiter returns 429 too early',
    state: { name: 'In Progress', type: 'started' },
    priority: 2,
    estimate: 5,
    assignee: { name: 'Alice Dev', email: 'alice@example.com' },
    creator: { name: 'Bob PM', email: 'bob@example.com' },
    labels: { nodes: [{ name: 'backend' }, { name: 'urgent' }] },
    project: { name: 'v0.13' },
    cycle: { name: 'Sprint 3', number: 3 },
    url: 'https://linear.app/acme/issue/ORC-42',
    createdAt: '2026-01-10T10:00:00Z',
    updatedAt: '2026-01-15T14:00:00Z',
    ...overrides,
  };
}

describe('normalizeLinearIssue', () => {
  it('normalizes issue with all fields', () => {
    const issue = makeLinearIssue();
    const result = normalizeLinearIssue(issue);

    expect(result.provider).toBe('linear');
    expect(result.externalId).toBe('issue-uuid-1');
    expect(result.externalKey).toBe('ORC-42');
    expect(result.title).toBe('Fix API rate limiting');
    expect(result.body).toBe('Rate limiter returns 429 too early');
    expect(result.status).toBe('open');
    expect(result.labels).toEqual(['backend', 'urgent']);
    expect(result.priority).toBe('High');
    expect(result.sourceKind).toBeUndefined();
    expect(result.reporter).toBe('Bob PM');
    expect(result.url).toBe('https://linear.app/acme/issue/ORC-42');
    expect(result.updatedAt).toBe('2026-01-15T14:00:00Z');
  });

  it('maps completed state to closed', () => {
    const issue = makeLinearIssue({ state: { name: 'Done', type: 'completed' } });
    const result = normalizeLinearIssue(issue);
    expect(result.status).toBe('closed');
  });

  it('handles null fields', () => {
    const issue = makeLinearIssue({
      description: null,
      state: null,
      priority: null,
      assignee: null,
      creator: null,
      labels: null,
      project: null,
      cycle: null,
    });

    const result = normalizeLinearIssue(issue);

    expect(result.body).toBe('');
    expect(result.status).toBe('open');
    expect(result.priority).toBeUndefined();
    expect(result.assignees).toEqual([]);
    expect(result.reporter).toBeUndefined();
    expect(result.labels).toEqual([]);
  });

  it('maps priority numbers correctly', () => {
    expect(normalizeLinearIssue(makeLinearIssue({ priority: 0 })).priority).toBe('No priority');
    expect(normalizeLinearIssue(makeLinearIssue({ priority: 1 })).priority).toBe('Urgent');
    expect(normalizeLinearIssue(makeLinearIssue({ priority: 2 })).priority).toBe('High');
    expect(normalizeLinearIssue(makeLinearIssue({ priority: 3 })).priority).toBe('Medium');
    expect(normalizeLinearIssue(makeLinearIssue({ priority: 4 })).priority).toBe('Low');
  });

  it('handles empty labels nodes', () => {
    const issue = makeLinearIssue({ labels: { nodes: [] } });
    const result = normalizeLinearIssue(issue);
    expect(result.labels).toEqual([]);
  });
});
