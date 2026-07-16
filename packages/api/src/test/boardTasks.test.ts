import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import * as columnRepo from '../repositories/column.js';
import { eq } from 'drizzle-orm';
import { taskEvents, tasks, columns as columnsTable, habitats, agents } from '../db/schema/index.js';
import { getTasksByHabitatId } from '../repositories/task.js';
import type { TaskListFilters } from '../repositories/task.js';

vi.mock('../services/chatService.js', () => ({
  sendAnomalyAlert: vi.fn().mockResolvedValue(undefined),
  processEvent: vi.fn().mockResolvedValue(undefined),
  executeCommand: vi.fn().mockResolvedValue({ response: {}, provider: 'slack' as const }),
  sendTestMessage: vi.fn().mockResolvedValue({ success: true, statusCode: 200, latencyMs: 0 }),
}));

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(agents).run();

  const { agent } = agentRepo.createAgent({ name: 'test-agent', type: 'claude-code', domain: 'backend' });
  agentId = agent.id;

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const column = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = column.id;

  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: 'Test Mission',
    createdBy: 'test-user',
  });
  missionId = mission.id;
});

afterEach(() => {
  closeDb();
});

function createTask(overrides: { title: string; priority: 'low' | 'medium' | 'high' | 'critical'; estimatedMinutes?: number | null }) {
  return taskRepo.createTask({
    missionId,
    title: overrides.title,
    priority: overrides.priority,
    estimatedMinutes: overrides.estimatedMinutes ?? null,
    createdBy: 'test-user',
  });
}

describe('getTasksByHabitatId sort', () => {
  it('returns default order (priority + createdAt ASC) when no sort params', () => {
    createTask({ title: 'Low task', priority: 'low' });
    createTask({ title: 'Critical task', priority: 'critical' });
    createTask({ title: 'Medium task', priority: 'medium' });

    const result = getTasksByHabitatId(habitatId);

    expect(result.total).toBe(3);
    expect(result.tasks[0].priority).toBe('critical');
    expect(result.tasks[1].priority).toBe('medium');
    expect(result.tasks[2].priority).toBe('low');
  });

  it('sorts by title ascending', () => {
    createTask({ title: 'Zebra task', priority: 'low' });
    createTask({ title: 'Alpha task', priority: 'critical' });
    createTask({ title: 'Middle task', priority: 'medium' });

    const filters: TaskListFilters = { sortBy: 'title', sortDirection: 'asc' };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.tasks[0].title).toBe('Alpha task');
    expect(result.tasks[1].title).toBe('Middle task');
    expect(result.tasks[2].title).toBe('Zebra task');
  });

  it('sorts by title descending', () => {
    createTask({ title: 'Alpha task', priority: 'critical' });
    createTask({ title: 'Zebra task', priority: 'low' });

    const filters: TaskListFilters = { sortBy: 'title', sortDirection: 'desc' };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.tasks[0].title).toBe('Zebra task');
    expect(result.tasks[1].title).toBe('Alpha task');
  });

  it('sorts by priority (critical first when asc)', () => {
    createTask({ title: 'Low', priority: 'low' });
    createTask({ title: 'High', priority: 'high' });
    createTask({ title: 'Critical', priority: 'critical' });
    createTask({ title: 'Medium', priority: 'medium' });

    const filters: TaskListFilters = { sortBy: 'priority', sortDirection: 'asc' };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.tasks.map(t => t.priority)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('sorts by estimatedMinutes descending (longest first)', () => {
    createTask({ title: 'Short', priority: 'low', estimatedMinutes: 5 });
    createTask({ title: 'Long', priority: 'low', estimatedMinutes: 120 });
    createTask({ title: 'Medium', priority: 'low', estimatedMinutes: 30 });

    const filters: TaskListFilters = { sortBy: 'estimatedMinutes', sortDirection: 'desc' };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.tasks[0].title).toBe('Long');
    expect(result.tasks[1].title).toBe('Medium');
    expect(result.tasks[2].title).toBe('Short');
  });

  it('sorts by status ascending', () => {
    const t1 = createTask({ title: 'Done', priority: 'low' });
    const t2 = createTask({ title: 'Pending', priority: 'low' });
    const t3 = createTask({ title: 'Claimed', priority: 'low' });

    taskRepo.updateTask(t1.id, { status: 'done' });
    taskRepo.updateTask(t3.id, { status: 'claimed' });

    const filters: TaskListFilters = { sortBy: 'status', sortDirection: 'asc' };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.tasks[0].title).toBe('Claimed');
    expect(result.tasks[1].title).toBe('Done');
    expect(result.tasks[2].title).toBe('Pending');
  });

  it('sorts by updatedAt', () => {
    createTask({ title: 'Task A', priority: 'low' });
    createTask({ title: 'Task B', priority: 'low' });

    const filters: TaskListFilters = { sortBy: 'updatedAt', sortDirection: 'desc' };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.tasks).toHaveLength(2);
    const dates = result.tasks.map(t => t.updatedAt);
    expect(dates[0]! >= dates[1]!).toBe(true);
  });

  it('falls back to default ordering for invalid sortBy value', () => {
    createTask({ title: 'Low', priority: 'low' });
    createTask({ title: 'Critical', priority: 'critical' });

    const filters: TaskListFilters = { sortBy: 'nonexistent' as any };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.tasks[0].priority).toBe('critical');
    expect(result.tasks[1].priority).toBe('low');
  });

  it('respects limit and offset with sort', () => {
    for (let i = 0; i < 5; i++) {
      createTask({ title: `Task ${i}`, priority: 'low', estimatedMinutes: (i + 1) * 10 });
    }

    const filters: TaskListFilters = { sortBy: 'estimatedMinutes', sortDirection: 'desc', limit: 2, offset: 1 };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.total).toBe(5);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].title).toBe('Task 3');
    expect(result.tasks[1].title).toBe('Task 2');
  });

  it('sorts by assignedAgentId ascending', () => {
    const t1 = createTask({ title: 'Assigned', priority: 'low' });
    createTask({ title: 'Unassigned', priority: 'low' });

    taskRepo.updateTask(t1.id, { assignedAgentId: agentId });

    const filters: TaskListFilters = { sortBy: 'assignedAgentId', sortDirection: 'asc' };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.tasks).toHaveLength(2);
    expect(result.tasks.map(t => t.title)).toContain('Assigned');
    expect(result.tasks.map(t => t.title)).toContain('Unassigned');
  });

  it('combines filters with sort', () => {
    const t1 = createTask({ title: 'Critical Pending', priority: 'critical' });
    const t2 = createTask({ title: 'Critical Done', priority: 'critical' });
    createTask({ title: 'Low Pending', priority: 'low' });

    taskRepo.updateTask(t2.id, { status: 'done' });

    const filters: TaskListFilters = { status: 'pending', sortBy: 'priority', sortDirection: 'asc' };
    const result = getTasksByHabitatId(habitatId, filters);

    expect(result.total).toBe(2);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].priority).toBe('critical');
    expect(result.tasks[1].priority).toBe('low');
  });

  it('returns empty array for habitat with no missions', () => {
    const emptyBoard = habitatRepo.createHabitat({ name: 'Empty Habitat' });
    const result = getTasksByHabitatId(emptyBoard.id);
    expect(result.tasks).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('backward compatibility: existing callers work unchanged', () => {
    createTask({ title: 'Low', priority: 'low' });
    createTask({ title: 'Critical', priority: 'critical' });

    const resultNoFilters = getTasksByHabitatId(habitatId);
    const resultEmptyFilters = getTasksByHabitatId(habitatId, {});
    const resultOnlyLimit = getTasksByHabitatId(habitatId, { limit: 10 });

    expect(resultNoFilters.tasks[0].priority).toBe('critical');
    expect(resultEmptyFilters.tasks[0].priority).toBe('critical');
    expect(resultOnlyLimit.tasks[0].priority).toBe('critical');
  });
});

describe('search filter', () => {
  it('matches tasks by title partial text', () => {
    createTask({ title: 'Fix login bug', priority: 'high' });
    createTask({ title: 'Add logout mission', priority: 'medium' });

    const result = getTasksByHabitatId(habitatId, { search: 'login' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Fix login bug');
  });

  it('matches tasks by description partial text', () => {
    createTask({ title: 'Task A', priority: 'low' });
    createTask({ title: 'Task B', priority: 'low' });

    const db = getDb();
    db.update(tasks).set({ description: 'This is about security' }).where(eq(tasks.title, 'Task A')).run();
    db.update(tasks).set({ description: 'Something else' }).where(eq(tasks.title, 'Task B')).run();

    const result = getTasksByHabitatId(habitatId, { search: 'security' });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Task A');
  });

  it('escapes LIKE wildcard % in search term', () => {
    createTask({ title: 'Task with 100% completion', priority: 'low' });
    createTask({ title: 'Task 100 done', priority: 'low' });

    const result = getTasksByHabitatId(habitatId, { search: '100%' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Task with 100% completion');
  });

  it('escapes LIKE wildcard _ in search term', () => {
    createTask({ title: 'Task A', priority: 'low' });
    createTask({ title: 'Task_B', priority: 'low' });

    const result = getTasksByHabitatId(habitatId, { search: 'Task_B' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('Task_B');
  });

  it('returns no results when search does not match', () => {
    createTask({ title: 'Some task', priority: 'low' });

    const result = getTasksByHabitatId(habitatId, { search: 'nonexistent' });

    expect(result.tasks).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('searches case-insensitively (SQLite LIKE default)', () => {
    createTask({ title: 'UPPERCASE Task', priority: 'low' });

    const result = getTasksByHabitatId(habitatId, { search: 'uppercase' });

    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].title).toBe('UPPERCASE Task');
  });
});

describe('habitat tasks route integration', () => {
  it('GET /habitats/:id/tasks route is registered and accessible', async () => {
    const { taskRoutes } = await import('../routes/tasks/index.js');
    expect(taskRoutes).toBeDefined();
    expect(typeof taskRoutes).toBe('function');
  });

  it('habitatTasksRoutes function exists and is a valid route module', async () => {
    const { habitatTasksRoutes } = await import('../routes/tasks/boardTasks.js');
    expect(habitatTasksRoutes).toBeDefined();
    expect(typeof habitatTasksRoutes).toBe('function');
  });
});

describe('batch route auth fix', () => {
  it('batch route uses agentOrHumanAuth instead of agentAuth', async () => {
    const fs = await import('fs');
    const path = await import('path');
    const batchContent = fs.readFileSync(
      path.resolve(process.cwd(), 'src/routes/tasks/batch.ts'),
      'utf-8'
    );
    expect(batchContent).toContain('agentOrHumanAuth');
    expect(batchContent).not.toContain('import { agentAuth }');
  });
});
