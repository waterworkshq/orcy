import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import jwt from 'jsonwebtoken';
import { initTestDb, closeDb } from '../db/index.js';
import { habitatRoutes } from '../routes/habitats.js';
import { boardAnalyticsRoutes } from '../routes/board-analytics.js';
import { boardExportRoutes } from '../routes/board-export.js';
import { agentRoutes } from '../routes/agents.js';
import { authRoutes } from '../routes/auth.js';
import { perAgentRateLimit } from '../middleware/rateLimit.js';

const JWT_SECRET = 'dev-secret-change-in-production';

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: 'orcy' });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(async (f) => {
    f.addHook('preHandler', perAgentRateLimit);
    await f.register(habitatRoutes);
    await f.register(boardAnalyticsRoutes);
    await f.register(boardExportRoutes);
    await f.register(agentRoutes);
    await f.register(authRoutes);
  }, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('Board Route Authentication', () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it('anonymous GET /boards/:id returns 401', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const board = createBoard({ name: 'Test Board' });
    const res = await app!.inject({ method: 'GET', url: `/api/boards/${board.id}` });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /boards/:id/stats returns 401', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const board = createBoard({ name: 'Stats Board' });
    const res = await app!.inject({ method: 'GET', url: `/api/boards/${board.id}/stats` });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /boards/:id/events returns 401', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const board = createBoard({ name: 'Events Board' });
    const res = await app!.inject({ method: 'GET', url: `/api/boards/${board.id}/events` });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /boards/:id/anomalies returns 401', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const board = createBoard({ name: 'Anomaly Board' });
    const res = await app!.inject({ method: 'GET', url: `/api/boards/${board.id}/anomalies` });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /boards/:id/capacity returns 401', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const board = createBoard({ name: 'Cap Board' });
    const res = await app!.inject({ method: 'GET', url: `/api/boards/${board.id}/capacity` });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /boards/:id/predictions returns 401', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const board = createBoard({ name: 'Pred Board' });
    const res = await app!.inject({ method: 'GET', url: `/api/boards/${board.id}/predictions` });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /boards/:id/burndown returns 401', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const board = createBoard({ name: 'Burndown Board' });
    const res = await app!.inject({ method: 'GET', url: `/api/boards/${board.id}/burndown` });
    expect(res.statusCode).toBe(401);
  });

  it('authenticated unauthorized human cannot read another team board', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const { createTeam } = await import('../repositories/team.js');
    const { createOrganization } = await import('../repositories/organization.js');

    const org = createOrganization({ name: 'Org A', slug: 'org-a-int' });
    const team = createTeam({ organizationId: org.id, name: 'Team X', slug: 'team-x-int' });
    const board = createBoard({ name: 'Protected Board', teamId: team.id });

    const token = makeToken({ sub: 'stranger', username: 'stranger', role: 'viewer' });
    const res = await app!.inject({
      method: 'GET',
      url: `/api/boards/${board.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('Agent Route Authentication', () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it('anonymous GET /agents returns 401', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/agents' });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /agents/:id returns 401', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/agents/nonexistent-id' });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /agents/:id/stats returns 401', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/agents/nonexistent-id/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /agents/stats returns 401', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/agents/stats' });
    expect(res.statusCode).toBe(401);
  });

  it('anonymous GET /agents/:id/suggestions returns 401', async () => {
    const res = await app!.inject({ method: 'GET', url: '/api/agents/nonexistent-id/suggestions?boardId=x' });
    expect(res.statusCode).toBe(401);
  });

  it('authenticated human can list agents', async () => {
    const token = makeToken({ sub: 'user-1', username: 'testuser', role: 'admin' });
    const res = await app!.inject({
      method: 'GET',
      url: '/api/agents',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.agents).toBeDefined();
  });

  it('agent with API key can list agents', async () => {
    const agentService = await import('../services/agentService.js');
    const { plainApiKey } = agentService.createAgent({
      name: 'Auth Test Agent',
      type: 'claude-code',
      domain: 'fullstack',
      capabilities: ['typescript'],
    });
    const res = await app!.inject({
      method: 'GET',
      url: '/api/agents',
      headers: { 'x-agent-api-key': plainApiKey },
    });
    expect(res.statusCode).toBe(200);
  });
});
