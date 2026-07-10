import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { decryptSecret, encryptSecret } from '../services/secretCrypto.js';

const ORIGINAL_JWT_SECRET = process.env.JWT_SECRET;

describe('secretCrypto', () => {
  beforeEach(() => {
    process.env.JWT_SECRET = 'test-secret-for-secretCrypto';
  });

  afterEach(() => {
    if (ORIGINAL_JWT_SECRET === undefined) {
      delete process.env.JWT_SECRET;
    } else {
      process.env.JWT_SECRET = ORIGINAL_JWT_SECRET;
    }
  });

  describe('round-trip equality', () => {
    it('decrypts back to the original plaintext', () => {
      const stored = encryptSecret('hello');
      expect(decryptSecret(stored)).toBe('hello');
    });

    it('round-trips an empty plaintext', () => {
      const stored = encryptSecret('');
      expect(decryptSecret(stored)).toBe('');
    });

    it('round-trips multi-byte UTF-8 plaintext without corruption', () => {
      const plaintext = 'snowman ☃ + emoji 🦊 — mixed';
      const stored = encryptSecret(plaintext);
      expect(decryptSecret(stored)).toBe(plaintext);
    });

    it('produces a fresh IV on every encryption (ciphertext differs per call)', () => {
      const first = encryptSecret('same');
      const second = encryptSecret('same');
      expect(first).not.toBe(second);
      expect(decryptSecret(first)).toBe('same');
      expect(decryptSecret(second)).toBe('same');
    });

    it('emits the aes: envelope shape expected by decryptSecret', () => {
      const stored = encryptSecret('hello');
      const parts = stored.split(':');
      expect(parts).toHaveLength(4);
      expect(parts[0]).toBe('aes');
      // 12-byte IV encoded as 24 hex chars
      expect(parts[1]).toMatch(/^[0-9a-f]{24}$/);
      // 16-byte GCM auth tag encoded as 32 hex chars
      expect(parts[2]).toMatch(/^[0-9a-f]{32}$/);
      expect(parts[3]).toMatch(/^[0-9a-f]+$/);
    });
  });

  describe('decryptSecret returns null for invalid input', () => {
    it('returns null for null', () => {
      expect(decryptSecret(null)).toBeNull();
    });

    it('returns null for undefined', () => {
      expect(decryptSecret(undefined)).toBeNull();
    });

    it('returns null for empty string', () => {
      expect(decryptSecret('')).toBeNull();
    });

    it('returns null for input without the aes: prefix', () => {
      expect(decryptSecret('xyz:foo')).toBeNull();
      expect(decryptSecret('plaintext-without-prefix')).toBeNull();
      expect(decryptSecret('AES:uppercase:tag:ct')).toBeNull();
    });

    it('returns null for malformed envelopes (wrong number of colon parts)', () => {
      // Too few parts
      expect(decryptSecret('aes:abc')).toBeNull();
      expect(decryptSecret('aes')).toBeNull();
      // Too many parts
      expect(decryptSecret('aes:iv:tag:ct:extra')).toBeNull();
    });
  });

  describe('tamper detection (GCM auth-tag rejection)', () => {
    it('returns null when a single hex byte of the ciphertext is mutated', () => {
      const stored = encryptSecret('payload-to-protect');
      const [prefix, iv, authTag, ciphertext] = stored.split(':');
      expect(prefix).toBe('aes');

      // Flip the first hex char of the ciphertext — should invalidate GCM auth tag.
      const firstByte = ciphertext.slice(0, 2);
      const flipped =
        firstByte === '00' ? 'ff' : firstByte === 'ff' ? '00' : 'ff';
      const tampered = `aes:${iv}:${authTag}:${flipped}${ciphertext.slice(2)}`;

      expect(decryptSecret(tampered)).toBeNull();
    });

    it('returns null when a single hex byte of the auth tag is mutated', () => {
      const stored = encryptSecret('payload-to-protect');
      const [prefix, iv, authTag, ciphertext] = stored.split(':');
      expect(prefix).toBe('aes');

      // Mutate the auth tag — GCM must reject regardless of ciphertext.
      const firstByte = authTag.slice(0, 2);
      const flipped = firstByte === '00' ? 'ff' : firstByte === 'ff' ? '00' : 'ff';
      const tampered = `aes:${iv}:${flipped}${authTag.slice(2)}:${ciphertext}`;

      expect(decryptSecret(tampered)).toBeNull();
    });

    it('does not return corrupted plaintext under tampering', () => {
      const stored = encryptSecret('original-secret');
      const [prefix, iv, authTag, ciphertext] = stored.split(':');
      expect(prefix).toBe('aes');

      // Flip a byte deep inside the ciphertext.
      const mid = Math.floor(ciphertext.length / 4) * 2;
      const targetByte = ciphertext.slice(mid, mid + 2);
      const flipped = targetByte === '00' ? 'ff' : targetByte === 'ff' ? '00' : 'ff';
      const tampered = [
        'aes',
        iv,
        authTag,
        ciphertext.slice(0, mid) + flipped + ciphertext.slice(mid + 2),
      ].join(':');

      const result = decryptSecret(tampered);
      expect(result).toBeNull();
      expect(result).not.toBe('original-secret');
    });
  });

  describe('cross-key non-decryption', () => {
    it('returns null when decryptSecret uses a different JWT_SECRET than encryptSecret', () => {
      const stored = encryptSecret('secret-under-key-a');

      // Switch the derived key.
      process.env.JWT_SECRET = 'a-completely-different-secret-for-key-b';

      expect(decryptSecret(stored)).toBeNull();
    });

    it('decrypts successfully again once the original JWT_SECRET is restored', () => {
      const stored = encryptSecret('secret-under-key-a');

      process.env.JWT_SECRET = 'tampered-secret';
      expect(decryptSecret(stored)).toBeNull();

      process.env.JWT_SECRET = 'test-secret-for-secretCrypto';
      expect(decryptSecret(stored)).toBe('secret-under-key-a');
    });
  });
});
