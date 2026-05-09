import { describe, it, expect } from 'vitest';
import { generateSecret, signPayload } from '../utils/webhookSigning.js';

describe('webhookSigning', () => {
  describe('generateSecret', () => {
    it('produces valid hex string of correct length', () => {
      const secret = generateSecret();
      expect(secret).toMatch(/^[0-9a-f]+$/);
      expect(secret).toHaveLength(64);
    });

    it('produces unique secrets', () => {
      const a = generateSecret();
      const b = generateSecret();
      expect(a).not.toBe(b);
    });
  });

  describe('signPayload', () => {
    it('produces valid HMAC-SHA256 signature', () => {
      const payload = '{"test":true}';
      const secret = 'test-secret-key';
      const sig = signPayload(payload, secret);
      expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
    });

    it('produces deterministic signature for same inputs', () => {
      const payload = '{"test":true}';
      const secret = 'test-secret-key';
      const a = signPayload(payload, secret);
      const b = signPayload(payload, secret);
      expect(a).toBe(b);
    });

    it('different payloads produce different signatures', () => {
      const secret = 'test-secret-key';
      const a = signPayload('payload-a', secret);
      const b = signPayload('payload-b', secret);
      expect(a).not.toBe(b);
    });
  });
});
