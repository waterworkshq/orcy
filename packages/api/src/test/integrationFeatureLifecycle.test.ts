import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { closeDb, initTestDb, getDb } from '../db/index.js';
import * as boardRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as featureRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as agentRepo from '../repositories/agent.js';
import * as featureService from '../services/featureService.js';
import * as boardService from '../services/boardService.js';
import { getTaskDetails } from '../services/tasks/task-details.js';
import { claimTask, startTask, submitTask, approveTask } from '../services/tasks/task-lifecycle.js';
import { featureDependencies, taskDependencies } from '../db/schema/index.js';
import { eq, sql, notInArray } from 'drizzle-orm';

async function setupBoard() {
  const { board, columns } = boardService.createBoard({ name: 'Test', defaultColumns: true });
  const agent = agentRepo.createAgent({ name: 'test-agent', type: 'claude-code', domain: 'fullstack' });
  return { board, columns, agent };
}

describe('Integration: Feature Lifecycle', () => {
  beforeEach(async () => { await initTestDb(); });
  afterEach(() => { closeDb(); });

  it('task claim → feature status changes to in_progress → feature auto-advances to In Progress column', async () => {
    const { board, columns, agent } = await setupBoard();
    const todoCol = columns[0];
    const inProgressCol = columns[1];

    const feature = featureRepo.createFeature({ boardId: board.id, columnId: todoCol.id, title: 'Auth Feature', createdBy: 'test' });
    expect(feature.status).toBe('not_started');
    expect(feature.columnId).toBe(todoCol.id);

    const task = taskRepo.createTask({ featureId: feature.id, title: 'Implement login', createdBy: 'test' });
    expect(task.status).toBe('pending');

    const result = claimTask(task.id, agent.agent.id);
    expect(result.success).toBe(true);

    const updatedFeature = featureRepo.getFeatureById(feature.id)!;
    expect(updatedFeature.status).toBe('in_progress');
    expect(updatedFeature.columnId).toBe(inProgressCol.id);
  });

  it('all tasks submitted → feature status changes to review → feature auto-advances to Review column', async () => {
    const { board, columns, agent } = await setupBoard();
    const todoCol = columns[0];
    const reviewCol = columns[2];

    const feature = featureRepo.createFeature({ boardId: board.id, columnId: todoCol.id, title: 'Review Feature', createdBy: 'test' });
    const task1 = taskRepo.createTask({ featureId: feature.id, title: 'Task 1', createdBy: 'test' });
    const task2 = taskRepo.createTask({ featureId: feature.id, title: 'Task 2', createdBy: 'test' });

    claimTask(task1.id, agent.agent.id);
    startTask(task1.id, agent.agent.id);
    claimTask(task2.id, agent.agent.id);
    startTask(task2.id, agent.agent.id);

    submitTask(task1.id, agent.agent.id, 'Done task 1', []);
    const fAfterFirst = featureRepo.getFeatureById(feature.id)!;
    expect(fAfterFirst.status).toBe('in_progress');

    submitTask(task2.id, agent.agent.id, 'Done task 2', []);

    const updatedFeature = featureRepo.getFeatureById(feature.id)!;
    expect(updatedFeature.status).toBe('review');
    expect(updatedFeature.columnId).toBe(reviewCol.id);
  });

  it('all tasks done → feature status changes to done → feature auto-advances to Done column', async () => {
    const { board, columns, agent } = await setupBoard();
    const todoCol = columns[0];
    const doneCol = columns[3];

    const feature = featureRepo.createFeature({ boardId: board.id, columnId: todoCol.id, title: 'Done Feature', createdBy: 'test' });
    const task1 = taskRepo.createTask({ featureId: feature.id, title: 'Task 1', createdBy: 'test' });
    const task2 = taskRepo.createTask({ featureId: feature.id, title: 'Task 2', createdBy: 'test' });

    claimTask(task1.id, agent.agent.id);
    startTask(task1.id, agent.agent.id);
    submitTask(task1.id, agent.agent.id, 'Done 1', []);

    claimTask(task2.id, agent.agent.id);
    startTask(task2.id, agent.agent.id);
    submitTask(task2.id, agent.agent.id, 'Done 2', []);

    approveTask(task1.id, 'reviewer');
    approveTask(task2.id, 'reviewer');

    taskRepo.updateTask(task1.id, { status: 'done' });
    featureService.recalculateFeatureStatus(feature.id);

    const updatedFeature = featureRepo.getFeatureById(feature.id)!;
    expect(updatedFeature.status).toBe('done');
    expect(updatedFeature.columnId).toBe(doneCol.id);
  });

  it('board summary returns features with task progress counts', async () => {
    const { board, columns } = await setupBoard();

    const feature1 = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Feature A', createdBy: 'test' });
    const feature2 = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Feature B', createdBy: 'test' });

    taskRepo.createTask({ featureId: feature1.id, title: 'T1', createdBy: 'test' });
    taskRepo.createTask({ featureId: feature1.id, title: 'T2', createdBy: 'test' });
    taskRepo.createTask({ featureId: feature2.id, title: 'T3', createdBy: 'test' });

    const { features: featureList } = featureService.listFeatures(board.id);
    expect(featureList).toHaveLength(2);

    const f1 = featureList.find(f => f.id === feature1.id)!;
    expect(f1.progress.total).toBe(2);
    expect(f1.progress.pending).toBe(2);
    expect(f1.progress.inProgress).toBe(0);

    const f2 = featureList.find(f => f.id === feature2.id)!;
    expect(f2.progress.total).toBe(1);
    expect(f2.progress.pending).toBe(1);
  });

  it('task context includes parent feature description and sibling results', async () => {
    const { board, columns, agent } = await setupBoard();

    const feature = featureRepo.createFeature({
      boardId: board.id,
      columnId: columns[0].id,
      title: 'Feature X',
      description: 'Build the auth module',
      acceptanceCriteria: 'All tests pass',
      createdBy: 'test',
    });

    const task1 = taskRepo.createTask({ featureId: feature.id, title: 'Sibling task', createdBy: 'test' });
    const task2 = taskRepo.createTask({ featureId: feature.id, title: 'Main task', createdBy: 'test' });

    claimTask(task1.id, agent.agent.id);
    startTask(task1.id, agent.agent.id);
    submitTask(task1.id, agent.agent.id, 'Sibling result here', []);

    const details = await getTaskDetails(task2.id);
    expect(details).not.toBeNull();
    expect(details!.feature).not.toBeNull();
    expect(details!.feature!.title).toBe('Feature X');
    expect(details!.feature!.description).toBe('Build the auth module');
    expect(details!.feature!.acceptanceCriteria).toBe('All tests pass');

    expect(details!.siblingTasks).toHaveLength(1);
    expect(details!.siblingTasks[0].id).toBe(task1.id);
    expect(details!.siblingTasks[0].status).toBe('submitted');
    expect(details!.siblingTasks[0].result).toBe('Sibling result here');
  });

  it('available tasks filter respects feature dependencies', async () => {
    const { board, columns } = await setupBoard();

    const featureA = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Feature A', createdBy: 'test' });
    const featureB = featureRepo.createFeature({
      boardId: board.id,
      columnId: columns[0].id,
      title: 'Feature B',
      createdBy: 'test',
      dependsOn: [featureA.id],
    });

    const taskA = taskRepo.createTask({ featureId: featureA.id, title: 'Task A', createdBy: 'test' });
    const taskB = taskRepo.createTask({ featureId: featureB.id, title: 'Task B', createdBy: 'test' });

    const availableBefore = taskRepo.getAvailableTasksForAgent(board.id, 'fullstack');
    const availableIds = availableBefore.map(t => t.id);

    expect(availableIds).toContain(taskA.id);
    expect(availableIds).not.toContain(taskB.id);

    featureRepo.updateFeature(featureA.id, { status: 'done' });
    const availableAfter = taskRepo.getAvailableTasksForAgent(board.id, 'fullstack');
    const afterIds = availableAfter.map(t => t.id);
    expect(afterIds).toContain(taskB.id);
  });

  it('available tasks filter respects task-level dependencies (correlated subquery)', async () => {
    const { board, columns, agent } = await setupBoard();
    const db = getDb();

    const feature = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Feature', createdBy: 'test' });

    const depTarget = taskRepo.createTask({ featureId: feature.id, title: 'Dependency target', createdBy: 'test' });
    const dependent = taskRepo.createTask({ featureId: feature.id, title: 'Has met deps', createdBy: 'test' });
    const blocked = taskRepo.createTask({ featureId: feature.id, title: 'Has unmet deps', createdBy: 'test' });
    const blocker = taskRepo.createTask({ featureId: feature.id, title: 'Blocker not done', createdBy: 'test' });

    db.insert(taskDependencies).values({ taskId: dependent.id, dependsOnId: depTarget.id }).run();
    db.insert(taskDependencies).values({ taskId: blocked.id, dependsOnId: blocker.id }).run();

    claimTask(depTarget.id, agent.agent.id);
    startTask(depTarget.id, agent.agent.id);
    submitTask(depTarget.id, agent.agent.id, 'Done', []);
    approveTask(depTarget.id, agent.agent.id);

    const available = taskRepo.getAvailableTasksForAgent(board.id, 'fullstack');
    const availableIds = available.map(t => t.id);

    expect(availableIds).toContain(dependent.id);
    expect(availableIds).not.toContain(blocked.id);
  });

  it('createFeature atomically creates feature and dependency rows', async () => {
    const { board, columns } = await setupBoard();

    const featureA = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Feature A', createdBy: 'test' });
    const featureB = featureRepo.createFeature({
      boardId: board.id,
      columnId: columns[0].id,
      title: 'Feature B',
      createdBy: 'test',
      dependsOn: [featureA.id],
    });

    expect(featureB.dependsOn).toEqual([featureA.id]);

    const db = getDb();
    const deps = db.select().from(featureDependencies).where(eq(featureDependencies.featureId, featureB.id)).all();
    expect(deps).toHaveLength(1);
    expect(deps[0].dependsOnId).toBe(featureA.id);
  });

  it('createFeature rolls back feature row when dependency insert fails', async () => {
    const { board, columns } = await setupBoard();

    const db = getDb();
    db.run(sql`PRAGMA foreign_keys = ON`);

    const fakeDepId = '00000000-0000-0000-0000-000000000000';
    expect(() => {
      featureRepo.createFeature({
        boardId: board.id,
        columnId: columns[0].id,
        title: 'Orphan Feature',
        createdBy: 'test',
        dependsOn: [fakeDepId],
      });
    }).toThrow();

    const allFeatures = featureRepo.getFeaturesByBoardId(board.id);
    expect(allFeatures.features.find(f => f.title === 'Orphan Feature')).toBeUndefined();

    db.run(sql`PRAGMA foreign_keys = OFF`);
  });

  it('createFeature with blocks creates reverse dependency rows in feature_dependencies', async () => {
    const { board, columns } = await setupBoard();

    const featureB = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Blocked Feature', createdBy: 'test' });
    const featureA = featureRepo.createFeature({
      boardId: board.id,
      columnId: columns[0].id,
      title: 'Blocker Feature',
      createdBy: 'test',
      blocks: [featureB.id],
    });

    expect(featureA.blocks).toEqual([featureB.id]);

    const db = getDb();
    const deps = db.select().from(featureDependencies).where(eq(featureDependencies.featureId, featureB.id)).all();
    expect(deps).toHaveLength(1);
    expect(deps[0].dependsOnId).toBe(featureA.id);
  });

  it('blocks dependency prevents tasks from appearing available via areAllFeatureDependenciesMet', async () => {
    const { board, columns } = await setupBoard();

    const featureB = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Blocked', createdBy: 'test' });
    const featureA = featureRepo.createFeature({
      boardId: board.id,
      columnId: columns[0].id,
      title: 'Blocker',
      createdBy: 'test',
      blocks: [featureB.id],
    });

    expect(featureRepo.areAllFeatureDependenciesMet(featureB.id)).toBe(false);

    featureRepo.updateFeature(featureA.id, { status: 'done' });
    expect(featureRepo.areAllFeatureDependenciesMet(featureB.id)).toBe(true);
  });

  it('updateFeature syncs blocks changes to feature_dependencies', async () => {
    const { board, columns } = await setupBoard();

    const featureB = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Blocked', createdBy: 'test' });
    const featureC = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Also Blocked', createdBy: 'test' });
    const featureA = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Blocker', createdBy: 'test' });

    featureRepo.updateFeature(featureA.id, { blocks: [featureB.id, featureC.id] });

    const db = getDb();
    const depsB = db.select().from(featureDependencies).where(eq(featureDependencies.featureId, featureB.id)).all();
    expect(depsB).toHaveLength(1);
    expect(depsB[0].dependsOnId).toBe(featureA.id);

    const depsC = db.select().from(featureDependencies).where(eq(featureDependencies.featureId, featureC.id)).all();
    expect(depsC).toHaveLength(1);
    expect(depsC[0].dependsOnId).toBe(featureA.id);

    featureRepo.updateFeature(featureA.id, { blocks: [featureC.id] });

    const depsBAfter = db.select().from(featureDependencies).where(eq(featureDependencies.featureId, featureB.id)).all();
    expect(depsBAfter).toHaveLength(0);

    const depsCAfter = db.select().from(featureDependencies).where(eq(featureDependencies.featureId, featureC.id)).all();
    expect(depsCAfter).toHaveLength(1);
    expect(depsCAfter[0].dependsOnId).toBe(featureA.id);
  });

  it('updateFeature clearing blocks removes all reverse dependency rows', async () => {
    const { board, columns } = await setupBoard();

    const featureB = featureRepo.createFeature({ boardId: board.id, columnId: columns[0].id, title: 'Blocked', createdBy: 'test' });
    const featureA = featureRepo.createFeature({
      boardId: board.id,
      columnId: columns[0].id,
      title: 'Blocker',
      createdBy: 'test',
      blocks: [featureB.id],
    });

    const db = getDb();
    const depsBefore = db.select().from(featureDependencies).where(eq(featureDependencies.featureId, featureB.id)).all();
    expect(depsBefore).toHaveLength(1);

    featureRepo.updateFeature(featureA.id, { blocks: [] });

    const depsAfter = db.select().from(featureDependencies).where(eq(featureDependencies.featureId, featureB.id)).all();
    expect(depsAfter).toHaveLength(0);
  });

  it('reorderFeature increments version for change detection', async () => {
    const { board, columns } = await setupBoard();
    const colId = columns[0].id;

    const featureA = featureRepo.createFeature({ boardId: board.id, columnId: colId, title: 'A', createdBy: 'test' });
    const featureB = featureRepo.createFeature({ boardId: board.id, columnId: colId, title: 'B', createdBy: 'test' });
    const featureC = featureRepo.createFeature({ boardId: board.id, columnId: colId, title: 'C', createdBy: 'test' });

    expect(featureA.version).toBe(1);

    const reordered = featureRepo.reorderFeature(featureA.id, featureC.id, null);
    expect(reordered).not.toBeNull();
    expect(reordered!.version).toBe(2);

    const reorderedAgain = featureRepo.reorderFeature(featureA.id, null, featureB.id);
    expect(reorderedAgain!.version).toBe(3);
  });

  it('feature archive and unarchive lifecycle', async () => {
    const { board, columns } = await setupBoard();
    const todoCol = columns[0];
    const doneCol = columns[3];

    const feature = featureRepo.createFeature({ boardId: board.id, columnId: todoCol.id, title: 'Archival Test', createdBy: 'test' });
    const task = taskRepo.createTask({ featureId: feature.id, title: 'Task to be archived', createdBy: 'test' });

    // Archiving a not_done feature should fail
    const archiveFailResult = featureService.archiveFeature(feature.id, 'user');
    expect(archiveFailResult.success).toBe(false);
    expect('reason' in archiveFailResult && archiveFailResult.reason).toBe('not_done');

    // Move to done
    featureRepo.updateFeature(feature.id, { status: 'done', columnId: doneCol.id });

    // Archive it
    const archiveResult = featureService.archiveFeature(feature.id, 'user');
    expect(archiveResult.success).toBe(true);

    const archivedFeature = featureRepo.getFeatureById(feature.id)!;
    expect(archivedFeature.isArchived).toBe(true);

    // List active features should not include it
    const activeFeatures = featureService.listFeatures(board.id, { isArchived: false });
    expect(activeFeatures.features.find(f => f.id === feature.id)).toBeUndefined();

    // List archived features should include it
    const listArchived = featureService.listFeatures(board.id, { isArchived: true });
    expect(listArchived.features.find(f => f.id === feature.id)).toBeDefined();

    // Cannot modify archived feature
    const updateResult = featureService.updateFeature(feature.id, { title: 'Changed' }, 'user');
    expect(updateResult.success).toBe(false);
    expect('archived' in updateResult && updateResult.archived).toBe(true);

    // Unarchive it
    const unarchiveResult = featureService.unarchiveFeature(feature.id, 'user');
    expect(unarchiveResult.success).toBe(true);

    const unarchivedFeature = featureRepo.getFeatureById(feature.id)!;
    expect(unarchivedFeature.isArchived).toBe(false);

    // Can modify again
    const updateAgain = featureService.updateFeature(feature.id, { title: 'Changed' }, 'user');
    expect(updateAgain.success).toBe(true);
    expect('feature' in updateAgain && updateAgain.feature.title).toBe('Changed');
  });
});
