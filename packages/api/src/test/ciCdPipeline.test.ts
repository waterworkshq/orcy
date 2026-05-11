import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createHmac } from 'crypto';

let _pipelineEvents: Record<string, {
  id: string;
  taskId: string;
  provider: string;
  repo: string;
  runId: string;
  status: string;
  branch: string;
  commitSha: string | null;
  createdAt: string;
}> = {};

let _tasks: Record<string, {
  id: string;
  boardId: string;
  status: string;
  title: string;
  artifacts: string;
}> = {};

function createMockDb() {
  const doInsert = () => {
    let _vals: any;
    const chain = {
      values: (vals: any) => { _vals = vals; return chain; },
      run: () => {
        _pipelineEvents[_vals.id] = {
          id: _vals.id,
          taskId: _vals.taskId,
          provider: _vals.provider,
          repo: _vals.repo,
          runId: _vals.runId,
          status: _vals.status,
          branch: _vals.branch,
          commitSha: _vals.commitSha ?? null,
          createdAt: _vals.createdAt,
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
        let results = Object.values(_pipelineEvents);
        for (const cond of _conditions) {
          if (cond?._type === 'and') {
            for (const c of cond.conditions) {
              if (c?.col === 'provider') results = results.filter(r => r.provider === c.val);
              if (c?.col === 'repo') results = results.filter(r => r.repo === c.val);
              if (c?.col === 'runId') results = results.filter(r => r.runId === c.val);
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
        if (id && _pipelineEvents[id]) {
          Object.assign(_pipelineEvents[id], _vals);
        }
      },
    };
    return chain;
  };

  return {
    insert: () => doInsert(),
    select: () => doSelect(),
    update: () => doUpdate(),
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
}));

vi.mock('../db/schema/index.js', () => ({
  pipelineEvents: {
    id: 'id',
    taskId: 'taskId',
    provider: 'provider',
    repo: 'repo',
    runId: 'runId',
    status: 'status',
    branch: 'branch',
    commitSha: 'commitSha',
    createdAt: 'createdAt',
  },
  tasks: { id: 'id', boardId: 'boardId', title: 'title', status: 'status', artifacts: 'artifacts' },
  boards: { id: 'id', name: 'name', ciCdSettings: 'ciCdSettings' },
  agents: { id: 'id', name: 'name' },
  pullRequests: { id: 'id', taskId: 'taskId' },
}));

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: { publish: vi.fn() },
}));

vi.mock('../repositories/event.js', () => ({
  createEvent: vi.fn(),
}));

vi.mock('../repositories/pullRequest.js', () => ({
  findTaskIdByPattern: vi.fn(),
  createPullRequest: vi.fn(),
  getById: vi.fn(),
  getByTaskId: vi.fn(),
  updatePullRequest: vi.fn(),
  findByProviderAndNumber: vi.fn(),
}));

vi.mock('../repositories/task.js', () => ({
  getTaskById: vi.fn((id: string) => _tasks[id] ? { id, boardId: _tasks[id].boardId, artifacts: JSON.parse(_tasks[id].artifacts || '[]') } : null),
  addArtifact: vi.fn(),
}));

vi.mock('../repositories/board.js', () => ({
  listBoards: vi.fn(() => []),
  getBoardById: vi.fn(),
}));

describe('PipelineEvent type', () => {
  it('PipelineEvent interface has correct shape', async () => {
    type T = import('../models/index.js').PipelineEvent;
    const pe: T = {
      id: 'pe-1',
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      runId: '12345',
      status: 'success',
      branch: 'main',
      commitSha: 'abc123',
      createdAt: '2026-04-10T00:00:00Z',
    };
    expect(pe.provider).toBe('github');
    expect(pe.status).toBe('success');
    expect(pe.branch).toBe('main');
  });
});

describe('CiCdSettings type', () => {
  it('has correct shape', async () => {
    type T = import('../models/index.js').CiCdSettings;
    const settings: T = {
      githubSecret: 'secret123',
      gitlabSecret: null,
      taskPattern: '([0-9a-f-]{36})',
    };
    expect(settings.githubSecret).toBe('secret123');
    expect(settings.gitlabSecret).toBeNull();
  });
});

describe('GitHub CI signature verification', () => {
  it('verifies valid HMAC-SHA256 signature', async () => {
    const { verifyGitHubSignature } = await import('../services/ciCdService.js');
    const secret = 'test-secret';
    const payload = '{"action":"completed"}';
    const signature = 'sha256=' + createHmac('sha256', secret).update(payload).digest('hex');
    expect(verifyGitHubSignature(payload, signature, secret)).toBe(true);
  });

  it('rejects invalid signature', async () => {
    const { verifyGitHubSignature } = await import('../services/ciCdService.js');
    expect(verifyGitHubSignature('{"action":"completed"}', 'sha256=invalid', 'secret')).toBe(false);
  });
});

describe('GitLab CI token verification', () => {
  it('accepts matching token', async () => {
    const { verifyGitLabToken } = await import('../services/ciCdService.js');
    expect(verifyGitLabToken('my-token', 'my-token')).toBe(true);
  });

  it('rejects non-matching token', async () => {
    const { verifyGitLabToken } = await import('../services/ciCdService.js');
    expect(verifyGitLabToken('wrong', 'my-token')).toBe(false);
  });
});

describe('GitHub workflow_run event handling', () => {
  beforeEach(() => {
    _pipelineEvents = {};
    _tasks = {};
  });

  it('returns no_matching_task when no task found', async () => {
    const { handleGitHubWorkflowRunEvent } = await import('../services/ciCdService.js');
    const result = handleGitHubWorkflowRunEvent({
      action: 'completed',
      workflow_run: {
        id: 42,
        name: 'CI',
        status: 'completed',
        conclusion: 'success',
        head_branch: 'feature/test',
        head_sha: 'abc123',
        repository: { full_name: 'org/repo' },
        html_url: 'https://github.com/org/repo/actions/runs/42',
      },
    });
    expect(result.status).toBe('no_matching_task');
  });
});

describe('GitLab pipeline event handling', () => {
  beforeEach(() => {
    _pipelineEvents = {};
    _tasks = {};
  });

  it('returns no_matching_task when no task found', async () => {
    const { handleGitLabPipelineEvent } = await import('../services/ciCdService.js');
    const result = handleGitLabPipelineEvent({
      object_kind: 'pipeline',
      object_attributes: {
        id: 1,
        status: 'success',
        ref: 'main',
        sha: 'abc123',
      },
      project: {
        path_with_namespace: 'org/repo',
        web_url: 'https://gitlab.com/org/repo',
      },
    });
    expect(result.status).toBe('no_matching_task');
  });
});

describe('GitLab build/job event handling', () => {
  it('returns no_matching_task when no task found', async () => {
    const { handleGitLabJobEvent } = await import('../services/ciCdService.js');
    const result = handleGitLabJobEvent({
      object_kind: 'build',
      build_id: 1,
      build_name: 'test',
      build_status: 'success',
      ref: 'main',
      sha: 'abc123',
      pipeline_id: 100,
      project: {
        path_with_namespace: 'org/repo',
        web_url: 'https://gitlab.com/org/repo',
      },
    });
    expect(result.status).toBe('no_matching_task');
  });
});

describe('PipelineEvent repository', () => {
  beforeEach(() => {
    _pipelineEvents = {};
  });

  it('creates and retrieves a pipeline event', async () => {
    const { createPipelineEvent, getById } = await import('../repositories/pipelineEvent.js');
    const pe = createPipelineEvent({
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      runId: '42',
      status: 'success',
      branch: 'main',
      commitSha: 'abc123',
    });
    expect(pe.provider).toBe('github');
    expect(pe.runId).toBe('42');
    expect(pe.status).toBe('success');
  });

  it('lists pipeline events by task ID', async () => {
    const { createPipelineEvent, getByTaskId } = await import('../repositories/pipelineEvent.js');
    createPipelineEvent({
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      runId: '1',
      status: 'queued',
      branch: 'main',
    });
    createPipelineEvent({
      taskId: 'task-1',
      provider: 'gitlab',
      repo: 'org/repo',
      runId: '2',
      status: 'success',
      branch: 'main',
    });
    const events = getByTaskId('task-1');
    expect(events).toHaveLength(2);
  });

  it('updates pipeline event status', async () => {
    const { createPipelineEvent, updatePipelineEvent } = await import('../repositories/pipelineEvent.js');
    const pe = createPipelineEvent({
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      runId: '1',
      status: 'queued',
      branch: 'main',
    });
    const updated = updatePipelineEvent(pe.id, { status: 'success' });
    expect(updated!.status).toBe('success');
  });

  it('finds pipeline event by provider and run ID', async () => {
    const { createPipelineEvent, findByProviderAndRunId } = await import('../repositories/pipelineEvent.js');
    createPipelineEvent({
      taskId: 'task-1',
      provider: 'github',
      repo: 'org/repo',
      runId: '42',
      status: 'success',
      branch: 'main',
    });
    const found = findByProviderAndRunId('github', 'org/repo', '42');
    expect(found).not.toBeNull();
    expect(found!.runId).toBe('42');
  });

  it('returns null for non-existent pipeline event', async () => {
    const { findByProviderAndRunId } = await import('../repositories/pipelineEvent.js');
    const found = findByProviderAndRunId('github', 'org/repo', '999');
    expect(found).toBeNull();
  });
});
