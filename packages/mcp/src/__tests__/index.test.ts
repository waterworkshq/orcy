import { describe, it, expect, vi, afterEach } from 'vitest';
import { getCurrentAgentId } from '../tools/agent-id.js';
import { createDispatchHandler } from '../tools/dispatch-utils.js';
import { resetConfig } from '@orcy/shared';

describe('getCurrentAgentId', () => {
  const originalAgentId = process.env.ORCY_AGENT_ID;

  afterEach(() => {
    process.env.ORCY_AGENT_ID = originalAgentId ?? '';
    resetConfig();
  });

  it('returns env var value when set', () => {
    process.env.ORCY_AGENT_ID = 'agent-123';
    expect(getCurrentAgentId()).toBe('agent-123');
  });

  it('returns empty string when env var unset', () => {
    delete process.env.ORCY_AGENT_ID;
    expect(getCurrentAgentId()).toBe('');
  });
});

describe('createDispatchHandler', () => {
  it('produces handler that returns formatted result', async () => {
    const mockResult = { success: true, data: 'test' };
    const mockFn = vi.fn().mockResolvedValue(mockResult);
    const actions = { 'test': mockFn };
    const handler = createDispatchHandler(actions);

    const client = {} as any;
    const result = await handler(client, { action: 'test' });

    expect(result.content[0].text).toBe(JSON.stringify(mockResult, null, 2));
  });

  it('routes to the correct action', async () => {
    const fn1 = vi.fn().mockResolvedValue('result1');
    const fn2 = vi.fn().mockResolvedValue('result2');
    const actions = { 'action1': fn1, 'action2': fn2 };
    const handler = createDispatchHandler(actions);

    const client = {} as any;
    const result = await handler(client, { action: 'action2' });

    expect(fn1).not.toHaveBeenCalled();
    expect(fn2).toHaveBeenCalledWith(client, { action: 'action2' });
    expect(result.content[0].text).toBe(JSON.stringify('result2', null, 2));
  });

  it('returns isError for unknown action', async () => {
    const actions = { 'valid-action': vi.fn() };
    const handler = createDispatchHandler(actions);

    const client = {} as any;
    const result = await handler(client, { action: 'unknown-action' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Unknown action: unknown-action');
    expect(result.content[0].text).toContain('valid-action');
  });
});

describe('Error response format', () => {
  it('returns appropriate error format for unknown tool', () => {
    const unknownToolName = 'nonexistent_tool';
    const result = {
      content: [{ type: 'text' as const, text: `Unknown tool: ${unknownToolName}` }],
      isError: true,
    };

    expect(result.content[0].text).toBe('Unknown tool: nonexistent_tool');
    expect(result.isError).toBe(true);
  });
});
