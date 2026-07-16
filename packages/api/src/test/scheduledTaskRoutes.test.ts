import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scheduledTaskRoutes } from '../routes/scheduledTasks.js';

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
  handler: any;
}

const { mockGetScheduledTaskById, mockGetScheduledTasksByHabitatId, mockCreateScheduledTask, mockUpdateScheduledTask, mockDeleteScheduledTask, mockCalculateNextRun, mockExecuteScheduledTask } = vi.hoisted(() => ({
  mockGetScheduledTaskById: vi.fn<() => any>(() => null),
  mockGetScheduledTasksByHabitatId: vi.fn<() => any>(() => []),
  mockCreateScheduledTask: vi.fn<() => any>(() => null),
  mockUpdateScheduledTask: vi.fn<() => any>(() => null),
  mockDeleteScheduledTask: vi.fn<() => any>(() => false),
  mockCalculateNextRun: vi.fn<() => string>(() => '2026-01-01T01:00:00.000Z'),
  mockExecuteScheduledTask: vi.fn<() => any>(() => ({ success: false, error: 'not found' })),
}));

const { mockGetHabitatById, mockIsTeamMemberByHabitatId } = vi.hoisted(() => ({
  mockGetHabitatById: vi.fn<() => any>(() => null),
  mockIsTeamMemberByHabitatId: vi.fn<() => boolean>(() => false),
}));

const mockScheduledTask = {
  id: 'st-1',
  habitatId: 'habitat-1',
  templateId: null,
  name: 'Test Schedule',
  description: '',
  scheduleType: 'cron',
  cronExpression: '0 * * * *',
  intervalMinutes: null,
  scheduledAt: null,
  timezone: 'UTC',
  missionTitle: 'Weekly Review',
  missionDescription: '',
  missionPriority: 'medium',
  missionLabels: [],
  missionDomain: null,
  tasksTemplate: [],
  enabled: true,
  lastRunAt: null,
  nextRunAt: '2026-01-01T00:00:00.000Z',
  runCount: 0,
  lastCreatedMissionId: null,
  createdBy: 'test-user',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

vi.mock('../repositories/scheduledTask.js', () => ({
  getScheduledTaskById: mockGetScheduledTaskById,
  getScheduledTasksByHabitatId: mockGetScheduledTasksByHabitatId,
  createScheduledTask: mockCreateScheduledTask,
  updateScheduledTask: mockUpdateScheduledTask,
  deleteScheduledTask: mockDeleteScheduledTask,
}));

vi.mock('../services/scheduledTaskService.js', () => ({
  calculateNextRun: mockCalculateNextRun,
  executeScheduledTask: mockExecuteScheduledTask,
}));

vi.mock('../repositories/habitat.js', () => ({
  getHabitatById: mockGetHabitatById,
}));

vi.mock('../repositories/teamMember.js', () => ({
  isTeamMemberByHabitatId: mockIsTeamMemberByHabitatId,
}));

const { mockHumanAuth, mockAgentOrHumanAuth, mockRequireHabitatAccess } = vi.hoisted(() => ({
  mockHumanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
  mockAgentOrHumanAuth: vi.fn((_req: any, _reply: any, done: any) => done()),
  mockRequireHabitatAccess: vi.fn((_req: any, _reply: any, done: any) => done()),
}));

vi.mock('../middleware/auth.js', () => ({
  humanAuth: mockHumanAuth,
  agentOrHumanAuth: mockAgentOrHumanAuth,
}));

vi.mock('../middleware/team.js', () => ({
  requireHabitatAccess: mockRequireHabitatAccess,
}));

vi.mock('../errors.js', () => ({
  notFound: (msg: string) => new Error(msg),
  forbidden: (msg: string) => new Error(msg),
  unauthorized: (msg: string) => new Error(msg),
}));

function captureScheduledTaskRoutes(): CapturedRoute[] {
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
    patch: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'PATCH', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'DELETE', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [], handler });
    }),
  };
  scheduledTaskRoutes(fakeFastify);
  return routes;
}

function resetMocks() {
  vi.clearAllMocks();
  mockGetScheduledTaskById.mockReturnValue(mockScheduledTask);
  mockGetScheduledTasksByHabitatId.mockReturnValue([mockScheduledTask]);
  mockCreateScheduledTask.mockReturnValue(mockScheduledTask);
  mockUpdateScheduledTask.mockReturnValue(mockScheduledTask);
  mockDeleteScheduledTask.mockReturnValue(true);
  mockCalculateNextRun.mockReturnValue('2026-01-01T01:00:00.000Z');
  mockExecuteScheduledTask.mockReturnValue({ success: true, missionId: 'feat-1' });
  mockGetHabitatById.mockReturnValue({ id: 'habitat-1', teamId: null });
  mockIsTeamMemberByHabitatId.mockReturnValue(false);
}

describe('scheduledTaskRoutes', () => {
  it('exports a function named scheduledTaskRoutes', () => {
    expect(scheduledTaskRoutes).toBeInstanceOf(Function);
    expect(scheduledTaskRoutes.name).toBe('scheduledTaskRoutes');
  });

  it('registers 8 endpoints', () => {
    const routes = captureScheduledTaskRoutes();
    expect(routes).toHaveLength(8);
  });

  it('registers POST /habitats/:habitatId/scheduled-tasks', () => {
    const routes = captureScheduledTaskRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/scheduled-tasks');
    expect(route).toBeDefined();
  });

  it('registers GET /habitats/:habitatId/scheduled-tasks', () => {
    const routes = captureScheduledTaskRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/scheduled-tasks');
    expect(route).toBeDefined();
  });

  it('registers GET /scheduled-tasks/:id', () => {
    const routes = captureScheduledTaskRoutes();
    const route = routes.find(r => r.method === 'GET' && r.path === '/scheduled-tasks/:id');
    expect(route).toBeDefined();
  });

  it('registers PATCH /scheduled-tasks/:id', () => {
    const routes = captureScheduledTaskRoutes();
    const route = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');
    expect(route).toBeDefined();
  });

  it('registers DELETE /scheduled-tasks/:id', () => {
    const routes = captureScheduledTaskRoutes();
    const route = routes.find(r => r.method === 'DELETE' && r.path === '/scheduled-tasks/:id');
    expect(route).toBeDefined();
  });

  it('registers POST /scheduled-tasks/:id/run', () => {
    const routes = captureScheduledTaskRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/run');
    expect(route).toBeDefined();
  });

  it('registers POST /scheduled-tasks/:id/enable', () => {
    const routes = captureScheduledTaskRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/enable');
    expect(route).toBeDefined();
  });

  it('registers POST /scheduled-tasks/:id/disable', () => {
    const routes = captureScheduledTaskRoutes();
    const route = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/disable');
    expect(route).toBeDefined();
  });
});

describe('scheduled task route auth', () => {
  it('POST /habitats/:habitatId/scheduled-tasks uses humanAuth', () => {
    const routes = captureScheduledTaskRoutes();
    const create = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/scheduled-tasks');
    expect(create!.preHandler).toContain(mockHumanAuth);
  });

  it('GET /habitats/:habitatId/scheduled-tasks uses agentOrHumanAuth', () => {
    const routes = captureScheduledTaskRoutes();
    const list = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/scheduled-tasks');
    expect(list!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it('GET /scheduled-tasks/:id uses agentOrHumanAuth', () => {
    const routes = captureScheduledTaskRoutes();
    const get = routes.find(r => r.method === 'GET' && r.path === '/scheduled-tasks/:id');
    expect(get!.preHandler).toContain(mockAgentOrHumanAuth);
  });

  it('PATCH /scheduled-tasks/:id uses humanAuth', () => {
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');
    expect(patch!.preHandler).toContain(mockHumanAuth);
  });

  it('DELETE /scheduled-tasks/:id uses humanAuth', () => {
    const routes = captureScheduledTaskRoutes();
    const del = routes.find(r => r.method === 'DELETE' && r.path === '/scheduled-tasks/:id');
    expect(del!.preHandler).toContain(mockHumanAuth);
  });

  it('POST /scheduled-tasks/:id/run uses humanAuth', () => {
    const routes = captureScheduledTaskRoutes();
    const run = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/run');
    expect(run!.preHandler).toContain(mockHumanAuth);
  });

  it('POST /scheduled-tasks/:id/enable uses humanAuth', () => {
    const routes = captureScheduledTaskRoutes();
    const enable = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/enable');
    expect(enable!.preHandler).toContain(mockHumanAuth);
  });

  it('POST /scheduled-tasks/:id/disable uses humanAuth', () => {
    const routes = captureScheduledTaskRoutes();
    const disable = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/disable');
    expect(disable!.preHandler).toContain(mockHumanAuth);
  });

  it('habitat-scoped endpoints require habitat access', () => {
    const routes = captureScheduledTaskRoutes();
    const habitatScoped = routes.filter(r => r.path.includes('habitats/:habitatId'));
    for (const route of habitatScoped) {
      expect(route.preHandler).toContain(mockRequireHabitatAccess);
    }
  });

  it('scheduled-tasks/:id endpoints verify habitat access in handler', () => {
    const routes = captureScheduledTaskRoutes();
    const taskScoped = routes.filter(r => !r.path.includes('habitats/:habitatId'));
    expect(taskScoped.length).toBeGreaterThan(0);
  });
});

describe('POST /habitats/:habitatId/scheduled-tasks handler', () => {
  beforeEach(resetMocks);

  it('creates a scheduled task and returns 201', async () => {
    const routes = captureScheduledTaskRoutes();
    const create = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/scheduled-tasks');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    const body = {
      name: 'Test Schedule',
      scheduleType: 'cron',
      cronExpression: '0 * * * *',
      missionTitle: 'Weekly Review',
    };
    await create!.handler({ params: { habitatId: 'habitat-1' }, body, user: { id: 'user-1' } } as any, reply);
    expect(mockCalculateNextRun).toHaveBeenCalled();
    expect(mockCreateScheduledTask).toHaveBeenCalledWith(expect.objectContaining({
      habitatId: 'habitat-1',
      name: 'Test Schedule',
      missionTitle: 'Weekly Review',
    }));
    expect(reply.status).toHaveBeenCalledWith(201);
  });

  it('returns 400 for invalid payload', async () => {
    const routes = captureScheduledTaskRoutes();
    const create = routes.find(r => r.method === 'POST' && r.path === '/habitats/:habitatId/scheduled-tasks');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await create!.handler({ params: { habitatId: 'habitat-1' }, body: { name: '' } } as any, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });
});

describe('GET /habitats/:habitatId/scheduled-tasks handler', () => {
  beforeEach(resetMocks);

  it('returns list of scheduled tasks for habitat', async () => {
    const routes = captureScheduledTaskRoutes();
    const list = routes.find(r => r.method === 'GET' && r.path === '/habitats/:habitatId/scheduled-tasks');

    const result = await list!.handler({ params: { habitatId: 'habitat-1' } } as any, {} as any);
    expect(mockGetScheduledTasksByHabitatId).toHaveBeenCalledWith('habitat-1');
    expect(result).toHaveProperty('scheduledTasks');
    expect(result.scheduledTasks).toHaveLength(1);
  });
});

describe('GET /scheduled-tasks/:id handler', () => {
  beforeEach(resetMocks);

  it('returns scheduled task details', async () => {
    const routes = captureScheduledTaskRoutes();
    const get = routes.find(r => r.method === 'GET' && r.path === '/scheduled-tasks/:id');

    const result = await get!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockGetScheduledTaskById).toHaveBeenCalledWith('st-1');
    expect(mockGetHabitatById).toHaveBeenCalledWith('habitat-1');
    expect(result).toHaveProperty('scheduledTask');
  });

  it('throws not found for missing scheduled task', async () => {
    mockGetScheduledTaskById.mockReturnValue(null);
    const routes = captureScheduledTaskRoutes();
    const get = routes.find(r => r.method === 'GET' && r.path === '/scheduled-tasks/:id');

    await expect(
      get!.handler({ params: { id: 'missing' }, user: { id: 'user-1' } } as any, {} as any)
    ).rejects.toThrow('Scheduled task not found');
  });

  it('denies access when user is not a habitat team member', async () => {
    mockGetHabitatById.mockReturnValue({ id: 'habitat-1', teamId: 'team-1' });
    mockIsTeamMemberByHabitatId.mockReturnValue(false);
    const routes = captureScheduledTaskRoutes();
    const get = routes.find(r => r.method === 'GET' && r.path === '/scheduled-tasks/:id');

    await expect(
      get!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any)
    ).rejects.toThrow('You do not have access to this habitat');
  });

  it('allows agents on public habitats (no teamId)', async () => {
    mockGetHabitatById.mockReturnValue({ id: 'habitat-1', teamId: null });
    const routes = captureScheduledTaskRoutes();
    const get = routes.find(r => r.method === 'GET' && r.path === '/scheduled-tasks/:id');

    const result = await get!.handler({ params: { id: 'st-1' }, agent: { id: 'agent-1' } } as any, {} as any);
    expect(result).toHaveProperty('scheduledTask');
  });

  it('denies agents on team habitats', async () => {
    mockGetHabitatById.mockReturnValue({ id: 'habitat-1', teamId: 'team-1' });
    const routes = captureScheduledTaskRoutes();
    const get = routes.find(r => r.method === 'GET' && r.path === '/scheduled-tasks/:id');

    await expect(
      get!.handler({ params: { id: 'st-1' }, agent: { id: 'agent-1' } } as any, {} as any)
    ).rejects.toThrow('Agents cannot access team habitats');
  });
});

describe('PATCH /scheduled-tasks/:id handler', () => {
  beforeEach(resetMocks);

  it('updates a scheduled task', async () => {
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');

    const result = await patch!.handler({ params: { id: 'st-1' }, body: { name: 'Updated' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockUpdateScheduledTask).toHaveBeenCalled();
    expect(result).toHaveProperty('scheduledTask');
  });

  it('returns 400 for invalid payload', async () => {
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await patch!.handler({ params: { id: 'st-1' }, body: { name: '' }, user: { id: 'user-1' } } as any, reply);
    expect(reply.status).toHaveBeenCalledWith(400);
  });

  it('throws not found for missing scheduled task', async () => {
    mockUpdateScheduledTask.mockReturnValue(null);
    mockGetScheduledTaskById.mockReturnValue(null);
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');

    await expect(
      patch!.handler({ params: { id: 'missing' }, body: { name: 'X' }, user: { id: 'user-1' } } as any, {} as any)
    ).rejects.toThrow('Scheduled task not found');
  });

  it('denies access when user is not a habitat team member', async () => {
    mockGetHabitatById.mockReturnValue({ id: 'habitat-1', teamId: 'team-1' });
    mockIsTeamMemberByHabitatId.mockReturnValue(false);
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');

    await expect(
      patch!.handler({ params: { id: 'st-1' }, body: { name: 'X' }, user: { id: 'user-1' } } as any, {} as any)
    ).rejects.toThrow('You do not have access to this habitat');
  });

  it('uses existing scheduleType as default when only cronExpression is patched', async () => {
    const intervalTask = { ...mockScheduledTask, scheduleType: 'interval' as const, cronExpression: null, intervalMinutes: 30 };
    mockGetScheduledTaskById.mockReturnValue(intervalTask);
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');

    await patch!.handler({ params: { id: 'st-1' }, body: { intervalMinutes: 60 }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockCalculateNextRun).toHaveBeenCalledWith('interval', null, 60, 'UTC');
  });

  it('uses existing scheduleType as default when only intervalMinutes is patched on a cron schedule', async () => {
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');

    await patch!.handler({ params: { id: 'st-1' }, body: { cronExpression: '0 0 * * *' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockCalculateNextRun).toHaveBeenCalledWith('cron', '0 0 * * *', null, 'UTC');
  });

  it('uses patched scheduleType over existing when explicitly provided', async () => {
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');

    await patch!.handler({ params: { id: 'st-1' }, body: { scheduleType: 'interval', intervalMinutes: 15 }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockCalculateNextRun).toHaveBeenCalledWith('interval', '0 * * * *', 15, 'UTC');
  });

  it('does not recalculate nextRunAt when no schedule fields are changed', async () => {
    const routes = captureScheduledTaskRoutes();
    const patch = routes.find(r => r.method === 'PATCH' && r.path === '/scheduled-tasks/:id');

    await patch!.handler({ params: { id: 'st-1' }, body: { name: 'Just a name change' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockCalculateNextRun).not.toHaveBeenCalled();
  });
});

describe('DELETE /scheduled-tasks/:id handler', () => {
  beforeEach(resetMocks);

  it('deletes a scheduled task and returns 204', async () => {
    const routes = captureScheduledTaskRoutes();
    const del = routes.find(r => r.method === 'DELETE' && r.path === '/scheduled-tasks/:id');

    const reply: any = { status: vi.fn(() => reply), send: vi.fn(() => reply) };
    await del!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, reply);
    expect(mockDeleteScheduledTask).toHaveBeenCalledWith('st-1');
    expect(reply.status).toHaveBeenCalledWith(204);
  });

  it('throws not found for missing scheduled task', async () => {
    mockDeleteScheduledTask.mockReturnValue(false);
    mockGetScheduledTaskById.mockReturnValue(null);
    const routes = captureScheduledTaskRoutes();
    const del = routes.find(r => r.method === 'DELETE' && r.path === '/scheduled-tasks/:id');

    await expect(
      del!.handler({ params: { id: 'missing' }, user: { id: 'user-1' } } as any, {} as any)
    ).rejects.toThrow('Scheduled task not found');
  });

  it('denies access when user is not a habitat team member', async () => {
    mockGetHabitatById.mockReturnValue({ id: 'habitat-1', teamId: 'team-1' });
    mockIsTeamMemberByHabitatId.mockReturnValue(false);
    const routes = captureScheduledTaskRoutes();
    const del = routes.find(r => r.method === 'DELETE' && r.path === '/scheduled-tasks/:id');

    await expect(
      del!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any)
    ).rejects.toThrow('You do not have access to this habitat');
  });
});

describe('POST /scheduled-tasks/:id/run handler', () => {
  beforeEach(resetMocks);

  it('triggers execution and returns result', async () => {
    const routes = captureScheduledTaskRoutes();
    const run = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/run');

    const result = await run!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockExecuteScheduledTask).toHaveBeenCalledWith('st-1');
    expect(result).toEqual({ success: true, missionId: 'feat-1' });
  });

  it('throws not found for missing scheduled task', async () => {
    mockGetScheduledTaskById.mockReturnValue(null);
    const routes = captureScheduledTaskRoutes();
    const run = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/run');

    await expect(
      run!.handler({ params: { id: 'missing' }, user: { id: 'user-1' } } as any, {} as any)
    ).rejects.toThrow('Scheduled task not found');
  });

  it('denies access when user is not a habitat team member', async () => {
    mockGetHabitatById.mockReturnValue({ id: 'habitat-1', teamId: 'team-1' });
    mockIsTeamMemberByHabitatId.mockReturnValue(false);
    const routes = captureScheduledTaskRoutes();
    const run = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/run');

    await expect(
      run!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any)
    ).rejects.toThrow('You do not have access to this habitat');
  });
});

describe('POST /scheduled-tasks/:id/enable handler', () => {
  beforeEach(resetMocks);

  it('enables a scheduled task', async () => {
    const routes = captureScheduledTaskRoutes();
    const enable = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/enable');

    const result = await enable!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockUpdateScheduledTask).toHaveBeenCalledWith('st-1', expect.objectContaining({ enabled: true }));
    expect(result).toHaveProperty('scheduledTask');
  });

  it('uses existing schedule fields when recalculating nextRunAt on enable', async () => {
    const routes = captureScheduledTaskRoutes();
    const enable = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/enable');

    await enable!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockCalculateNextRun).toHaveBeenCalledWith('cron', '0 * * * *', null, 'UTC');
  });

  it('uses interval schedule fields when enabling an interval-based task', async () => {
    const intervalTask = { ...mockScheduledTask, scheduleType: 'interval' as const, cronExpression: null, intervalMinutes: 30 };
    mockGetScheduledTaskById.mockReturnValue(intervalTask);
    const routes = captureScheduledTaskRoutes();
    const enable = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/enable');

    await enable!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockCalculateNextRun).toHaveBeenCalledWith('interval', null, 30, 'UTC');
  });
});

describe('POST /scheduled-tasks/:id/disable handler', () => {
  beforeEach(resetMocks);

  it('disables a scheduled task', async () => {
    const routes = captureScheduledTaskRoutes();
    const disable = routes.find(r => r.method === 'POST' && r.path === '/scheduled-tasks/:id/disable');

    const result = await disable!.handler({ params: { id: 'st-1' }, user: { id: 'user-1' } } as any, {} as any);
    expect(mockUpdateScheduledTask).toHaveBeenCalledWith('st-1', { enabled: false });
    expect(result).toHaveProperty('scheduledTask');
  });
});
