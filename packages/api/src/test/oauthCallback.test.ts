import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startCallbackServer, stopCallbackServer } from '../services/integrations/oauthCallback.js';

describe('oauthCallback', () => {
  beforeEach(() => {
    stopCallbackServer();
  });

  afterEach(() => {
    stopCallbackServer();
  });

  it('starts server and resolves code from callback', async () => {
    const { port, code } = await startCallbackServer();

    const res = await fetch(`http://127.0.0.1:${port}/callback?code=test-auth-code-123`);
    expect(res.ok).toBe(true);

    const result = await code;
    expect(result).toBe('test-auth-code-123');
  });

  it('rejects on OAuth error parameter', async () => {
    const { port, code } = await startCallbackServer();

    await fetch(`http://127.0.0.1:${port}/callback?error=access_denied`);

    await expect(code).rejects.toThrow('OAuth error: access_denied');
  });

  it('returns 400 when no code or error parameter', async () => {
    const { port } = await startCallbackServer();

    const res = await fetch(`http://127.0.0.1:${port}/callback`);
    expect(res.status).toBe(400);
  });

  it('throws if server already running', async () => {
    const { code } = await startCallbackServer();
    code.catch(() => {});

    expect(() => startCallbackServer()).toThrow('already running');
  });

  it('uses random port', async () => {
    const { port: port1, code: code1 } = await startCallbackServer();
    code1.catch(() => {});
    stopCallbackServer();

    const { port: port2, code: code2 } = await startCallbackServer();
    code2.catch(() => {});

    expect(port1).toBeGreaterThan(0);
    expect(port2).toBeGreaterThan(0);
    expect(port1).not.toBe(port2);
  });
});
