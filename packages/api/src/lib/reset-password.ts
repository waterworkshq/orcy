import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from '../db/schema/index.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import bcrypt from 'bcryptjs';

type DrizzleDb = BetterSQLite3Database<typeof schema>;

export class ResetPasswordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResetPasswordError';
  }
}

export async function resetPassword(
  username: string | undefined,
  newPassword: string | undefined,
  db: DrizzleDb,
): Promise<string> {
  if (!username) {
    throw new ResetPasswordError('Username is required.');
  }

  if (!newPassword) {
    throw new ResetPasswordError('New password is required.');
  }

  if (newPassword.length < 4) {
    throw new ResetPasswordError('New password must be at least 4 characters.');
  }

  const user = db.select({
    id: users.id,
    username: users.username,
  }).from(users).where(eq(users.username, username)).get();

  if (!user) {
    throw new ResetPasswordError(`User '${username}' not found.`);
  }

  const passwordHash = await bcrypt.hash(newPassword, 10);
  db.update(users).set({ passwordHash, updatedAt: new Date().toISOString() }).where(eq(users.id, user.id)).run();

  return `Password reset for user '${username}'. You can now log in with the new password.`;
}
