import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import jwt from 'jsonwebtoken';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as boardRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as featureRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as templateRepo from '../repositories/template.js';
import { templateRoutes } from '../routes/templates.js';
import { featureTemplates, tasks, features, columns as columnsTable, boards } from '../db/schema/index.js';
import { sql } from 'drizzle-orm';
import type { TaskTemplateEntry, TaskPriority } from '../models/index.js';

let boardId: string;
let columnId: string;
let featureId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(features).run();
  db.delete(columnsTable).run();
  db.delete(boards).run();
  db.delete(featureTemplates).run();

  const board = boardRepo.createBoard({ name: 'Test Board' });
  boardId = board.id;

  const column = columnRepo.createColumn({ boardId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = column.id;

  const feature = featureRepo.createFeature({ boardId, columnId, title: 'Existing Feature', createdBy: 'human' });
  featureId = feature.id;
});

afterEach(() => {
  closeDb();
});

describe('applyTemplate', () => {
  function createTestTemplate(overrides: { tasksTemplate?: TaskTemplateEntry[] } = {}) {
    return templateRepo.createTemplate({
      boardId,
      name: 'Test Template',
      titlePattern: 'Sprint Task',
      descriptionPattern: '## Goal\nComplete the work',
      priority: 'high' as TaskPriority,
      labels: ['sprint', 'backend'],
      requiredDomain: 'backend',
      requiredCapabilities: ['typescript'],
      tasksTemplate: overrides.tasksTemplate ?? [
        { title: 'Setup', description: 'Initialize project', priority: 'high' as TaskPriority, order: 0, estimatedMinutes: 30 },
        { title: 'Implementation', priority: 'medium' as TaskPriority, order: 1, estimatedMinutes: 120 },
        { title: 'Testing', description: 'Write tests', priority: 'medium' as TaskPriority, order: 2, requiredDomain: 'qa' },
      ],
      createdBy: 'human',
    });
  }

  it('creates feature with correct title and priority', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, boardId);

    expect(result).not.toBeNull();
    expect(result!.feature.title).toBe('Sprint Task');
    expect(result!.feature.description).toBe('## Goal\nComplete the work');
    expect(result!.feature.priority).toBe('high');
    expect(result!.feature.labels).toEqual(['sprint', 'backend']);
    expect(result!.feature.boardId).toBe(boardId);
  });

  it('creates child tasks from tasksTemplate array', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, boardId);

    expect(result).not.toBeNull();
    expect(result!.tasks).toHaveLength(3);
    expect(result!.tasks[0].title).toBe('Setup');
    expect(result!.tasks[0].description).toBe('Initialize project');
    expect(result!.tasks[0].priority).toBe('high');
    expect(result!.tasks[0].estimatedMinutes).toBe(30);
    expect(result!.tasks[1].title).toBe('Implementation');
    expect(result!.tasks[1].priority).toBe('medium');
    expect(result!.tasks[2].title).toBe('Testing');
    expect(result!.tasks[2].requiredDomain).toBe('qa');

    for (const task of result!.tasks) {
      expect(task.featureId).toBe(result!.feature.id);
    }
  });

  it('increments usage count on template', () => {
    const template = createTestTemplate();
    expect(template.usageCount).toBe(0);

    templateRepo.applyTemplate(template.id, boardId);

    const updated = templateRepo.getTemplateById(template.id);
    expect(updated!.usageCount).toBe(1);

    templateRepo.applyTemplate(template.id, boardId);

    const updatedAgain = templateRepo.getTemplateById(template.id);
    expect(updatedAgain!.usageCount).toBe(2);
  });

  it('with overrides overrides template defaults', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, boardId, {
      title: 'Custom Title',
      description: 'Custom description',
      priority: 'critical' as TaskPriority,
      labels: ['custom'],
    });

    expect(result).not.toBeNull();
    expect(result!.feature.title).toBe('Custom Title');
    expect(result!.feature.description).toBe('Custom description');
    expect(result!.feature.priority).toBe('critical');
    expect(result!.feature.labels).toEqual(['custom']);
  });

  it('returns null for non-existent template', () => {
    const result = templateRepo.applyTemplate('non-existent-id', boardId);

    expect(result).toBeNull();
  });

  it('handles empty tasksTemplate array (creates feature only)', () => {
    const template = createTestTemplate({ tasksTemplate: [] });

    const result = templateRepo.applyTemplate(template.id, boardId);

    expect(result).not.toBeNull();
    expect(result!.feature.title).toBe('Sprint Task');
    expect(result!.tasks).toHaveLength(0);
  });

  it('uses provided createdBy for feature and tasks', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, boardId, undefined, 'agent-42');

    expect(result).not.toBeNull();
    expect(result!.feature.createdBy).toBe('agent-42');
    for (const task of result!.tasks) {
      expect(task.createdBy).toBe('agent-42');
    }
  });

  it('defaults createdBy to system when not provided', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, boardId);

    expect(result).not.toBeNull();
    expect(result!.feature.createdBy).toBe('system');
    for (const task of result!.tasks) {
      expect(task.createdBy).toBe('system');
    }
  });

  it('tasks are persisted in the database', () => {
    const template = createTestTemplate();
    const result = templateRepo.applyTemplate(template.id, boardId);

    const dbTasks = taskRepo.getTasksByFeatureId(result!.feature.id);
    expect(dbTasks).toHaveLength(3);
    expect(dbTasks.map(t => t.title).sort()).toEqual(['Implementation', 'Setup', 'Testing'].sort());
  });

  it('feature is persisted in the database', () => {
    const template = createTestTemplate();
    const result = templateRepo.applyTemplate(template.id, boardId);

    const dbFeature = featureRepo.getFeatureById(result!.feature.id);
    expect(dbFeature).not.toBeNull();
    expect(dbFeature!.title).toBe('Sprint Task');
  });

  it('rolls back all changes on failure within transaction', () => {
    const db = getDb();
    const featureCountBefore = db.select({ count: sql<number>`COUNT(*)` }).from(features).get()!.count;
    const taskCountBefore = db.select({ count: sql<number>`COUNT(*)` }).from(tasks).get()!.count;

    const template = templateRepo.createTemplate({
      boardId,
      name: 'Rollback Test',
      titlePattern: 'Rollback',
      tasksTemplate: [
        { title: 'First Task', order: 0 },
        { title: 'Second Task', order: 1 },
      ],
      createdBy: 'human',
    });

    const usageCountBefore = templateRepo.getTemplateById(template.id)!.usageCount;

    let taskInsertCall = 0;
    const origTransaction = db.transaction.bind(db);
    db.transaction = function(fn: any) {
      return origTransaction(function(tx: any) {
        const origTxInsert = tx.insert.bind(tx);
        tx.insert = function(...args: any[]) {
          const builder = origTxInsert(...args);
          if (args[0] === tasks) {
            taskInsertCall++;
            if (taskInsertCall === 2) {
              const origRun = builder.run.bind(builder);
              builder.run = function() {
                throw new Error('Simulated failure on second task');
              };
            }
          }
          return builder;
        };
        return fn(tx);
      });
    };

    let threw = false;
    try {
      templateRepo.applyTemplate(template.id, boardId);
    } catch {
      threw = true;
    }

    db.transaction = origTransaction;

    expect(threw).toBe(true);

    const featureCountAfter = db.select({ count: sql<number>`COUNT(*)` }).from(features).get()!.count;
    const taskCountAfter = db.select({ count: sql<number>`COUNT(*)` }).from(tasks).get()!.count;
    const usageCountAfter = templateRepo.getTemplateById(template.id)!.usageCount;

    expect(featureCountAfter).toBe(featureCountBefore);
    expect(taskCountAfter).toBe(taskCountBefore);
    expect(usageCountAfter).toBe(usageCountBefore);
  });
});

describe('POST /features/:id/apply-template/:templateId - board association', () => {
  let app: FastifyInstance | null = null;
  const JWT_SECRET = 'dev-secret-change-in-production';

  function makeToken(payload: { sub: string; username: string; role: string }): string {
    return jwt.sign(payload, JWT_SECRET, { issuer: 'orcy' });
  }

  async function buildApp(): Promise<FastifyInstance> {
    const f = Fastify({ logger: false });
    f.setValidatorCompiler(validatorCompiler);
    f.setSerializerCompiler(serializerCompiler);
    await f.register(templateRoutes);
    await f.ready();
    return f;
  }

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(tasks).run();
    db.delete(features).run();
    db.delete(columnsTable).run();
    db.delete(boards).run();
    db.delete(featureTemplates).run();

    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it('returns 403 when template belongs to a different board', async () => {
    const boardA = boardRepo.createBoard({ name: 'Board A' });
    const boardB = boardRepo.createBoard({ name: 'Board B' });

    const colA = columnRepo.createColumn({ boardId: boardA.id, name: 'Backlog', order: 0, requiresClaim: false });
    const colB = columnRepo.createColumn({ boardId: boardB.id, name: 'Backlog', order: 0, requiresClaim: false });

    const template = templateRepo.createTemplate({
      boardId: boardA.id,
      name: 'Board A Template',
      titlePattern: 'From Board A',
      createdBy: 'human',
    });

    const feature = featureRepo.createFeature({ boardId: boardB.id, columnId: colB.id, title: 'Feature on B', createdBy: 'human' });

    const token = makeToken({ sub: 'user-1', username: 'admin', role: 'admin' });
    const res = await app!.inject({
      method: 'POST',
      url: `/features/${feature.id}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/template.*not.*belong|forbidden/i);
  });

  it('allows applying same-board template', async () => {
    const board = boardRepo.createBoard({ name: 'Board' });
    const col = columnRepo.createColumn({ boardId: board.id, name: 'Backlog', order: 0, requiresClaim: false });

    const template = templateRepo.createTemplate({
      boardId: board.id,
      name: 'Same Board Template',
      titlePattern: 'Same Board Task',
      createdBy: 'human',
    });

    const feature = featureRepo.createFeature({ boardId: board.id, columnId: col.id, title: 'Feature', createdBy: 'human' });

    const token = makeToken({ sub: 'user-1', username: 'admin', role: 'admin' });
    const res = await app!.inject({
      method: 'POST',
      url: `/features/${feature.id}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.feature.title).toBe('Same Board Task');
  });

  it('allows applying global template (boardId = null) to any board', async () => {
    const board = boardRepo.createBoard({ name: 'Any Board' });
    const col = columnRepo.createColumn({ boardId: board.id, name: 'Backlog', order: 0, requiresClaim: false });

    const template = templateRepo.createTemplate({
      boardId: null,
      name: 'Global Template',
      titlePattern: 'Global Task',
      createdBy: 'system',
    });

    const feature = featureRepo.createFeature({ boardId: board.id, columnId: col.id, title: 'Feature', createdBy: 'human' });

    const token = makeToken({ sub: 'user-1', username: 'admin', role: 'admin' });
    const res = await app!.inject({
      method: 'POST',
      url: `/features/${feature.id}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.feature.title).toBe('Global Task');
  });
});
