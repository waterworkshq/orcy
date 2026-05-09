// @ts-nocheck
import { describe, it, expect, vi } from 'vitest';

function mockReqRes(overrides: Record<string, any> = {}) {
  const request: any = {
    params: {},
    query: {},
    body: {},
    agent: undefined,
    user: undefined,
    ...overrides,
  };
  const sent: any = { code: null, body: null, headers: {} };
  const reply: any = {
    code: vi.fn((c: number) => { sent.code = c; return reply; }),
    send: vi.fn((b: any) => { sent.body = b; return reply; }),
    header: vi.fn((k: string, v: string) => { sent.headers[k] = v; return reply; }),
  };
  return { request, reply, sent };
}

describe('delegateErrorToStatus', () => {
  it('maps not_found to 404', async () => {
    const { delegateErrorToStatus } = await import('../routes/tasks/delegation.js');
    expect(delegateErrorToStatus('not_found')).toBe(404);
  });

  it('maps capability_mismatch to 403', async () => {
    const { delegateErrorToStatus } = await import('../routes/tasks/delegation.js');
    expect(delegateErrorToStatus('capability_mismatch')).toBe(403);
  });

  it('maps domain_mismatch to 403', async () => {
    const { delegateErrorToStatus } = await import('../routes/tasks/delegation.js');
    expect(delegateErrorToStatus('domain_mismatch')).toBe(403);
  });

  it('maps unknown reasons to 409', async () => {
    const { delegateErrorToStatus } = await import('../routes/tasks/delegation.js');
    expect(delegateErrorToStatus('already_claimed')).toBe(409);
    expect(delegateErrorToStatus('wrong_status')).toBe(409);
  });
});
