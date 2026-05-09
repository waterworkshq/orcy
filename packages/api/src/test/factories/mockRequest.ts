import type { FastifyRequest, FastifyReply } from 'fastify';
import { vi } from 'vitest';

export interface MockRequestOverrides {
  params?: Record<string, string>;
  query?: Record<string, string>;
  body?: unknown;
  headers?: Record<string, string>;
  agent?: { id: string; name?: string; domain?: string } | undefined;
  user?: { id: string; username?: string; role?: string; type?: string } | undefined;
}

export interface MockReplyResult {
  code: number | null;
  body: any;
}

export function mockRequest(overrides: MockRequestOverrides = {}): FastifyRequest {
  return {
    params: overrides.params ?? {},
    query: overrides.query ?? {},
    body: overrides.body ?? {},
    headers: overrides.headers ?? {},
    agent: overrides.agent,
    user: overrides.user,
  } as unknown as FastifyRequest;
}

export function mockReply(): { reply: FastifyReply; sent: MockReplyResult } {
  const sent: MockReplyResult = { code: null, body: null };
  const reply = {
    code: vi.fn((c: number) => { sent.code = c; return reply; }),
    send: vi.fn((b: unknown) => { sent.body = b; return reply; }),
    header: vi.fn(() => reply),
    status: vi.fn((c: number) => { sent.code = c; return reply; }),
  } as unknown as FastifyReply;
  return { reply, sent };
}
