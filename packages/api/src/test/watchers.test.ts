import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/index.js', () => ({
  getDb: vi.fn(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('../db/schema/index.js', () => ({
  taskWatchers: {},
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn(),
  and: vi.fn(),
  asc: vi.fn(),
  desc: vi.fn(),
}));

describe('TaskWatcher types', () => {
  it('TaskWatcher interface has correct shape', async () => {
    type T = import('../models/index.js').TaskWatcher;
    const watcher: T = {
      taskId: 'task-1',
      userId: 'user-1',
      createdAt: '2026-04-10T00:00:00Z',
    };
    expect(watcher.taskId).toBe('task-1');
    expect(watcher.userId).toBe('user-1');
    expect(watcher.createdAt).toBe('2026-04-10T00:00:00Z');
  });
});

describe('watcherSchemas', () => {
  it('taskIdParamSchema validates UUID', async () => {
    const { taskIdParamSchema } = await import('../models/watcherSchemas.js');
    const result = taskIdParamSchema.safeParse({ id: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('taskIdParamSchema accepts valid UUID', async () => {
    const { taskIdParamSchema } = await import('../models/watcherSchemas.js');
    const result = taskIdParamSchema.safeParse({ id: '550e8400-e29b-41d4-a716-446655440000' });
    expect(result.success).toBe(true);
  });
});
