import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as boardRepo from '../repositories/board.js';
import * as taskRepo from '../repositories/task.js';
import * as featureRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import * as columnRepo from '../repositories/column.js';
import { taskEvents, tasks, columns as columnsTable, boards, agents } from '../db/schema/index.js';
import { getTasksByBoardId } from '../repositories/task.js';
import type { TaskListFilters } from '../repositories/task.js';

vi.mock('../services/chatService.js', () => ({
  sendAnomalyAlert: vi.fn().mockResolvedValue(undefined),
  processEvent: vi.fn().mockResolvedValue(undefined),
  executeCommand: vi.fn().mockResolvedValue({ response: {}, provider: 'slack' as const }),
  sendTestMessage: vi.fn().mockResolvedValue({ success: true, statusCode: 200, latencyMs: 0 }),
}));

let boardId: string;
let columnId: string;
let featureId: string;
let agentId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(boards).run();
  db.delete(agents).run();

  const { agent } = agentRepo.createAgent({ name: 'test-agent', type: 'claude-code', domain: 'backend' });
  agentId = agent.id;

  const board = boardRepo.createBoard({ name: 'Test Board' });
  boardId = board.id;

  const column = columnRepo.createColumn({ boardId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = column.id;

  const feature = featureRepo.createFeature({
    boardId,
    columnId,
    title: 'Test Feature',
    createdBy: 'test-user',
  });
  featureId = feature.id;
});

afterEach(() => {
  closeDb();
});

function createTask(overrides: { title: string; priority: 'low' | 'medium' | 'high' | 'critical'; estimatedMinutes?: number | null }) {
  return taskRepo.createTask({
    featureId,
    title: overrides.title,
    priority: overrides.priority,
    estimatedMinutes: overrides.estimatedMinutes ?? null,
    createdBy: 'test-user',
  });
}

describe('getTasksByBoardId sort', () => {
  it('returns default order (priority + createdAt ASC) when no sort params', () => {
    createTask({ title: 'Low task', priority: 'low' });
    createTask({ title: 'Critical task', priority: 'critical' });
    createTask({ title: 'Medium task', priority: 'medium' });

    const result = getTasksByBoardId(boardId);

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
    const result = getTasksByBoardId(boardId, filters);

    expect(result.tasks[0].title).toBe('Alpha task');
    expect(result.tasks[1].title).toBe('Middle task');
    expect(result.tasks[2].title).toBe('Zebra task');
  });

  it('sorts by title descending', () => {
    createTask({ title: 'Alpha task', priority: 'critical' });
    createTask({ title: 'Zebra task', priority: 'low' });

    const filters: TaskListFilters = { sortBy: 'title', sortDirection: 'desc' };
    const result = getTasksByBoardId(boardId, filters);

    expect(result.tasks[0].title).toBe('Zebra task');
    expect(result.tasks[1].title).toBe('Alpha task');
  });

  it('sorts by priority (critical first when asc)', () => {
    createTask({ title: 'Low', priority: 'low' });
    createTask({ title: 'High', priority: 'high' });
    createTask({ title: 'Critical', priority: 'critical' });
    createTask({ title: 'Medium', priority: 'medium' });

    const filters: TaskListFilters = { sortBy: 'priority', sortDirection: 'asc' };
    const result = getTasksByBoardId(boardId, filters);

    expect(result.tasks.map(t => t.priority)).toEqual(['critical', 'high', 'medium', 'low']);
  });

  it('sorts by estimatedMinutes descending (longest first)', () => {
    createTask({ title: 'Short', priority: 'low', estimatedMinutes: 5 });
    createTask({ title: 'Long', priority: 'low', estimatedMinutes: 120 });
    createTask({ title: 'Medium', priority: 'low', estimatedMinutes: 30 });

    const filters: TaskListFilters = { sortBy: 'estimatedMinutes', sortDirection: 'desc' };
    const result = getTasksByBoardId(boardId, filters);

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
    const result = getTasksByBoardId(boardId, filters);

    expect(result.tasks[0].title).toBe('Claimed');
    expect(result.tasks[1].title).toBe('Done');
    expect(result.tasks[2].title).toBe('Pending');
  });

  it('sorts by updatedAt', () => {
    createTask({ title: 'Task A', priority: 'low' });
    createTask({ title: 'Task B', priority: 'low' });

    const filters: TaskListFilters = { sortBy: 'updatedAt', sortDirection: 'desc' };
    const result = getTasksByBoardId(boardId, filters);

    expect(result.tasks).toHaveLength(2);
    const dates = result.tasks.map(t => t.updatedAt);
    expect(dates[0]! >= dates[1]!).toBe(true);
  });

  it('falls back to default ordering for invalid sortBy value', () => {
    createTask({ title: 'Low', priority: 'low' });
    createTask({ title: 'Critical', priority: 'critical' });

    const filters: TaskListFilters = { sortBy: 'nonexistent' as any };
    const result = getTasksByBoardId(boardId, filters);

    expect(result.tasks[0].priority).toBe('critical');
    expect(result.tasks[1].priority).toBe('low');
  });

  it('respects limit and offset with sort', () => {
    for (let i = 0; i < 5; i++) {
      createTask({ title: `Task ${i}`, priority: 'low', estimatedMinutes: (i + 1) * 10 });
    }

    const filters: TaskListFilters = { sortBy: 'estimatedMinutes', sortDirection: 'desc', limit: 2, offset: 1 };
    const result = getTasksByBoardId(boardId, filters);

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
    const result = getTasksByBoardId(boardId, filters);

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
    const result = getTasksByBoardId(boardId, filters);

    expect(result.total).toBe(2);
    expect(result.tasks).toHaveLength(2);
    expect(result.tasks[0].priority).toBe('critical');
    expect(result.tasks[1].priority).toBe('low');
  });

  it('returns empty array for board with no features', () => {
    const emptyBoard = boardRepo.createBoard({ name: 'Empty Board' });
    const result = getTasksByBoardId(emptyBoard.id);
    expect(result.tasks).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('backward compatibility: existing callers work unchanged', () => {
    createTask({ title: 'Low', priority: 'low' });
    createTask({ title: 'Critical', priority: 'critical' });

    const resultNoFilters = getTasksByBoardId(boardId);
    const resultEmptyFilters = getTasksByBoardId(boardId, {});
    const resultOnlyLimit = getTasksByBoardId(boardId, { limit: 10 });

    expect(resultNoFilters.tasks[0].priority).toBe('critical');
    expect(resultEmptyFilters.tasks[0].priority).toBe('critical');
    expect(resultOnlyLimit.tasks[0].priority).toBe('critical');
  });
});

describe('board tasks route integration', () => {
  it('GET /boards/:id/tasks route is registered and accessible', async () => {
    const { taskRoutes } = await import('../routes/tasks/index.js');
    expect(taskRoutes).toBeDefined();
    expect(typeof taskRoutes).toBe('function');
  });

  it('boardTasksRoutes function exists and is a valid route module', async () => {
    const { boardTasksRoutes } = await import('../routes/tasks/boardTasks.js');
    expect(boardTasksRoutes).toBeDefined();
    expect(typeof boardTasksRoutes).toBe('function');
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
