import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import bcrypt from 'bcryptjs';
import { initTestDb, closeDb, getDb } from '../db/index.js';
import { users } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { resetPassword, ResetPasswordError } from '../lib/reset-password.js';

describe('reset-password', () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => {
    closeDb();
  });

  it('throws error when username is missing', async () => {
    const db = getDb();
    await expect(resetPassword(undefined, 'newpass123', db)).rejects.toThrow(ResetPasswordError);
    await expect(resetPassword(undefined, 'newpass123', db)).rejects.toThrow('Username is required');
  });

  it('throws error when new password is missing', async () => {
    const db = getDb();
    await expect(resetPassword('admin', undefined, db)).rejects.toThrow(ResetPasswordError);
    await expect(resetPassword('admin', undefined, db)).rejects.toThrow('New password is required');
  });

  it('throws error when new password is less than 4 characters', async () => {
    const db = getDb();
    await expect(resetPassword('admin', 'ab', db)).rejects.toThrow(ResetPasswordError);
    await expect(resetPassword('admin', 'ab', db)).rejects.toThrow('at least 4 characters');
  });

  it('throws error when username does not exist in database', async () => {
    const db = getDb();
    await expect(resetPassword('nonexistent', 'newpass123', db)).rejects.toThrow(ResetPasswordError);
    await expect(resetPassword('nonexistent', 'newpass123', db)).rejects.toThrow('not found');
  });

  it('successfully hashes new password and updates user record', async () => {
    const db = getDb();
    const message = await resetPassword('admin', 'newpass123', db);
    expect(message).toContain('Password reset for user');

    const updated = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.username, 'admin')).get();
    const valid = await bcrypt.compare('newpass123', updated!.passwordHash);
    expect(valid).toBe(true);
  });

  it('old password no longer works after reset', async () => {
    const db = getDb();
    const before = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.username, 'admin')).get();
    const oldValidBefore = await bcrypt.compare('admin123', before!.passwordHash);
    expect(oldValidBefore).toBe(true);

    await resetPassword('admin', 'resetpass999', db);

    const after = db.select({ passwordHash: users.passwordHash }).from(users).where(eq(users.username, 'admin')).get();
    const oldValidAfter = await bcrypt.compare('admin123', after!.passwordHash);
    expect(oldValidAfter).toBe(false);

    const newValid = await bcrypt.compare('resetpass999', after!.passwordHash);
    expect(newValid).toBe(true);
  });
});
