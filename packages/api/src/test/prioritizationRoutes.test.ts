import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prioritizationRoutes } from '../routes/prioritization.js';

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  handler: any;
}

function capturePrioritizationRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    get: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'GET', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
    put: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'PUT', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
    post: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'POST', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
  };
  prioritizationRoutes(fakeFastify);
  return routes;
}

vi.mock('../services/prioritizationService.js', () => ({
  getPrioritizationRules: vi.fn(() => ({
    enabled: true,
    evaluateIntervalMinutes: 5,
    rules: [],
    fallbackToManual: true,
  })),
  getDefaultPrioritizationSettings: vi.fn(() => ({
    enabled: true,
    evaluateIntervalMinutes: 5,
    rules: [],
    fallbackToManual: true,
  })),
  applyPrioritization: vi.fn(() => ({
    habitatId: 'habitat-1',
    evaluatedTasks: 0,
    changedTasks: 0,
    results: [],
  })),
  evaluateRules: vi.fn(() => []),
}));

vi.mock('../repositories/board.js', () => ({
  getHabitatById: vi.fn(() => ({
    id: 'habitat-1',
    name: 'Test Habitat',
    prioritizationSettings: null,
  })),
  updateHabitat: vi.fn(),
}));

vi.mock('../repositories/task.js', () => ({
  getTasksByHabitatId: vi.fn(() => ({ tasks: [], total: 0 })),
}));

vi.mock('../middleware/auth.js', () => ({
  humanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
  agentOrHumanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
}));

vi.mock('../middleware/team.js', () => ({
  requireHabitatAccess: vi.fn((_req: any, _reply: any, done: any) => done()),
}));

vi.mock('../errors.js', () => ({
  notFound: (msg: string) => new Error(msg),
}));

describe('prioritizationRoutes', () => {
  it('exports a function named prioritizationRoutes', () => {
    expect(prioritizationRoutes).toBeInstanceOf(Function);
    expect(prioritizationRoutes.name).toBe('prioritizationRoutes');
  });

  it('registers 4 endpoints', () => {
    const routes = capturePrioritizationRoutes();
    expect(routes).toHaveLength(4);
  });

  it('registers GET /habitats/:habitatId/rules', () => {
    const routes = capturePrioritizationRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/rules');
    expect(route).toBeDefined();
  });

  it('registers PUT /habitats/:habitatId/rules', () => {
    const routes = capturePrioritizationRoutes();
    const route = routes.find(r => r.method === 'PUT' && r.path === '/habitats/:habitatId/rules');
    expect(route).toBeDefined();
  });

  it('registers POST /habitats/:habitatId/rules/evaluate', () => {
    const routes = capturePrioritizationRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/rules/evaluate');
    expect(route).toBeDefined();
  });

  it('registers GET /habitats/:habitatId/priority-report', () => {
    const routes = capturePrioritizationRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/priority-report');
    expect(route).toBeDefined();
  });
});

describe('prioritization route auth', () => {
  it('GET /rules uses agentOrHumanAuth', async () => {
    const { agentOrHumanAuth } = await import('../middleware/auth.js');
    const routes = capturePrioritizationRoutes();
    const getRules = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/rules');
    expect(getRules!.preHandler).toContain(agentOrHumanAuth);
  });

  it('PUT /rules uses humanAuth', async () => {
    const { humanAuth } = await import('../middleware/auth.js');
    const routes = capturePrioritizationRoutes();
    const putRules = routes.find(r => r.method === 'PUT' && r.path === '/habitats/:habitatId/rules');
    expect(putRules!.preHandler).toContain(humanAuth);
  });

  it('POST /rules/evaluate uses humanAuth', async () => {
    const { humanAuth } = await import('../middleware/auth.js');
    const routes = capturePrioritizationRoutes();
    const evaluate = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/rules/evaluate');
    expect(evaluate!.preHandler).toContain(humanAuth);
  });

  it('GET /priority-report uses agentOrHumanAuth', async () => {
    const { agentOrHumanAuth } = await import('../middleware/auth.js');
    const routes = capturePrioritizationRoutes();
    const report = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/priority-report');
    expect(report!.preHandler).toContain(agentOrHumanAuth);
  });

  it('all endpoints require habitat access', async () => {
    const { requireHabitatAccess } = await import('../middleware/team.js');
    const routes = capturePrioritizationRoutes();
    for (const route of routes) {
      expect(route.preHandler).toContain(requireHabitatAccess);
    }
  });
});

describe('GET /habitats/:habitatId/rules handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns current rules', async () => {
    const routes = capturePrioritizationRoutes();
    const getRules = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/rules');
    const { getPrioritizationRules } = await import('../services/prioritizationService.js');

    const reply: any = {};
    const result = await getRules!.handler({ params: { habitatId: 'habitat-1' } } as any, reply);
    expect(getPrioritizationRules).toHaveBeenCalledWith('habitat-1');
    expect(result).toHaveProperty('rules');
  });
});

describe('PUT /habitats/:habitatId/rules handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('saves prioritization rules to habitat settings', async () => {
    const routes = capturePrioritizationRoutes();
    const putRules = routes.find(r => r.method === 'PUT' && r.path === '/habitats/:habitatId/rules');
    const { updateHabitat } = await import('../repositories/board.js');

    const newRules = {
      enabled: true,
      evaluateIntervalMinutes: 10,
      rules: [{
        id: 'rule-1',
        name: 'Test Rule',
        enabled: true,
        condition: { type: 'overdue' },
        action: { type: 'set_priority', value: 'critical' },
        priority: 1,
      }],
      fallbackToManual: false,
    };

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await putRules!.handler({ params: { habitatId: 'habitat-1' }, body: newRules } as any, reply);
    expect(updateHabitat).toHaveBeenCalledWith('habitat-1', { prioritizationSettings: expect.objectContaining(newRules) });
  });

  it('returns 400 for invalid payload', async () => {
    const routes = capturePrioritizationRoutes();
    const putRules = routes.find(r => r.method === 'PUT' && r.path === '/habitats/:habitatId/rules');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await putRules!.handler({ params: { habitatId: 'habitat-1' }, body: { rules: 'invalid' } } as any, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rule has missing fields', async () => {
    const routes = capturePrioritizationRoutes();
    const putRules = routes.find(r => r.method === 'PUT' && r.path === '/habitats/:habitatId/rules');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await putRules!.handler({
      params: { habitatId: 'habitat-1' },
      body: {
        rules: [{
          completely: 'wrong',
          structure: true,
        }],
      },
    } as any, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rule condition has invalid type', async () => {
    const routes = capturePrioritizationRoutes();
    const putRules = routes.find(r => r.method === 'PUT' && r.path === '/habitats/:habitatId/rules');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await putRules!.handler({
      params: { habitatId: 'habitat-1' },
      body: {
        rules: [{
          id: 'r-1',
          name: 'Bad Rule',
          enabled: true,
          condition: { type: 'nonexistent_type' },
          action: { type: 'set_priority', value: 'high' },
          priority: 1,
        }],
      },
    } as any, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when rule action has mismatched value type', async () => {
    const routes = capturePrioritizationRoutes();
    const putRules = routes.find(r => r.method === 'PUT' && r.path === '/habitats/:habitatId/rules');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await putRules!.handler({
      params: { habitatId: 'habitat-1' },
      body: {
        rules: [{
          id: 'r-1',
          name: 'Bad Action',
          enabled: true,
          condition: { type: 'overdue' },
          action: { type: 'bump_priority', value: 'not-a-number' },
          priority: 1,
        }],
      },
    } as any, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('accepts rules with recursive and condition', async () => {
    const routes = capturePrioritizationRoutes();
    const putRules = routes.find(r => r.method === 'PUT' && r.path === '/habitats/:habitatId/rules');
    const { updateHabitat } = await import('../repositories/board.js');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await putRules!.handler({
      params: { habitatId: 'habitat-1' },
      body: {
        enabled: true,
        rules: [{
          id: 'r-1',
          name: 'Composite Rule',
          enabled: true,
          condition: {
            type: 'and',
            conditions: [
              { type: 'overdue', byDays: 3 },
              { type: 'priority_is', priority: 'high' },
            ],
          },
          action: { type: 'set_priority', value: 'critical' },
          priority: 10,
        }],
      },
    } as any, reply);
    expect(updateHabitat).toHaveBeenCalled();
  });
});

describe('POST /habitats/:habitatId/rules/evaluate handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('triggers evaluation and returns results', async () => {
    const routes = capturePrioritizationRoutes();
    const evaluate = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/rules/evaluate');
    const { applyPrioritization } = await import('../services/prioritizationService.js');

    const reply: any = {};
    const result = await evaluate!.handler({ params: { habitatId: 'habitat-1' } } as any, reply);
    expect(applyPrioritization).toHaveBeenCalledWith('habitat-1');
    expect(result).toHaveProperty('evaluation');
  });
});

describe('GET /habitats/:habitatId/priority-report handler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns distribution counts with default limit', async () => {
    const routes = capturePrioritizationRoutes();
    const report = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/priority-report');
    const { getTasksByHabitatId } = await import('../repositories/task.js');

    (getTasksByHabitatId as any).mockReturnValue({
      tasks: [
        { id: 't1', priority: 'high' },
        { id: 't2', priority: 'high' },
        { id: 't3', priority: 'low' },
      ],
      total: 3,
    });

    const reply: any = {};
    const result = await report!.handler({ params: { habitatId: 'habitat-1' }, query: {} } as any, reply);
    expect(getTasksByHabitatId).toHaveBeenCalledWith('habitat-1', { limit: 500 });
    expect(result).toEqual({
      habitatId: 'habitat-1',
      totalTasks: 3,
      distribution: { high: 2, low: 1 },
      ruleHits: {},
      lastEvaluatedAt: expect.any(String),
    });
  });

  it('forwards custom limit to getTasksByHabitatId', async () => {
    const routes = capturePrioritizationRoutes();
    const report = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/priority-report');
    const { getTasksByHabitatId } = await import('../repositories/task.js');

    (getTasksByHabitatId as any).mockReturnValue({ tasks: [], total: 0 });

    const reply: any = {};
    await report!.handler({ params: { habitatId: 'habitat-1' }, query: { limit: '100' } } as any, reply);
    expect(getTasksByHabitatId).toHaveBeenCalledWith('habitat-1', { limit: 100 });
  });

  it('clamps limit to max of 2000', async () => {
    const routes = capturePrioritizationRoutes();
    const report = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/priority-report');
    const { getTasksByHabitatId } = await import('../repositories/task.js');

    (getTasksByHabitatId as any).mockReturnValue({ tasks: [], total: 0 });

    const reply: any = {};
    await report!.handler({ params: { habitatId: 'habitat-1' }, query: { limit: '99999' } } as any, reply);
    expect(getTasksByHabitatId).toHaveBeenCalledWith('habitat-1', { limit: 2000 });
  });
});
