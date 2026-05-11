import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

let _prs: Record<string, {
  id: string;
  taskId: string;
  provider: string;
  repo: string;
  prNumber: number;
  prTitle: string | null;
  prUrl: string;
  branchName: string | null;
  state: string;
  reviewStatus: string;
  createdAt: string;
  updatedAt: string;
}> = {};

let _tasks: Record<string, {
  id: string;
  boardId: string;
  status: string;
  title: string;
}> = {};

function createMockDb() {
  const doInsert = () => {
    let _vals: any;
    const chain = {
      values: (vals: any) => { _vals = vals; return chain; },
      run: () => {
        _prs[_vals.id] = {
          id: _vals.id,
          taskId: _vals.taskId,
          provider: _vals.provider,
          repo: _vals.repo,
          prNumber: _vals.prNumber,
          prTitle: _vals.prTitle ?? null,
          prUrl: _vals.prUrl,
          branchName: _vals.branchName ?? null,
          state: _vals.state ?? 'open',
          reviewStatus: _vals.reviewStatus ?? 'pending',
          createdAt: _vals.createdAt,
          updatedAt: _vals.updatedAt,
        };
      },
    };
    return chain;
  };

  const doSelect = () => {
    let _conditions: any[] = [];
    const chain = {
      from: () => chain,
      where: (...args: any[]) => { _conditions = args; return chain; },
      orderBy: (...args: any[]) => chain,
      all: () => {
        let results = Object.values(_prs);
        for (const cond of _conditions) {
          if (cond?._type === 'and') {
            for (const c of cond.conditions) {
              if (c?.col === 'provider') results = results.filter(r => r.provider === c.val);
              if (c?.col === 'repo') results = results.filter(r => r.repo === c.val);
              if (c?.col === 'prNumber') results = results.filter(r => r.prNumber === c.val);
              if (c?.col === 'taskId') results = results.filter(r => r.taskId === c.val);
            }
          }
          if (cond?.col === 'id') results = results.filter(r => r.id === cond.val);
          if (cond?.col === 'taskId') results = results.filter(r => r.taskId === cond.val);
        }
        return results;
      },
    };
    return chain;
  };

  const doUpdate = () => {
    let _vals: any;
    let _condition: any;
    const chain = {
      set: (vals: any) => { _vals = vals; return chain; },
      where: (condition: any) => { _condition = condition; return chain; },
      run: () => {
        const id = _condition?.val;
        if (id && _prs[id]) {
          Object.assign(_prs[id], _vals);
        }
      },
    };
    return chain;
  };

  const doDelete = () => {
    let _condition: any;
    const chain = {
      where: (condition: any) => { _condition = condition; return chain; },
      run: () => {
        if (_condition?.col === 'taskId') {
          Object.keys(_prs).forEach(k => {
            if (_prs[k].taskId === _condition.val) delete _prs[k];
          });
        }
      },
    };
    return chain;
  };

  return {
    insert: () => doInsert(),
    select: () => doSelect(),
    update: () => doUpdate(),
    delete: () => doDelete(),
  };
}

vi.mock('../db/index.js', () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: any) => ({ col, val }),
  and: (...conditions: any[]) => ({ _type: 'and', conditions }),
  sql: (strings: any, ...values: any[]) => ({ _type: 'sql', strings, values }),
  desc: (col: any) => col,
  asc: (col: any) => col,
  or: (...conditions: any[]) => ({ _type: 'or', conditions }),
  isNull: (col: string) => ({ _type: `isNull_${col}`, col }),
  not: (cond: any) => cond,
  count: () => 'count',
}));

vi.mock('../db/schema/index.js', () => ({
  pullRequests: {
    id: 'id',
    taskId: 'taskId',
    provider: 'provider',
    repo: 'repo',
    prNumber: 'prNumber',
    prTitle: 'prTitle',
    prUrl: 'prUrl',
    branchName: 'branchName',
    state: 'state',
    reviewStatus: 'reviewStatus',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  tasks: { id: 'id', boardId: 'boardId', title: 'title', status: 'status', artifacts: 'artifacts' },
  boards: { id: 'id', name: 'name', codeReviewSettings: 'codeReviewSettings' },
  agents: { id: 'id', name: 'name' },
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

vi.mock('../repositories/event.js', () => ({
  createEvent: vi.fn(),
}));

describe('PullRequest type', () => {
  it('PullRequest interface has correct shape', async () => {
    type T = import('../models/index.js').PullRequest;
    const pr: T = {
      id: 'pr-1',
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      prNumber: 42,
      prTitle: 'Fix bug',
      prUrl: 'https://github.com/org/repo/pull/42',
      branchName: 'feature/abc-123',
      state: 'open',
      reviewStatus: 'pending',
      createdAt: '2026-04-10T00:00:00Z',
      updatedAt: '2026-04-10T00:00:00Z',
    };
    expect(pr.provider).toBe('github');
    expect(pr.state).toBe('open');
    expect(pr.reviewStatus).toBe('pending');
  });
});

describe('CodeReviewSettings type', () => {
  it('has correct shape', async () => {
    type T = import('../models/index.js').CodeReviewSettings;
    const settings: T = {
      autoApproveOnMerge: true,
      githubSecret: 'secret123',
      gitlabSecret: null,
      taskPattern: '([0-9a-f-]{36})',
    };
    expect(settings.autoApproveOnMerge).toBe(true);
    expect(settings.githubSecret).toBe('secret123');
  });
});

describe('findTaskIdByPattern', () => {
  it('matches UUID in branch name', async () => {
    const { findTaskIdByPattern } = await import('../repositories/pullRequest.js');
    const taskId = '550e8400-e29b-41d4-a716-446655440000';
    const result = findTaskIdByPattern(
      `feature/${taskId}-fix`,
      '([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})'
    );
    expect(result).toBe(taskId);
  });

  it('returns null when no match', async () => {
    const { findTaskIdByPattern } = await import('../repositories/pullRequest.js');
    const result = findTaskIdByPattern('feature/no-uuid-here', '([0-9a-f-]{36})');
    expect(result).toBeNull();
  });

  it('handles invalid regex gracefully', async () => {
    const { findTaskIdByPattern } = await import('../repositories/pullRequest.js');
    const result = findTaskIdByPattern('test', '[invalid');
    expect(result).toBeNull();
  });

  it('matches task ID in PR title with custom pattern', async () => {
    const { findTaskIdByPattern } = await import('../repositories/pullRequest.js');
    const result = findTaskIdByPattern('[T-123] Fix login', 'T-(\\d+)');
    expect(result).toBe('123');
  });
});

describe('GitHub webhook signature verification', () => {
  it('verifies valid HMAC-SHA256 signature', async () => {
    const { verifyGitHubSignature } = await import('../services/githubWebhook.js');
    const secret = 'test-secret';
    const payload = '{"action":"opened"}';
    const signature = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyGitHubSignature(payload, signature, secret)).toBe(true);
  });

  it('rejects invalid signature', async () => {
    const { verifyGitHubSignature } = await import('../services/githubWebhook.js');
    expect(verifyGitHubSignature('{"action":"opened"}', 'sha256=invalid', 'secret')).toBe(false);
  });

  it('rejects wrong secret', async () => {
    const { verifyGitHubSignature } = await import('../services/githubWebhook.js');
    const payload = '{"action":"opened"}';
    const signature = 'sha256=' + createHmac('sha256', 'correct').update(payload).digest('hex');
    expect(verifyGitHubSignature(payload, signature, 'wrong')).toBe(false);
  });
});

describe('GitLab webhook token verification', () => {
  it('accepts matching token', async () => {
    const { verifyGitLabToken } = await import('../services/gitlabWebhook.js');
    expect(verifyGitLabToken('my-token', 'my-token')).toBe(true);
  });

  it('rejects non-matching token', async () => {
    const { verifyGitLabToken } = await import('../services/gitlabWebhook.js');
    expect(verifyGitLabToken('wrong', 'my-token')).toBe(false);
  });
});

describe('GitHub PR event handling', () => {
  beforeEach(() => {
    _prs = {};
    _tasks = {};
  });

  it('returns no_matching_task when no task found', async () => {
    const { handlePullRequestEvent } = await import('../services/githubWebhook.js');
    const result = handlePullRequestEvent({
      action: 'opened',
      number: 1,
      pull_request: {
        title: 'Some PR',
        html_url: 'https://github.com/org/repo/pull/1',
        state: 'open',
        merged: false,
        head: { ref: 'feature/test' },
        base: { repo: { full_name: 'org/repo' } },
      },
    });
    expect(result.status).toBe('no_matching_task');
  });
});

describe('GitLab MR event handling', () => {
  beforeEach(() => {
    _prs = {};
    _tasks = {};
  });

  it('returns no_matching_task when no task found', async () => {
    const { handleMergeRequestEvent } = await import('../services/gitlabWebhook.js');
    const result = handleMergeRequestEvent({
      object_kind: 'merge_request',
      action: 'open',
      object_attributes: {
        iid: 1,
        title: 'Some MR',
        url: 'https://gitlab.com/org/repo/-/merge_requests/1',
        state: 'opened',
        merge_status: 'unchecked',
        source_branch: 'feature/test',
        target_project_id: 1,
      },
      project: { path_with_namespace: 'org/repo' },
    });
    expect(result.status).toBe('no_matching_task');
  });
});

describe('GitLab note event handling', () => {
  it('ignores non-MR notes', async () => {
    const { handleNoteEvent } = await import('../services/gitlabWebhook.js');
    const result = handleNoteEvent({
      object_kind: 'note',
      noteable_type: 'Issue',
      note: { noteable_iid: 1 },
      merge_request: {
        iid: 1,
        title: 'Test',
        url: 'https://gitlab.com/org/repo/-/merge_requests/1',
        state: 'opened',
        source_branch: 'main',
      },
      project: { path_with_namespace: 'org/repo' },
    });
    expect(result.status).toBe('ignored');
  });
});

describe('PullRequest repository', () => {
  beforeEach(() => {
    _prs = {};
  });

  it('creates and retrieves a PR', async () => {
    const { createPullRequest, getById } = await import('../repositories/pullRequest.js');
    const pr = createPullRequest({
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      prNumber: 42,
      prTitle: 'Fix bug',
      prUrl: 'https://github.com/org/repo/pull/42',
      branchName: 'feature/test',
    });
    expect(pr.provider).toBe('github');
    expect(pr.prNumber).toBe(42);
    expect(pr.state).toBe('open');
    expect(pr.reviewStatus).toBe('pending');
  });

  it('lists PRs by task ID', async () => {
    const { createPullRequest, getByTaskId } = await import('../repositories/pullRequest.js');
    createPullRequest({
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    createPullRequest({
      taskId: 'task-1',
      provider: 'gitlab',
      repo: 'org/repo',
      prNumber: 2,
      prUrl: 'https://gitlab.com/org/repo/-/merge_requests/2',
    });
    const prs = getByTaskId('task-1');
    expect(prs).toHaveLength(2);
  });

  it('updates PR state', async () => {
    const { createPullRequest, updatePullRequest } = await import('../repositories/pullRequest.js');
    const pr = createPullRequest({
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      prNumber: 1,
      prUrl: 'https://github.com/org/repo/pull/1',
    });
    const updated = updatePullRequest(pr.id, { state: 'merged', reviewStatus: 'approved' });
    expect(updated!.state).toBe('merged');
    expect(updated!.reviewStatus).toBe('approved');
  });

  it('finds PR by provider and number', async () => {
    const { createPullRequest, findByProviderAndNumber } = await import('../repositories/pullRequest.js');
    createPullRequest({
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      prNumber: 42,
      prUrl: 'https://github.com/org/repo/pull/42',
    });
    const found = findByProviderAndNumber('github', 'org/repo', 42);
    expect(found).not.toBeNull();
    expect(found!.prNumber).toBe(42);
  });

  it('returns null for non-existent PR', async () => {
    const { findByProviderAndNumber } = await import('../repositories/pullRequest.js');
    const found = findByProviderAndNumber('github', 'org/repo', 999);
    expect(found).toBeNull();
  });
});
