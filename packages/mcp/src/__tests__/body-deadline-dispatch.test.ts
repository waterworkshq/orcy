import { createServer } from 'node:http';
import { once } from 'node:events';
import { expect, it, vi } from 'vitest';
import { resetConfig } from '@orcy/shared';
import { KanbanApiClient } from '../api.js';
import { AUTOMATION_DISPATCH_HANDLER } from '../tools/automation-dispatch.js';

it('reports a successful-body timeout through automation dispatch', async () => {
  let requests = 0;
  let path = '';
  const server = createServer((req, res) => {
    requests++;
    path = req.url ?? '';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.write('[');
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('missing address');
  try {
    vi.stubEnv('ORCY_API_KEY', 'synthetic');
    resetConfig();
    const client = new KanbanApiClient(`http://127.0.0.1:${address.port}`, 80, { maxRetries: 2 });
    const result = await AUTOMATION_DISPATCH_HANDLER(client, { action: 'list', habitatId: 'synthetic' });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('API 408:');
    expect(path).toContain('synthetic');
    expect(requests).toBe(1);
  } finally {
    vi.unstubAllEnvs();
    resetConfig();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
