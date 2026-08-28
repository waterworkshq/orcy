import { applyDeclaredAuthPolicies } from "../authPolicy.js";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { z } from "zod";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { getDb } from "../db/index.js";
import { users } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import { badRequest, unauthorized } from "../errors.js";
import {
  getSetupStatus,
  registerInitialAdmin,
  getCurrentUserProfile,
} from "../services/authService.js";

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
  // Heterogeneous module: routes declare policy individually; this applier
  // installs their guards (a no-op on seam-constructed instances, where the
  // root installer has already done so).
  applyDeclaredAuthPolicies(fastify);

  fastify.post<{ Body: z.infer<typeof loginSchema> }>(
    "/auth/login",
    { config: { authPolicy: "anonymous" } },
    async (
      request: FastifyRequest<{ Body: z.infer<typeof loginSchema> }>,
      _reply: FastifyReply,
    ) => {
      const parsed = loginSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Invalid request");
      }

      const { username, password } = parsed.data;
      const db = getDb();

      const row = db
        .select({
          id: users.id,
          username: users.username,
          passwordHash: users.passwordHash,
          role: users.role,
        })
        .from(users)
        .where(eq(users.username, username))
        .get();

      if (!row) {
        throw unauthorized("Invalid credentials", "INVALID_CREDENTIALS");
      }

      const valid = await bcrypt.compare(password, row.passwordHash);
      if (!valid) {
        throw unauthorized("Invalid credentials", "INVALID_CREDENTIALS");
      }

      const token = jwt.sign(
        { sub: row.id, username: row.username, role: row.role },
        getJwtSecret(),
        { expiresIn: "24h", issuer: "orcy" },
      );

      db.update(users)
        .set({ lastLoginAt: new Date().toISOString() })
        .where(eq(users.id, row.id))
        .run();

      return { token, user: { id: row.id, username: row.username, role: row.role } };
    },
  );

  fastify.get(
    "/auth/stream-token",
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const user = request.user!;
      const token = jwt.sign(
        { sub: user.id, username: user.username, role: user.role },
        getJwtSecret(),
        { expiresIn: "30s", issuer: "orcy" },
      );
      return { token };
    },
  );

  fastify.get("/auth/setup-status", { config: { authPolicy: "anonymous" } }, async () => {
    return getSetupStatus();
  });

  fastify.post(
    "/auth/register",
    { config: { authPolicy: "anonymous" } },
    async (request: FastifyRequest, _reply: FastifyReply) => {
    const parsed = registerSchema.safeParse(request.body);
    if (!parsed.success) {
      throw badRequest("Invalid request");
    }

    const result = registerInitialAdmin(parsed.data);

    return result;
  });

  fastify.get("/auth/me", { config: { authPolicy: "human" } }, async (request: FastifyRequest) => {
    const user = request.user!;
    return getCurrentUserProfile(user);
  });

  fastify.post("/auth/logout", { config: { authPolicy: "human" } }, async () => {
    return { success: true };
  });

  fastify.post(
    "/auth/change-password",
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const parsed = changePasswordSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Invalid request");
      }

      const user = request.user!;
      const { currentPassword, newPassword } = parsed.data;
      const db = getDb();

      const row = db
        .select({ id: users.id, passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, user.id))
        .get();
      if (!row) {
        throw unauthorized("User not found");
      }

      const valid = await bcrypt.compare(currentPassword, row.passwordHash);
      if (!valid) {
        throw unauthorized("Current password is incorrect", "INVALID_CREDENTIALS");
      }

      const newHash = await bcrypt.hash(newPassword, 10);
      db.update(users)
        .set({ passwordHash: newHash, updatedAt: new Date().toISOString() })
        .where(eq(users.id, row.id))
        .run();

      return { success: true };
    },
  );

  fastify.patch(
    "/auth/me",
    { config: { authPolicy: "human" } },
    async (request: FastifyRequest, _reply: FastifyReply) => {
      const parsed = updateProfileSchema.safeParse(request.body);
      if (!parsed.success) {
        throw badRequest("Invalid request");
      }

      const user = request.user!;
      const { displayName } = parsed.data;
      const db = getDb();

      const updateData =
        displayName !== undefined
          ? { displayName, updatedAt: new Date().toISOString() }
          : { updatedAt: new Date().toISOString() };
      db.update(users).set(updateData).where(eq(users.id, user.id)).run();

      const row = db
        .select({
          id: users.id,
          username: users.username,
          role: users.role,
          displayName: users.displayName,
        })
        .from(users)
        .where(eq(users.id, user.id))
        .get();

      return {
        user: {
          id: row!.id,
          username: row!.username,
          role: row!.role,
          displayName: row!.displayName,
        },
      };
    },
  );
}
