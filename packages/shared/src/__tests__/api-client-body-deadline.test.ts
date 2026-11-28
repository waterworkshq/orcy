import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it } from 'vitest';
import { ApiClientError, createApiClient } from '../api-client.js';

it('aborts a slow successful write acknowledgement without replaying it', async () => {
  let attempts = 0;
  let closed = false;
  const server = createServer((_req, res) => {
    attempts++;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{"ok":');
    res.on('close', () => { closed = true; });
    setTimeout(() => res.end('true}'), 350).unref();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  try {
    const client = createApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 80, maxRetries: 2, baseDelay: 1 });
    const result = await client.post('/write', { synthetic: true }).then(() => 'success', (error: unknown) => error);
    expect(result).toBeInstanceOf(ApiClientError);
    expect((result as ApiClientError).status).toBe(408);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(attempts).toBe(1);
    expect(closed).toBe(true);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('preserves successful empty and malformed body behavior and unrelated retries', async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts++;
    if (req.url === '/empty') { res.writeHead(200, { 'content-length': '0' }).end(); return; }
    if (req.url === '/no-content') { res.writeHead(204).end(); return; }
    if (req.url === '/malformed') { res.end('{'); return; }
    if (req.url === '/retry' && attempts === 1) { res.writeHead(503).end('retry'); return; }
    res.end('{"ok":true}');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  const client = createApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 500, maxRetries: 2, baseDelay: 1 });
  try {
    expect(await client.get('/empty')).toBeUndefined();
    expect(await client.get('/no-content')).toBeUndefined();
    attempts = 0;
    await expect(client.get('/malformed')).rejects.toBeInstanceOf(SyntaxError);
    expect(attempts).toBe(1);
    attempts = 0;
    expect(await client.get('/retry')).toEqual({ ok: true });
    expect(attempts).toBe(2);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('keeps HTTP error classification when its body stalls and aborts', async () => {
  let attempts = 0;
  const server = createServer((_req, res) => {
    attempts++;
    res.writeHead(400, 'Bad Request');
    res.write('partial');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  try {
    const client = createApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 80, maxRetries: 2 });
    await expect(client.get('/error')).rejects.toMatchObject({ status: 400, message: 'API 400: Bad Request' });
    expect(attempts).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('preserves non-timeout body failures and header timeout behavior', async () => {
  let attempts = 0;
  const server = createServer((req, res) => {
    attempts++;
    if (req.url === '/headers') return;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('{');
    setTimeout(() => res.destroy(), 10);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  try {
    const client = createApiClient({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 100, maxRetries: 2, baseDelay: 1 });
    await expect(client.get('/broken')).rejects.toBeInstanceOf(TypeError);
    expect(attempts).toBe(1);
    attempts = 0;
    await expect(client.get('/headers')).rejects.toMatchObject({ status: 408 });
    expect(attempts).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
