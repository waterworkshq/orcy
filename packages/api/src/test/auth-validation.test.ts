import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { hashApiKey } from '../repositories/agent.js';
import { initTestDb, closeDb } from '../db/index.js';
import { authRoutes } from '../routes/auth.js';
import { users } from '../db/schema/index.js';
import { sql } from 'drizzle-orm';
import { isAppError } from '../errors.js';

const JWT_SECRET = 'dev-secret-change-in-production';

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: 'orcy' });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.setErrorHandler((error: any, _request, reply) => {
    if (isAppError(error)) {
      reply.status(error.statusCode).send({ error: error.message, code: error.code });
      return;
    }
    reply.status(error.statusCode ?? 500).send({ error: error.message ?? 'Internal server error' });
  });
  await app.register(authRoutes, { prefix: '/api' });
  await app.ready();
  return app;
}

describe('Agent Auth - Header-Only Identification', () => {
  it('should have hashApiKey function for API key hashing', () => {
    expect(typeof hashApiKey).toBe('function');
  });

  it('should produce consistent hashes for the same key', () => {
    const hash1 = hashApiKey('test-key-123');
    const hash2 = hashApiKey('test-key-123');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different keys', () => {
    const hash1 = hashApiKey('key-one');
    const hash2 = hashApiKey('key-two');
    expect(hash1).not.toBe(hash2);
  });

  it('should produce hex string hashes', () => {
    const hash = hashApiKey('test-key');
    expect(hash).toMatch(/^[a-f0-9]+$/);
  });

  it('should handle empty strings', () => {
    const hash = hashApiKey('');
    expect(typeof hash).toBe('string');
    expect(hash.length).toBeGreaterThan(0);
  });
});

describe('Auth Endpoints', () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  describe('GET /auth/setup-status', () => {
    it('returns needsSetup true when users table is empty', async () => {
      const db = (await import('../db/index.js')).getDb();
      db.delete(users).run();
      const res = await app!.inject({ method: 'GET', url: '/api/auth/setup-status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ needsSetup: true });
    });

    it('returns needsSetup false when users exist', async () => {
      const res = await app!.inject({ method: 'GET', url: '/api/auth/setup-status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ needsSetup: false });
    });
  });

  describe('POST /auth/register', () => {
    it('creates admin user with role admin and returns JWT', async () => {
      const db = (await import('../db/index.js')).getDb();
      db.delete(users).run();

      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'newadmin', password: 'secure123', displayName: 'New Admin' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.token).toBeDefined();
      expect(body.user.username).toBe('newadmin');
      expect(body.user.role).toBe('admin');
      expect(body.user.displayName).toBe('New Admin');

      const decoded = jwt.verify(body.token, JWT_SECRET, { issuer: 'orcy' }) as any;
      expect(decoded.username).toBe('newadmin');
      expect(decoded.role).toBe('admin');
    });

    it('returns 403 when users already exist', async () => {
      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'another', password: 'secure123' },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json().error).toBe('Setup already completed');
    });

    it('rejects passwords shorter than 4 characters', async () => {
      const db = (await import('../db/index.js')).getDb();
      db.delete(users).run();

      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'testuser', password: 'ab' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects passwords longer than 128 characters', async () => {
      const db = (await import('../db/index.js')).getDb();
      db.delete(users).run();

      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: 'testuser', password: 'a'.repeat(129) },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects empty username', async () => {
      const db = (await import('../db/index.js')).getDb();
      db.delete(users).run();

      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { username: '', password: 'secure123' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('allows only one admin from concurrent register requests', async () => {
      const db = (await import('../db/index.js')).getDb();
      db.delete(users).run();

      const requests = Array.from({ length: 5 }, (_, i) =>
        app!.inject({
          method: 'POST',
          url: '/api/auth/register',
          payload: { username: `admin${i}`, password: 'secure123' },
        })
      );

      const results = await Promise.all(requests);
      const successes = results.filter(r => r.statusCode === 200);
      const failures = results.filter(r => r.statusCode !== 200);

      expect(successes.length).toBe(1);
      expect(failures.length).toBe(4);
      expect(successes[0].json().user.role).toBe('admin');

      const countResult = db.select({ count: sql<number>`COUNT(*)` }).from(users).get();
      expect(countResult?.count).toBe(1);
    });
  });

  describe('GET /auth/me', () => {
    it('returns authenticated user info with valid JWT', async () => {
      const token = makeToken({ sub: 'admin-id', username: 'admin', role: 'admin' });
      const res = await app!.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.user.username).toBe('admin');
      expect(body.user.role).toBe('admin');
      expect(body.user.id).toBeDefined();
      expect(body.user.displayName).toBeDefined();
    });

    it('returns 401 without valid JWT', async () => {
      const res = await app!.inject({ method: 'GET', url: '/api/auth/me' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /auth/logout', () => {
    it('returns success true with valid JWT', async () => {
      const token = makeToken({ sub: 'admin-id', username: 'admin', role: 'admin' });
      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/logout',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });
    });

    it('returns 401 without valid JWT', async () => {
      const res = await app!.inject({ method: 'POST', url: '/api/auth/logout' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /auth/change-password', () => {
    it('succeeds with correct current password', async () => {
      const db = (await import('../db/index.js')).getDb();
      const row = db.select({ id: users.id }).from(users).limit(1).get();
      const token = makeToken({ sub: row!.id, username: 'admin', role: 'admin' });

      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword: 'admin123', newPassword: 'newpassword1' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });

      const updatedRow = db.select({ passwordHash: users.passwordHash }).from(users).where(sql`id = ${row!.id}`).get();
      const valid = await bcrypt.compare('newpassword1', updatedRow!.passwordHash);
      expect(valid).toBe(true);
    });

    it('returns 401 with incorrect current password', async () => {
      const db = (await import('../db/index.js')).getDb();
      const row = db.select({ id: users.id }).from(users).limit(1).get();
      const token = makeToken({ sub: row!.id, username: 'admin', role: 'admin' });

      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword: 'wrongpassword', newPassword: 'newpassword1' },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json().error).toBe('Current password is incorrect');
    });

    it('validates new password minimum length', async () => {
      const db = (await import('../db/index.js')).getDb();
      const row = db.select({ id: users.id }).from(users).limit(1).get();
      const token = makeToken({ sub: row!.id, username: 'admin', role: 'admin' });

      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        headers: { authorization: `Bearer ${token}` },
        payload: { currentPassword: 'admin123', newPassword: 'ab' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('returns 401 without valid JWT', async () => {
      const res = await app!.inject({
        method: 'POST',
        url: '/api/auth/change-password',
        payload: { currentPassword: 'admin123', newPassword: 'newpassword1' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PATCH /auth/me', () => {
    it('updates display name successfully', async () => {
      const db = (await import('../db/index.js')).getDb();
      const row = db.select({ id: users.id }).from(users).limit(1).get();
      const token = makeToken({ sub: row!.id, username: 'admin', role: 'admin' });

      const res = await app!.inject({
        method: 'PATCH',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: { displayName: 'Updated Name' },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.displayName).toBe('Updated Name');
    });

    it('returns 401 without valid JWT', async () => {
      const res = await app!.inject({
        method: 'PATCH',
        url: '/api/auth/me',
        payload: { displayName: 'No Auth' },
      });
      expect(res.statusCode).toBe(401);
    });

    it('succeeds with empty body without changing displayName', async () => {
      const db = (await import('../db/index.js')).getDb();
      const row = db.select({ id: users.id, displayName: users.displayName }).from(users).limit(1).get();
      const token = makeToken({ sub: row!.id, username: 'admin', role: 'admin' });

      const res = await app!.inject({
        method: 'PATCH',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
        payload: {},
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().user.displayName).toBe(row!.displayName);
    });
  });
});
