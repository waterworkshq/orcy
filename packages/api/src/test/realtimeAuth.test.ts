import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/index.js';
import { mockRequest, mockReply } from './factories/mockRequest.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { isAppError } from '../errors.js';

function ensureUser(userId: string) {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users).values({
      id: userId,
      username: userId,
      passwordHash: 'hash',
      displayName: userId,
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
      try {
        await authenticateRealtime(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) {
          expect(err.statusCode).toBe(401);
          expect(err.message).toBe('Missing authentication token');
        }
      }
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
      try {
        await authenticateRealtime(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) {
          expect(err.statusCode).toBe(401);
          expect(err.message).toBe('Invalid agent API key');
        }
      }
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
      try {
        await authenticateRealtime(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) {
          expect(err.statusCode).toBe(401);
          expect(err.code).toBe('TOKEN_EXPIRED');
        }
      }
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
      const oldIat = Math.floor(Date.now() / 1000) - 60;
      const staleToken = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin', iat: oldIat },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '24h', issuer: 'orcy' },
      );
      const { request, reply, sent } = mockReqRes({
        query: { token: staleToken },
      });
      try {
        await authenticateRealtime(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) {
          expect(err.statusCode).toBe(401);
          expect(err.code).toBe('TOKEN_EXPIRED');
          expect(err.message).toBe('Query token expired');
        }
      }
    });

    it('accepts long-lived Bearer header tokens within expiry', async () => {
      const { authenticateRealtime } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;
      const token = jwt.sign(
        { sub: 'user-1', username: 'alice', role: 'admin' },
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

  describe('authorizeHabitatAccess', () => {
    it('returns 404 when habitat does not exist', async () => {
      const { authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');
      const { request, reply, sent } = mockReqRes({
        params: { habitatId: 'nonexistent-habitat-id' },
        agent: { id: 'agent-1', domain: 'backend' },
      });
      try {
        await authorizeHabitatAccess(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) expect(err.statusCode).toBe(404);
      }
    });

    it('allows agent principal access to any habitat', async () => {
      const { authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');
      const { createHabitat } = await import('../repositories/board.js');
      const { createTeam } = await import('../repositories/team.js');
      const { createOrganization } = await import('../repositories/organization.js');

      const org = createOrganization({ name: 'Org', slug: 'org-rt' });
      const team = createTeam({ organizationId: org.id, name: 'Team', slug: 'team-rt' });
      const habitat = createHabitat({ name: 'Agent Habitat', teamId: team.id });

      const { request, reply, sent } = mockReqRes({
        params: { habitatId: habitat.id },
        agent: { id: 'agent-1', domain: 'backend' },
      });
      await authorizeHabitatAccess(request, reply);
      expect(sent.code).toBeNull();
    });

    it('allows human team member access to habitat', async () => {
      const { authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');
      const { createHabitat } = await import('../repositories/board.js');
      const { createTeam } = await import('../repositories/team.js');
      const { addMember } = await import('../repositories/teamMember.js');
      const { createOrganization } = await import('../repositories/organization.js');

      ensureUser('user-1');
      const org = createOrganization({ name: 'Org2', slug: 'org-rt2' });
      const team = createTeam({ organizationId: org.id, name: 'Team2', slug: 'team-rt2' });
      const habitat = createHabitat({ name: 'Human Habitat', teamId: team.id });
      addMember({ teamId: team.id, userId: 'user-1', role: 'member' });

      const { request, reply, sent } = mockReqRes({
        params: { habitatId: habitat.id },
        user: { id: 'user-1', role: 'viewer', type: 'human' },
      });
      await authorizeHabitatAccess(request, reply);
      expect(sent.code).toBeNull();
    });

    it('denies non-member human access to a team habitat', async () => {
      const { authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');
      const { createHabitat } = await import('../repositories/board.js');
      const { createTeam } = await import('../repositories/team.js');
      const { createOrganization } = await import('../repositories/organization.js');

      const org = createOrganization({ name: 'Org3', slug: 'org-rt3' });
      const team = createTeam({ organizationId: org.id, name: 'Team3', slug: 'team-rt3' });
      const habitat = createHabitat({ name: 'Protected Habitat', teamId: team.id });

      const { request, reply, sent } = mockReqRes({
        params: { habitatId: habitat.id },
        user: { id: 'stranger-user', role: 'viewer', type: 'human' },
      });
      try {
        await authorizeHabitatAccess(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) {
          expect(err.statusCode).toBe(403);
          expect(err.message).toBe('You do not have access to this habitat');
        }
      }
    });

    it('allows human access to a habitat with no team', async () => {
      const { authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');
      const { createHabitat } = await import('../repositories/board.js');

      const habitat = createHabitat({ name: 'Open Habitat' });

      const { request, reply, sent } = mockReqRes({
        params: { habitatId: habitat.id },
        user: { id: 'any-user', role: 'viewer', type: 'human' },
      });
      await authorizeHabitatAccess(request, reply);
      expect(sent.code).toBeNull();
    });

    it('returns 401 when no principal is set', async () => {
      const { authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');
      const { createHabitat } = await import('../repositories/board.js');

      const habitat = createHabitat({ name: 'Auth Habitat' });

      const { request, reply, sent } = mockReqRes({
        params: { habitatId: habitat.id },
      });
      try {
        await authorizeHabitatAccess(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) {
          expect(err.statusCode).toBe(401);
          expect(err.message).toBe('Authentication required');
        }
      }
    });

    it('works with :id param (SSE route style)', async () => {
      const { authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');
      const { createHabitat } = await import('../repositories/board.js');

      const habitat = createHabitat({ name: 'SSE Habitat' });

      const { request, reply, sent } = mockReqRes({
        params: { id: habitat.id },
        user: { id: 'user-1', role: 'admin', type: 'human' },
      });
      await authorizeHabitatAccess(request, reply);
      expect(sent.code).toBeNull();
    });
  });
});

describe('Realtime Auth — Integration', () => {
  let habitatId: string;
  let teamHabitatId: string;
  let agentApiKey: string;
  let humanToken: string;

  beforeEach(async () => {
    await initTestDb();

    const { createHabitat } = await import('../repositories/board.js');
    const { createAgent } = await import('../repositories/agent.js');
    const { createTeam } = await import('../repositories/team.js');
    const { addMember } = await import('../repositories/teamMember.js');
    const { createOrganization } = await import('../repositories/organization.js');
    const jwt = (await import('jsonwebtoken')).default;

    const habitat = createHabitat({ name: 'Open Integration Habitat' });
    habitatId = habitat.id;

    const org = createOrganization({ name: 'Int Org', slug: 'int-org' });
    const team = createTeam({ organizationId: org.id, name: 'Int Team', slug: 'int-team' });
    const teamHabitat = createHabitat({ name: 'Team Habitat', teamId: team.id });
    teamHabitatId = teamHabitat.id;
    ensureUser('user-1');
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
        params: { id: habitatId },
      });
      try {
        await authenticateRealtime(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) expect(err.statusCode).toBe(401);
      }
    });

    it('SSE subscription enforces habitat access rules', async () => {
      const { authenticateRealtime, authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');
      const jwt = (await import('jsonwebtoken')).default;

      const strangerToken = jwt.sign(
        { sub: 'stranger-user', username: 'stranger', role: 'viewer' },
        process.env.JWT_SECRET || 'dev-secret-change-in-production',
        { expiresIn: '1h', issuer: 'orcy' },
      );

      const { request, reply, sent } = mockReqRes({
        params: { id: teamHabitatId },
        headers: { authorization: `Bearer ${strangerToken}` },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();

      const { reply: authReply, sent: authSent } = mockReply();
      try {
        await authorizeHabitatAccess(request, authReply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) expect(err.statusCode).toBe(403);
      }
    });

    it('SSE allows authorized human team member', async () => {
      const { authenticateRealtime, authorizeHabitatAccess } = await import('../middleware/realtimeAuth.js');

      const { request, reply, sent } = mockReqRes({
        params: { id: teamHabitatId },
        headers: { authorization: `Bearer ${humanToken}` },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();

      const { reply: authReply, sent: authSent } = mockReply();
      await authorizeHabitatAccess(request, authReply);
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
        params: { id: habitatId },
        query: { token: staleToken },
      });
      try {
        await authenticateRealtime(request, reply);
      } catch (err) {
        expect(isAppError(err)).toBe(true);
        if (isAppError(err)) expect(err.statusCode).toBe(401);
      }
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
        params: { id: habitatId },
        query: { token: freshToken },
      });
      await authenticateRealtime(request, reply);
      expect(sent.code).toBeNull();
      expect(request.user!.id).toBe('user-1');
    });
  });
});

describe('getHabitatIdFromParams', () => {
  it('extracts habitatId from :habitatId param', async () => {
    const { getHabitatIdFromParams } = await import('../middleware/realtimeAuth.js');
    expect(getHabitatIdFromParams(mockRequest({ params: { habitatId: 'abc-123' } }))).toBe('abc-123');
  });

  it('extracts habitatId from :id param', async () => {
    const { getHabitatIdFromParams } = await import('../middleware/realtimeAuth.js');
    expect(getHabitatIdFromParams(mockRequest({ params: { id: 'xyz-789' } }))).toBe('xyz-789');
  });

  it('returns undefined when no matching param', async () => {
    const { getHabitatIdFromParams } = await import('../middleware/realtimeAuth.js');
    expect(getHabitatIdFromParams(mockRequest({ params: { other: 'foo' } }))).toBeUndefined();
  });
});
