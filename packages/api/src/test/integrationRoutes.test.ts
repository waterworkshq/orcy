import { describe, it, expect, vi, beforeEach } from 'vitest';
import { integrationRoutes } from '../routes/integrations.js';

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  handler: any;
}

function captureIntegrationRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    get: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'GET', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
    post: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'POST', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
    put: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'PUT', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
    patch: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'PATCH', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'DELETE', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
  };
  integrationRoutes(fakeFastify);
  return routes;
}

const { mockSyncConnection } = vi.hoisted(() => ({
  mockSyncConnection: vi.fn(),
}));

vi.mock('../repositories/integrationConnection.js', () => ({
  create: vi.fn(),
  getById: vi.fn(),
  listByHabitat: vi.fn(),
  listEnabledByProvider: vi.fn(),
  listEnabledByProviderAndRepo: vi.fn(),
  update: vi.fn(),
  disable: vi.fn(),
  toView: (c: any) => ({ ...c, hasAccessToken: !!c.accessToken, hasRefreshToken: !!c.refreshToken, hasWebhookSecret: !!c.webhookSecret }),
}));

vi.mock('../repositories/externalIssueLink.js', () => ({
  create: vi.fn(),
  getById: vi.fn(),
  findByConnectionIdAndExternalId: vi.fn(),
  listByMissionId: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../repositories/integrationSyncRun.js', () => ({
  create: vi.fn(),
  finish: vi.fn(),
  listByConnectionId: vi.fn(),
  getById: vi.fn(),
}));

vi.mock('../services/integrations/syncService.js', () => ({
  syncConnection: (...args: unknown[]) => mockSyncConnection(...args),
  syncExternalIssue: vi.fn(),
}));

vi.mock('../services/integrations/githubAdapter.js', () => {
  const fakeAdapter = {
    provider: 'github' as const,
    listIssues: vi.fn().mockResolvedValue([]),
    getIssue: vi.fn().mockResolvedValue(null),
  };
  return {
    __esModule: true,
    default: { githubAdapter: fakeAdapter },
    githubAdapter: fakeAdapter,
  };
});

vi.mock('../services/integrations/githubOAuth.js', () => ({
  startGitHubDeviceFlow: vi.fn().mockResolvedValue({
    device_code: 'dc-123',
    user_code: 'ABCD-1234',
    verification_uri: 'https://github.com/login/device',
    expires_in: 900,
    interval: 5,
  }),
  pollGitHubDeviceFlow: vi.fn().mockResolvedValue({ access_token: 'gho_test', token_type: 'bearer', scope: 'repo,read:user' }),
  getGitHubViewer: vi.fn().mockResolvedValue({ id: 123, login: 'testuser', name: 'Test User' }),
}));

vi.mock('../repositories/board.js', () => ({
  getHabitatById: vi.fn(() => ({ id: 'hab-1', name: 'Test', teamId: null })),
}));

vi.mock('../repositories/teamMember.js', () => ({
  isTeamMemberByHabitatId: vi.fn(() => true),
}));

vi.mock('../middleware/auth.js', () => ({
  humanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
  agentOrHumanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
}));

vi.mock('../middleware/team.js', () => ({
  requireHabitatAccess: vi.fn((_req: any, _reply: any, done: any) => done()),
}));

vi.mock('../errors.js', () => ({
  notFound: (msg: string) => ({ statusCode: 404, message: msg }),
  badRequest: (msg: string) => ({ statusCode: 400, message: msg }),
  forbidden: (msg: string) => ({ statusCode: 403, message: msg }),
  unauthorized: (msg: string) => ({ statusCode: 401, message: msg }),
}));

vi.mock('uuid', () => ({ v4: () => 'mock-uuid-123', default: { v4: () => 'mock-uuid-123' } }));

vi.mock('crypto', () => ({
  randomBytes: () => Buffer.from('mock-secret-abc'),
  default: {
    randomBytes: () => Buffer.from('mock-secret-abc'),
  },
}));

function makeMockReply() {
  const reply: any = {};
  reply.status = vi.fn(() => reply);
  reply.send = vi.fn(() => reply);
  reply.code = vi.fn(() => reply);
  return reply;
}

function makeMockRequest(overrides: Record<string, unknown> = {}) {
  return {
    params: {},
    body: {},
    user: { id: 'user-1' },
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('integrationRoutes', () => {
  it('exports a function', () => {
    expect(integrationRoutes).toBeInstanceOf(Function);
  });

  it('registers 9 endpoints', () => {
    const routes = captureIntegrationRoutes();
    expect(routes).toHaveLength(9);
  });

  it('registers GET /habitats/:habitatId/integrations', () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/integrations');
    expect(route).toBeDefined();
    expect(route!.preHandler.some((h: any) => h.name)).toBe(true);
  });

  it('registers POST /habitats/:habitatId/integrations/github/pat', () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/integrations/github/pat');
    expect(route).toBeDefined();
  });

  it('registers PATCH /integrations/:connectionId', () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'PATCH' && r.path === '/integrations/:connectionId');
    expect(route).toBeDefined();
  });

  it('registers DELETE /integrations/:connectionId', () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'DELETE' && r.path === '/integrations/:connectionId');
    expect(route).toBeDefined();
  });

  it('registers POST /integrations/:connectionId/sync', () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/integrations/:connectionId/sync');
    expect(route).toBeDefined();
  });

  it('registers GET /integrations/:connectionId/sync-runs', () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/integrations/:connectionId/sync-runs');
    expect(route).toBeDefined();
  });

  it('registers POST /habitats/:habitatId/integrations/github/oauth/device/start', () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/integrations/github/oauth/device/start');
    expect(route).toBeDefined();
  });

  it('registers POST /habitats/:habitatId/integrations/github/oauth/device/poll', () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/integrations/github/oauth/device/poll');
    expect(route).toBeDefined();
  });
});

describe('GET /habitats/:habitatId/integrations', () => {
  it('returns masked connections for habitat', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/integrations')!;
    const connRepo = await import('../repositories/integrationConnection.js');

    const rawConn = { id: 'conn-1', habitatId: 'hab-1', provider: 'github', accessToken: 'secret' };
    (connRepo.listByHabitat as any).mockReturnValue([rawConn]);

    const reply = makeMockReply();
    const result = await route.handler(makeMockRequest({ params: { habitatId: 'hab-1' } }), reply);
    expect(result.integrations).toHaveLength(1);
    expect(result.integrations[0].hasAccessToken).toBe(true);
  });
});

describe('POST /habitats/:habitatId/integrations/github/pat', () => {
  it('creates connection with valid input and returns 201', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/integrations/github/pat')!;
    const connRepo = await import('../repositories/integrationConnection.js');

    const created = { id: 'conn-1', habitatId: 'hab-1', provider: 'github', name: 'My Repo', authMethod: 'pat', accessToken: 'ghp_test', repositoryOwner: 'acme', repositoryName: 'repo' };
    (connRepo.create as any).mockReturnValue(created);

    const reply = makeMockReply();
    const body = { name: 'My Repo', token: 'ghp_test', repositoryOwner: 'acme', repositoryName: 'repo' };
    await route.handler(makeMockRequest({ params: { habitatId: 'hab-1' }, body }), reply);

    expect(connRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      habitatId: 'hab-1',
      provider: 'github',
      authMethod: 'pat',
      name: 'My Repo',
      accessToken: 'ghp_test',
      repositoryOwner: 'acme',
      repositoryName: 'repo',
    }));
    expect(reply.code).toHaveBeenCalledWith(201);
    expect(reply.send).toHaveBeenCalled();
  });

  it('returns bad request on invalid body', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/integrations/github/pat')!;

    const reply = makeMockReply();
    await expect(() =>
      route.handler(makeMockRequest({ params: { habitatId: 'hab-1' }, body: { name: '' } }), reply)
    ).rejects.toBeDefined();
  });
});

describe('PATCH /integrations/:connectionId', () => {
  it('updates connection settings', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'PATCH' && r.path === '/integrations/:connectionId')!;
    const connRepo = await import('../repositories/integrationConnection.js');

    const existing = { id: 'conn-1', habitatId: 'hab-1', provider: 'github', name: 'Old Name', enabled: true };
    (connRepo.getById as any).mockReturnValue(existing);
    (connRepo.update as any).mockReturnValue({ ...existing, name: 'New Name' });

    const reply = makeMockReply();
    const result = await route.handler(
      makeMockRequest({ params: { connectionId: 'conn-1' }, body: { name: 'New Name' } }),
      reply
    );

    expect(connRepo.update).toHaveBeenCalledWith('conn-1', { name: 'New Name' });
    expect(result.integration).toBeDefined();
  });

  it('returns 404 for unknown connection', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'PATCH' && r.path === '/integrations/:connectionId')!;
    const connRepo = await import('../repositories/integrationConnection.js');

    (connRepo.getById as any).mockReturnValue(null);

    const reply = makeMockReply();
    await expect(() =>
      route.handler(makeMockRequest({ params: { connectionId: 'conn-missing' }, body: {} }), reply)
    ).rejects.toBeDefined();
  });
});

describe('DELETE /integrations/:connectionId', () => {
  it('disables connection and returns 204', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'DELETE' && r.path === '/integrations/:connectionId')!;
    const connRepo = await import('../repositories/integrationConnection.js');

    (connRepo.getById as any).mockReturnValue({ id: 'conn-1', habitatId: 'hab-1', provider: 'github' });

    const reply = makeMockReply();
    await route.handler(makeMockRequest({ params: { connectionId: 'conn-1' } }), reply);

    expect(connRepo.disable).toHaveBeenCalledWith('conn-1');
    expect(reply.code).toHaveBeenCalledWith(204);
    expect(reply.send).toHaveBeenCalled();
  });
});

describe('POST /integrations/:connectionId/sync', () => {
  it('rejects sync for disabled connection', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/integrations/:connectionId/sync')!;
    const connRepo = await import('../repositories/integrationConnection.js');

    (connRepo.getById as any).mockReturnValue({ id: 'conn-1', habitatId: 'hab-1', provider: 'github', enabled: false, pullEnabled: true });

    const reply = makeMockReply();
    await expect(() =>
      route.handler(makeMockRequest({ params: { connectionId: 'conn-1' } }), reply)
    ).rejects.toBeDefined();
  });

  it('rejects sync for pull-disabled connection', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/integrations/:connectionId/sync')!;
    const connRepo = await import('../repositories/integrationConnection.js');

    (connRepo.getById as any).mockReturnValue({ id: 'conn-1', habitatId: 'hab-1', provider: 'github', enabled: true, pullEnabled: false });

    const reply = makeMockReply();
    await expect(() =>
      route.handler(makeMockRequest({ params: { connectionId: 'conn-1' } }), reply)
    ).rejects.toBeDefined();
  });
});

describe('GET /integrations/:connectionId/sync-runs', () => {
  it('lists sync runs', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/integrations/:connectionId/sync-runs')!;
    const connRepo = await import('../repositories/integrationConnection.js');
    const syncRunRepo = await import('../repositories/integrationSyncRun.js');

    (connRepo.getById as any).mockReturnValue({ id: 'conn-1', habitatId: 'hab-1', provider: 'github' });
    (syncRunRepo.listByConnectionId as any).mockReturnValue([{ id: 'run-1', status: 'success' }]);

    const reply = makeMockReply();
    const result = await route.handler(makeMockRequest({ params: { connectionId: 'conn-1' } }), reply);

    expect(syncRunRepo.listByConnectionId).toHaveBeenCalledWith('conn-1');
    expect(result.syncRuns).toHaveLength(1);
  });
});

describe('GET /missions/:missionId/external-links', () => {
  it('lists links for mission', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/missions/:missionId/external-links')!;
    const linkRepo = await import('../repositories/externalIssueLink.js');

    (linkRepo.listByMissionId as any).mockReturnValue([{ id: 'link-1', missionId: 'mis-1', externalUrl: 'https://github.com/a/b/issues/1' }]);

    const reply = makeMockReply();
    const result = await route.handler(makeMockRequest({ params: { missionId: 'mis-1' } }), reply);

    expect(linkRepo.listByMissionId).toHaveBeenCalledWith('mis-1');
    expect(result.externalLinks).toHaveLength(1);
  });
});

describe('POST /habitats/:habitatId/integrations/github/oauth/device/start', () => {
  it('returns device flow info', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/integrations/github/oauth/device/start')!;

    const reply = makeMockReply();
    const result = await route.handler(makeMockRequest({ params: { habitatId: 'hab-1' } }), reply);

    expect(result.deviceCode).toBe('dc-123');
    expect(result.userCode).toBe('ABCD-1234');
    expect(result.verificationUri).toBe('https://github.com/login/device');
  });
});

describe('POST /habitats/:habitatId/integrations/github/oauth/device/poll', () => {
  it('returns pending when authorization_pending', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/integrations/github/oauth/device/poll')!;
    const oauth = await import('../services/integrations/githubOAuth.js');

    (oauth.pollGitHubDeviceFlow as any).mockResolvedValue({ error: 'authorization_pending' });

    const reply = makeMockReply();
    const result = await route.handler(
      makeMockRequest({ params: { habitatId: 'hab-1' }, body: { deviceCode: 'dc-123' } }),
      reply,
    );

    expect(result.status).toBe('pending');
  });

  it('creates connection on success and returns 201', async () => {
    const routes = captureIntegrationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/integrations/github/oauth/device/poll')!;
    const oauth = await import('../services/integrations/githubOAuth.js');
    const connRepo = await import('../repositories/integrationConnection.js');

    (oauth.pollGitHubDeviceFlow as any).mockResolvedValue({ access_token: 'gho_abc', token_type: 'bearer', scope: 'repo,read:user' });
    (oauth.getGitHubViewer as any).mockResolvedValue({ id: 123, login: 'testuser', name: 'Test User' });

    const created = { id: 'conn-oauth', habitatId: 'hab-1', provider: 'github', authMethod: 'oauth_device', externalAccountName: 'testuser' };
    (connRepo.create as any).mockReturnValue(created);

    const reply = makeMockReply();
    await route.handler(
      makeMockRequest({ params: { habitatId: 'hab-1' }, body: { deviceCode: 'dc-123' } }),
      reply,
    );

    expect(connRepo.create).toHaveBeenCalledWith(expect.objectContaining({
      provider: 'github',
      authMethod: 'oauth_device',
      externalAccountName: 'testuser',
    }));
    expect(reply.code).toHaveBeenCalledWith(201);
  });
});
