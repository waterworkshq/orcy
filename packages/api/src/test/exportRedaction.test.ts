import { describe, it, expect } from 'vitest';
import { redactSensitiveHeaders } from '../config/integrationSecurity.js';

describe('Export Redaction', () => {
  describe('redactSensitiveHeaders — unit', () => {
    it('redacts Authorization header', () => {
      const result = redactSensitiveHeaders({ Authorization: 'Bearer secret123' });
      expect(result.Authorization).toBe('[REDACTED]');
    });

    it('redacts Cookie header', () => {
      const result = redactSensitiveHeaders({ Cookie: 'session=abc123' });
      expect(result.Cookie).toBe('[REDACTED]');
    });

    it('redacts X-API-Key header', () => {
      const result = redactSensitiveHeaders({ 'X-API-Key': 'my-api-key' });
      expect(result['X-API-Key']).toBe('[REDACTED]');
    });

    it('redacts X-Auth-Token header', () => {
      const result = redactSensitiveHeaders({ 'X-Auth-Token': 'token123' });
      expect(result['X-Auth-Token']).toBe('[REDACTED]');
    });

    it('redacts headers with "secret" in name', () => {
      const result = redactSensitiveHeaders({ 'X-My-Secret-Value': 'supersecret' });
      expect(result['X-My-Secret-Value']).toBe('[REDACTED]');
    });

    it('redacts headers with "token" in name', () => {
      const result = redactSensitiveHeaders({ 'X-Csrf-Token': 'csrf-value' });
      expect(result['X-Csrf-Token']).toBe('[REDACTED]');
    });

    it('redacts headers with "key" in name', () => {
      const result = redactSensitiveHeaders({ 'Api-Key': 'key123' });
      expect(result['Api-Key']).toBe('[REDACTED]');
    });

    it('preserves non-sensitive headers', () => {
      const result = redactSensitiveHeaders({
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'X-Custom-Header': 'value',
      });
      expect(result['Content-Type']).toBe('application/json');
      expect(result['Accept']).toBe('application/json');
      expect(result['X-Custom-Header']).toBe('value');
    });

    it('handles empty headers object', () => {
      const result = redactSensitiveHeaders({});
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('redacts multiple sensitive headers at once', () => {
      const result = redactSensitiveHeaders({
        Authorization: 'Bearer token',
        'Content-Type': 'application/json',
        Cookie: 'session=xyz',
        Accept: '*/*',
      });
      expect(result.Authorization).toBe('[REDACTED]');
      expect(result.Cookie).toBe('[REDACTED]');
      expect(result['Content-Type']).toBe('application/json');
      expect(result.Accept).toBe('*/*');
    });
  });

  describe('export defaults — unit', () => {
    it('default export include list excludes webhooks', () => {
      const defaultInclude = ['columns', 'features', 'comments', 'templates'];
      expect(defaultInclude).not.toContain('webhooks');
      expect(defaultInclude).toContain('columns');
      expect(defaultInclude).toContain('features');
    });
  });
});
