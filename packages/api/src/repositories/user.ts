import { getDb } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';

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
    .where(sql`LOWER(${users.username}) IN (${sql.join(normalized.map(n => sql`${n}`), sql`, `)})`)
    .all();
  return rows;
}

export function getUserById(userId: string): { id: string; username: string; displayName: string; email: string | null; role: string } | null {
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
  db.update(users)
    .set({ email, updatedAt: now })
    .where(eq(users.id, userId))
    .run();
}
