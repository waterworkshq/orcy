import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb } from '../db/index.js';
import { mockRequest, mockReply } from './factories/mockRequest.js';

function mockReqRes(overrides: Record<string, unknown> = {}) {
  const request = mockRequest({
    params: overrides.params as Record<string, string> | undefined,
    query: overrides.query as Record<string, string> | undefined,
    body: overrides.body,
    headers: overrides.headers as Record<string, string> | undefined,
    agent: overrides.agent as { id: string; name?: string; domain?: string } | undefined,
    user: overrides.user as { id: string; username?: string; role?: string; type?: string } | undefined,
  });
  const { reply, sent } = mockReply();
  return { request, reply, sent };
}

describe('Realtime Auth Middleware', () => {
  beforeEach(async () => {
    await initTestDb();
  });
  afterEach(() => { closeDb(); });

  describe('authenticateRealtime', () => {
    it('rejects anonymous requests with no credentials', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const { request, reply, sent } = mockReqRes();
      await authenticateRealtime(request, reply);
      expect(sent.code).toBe(401);
      expect(sent.body.error).toBe('Authentication required');
    });

    it('authenticates via agent API key header', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const { createAgent } = await import('../repositories/agent.js');

      const result = createAgent({ name: 'ws-test-agent', type: 'claude-code', domain: 'backend' });

      const { request, reply, sent } = mockReqRes({
        headers: { 'x-agent-api-key': result.plainApiKey },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();
      expect(request.agent).toBeDefined();
      expect(request.agent!.id).toBe(result.agent.id);
    });

    it('rejects invalid agent API key', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const { request, reply, sent } = mockReqRes({
        headers: { 'x-agent-api-key': 'invalid-key-12345' },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBe(401);
      expect(sent.body.error).toBe('Invalid agent API key');
    });

    it('authenticates via Bearer JWT in Authorization header', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;
      const token = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin' },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '1h', issuer: 'orcy' },
      );
      const { request, reply, sent } = mockReqRes({
        headers: { authorization: `Bearer ${token}` },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();
      expect(request.user!.id).toBe('user-1');
      expect(request.user!.username).toBe('alice');
    });

    it('rejects expired Bearer JWT', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;
      const token = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin' },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '-1s', issuer: 'orcy' },
      );
      const { request, reply, sent } = mockReqRes({
        headers: { authorization: `Bearer ${token}` },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBe(401);
      expect(sent.body.code).toBe('TOKEN_EXPIRED');
    });

    it('accepts fresh query token (within 30s)', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;
      const token = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin' },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '30s', issuer: 'orcy' },
      );
      const { request, reply, sent } = mockReqRes({
        query: { token },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();
      expect(request.user!.id).toBe('user-1');
    });

    it('rejects stale query token (older than 30s from iat)', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;
      const token = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin' },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '24h', issuer: 'orcy', notBefore: '-60s' },
      );
      // Manually craft a token with an old iat
      const oldIat = Math.floor(Date.now() / 1000) - 60;
      const decoded = jwt.verify(token, process.env.JWT_SECRET || 'dev-secret-change-in-production') as { sub: string; username: string; role: string };
      const staleToken = jwt.sign(
        { sub: decoded.sub, username: decoded.username, role: decoded.role, iat: oldIat },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '24h', issuer: 'orcy' },
      );
      const { request, reply, sent } = mockReqRes({
        query: { token: staleToken },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBe(401);
      expect(sent.body.code).toBe('TOKEN_EXPIRED');
      expect(sent.body.error).toBe('Query token expired');
    });

    it('accepts long-lived Bearer header tokens (no iat constraint)', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;
      const oldIat = Math.floor(Date.now() / 1000) - 3600;
      const token = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin', iat: oldIat },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '24h', issuer: 'orcy' },
      );
      const { request, reply, sent } = mockReqRes({
        headers: { authorization: `Bearer ${token}` },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();
      expect(request.user!.id).toBe('user-1');
    });
  });

  describe('authorizeBoardAccess', () => {
    it('returns 404 when board does not exist', async () => {
      const { authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');
      const { request, reply, sent } = mockReqRes({
        params: { boardId: 'nonexistent-board-id' },
        agent: { id: 'agent-1', domain: 'backend' },
      });
      await authorizeBoardAccess(request, reply);
      expect(sent.code).toBe(404);
    });

    it('allows agent principal access to any board', async () => {
      const { authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');
      const { createBoard } = await import('../repositories/board.js');
      const { createTeam } = await import('../repositories/team.js');
      const { createOrganization } = await import('../repositories/organization.js');

      const org = createOrganization({ name: 'Org', slug: 'org-rt' });
      const team = createTeam({ organizationId: org.id, name: 'Team', slug: 'team-rt' });
      const board = createBoard({ name: 'Agent Board', teamId: team.id });

      const { request, reply, sent } = mockReqRes({
        params: { boardId: board.id },
        agent: { id: 'agent-1', domain: 'backend' },
      });
      await authorizeBoardAccess(request, reply);
      expect(sent.code).toBeNull();
    });

    it('allows human team member access to board', async () => {
      const { authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');
      const { createBoard } = await import('../repositories/board.js');
      const { createTeam } = await import('../repositories/team.js');
      const { addMember } = await import('../repositories/teamMember.js');
      const { createOrganization } = await import('../repositories/organization.js');

      const org = createOrganization({ name: 'Org2', slug: 'org-rt2' });
      const team = createTeam({ organizationId: org.id, name: 'Team2', slug: 'team-rt2' });
      const board = createBoard({ name: 'Human Board', teamId: team.id });
      addMember({ teamId: team.id, userId: 'user-1', role: 'member' });

      const { request, reply, sent } = mockReqRes({
        params: { boardId: board.id },
        user: { id: 'user-1', role: 'viewer', type: 'human' },
      });
      await authorizeBoardAccess(request, reply);
      expect(sent.code).toBeNull();
    });

    it('denies non-member human access to a team board', async () => {
      const { authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');
      const { createBoard } = await import('../repositories/board.js');
      const { createTeam } = await import('../repositories/team.js');
      const { createOrganization } = await import('../repositories/organization.js');

      const org = createOrganization({ name: 'Org3', slug: 'org-rt3' });
      const team = createTeam({ organizationId: org.id, name: 'Team3', slug: 'team-rt3' });
      const board = createBoard({ name: 'Protected Board', teamId: team.id });

      const { request, reply, sent } = mockReqRes({
        params: { boardId: board.id },
        user: { id: 'stranger-user', role: 'viewer', type: 'human' },
      });
      await authorizeBoardAccess(request, reply);
      expect(sent.code).toBe(403);
      expect(sent.body.error).toBe('You do not have access to this board');
    });

    it('allows human access to a board with no team', async () => {
      const { authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');
      const { createBoard } = await import('../repositories/board.js');

      const board = createBoard({ name: 'Open Board' });

      const { request, reply, sent } = mockReqRes({
        params: { boardId: board.id },
        user: { id: 'any-user', role: 'viewer', type: 'human' },
      });
      await authorizeBoardAccess(request, reply);
      expect(sent.code).toBeNull();
    });

    it('returns 401 when no principal is set', async () => {
      const { authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');
      const { createBoard } = await import('../repositories/board.js');

      const board = createBoard({ name: 'Auth Board' });

      const { request, reply, sent } = mockReqRes({
        params: { boardId: board.id },
      });
      await authorizeBoardAccess(request, reply);
      expect(sent.code).toBe(401);
      expect(sent.body.error).toBe('Authentication required');
    });

    it('works with :id param (SSE route style)', async () => {
      const { authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');
      const { createBoard } = await import('../repositories/board.js');

      const board = createBoard({ name: 'SSE Board' });

      const { request, reply, sent } = mockReqRes({
        params: { id: board.id },
        user: { id: 'user-1', role: 'admin', type: 'human' },
      });
      await authorizeBoardAccess(request, reply);
      expect(sent.code).toBeNull();
    });
  });
});

describe('Realtime Auth — Integration', () => {
  let boardId: string;
  let teamBoardId: string;
  let agentApiKey: string;
  let humanToken: string;

  beforeEach(async () => {
    await initTestDb();

    const { createBoard } = await import('../repositories/board.js');
    const { createAgent } = await import('../repositories/agent.js');
    const { createTeam } = await import('../repositories/team.js');
    const { addMember } = await import('../repositories/teamMember.js');
    const { createOrganization } = await import('../repositories/organization.js');
    const jwt = (await import('jsonwebtoken')).default;

    const board = createBoard({ name: 'Open Integration Board' });
    boardId = board.id;

    const org = createOrganization({ name: 'Int Org', slug: 'int-org' });
    const team = createTeam({ organizationId: org.id, name: 'Int Team', slug: 'int-team' });
    const teamBoard = createBoard({ name: 'Team Board', teamId: team.id });
    teamBoardId = teamBoard.id;
    addMember({ teamId: team.id, userId: 'user-1', role: 'member' });

    const agentResult = createAgent({ name: 'int-test-agent', type: 'claude-code', domain: 'backend' });
    agentApiKey = agentResult.plainApiKey;

    humanToken = jwt.sign(
      { sub: 'user-1', username: 'alice', role: 'admin' },
      process.env.JWT_SECRET || 'dev-secret-change-in-production',
      { expiresIn: '1h', issuer: 'orcy' },
    );
  });

  afterEach(() => { closeDb(); });

  describe('Realtime authorization', () => {
    it('SSE subscription rejects anonymous requests', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const { request, reply, sent } = mockReqRes({
        params: { id: boardId },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBe(401);
    });

    it('SSE subscription enforces board access rules', async () => {
      const { authenticateRealtime, authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;

      const strangerToken = jwt.sign(
        { sub: 'stranger-user', username: 'stranger', role: 'viewer' },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '1h', issuer: 'orcy' },
      );

      const { request, reply, sent } = mockReqRes({
        params: { id: teamBoardId },
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();

      const { reply: authReply, sent: authSent } = mockReqRes();
      await authorizeBoardAccess(request, authReply);
      expect(authSent.code).toBe(403);
    });

    it('SSE allows authorized human team member', async () => {
      const { authenticateRealtime, authorizeBoardAccess } = await import('../middleware/realtimeAuth.js');

      const { request, reply, sent } = mockReqRes({
        params: { id: teamBoardId },
        headers: { authorization: `Bearer ${humanToken}` },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();

      const { reply: authReply, sent: authSent } = mockReqRes();
      await authorizeBoardAccess(request, authReply);
      expect(authSent.code).toBeNull();
    });
  });

  describe('Query token policy', () => {
    it('rejects long-lived query tokens from SSE connection', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;

      const oldIat = Math.floor(Date.now() / 1000) - 120;
      const staleToken = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin', iat: oldIat },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '24h', issuer: 'orcy' },
      );

      const { request, reply, sent } = mockReqRes({
        params: { id: boardId },
        query: { token: staleToken },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBe(401);
      expect(sent.body.code).toBe('TOKEN_EXPIRED');
    });

    it('accepts short-lived stream token from SSE connection', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;

      const freshToken = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin' },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '30s', issuer: 'orcy' },
      );

      const { request, reply, sent } = mockReqRes({
        params: { id: boardId },
        query: { token: freshToken },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();
      expect(request.user!.id).toBe('user-1');
    });
  });
});

describe('getBoardIdFromParams', () => {
  it('extracts boardId from :boardId param', async () => {
    const { getBoardIdFromParams } = await import('../middleware/realtimeAuth.js');
    expect(getBoardIdFromParams(mockRequest({ params: { boardId: 'abc-123' } }))).toBe('abc-123');
  });

  it('extracts boardId from :id param', async () => {
    const { getBoardIdFromParams } = await import('../middleware/realtimeAuth.js');
    expect(getBoardIdFromParams(mockRequest({ params: { id: 'xyz-789' } }))).toBe('xyz-789');
  });

  it('returns undefined when no matching param', async () => {
    const { getBoardIdFromParams } = await import('../middleware/realtimeAuth.js');
    expect(getBoardIdFromParams(mockRequest({ params: { other: 'foo' } }))).toBeUndefined();
  });
});
