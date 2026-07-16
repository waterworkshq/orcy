import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import jwt from 'jsonwebtoken';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as missionRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as templateRepo from '../repositories/template.js';
import { templateRoutes } from '../routes/templates.js';
import { missionTemplates, tasks, missions, columns as columnsTable, habitats } from '../db/schema/index.js';
import { sql } from 'drizzle-orm';
import type { TaskTemplateEntry, TaskPriority } from '../models/index.js';

let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(missionTemplates).run();

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const column = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = column.id;

  const mission = missionRepo.createMission({ habitatId, columnId, title: 'Existing Mission', createdBy: 'human' });
  missionId = mission.id;
});

afterEach(() => {
  closeDb();
});

describe('applyTemplate', () => {
  function createTestTemplate(overrides: { tasksTemplate?: TaskTemplateEntry[] } = {}) {
    return templateRepo.createTemplate({
      habitatId,
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

  it('creates mission with correct title and priority', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    expect(result!.mission.title).toBe('Sprint Task');
    expect(result!.mission.description).toBe('## Goal\nComplete the work');
    expect(result!.mission.priority).toBe('high');
    expect(result!.mission.labels).toEqual(['sprint', 'backend']);
    expect(result!.mission.habitatId).toBe(habitatId);
  });

  it('creates child tasks from tasksTemplate array', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, habitatId);

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
      expect(task.missionId).toBe(result!.mission.id);
    }
  });

  it('increments usage count on template', () => {
    const template = createTestTemplate();
    expect(template.usageCount).toBe(0);

    templateRepo.applyTemplate(template.id, habitatId);

    const updated = templateRepo.getTemplateById(template.id);
    expect(updated!.usageCount).toBe(1);

    templateRepo.applyTemplate(template.id, habitatId);

    const updatedAgain = templateRepo.getTemplateById(template.id);
    expect(updatedAgain!.usageCount).toBe(2);
  });

  it('with overrides overrides template defaults', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, habitatId, {
      title: 'Custom Title',
      description: 'Custom description',
      priority: 'critical' as TaskPriority,
      labels: ['custom'],
    });

    expect(result).not.toBeNull();
    expect(result!.mission.title).toBe('Custom Title');
    expect(result!.mission.description).toBe('Custom description');
    expect(result!.mission.priority).toBe('critical');
    expect(result!.mission.labels).toEqual(['custom']);
  });

  it('returns null for non-existent template', () => {
    const result = templateRepo.applyTemplate('non-existent-id', habitatId);

    expect(result).toBeNull();
  });

  it('handles empty tasksTemplate array (creates mission only)', () => {
    const template = createTestTemplate({ tasksTemplate: [] });

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    expect(result!.mission.title).toBe('Sprint Task');
    expect(result!.tasks).toHaveLength(0);
  });

  it('uses provided createdBy for mission and tasks', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, habitatId, undefined, 'agent-42');

    expect(result).not.toBeNull();
    expect(result!.mission.createdBy).toBe('agent-42');
    for (const task of result!.tasks) {
      expect(task.createdBy).toBe('agent-42');
    }
  });

  it('defaults createdBy to system when not provided', () => {
    const template = createTestTemplate();

    const result = templateRepo.applyTemplate(template.id, habitatId);

    expect(result).not.toBeNull();
    expect(result!.mission.createdBy).toBe('system');
    for (const task of result!.tasks) {
      expect(task.createdBy).toBe('system');
    }
  });

  it('tasks are persisted in the database', () => {
    const template = createTestTemplate();
    const result = templateRepo.applyTemplate(template.id, habitatId);

    const dbTasks = taskRepo.getTasksByMissionId(result!.mission.id);
    expect(dbTasks).toHaveLength(3);
    expect(dbTasks.map(t => t.title).toSorted()).toEqual(['Implementation', 'Setup', 'Testing'].toSorted());
  });

  it('mission is persisted in the database', () => {
    const template = createTestTemplate();
    const result = templateRepo.applyTemplate(template.id, habitatId);

    const dbMission = missionRepo.getMissionById(result!.mission.id);
    expect(dbMission).not.toBeNull();
    expect(dbMission!.title).toBe('Sprint Task');
  });

  it('rolls back all changes on failure within transaction', () => {
    const db = getDb();
    const missionCountBefore = db.select({ count: sql<number>`COUNT(*)` }).from(missions).get()!.count;
    const taskCountBefore = db.select({ count: sql<number>`COUNT(*)` }).from(tasks).get()!.count;

    const template = templateRepo.createTemplate({
      habitatId,
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
      templateRepo.applyTemplate(template.id, habitatId);
    } catch {
      threw = true;
    }

    db.transaction = origTransaction;

    expect(threw).toBe(true);

    const missionCountAfter = db.select({ count: sql<number>`COUNT(*)` }).from(missions).get()!.count;
    const taskCountAfter = db.select({ count: sql<number>`COUNT(*)` }).from(tasks).get()!.count;
    const usageCountAfter = templateRepo.getTemplateById(template.id)!.usageCount;

    expect(missionCountAfter).toBe(missionCountBefore);
    expect(taskCountAfter).toBe(taskCountBefore);
    expect(usageCountAfter).toBe(usageCountBefore);
  });
});

describe('POST /missions/:id/apply-template/:templateId - habitat association', () => {
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
    db.delete(missions).run();
    db.delete(columnsTable).run();
    db.delete(habitats).run();
    db.delete(missionTemplates).run();

    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it('returns 403 when template belongs to a different habitat', async () => {
    const habitatA = habitatRepo.createHabitat({ name: 'Habitat A' });
    const habitatB = habitatRepo.createHabitat({ name: 'Habitat B' });

    const colA = columnRepo.createColumn({ habitatId: habitatA.id, name: 'Backlog', order: 0, requiresClaim: false });
    const colB = columnRepo.createColumn({ habitatId: habitatB.id, name: 'Backlog', order: 0, requiresClaim: false });

    const template = templateRepo.createTemplate({
      habitatId: habitatA.id,
      name: 'Habitat A Template',
      titlePattern: 'From Habitat A',
      createdBy: 'human',
    });

    const mission = missionRepo.createMission({ habitatId: habitatB.id, columnId: colB.id, title: 'Mission on B', createdBy: 'human' });

    const token = makeToken({ sub: 'user-1', username: 'admin', role: 'admin' });
    const res = await app!.inject({
      method: 'POST',
      url: `/missions/${mission.id}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toMatch(/template.*not.*belong|forbidden/i);
  });

  it('allows applying same-habitat template', async () => {
    const habitat = habitatRepo.createHabitat({ name: 'Habitat' });
    const col = columnRepo.createColumn({ habitatId: habitat.id, name: 'Backlog', order: 0, requiresClaim: false });

    const template = templateRepo.createTemplate({
      habitatId: habitat.id,
      name: 'Same Habitat Template',
      titlePattern: 'Same Habitat Task',
      createdBy: 'human',
    });

    const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: col.id, title: 'Mission', createdBy: 'human' });

    const token = makeToken({ sub: 'user-1', username: 'admin', role: 'admin' });
    const res = await app!.inject({
      method: 'POST',
      url: `/missions/${mission.id}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.mission.title).toBe('Same Habitat Task');
  });

  it('allows applying global template (habitatId = null) to any habitat', async () => {
    const habitat = habitatRepo.createHabitat({ name: 'Any Habitat' });
    const col = columnRepo.createColumn({ habitatId: habitat.id, name: 'Backlog', order: 0, requiresClaim: false });

    const template = templateRepo.createTemplate({
      habitatId: null,
      name: 'Global Template',
      titlePattern: 'Global Task',
      createdBy: 'system',
    });

    const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: col.id, title: 'Mission', createdBy: 'human' });

    const token = makeToken({ sub: 'user-1', username: 'admin', role: 'admin' });
    const res = await app!.inject({
      method: 'POST',
      url: `/missions/${mission.id}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.mission.title).toBe('Global Task');
  });
});
