import { describe, it, expect, afterEach } from 'vitest';
import {
  SUBSCRIPTION_DISPATCH_HANDLER,
  WORKTREE_DISPATCH_HANDLER,
} from '../../tools/index.js';
import { createMockClient } from '../__fixtures__/mock-client.js';
import { resetConfig } from '@orcy/shared';

afterEach(() => {
  resetConfig();
});

describe('subscription dispatch subscribe', () => {
  it('throws when ORCY_AGENT_ID not set', async () => {
    const client = createMockClient();
    const original = process.env.ORCY_AGENT_ID;
    delete process.env.ORCY_AGENT_ID;

    const result = await SUBSCRIPTION_DISPATCH_HANDLER(client, { action: 'subscribe', boardId: 'board-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ORCY_AGENT_ID not configured');

    process.env.ORCY_AGENT_ID = original ?? '';
  });
});

describe('subscription dispatch unsubscribe', () => {
  it('throws when ORCY_AGENT_ID not set', async () => {
    const client = createMockClient();
    const original = process.env.ORCY_AGENT_ID;
    delete process.env.ORCY_AGENT_ID;

    const result = await SUBSCRIPTION_DISPATCH_HANDLER(client, { action: 'unsubscribe', boardId: 'board-1' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('ORCY_AGENT_ID not configured');

    process.env.ORCY_AGENT_ID = original ?? '';
  });
});

describe('worktree dispatch get-worktree', () => {
  it('returns worktree info when available', async () => {
    const client = createMockClient();
    const mockWorktree = {
      path: '/repo/../task-abc12345',
      branch: 'task/abc12345',
      repoRoot: '/repo',
    };
    client.getWorktree.mockResolvedValue({ worktree: mockWorktree, enabled: true });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, { action: 'get-worktree', taskId: 'abc12345-xxxx' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.enabled).toBe(true);
    expect(result.worktree).toEqual(mockWorktree);
    expect(client.getWorktree).toHaveBeenCalledWith('abc12345-xxxx');
  });

  it('returns null worktree when not available', async () => {
    const client = createMockClient();
    client.getWorktree.mockResolvedValue({ worktree: null, enabled: false });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, { action: 'get-worktree', taskId: 'task-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.enabled).toBe(false);
    expect(result.worktree).toBeNull();
  });

  it('handles API errors gracefully', async () => {
    const client = createMockClient();
    client.getWorktree.mockResolvedValue({ worktree: null, enabled: false });

    const raw = await WORKTREE_DISPATCH_HANDLER(client, { action: 'get-worktree', taskId: 'task-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.worktree).toBeNull();
    expect(result.enabled).toBe(false);
  });
});
