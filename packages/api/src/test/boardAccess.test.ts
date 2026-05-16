import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/index.js';
import { boardRoutes } from '../routes/boards.js';
import { boardAnalyticsRoutes } from '../routes/board-analytics.js';
import { boardExportRoutes } from '../routes/board-export.js';
import * as boardRepo from '../repositories/board.js';
import * as teamRepo from '../repositories/team.js';
import * as orgRepo from '../repositories/organization.js';
import * as teamMemberRepo from '../repositories/teamMember.js';
import { mockRequest, mockReply } from './factories/mockRequest.js';
import { users } from '../db/schema/index.js';
import { isAppError } from '../errors.js';
import { eq } from 'drizzle-orm';

function ensureUser(userId: string, username?: string) {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users).values({
      id: userId,
      username: username ?? userId,
      passwordHash: 'hash',
      displayName: username ?? userId,
      role: 'admin',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }).run();
  }
}

function mockReqRes(overrides: Record<string, unknown> = {}) {
  const request = mockRequest({
    params: overrides.params as Record<string, string> | undefined,
    query: overrides.query as Record<string, string> | undefined,
    body: overrides.body,
    agent: overrides.agent as { id: string; name?: string } | undefined,
    user: overrides.user as { id: string; role?: string; type?: string } | undefined,
  });
  const { reply, sent } = mockReply();
  return { request, reply, sent };
}

type RouteHandler = (req: any, reply: any) => Promise<void>;
interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any;
}

function captureBoardRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'POST', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [] });
    }),
    get: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'GET', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [] });
    }),
    patch: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'PATCH', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [] });
    }),
    delete: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'DELETE', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [] });
    }),
  };
  boardRoutes(fakeFastify);
  boardAnalyticsRoutes(fakeFastify);
  boardExportRoutes(fakeFastify);
  return routes;
}

describe('requireBoardAccess', () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => { closeDb(); });

  it('returns 404 when board does not exist', async () => {
    const { requireBoardAccess } = await import('../middleware/team.js');
    const { request, reply, sent } = mockReqRes({
      params: { id: 'nonexistent-board-id' },
      user: { id: 'user-1', role: 'admin', type: 'human' },
    });
    try {
      await requireBoardAccess(request, reply);
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.statusCode).toBe(404);
    }
  });

  it('allows human team member access', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const { createTeam } = await import('../repositories/team.js');
    const { addMember } = await import('../repositories/teamMember.js');
    const { createOrganization } = await import('../repositories/organization.js');
    const { requireBoardAccess } = await import('../middleware/team.js');

    ensureUser('user-1', 'user-1');
    const org = createOrganization({ name: 'Test Org', slug: 'test-org' });
    const team = createTeam({ organizationId: org.id, name: 'Team A', slug: 'team-a' });
    const board = createBoard({ name: 'Board 1', teamId: team.id });
    addMember({ teamId: team.id, userId: 'user-1', role: 'member' });

    const { request, reply, sent } = mockReqRes({
      params: { id: board.id },
      user: { id: 'user-1', role: 'admin', type: 'human' },
    });
    await requireBoardAccess(request, reply);
    expect(sent.code).toBeNull();
  });

  it('denies non-member human access to a board with a team', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const { createTeam } = await import('../repositories/team.js');
    const { createOrganization } = await import('../repositories/organization.js');
    const { requireBoardAccess } = await import('../middleware/team.js');

    const org = createOrganization({ name: 'Test Org', slug: 'test-org2' });
    const team = createTeam({ organizationId: org.id, name: 'Team B', slug: 'team-b' });
    const board = createBoard({ name: 'Board 2', teamId: team.id });

    const { request, reply, sent } = mockReqRes({
      params: { id: board.id },
      user: { id: 'stranger-user', role: 'viewer', type: 'human' },
    });
    try {
      await requireBoardAccess(request, reply);
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.statusCode).toBe(403);
        expect(err.message).toBe('You do not have access to this board');
      }
    }
  });

  it('allows any human access to a board with no team', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const { requireBoardAccess } = await import('../middleware/team.js');

    const board = createBoard({ name: 'Orphan Board' });

    const { request, reply, sent } = mockReqRes({
      params: { id: board.id },
      user: { id: 'any-user', role: 'viewer', type: 'human' },
    });
    await requireBoardAccess(request, reply);
    expect(sent.code).toBeNull();
  });

  it('allows agent principal access to any board', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const { createTeam } = await import('../repositories/team.js');
    const { createOrganization } = await import('../repositories/organization.js');
    const { requireBoardAccess } = await import('../middleware/team.js');

    const org = createOrganization({ name: 'Test Org', slug: 'test-org3' });
    const team = createTeam({ organizationId: org.id, name: 'Team C', slug: 'team-c' });
    const board = createBoard({ name: 'Agent Board', teamId: team.id });

    const { request, reply, sent } = mockReqRes({
      params: { id: board.id },
      agent: { id: 'agent-1', name: 'Test Agent' },
    });
    await requireBoardAccess(request, reply);
    expect(sent.code).toBeNull();
  });

  it('returns 401 when no principal is set', async () => {
    const { createBoard } = await import('../repositories/board.js');
    const { requireBoardAccess } = await import('../middleware/team.js');

    const board = createBoard({ name: 'Public Board' });

    const { request, reply, sent } = mockReqRes({
      params: { id: board.id },
    });
    try {
      await requireBoardAccess(request, reply);
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) {
        expect(err.statusCode).toBe(401);
        expect(err.message).toBe('Authentication required');
      }
    }
  });

  it('passes through when no boardId in params', async () => {
    const { requireBoardAccess } = await import('../middleware/team.js');
    const { request, reply, sent } = mockReqRes({
      params: {},
    });
    await requireBoardAccess(request, reply);
    expect(sent.code).toBeNull();
  });

  it('summary route requires requireBoardAccess preHandler', async () => {
    const routes = captureBoardRoutes();
    const summaryRoute = routes.find(r => r.path === '/boards/:id/summary');
    expect(summaryRoute).toBeDefined();
    const preHandlerNames = summaryRoute!.preHandler.map((h: any) => h.name || String(h));
    expect(preHandlerNames.length).toBeGreaterThanOrEqual(2);
    const hasBoardAccess = summaryRoute!.preHandler.some(
      (h: any) => h.name === 'authorizeBoardAccess' || h.name === 'requireBoardAccess'
    );
    expect(hasBoardAccess).toBe(true);
  });

  it('non-member human cannot access summary of team-scoped board', async () => {
    const { requireBoardAccess } = await import('../middleware/team.js');

    const org = orgRepo.createOrganization({ name: 'Summary Test Org', slug: 'summary-test-org' });
    const team = teamRepo.createTeam({ organizationId: org.id, name: 'Summary Team', slug: 'summary-team' });
    const board = boardRepo.createBoard({ name: 'Summary Board', teamId: team.id });

    const { request, reply, sent } = mockReqRes({
      params: { id: board.id },
      user: { id: 'stranger-user', role: 'viewer', type: 'human' },
    });
    try {
      await requireBoardAccess(request, reply);
    } catch (err) {
      expect(isAppError(err)).toBe(true);
      if (isAppError(err)) expect(err.statusCode).toBe(403);
    }
  });
});
