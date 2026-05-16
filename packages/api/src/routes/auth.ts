import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { humanAuth } from '../middleware/auth.js';
import { getJwtSecret } from '../middleware/jwt-verification.js';
import { badRequest, unauthorized, forbidden } from '../errors.js';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const registerSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(4).max(128),
  displayName: z.string().max(128).optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(4).max(128),
});

const updateProfileSchema = z.object({
  displayName: z.string().max(128).optional(),
});

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post<{ Body: z.infer<typeof loginSchema> }>(
    '/auth/login',
    async (request: FastifyRequest<{ Body: z.infer<typeof loginSchema> }>, reply: FastifyReply) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Invalid request');
      }

      const { username, password } = parsed.data;
      const db = getDb();

      const row = db.select({
        id: users.id,
        username: users.username,
        passwordHash: users.passwordHash,
        role: users.role,
      }).from(users).where(eq(users.username, username)).get();

      if (!row) {
        throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
      }

      const valid = await bcrypt.compare(password, row.passwordHash);
      if (!valid) {
        throw unauthorized('Invalid credentials', 'INVALID_CREDENTIALS');
      }

      const token = jwt.sign(
        { sub: row.id, username: row.username, role: row.role },
        getJwtSecret(),
        { expiresIn: '24h', issuer: 'orcy' }
      );

      db.update(users).set({ lastLoginAt: new Date().toISOString() }).where(eq(users.id, row.id)).run();

      return { token, user: { id: row.id, username: row.username, role: row.role } };
    }
  );

  fastify.get(
    '/auth/stream-token',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const user = request.user!;
      const token = jwt.sign(
        { sub: user.id, username: user.username, role: user.role },
        getJwtSecret(),
        { expiresIn: '30s', issuer: 'orcy' }
      );
      return { token };
    }
  );

  fastify.get('/auth/setup-status', async () => {
    const db = getDb();
    const result = db.select({ count: sql<number>`COUNT(*)` }).from(users).get();
    return { needsSetup: (result?.count ?? 0) === 0 };
  });

  fastify.post('/auth/register', async (request: FastifyRequest, reply: FastifyReply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest('Invalid request');
    }

    const { username, password, displayName } = parsed.data;
    const passwordHash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const now = new Date().toISOString();

    const db = getDb();
    db.run(sql`BEGIN IMMEDIATE`);
    try {
      const countResult = db.select({ count: sql<number>`COUNT(*)` }).from(users).get();
      if ((countResult?.count ?? 0) > 0) {
        throw forbidden('Setup already completed', 'SETUP_ALREADY_COMPLETED');
      }

      db.insert(users).values({
        id,
        username,
        passwordHash,
        displayName: displayName ?? '',
        role: 'admin',
        createdAt: now,
        updatedAt: now,
      }).run();

      db.run(sql`COMMIT`);
    } catch (err) {
      db.run(sql`ROLLBACK`);
      throw err;
    }

    const token = jwt.sign(
      { sub: id, username, role: 'admin' },
      getJwtSecret(),
      { expiresIn: '24h', issuer: 'orcy' }
    );

    return { token, user: { id, username, role: 'admin' as const, displayName: displayName ?? '' } };
  });

  fastify.get(
    '/auth/me',
    { preHandler: humanAuth },
    async (request: FastifyRequest) => {
      const user = request.user!;
      const db = getDb();
      const row = db.select({
        id: users.id,
        username: users.username,
        role: users.role,
        displayName: users.displayName,
      }).from(users).where(eq(users.id, user.id)).get();

      if (!row) {
        return { user: { id: user.id, username: user.username, role: user.role, displayName: '' } };
      }
      return { user: { id: row.id, username: row.username, role: row.role, displayName: row.displayName } };
    }
  );

  fastify.post(
    '/auth/logout',
    { preHandler: humanAuth },
    async () => {
      return { success: true };
    }
  );

  fastify.post(
    '/auth/change-password',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Invalid request');
      }

      const user = request.user!;
      const { currentPassword, newPassword } = parsed.data;
      const db = getDb();

      const row = db.select({ id: users.id, passwordHash: users.passwordHash }).from(users).where(eq(users.id, user.id)).get();
      if (!row) {
        throw unauthorized('User not found');
      }

      const valid = await bcrypt.compare(currentPassword, row.passwordHash);
      if (!valid) {
        throw unauthorized('Current password is incorrect', 'INVALID_CREDENTIALS');
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      db.update(users).set({ passwordHash: newHash, updatedAt: new Date().toISOString() }).where(eq(users.id, row.id)).run();

      return { success: true };
    }
  );

  fastify.patch(
    '/auth/me',
    { preHandler: humanAuth },
    async (request: FastifyRequest, reply: FastifyReply) => {
      const parsed = updateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest('Invalid request');
      }

      const user = request.user!;
      const { displayName } = parsed.data;
      const db = getDb();

      const updateData = displayName !== undefined
        ? { displayName, updatedAt: new Date().toISOString() }
        : { updatedAt: new Date().toISOString() };
      db.update(users).set(updateData).where(eq(users.id, user.id)).run();

      const row = db.select({
        id: users.id,
        username: users.username,
        role: users.role,
        displayName: users.displayName,
      }).from(users).where(eq(users.id, user.id)).get();

      return { user: { id: row!.id, username: row!.username, role: row!.role, displayName: row!.displayName } };
    }
  );
}
