import { getDb } from "../db/index.js";
import { users } from "../db/schema/index.js";
import { eq, sql } from "drizzle-orm";
import { repositoryUpdateError } from "../errors/repository.js";
import * as agentRepo from "./agent.js";

export interface UserLookup {
  id: string;
  username: string;
}

export function findUsersByUsernamesCaseInsensitive(usernames: string[]): UserLookup[] {
  if (usernames.length === 0) return [];
  const db = getDb();
  const normalized = [...new Set(usernames.map((u) => u.toLowerCase()))];
  const rows = db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(
      sql`LOWER(${users.username}) IN (${sql.join(
        normalized.map((n) => sql`${n}`),
        sql`, `,
      )})`,
    )
    .all();
  return rows;
}

export function getUserById(userId: string): {
  id: string;
  username: string;
  displayName: string;
  email: string | null;
  role: string;
} | null {
  const db = getDb();
  const row = db
    .select({
      id: users.id,
      username: users.username,
      displayName: users.displayName,
      email: users.email,
      role: users.role,
    })
    .from(users)
    .where(eq(users.id, userId))
    .get();
  return row ?? null;
}

export function updateUserEmail(userId: string, email: string): void {
  const db = getDb();
  const now = new Date().toISOString();
  try {
    db.update(users)
      .set({ email: email || null, updatedAt: now })
      .where(eq(users.id, userId))
      .run();
  } catch (err) {
    throw repositoryUpdateError("user", err as Error, userId);
  }
}

export function getAdmins(): Array<{ id: string }> {
  const db = getDb();
  const rows = db.select({ id: users.id }).from(users).where(eq(users.role, "admin")).all();
  return rows as Array<{ id: string }>;
}

export function getUserEmail(userId: string): string | null {
  const db = getDb();
  const row = db.select({ email: users.email }).from(users).where(eq(users.id, userId)).get();
  return row?.email ?? null;
}

export function getActorName(actorId: string): string {
  const agent = agentRepo.getAgentById(actorId);
  if (agent) return agent.name;

  const db = getDb();
  const row = db
    .select({ displayName: users.displayName, username: users.username })
    .from(users)
    .where(eq(users.id, actorId))
    .get();
  if (row) return row.displayName || row.username || actorId;
  return actorId;
}

export function countUsers(): number {
  const db = getDb();
  const result = db
    .select({ count: sql<number>`COUNT(*)` })
    .from(users)
    .get();
  return result?.count ?? 0;
}

export interface UserAuthRow {
  id: string;
  username: string;
  passwordHash: string;
  role: string;
}

export function getUserByUsername(username: string): UserAuthRow | null {
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
  return row ?? null;
}

export function createUser(input: {
  id: string;
  username: string;
  passwordHash: string;
  displayName?: string;
  role?: "admin" | "editor" | "viewer";
  createdAt: string;
  updatedAt: string;
}): void {
  const db = getDb();
  db.insert(users)
    .values({
      id: input.id,
      username: input.username,
      passwordHash: input.passwordHash,
      displayName: input.displayName ?? "",
      role: input.role ?? "admin",
      createdAt: input.createdAt,
      updatedAt: input.updatedAt,
    })
    .run();
}
