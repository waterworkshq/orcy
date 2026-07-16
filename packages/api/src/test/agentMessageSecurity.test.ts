import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initTestDb, closeDb } from '../db/index.js';
import * as agentRepo from '../repositories/agent.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as agentMessageRepo from '../repositories/agentMessage.js';
import { agentMessageRoutes, requireSelfAgent } from '../routes/agentMessages.js';
import { isAppError } from '../errors.js';

function mockReqRes(overrides: Record<string, any> = {}) {
  const request: any = {
    params: {},
    query: {},
    body: {},
    agent: undefined,
    user: undefined,
    ...overrides,
  };
  const sent: any = { code: null, body: null };
  const reply: any = {
    code: vi.fn((c: number) => { sent.code = c; return reply; }),
    send: vi.fn((b: any) => { sent.body = b; return reply; }),
    status: vi.fn((c: number) => { sent.code = c; return reply; }),
  };
  return { request, reply, sent };
}

async function callHandler(handler: any, request: any, reply: any, sent: any): Promise<void> {
  try {
    await handler(request, reply);
  } catch (err: unknown) {
    if (isAppError(err)) {
      sent.code = err.statusCode;
      sent.body = { error: err.message, code: err.code, details: err.details };
      return;
    }
    throw err;
  }
}

type RouteHandler = (req: any, reply: any) => Promise<void>;
interface CapturedRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    post: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'POST', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    get: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'GET', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    put: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'PUT', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'DELETE', path, handler: typeof opts === 'function' ? opts : handler });
    }),
  };
  agentMessageRoutes(fakeFastify);
  return routes;
}

function findRoute(routes: CapturedRoute[], method: string, pathPattern: string): RouteHandler {
  const r = routes.find(route => route.method === method && route.path.includes(pathPattern));
  if (!r) throw new Error(`Route ${method} ${pathPattern} not found`);
  return r.handler;
}

describe('Agent Message Security', () => {
  let habitatId: string;
  let agent1Id: string;
  let agent2Id: string;
  let agent3Id: string;
  let routes: CapturedRoute[];

  beforeEach(async () => {
    await initTestDb();

    const habitat = habitatRepo.createHabitat({ name: 'Security Test Habitat' });
    habitatId = habitat.id;

    const a1 = agentRepo.createAgent({ name: 'agent-a', type: 'claude-code', domain: 'backend' });
    agent1Id = a1.agent.id;

    const a2 = agentRepo.createAgent({ name: 'agent-b', type: 'opencode', domain: 'frontend' });
    agent2Id = a2.agent.id;

    const a3 = agentRepo.createAgent({ name: 'agent-c', type: 'codex', domain: 'devops' });
    agent3Id = a3.agent.id;

    routes = captureRoutes();
  });

  afterEach(() => { closeDb(); });

  describe('requireSelfAgent helper', () => {
    it('returns true when agent ID matches authenticated agent', () => {
      const req: any = { agent: { id: agent1Id } };
      expect(requireSelfAgent(req, agent1Id)).toBe(true);
    });

    it('returns false when agent ID differs from authenticated agent', () => {
      const req: any = { agent: { id: agent1Id } };
      expect(requireSelfAgent(req, agent2Id)).toBe(false);
    });
  });

  describe('Message ownership — repository layer', () => {
    it('allows recipient to mark a message read', () => {
      const msg = agentMessageRepo.createMessage({
        habitatId,
        fromAgentId: agent1Id,
        toAgentId: agent2Id,
        subject: 'Test',
        body: 'Body',
      });

      const updated = agentMessageRepo.markAsRead(msg.id);
      expect(updated).not.toBeNull();
      expect(updated!.readAt).not.toBeNull();
    });

    it('allows sender to mark a message read (permitted participant)', () => {
      const msg = agentMessageRepo.createMessage({
        habitatId,
        fromAgentId: agent1Id,
        toAgentId: agent2Id,
        subject: 'Test',
        body: 'Body',
      });

      const updated = agentMessageRepo.markAsRead(msg.id);
      expect(updated).not.toBeNull();
    });
  });

  describe('Cross-agent impersonation denial — integration', () => {
    it('agent A cannot send a message as agent B', async () => {
      const handler = findRoute(routes, 'POST', '/agents/:agentId/messages');
      const { request, reply, sent } = mockReqRes({
        params: { agentId: agent2Id },
        body: { habitatId, toAgentId: agent1Id, subject: 'hi', body: 'hello' },
        agent: { id: agent1Id, name: 'agent-a' },
      });

      await callHandler(handler, request, reply, sent);
      expect(sent.code).toBe(403);
    });

    it('agent A cannot list agent B inbox', async () => {
      const handler = findRoute(routes, 'GET', '/agents/:agentId/messages');
      const { request, reply, sent } = mockReqRes({
        params: { agentId: agent2Id },
        agent: { id: agent1Id, name: 'agent-a' },
      });

      await callHandler(handler, request, reply, sent);
      expect(sent.code).toBe(403);
      expect(sent.body.error).toContain('read its own messages');
    });

    it('agent A cannot read agent B messages (with messages in DB)', async () => {
      agentMessageRepo.createMessage({
        habitatId,
        fromAgentId: agent1Id,
        toAgentId: agent2Id,
        subject: 'Private to B',
        body: 'Secret',
      });

      const handler = findRoute(routes, 'GET', '/agents/:agentId/messages');

      const { request, reply, sent } = mockReqRes({
        params: { agentId: agent2Id },
        query: {},
        agent: { id: agent1Id, name: 'agent-a' },
      });

      await callHandler(handler, request, reply, sent);

      expect(sent.code).toBe(403);
      expect(sent.body.error).toContain('read its own messages');
    });

    it('agent A cannot mark all agent B messages read', async () => {
      const handler = findRoute(routes, 'PUT', '/agents/:agentId/messages/read-all');
      const { request, reply, sent } = mockReqRes({
        params: { agentId: agent2Id },
        agent: { id: agent1Id, name: 'agent-a' },
      });

      await callHandler(handler, request, reply, sent);
      expect(sent.code).toBe(403);
      expect(sent.body.error).toContain('mark its own messages');
    });

    it('agent B (recipient) can delete a message from agent A', async () => {
      const msg = agentMessageRepo.createMessage({
        habitatId,
        fromAgentId: agent1Id,
        toAgentId: agent2Id,
        subject: 'Hello',
        body: 'World',
      });

      const handler = findRoute(routes, 'DELETE', '/agents/messages/:id');

      const { request, reply, sent } = mockReqRes({
        params: { id: msg.id },
        agent: { id: agent2Id, name: 'agent-b' },
      });

      await handler(request, reply);

      expect(sent.code).toBe(204);
      expect(agentMessageRepo.getMessageById(msg.id)).toBeNull();
    });

    it('unrelated agent C cannot delete agent A-B message', async () => {
      const msg = agentMessageRepo.createMessage({
        habitatId, fromAgentId: agent1Id, toAgentId: agent2Id,
        subject: 'secret', body: 'confidential',
      });
      const handler = findRoute(routes, 'DELETE', '/agents/messages/:id');
      const { request, reply, sent } = mockReqRes({
        params: { id: msg.id },
        agent: { id: agent3Id, name: 'agent-c' },
      });

      await callHandler(handler, request, reply, sent);
      expect(sent.code).toBe(403);
      expect(sent.body.error).toContain('Not authorized to delete');
      expect(agentMessageRepo.getMessageById(msg.id)).not.toBeNull();
    });

    it('unrelated agent C cannot mark agent A-B message read', async () => {
      const msg = agentMessageRepo.createMessage({
        habitatId, fromAgentId: agent1Id, toAgentId: agent2Id,
        subject: 'secret', body: 'confidential',
      });
      const handler = findRoute(routes, 'PUT', '/agents/messages/:id/read');
      const { request, reply, sent } = mockReqRes({
        params: { id: msg.id },
        agent: { id: agent3Id, name: 'agent-c' },
      });

      await callHandler(handler, request, reply, sent);
      expect(sent.code).toBe(403);
      expect(sent.body.error).toContain('Not authorized to modify');
    });
  });
});
