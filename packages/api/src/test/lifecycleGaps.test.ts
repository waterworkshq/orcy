import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/index.js';
import * as taskRepo from '../repositories/task.js';
import * as featureRepo from '../repositories/feature.js';
import * as boardService from '../services/boardService.js';
import * as columnRepo from '../repositories/column.js';
import * as agentRepo from '../repositories/agent.js';
import * as timeRepo from '../repositories/timeTracking.js';
import * as timeService from '../services/timeTrackingService.js';
import * as dependencyService from '../services/dependencyService.js';
import * as qualityRepo from '../repositories/qualityGate.js';
import * as qualityService from '../services/qualityGateService.js';
import { claimTask, startTask, submitTask } from '../services/tasks/task-lifecycle.js';

let boardId: string;
let columnId: string;
let featureId: string;
let agentId: string;

function setupBoard() {
  const { board, columns } = boardService.createBoard({ name: 'Test Board', defaultColumns: true });
  boardId = board.id;
  columnId = columns[0].id;

  const feature = featureRepo.createFeature({
    boardId,
    columnId,
    title: 'Test Feature',
    createdBy: 'test-user',
  });
  featureId = feature.id;

  const { agent } = agentRepo.createAgent({
    name: `test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'claude-code',
    domain: 'fullstack',
    capabilities: ['typescript'],
  });
  agentId = agent.id;
}

beforeEach(async () => {
  await initTestDb();
  setupBoard();
});

afterEach(() => {
  closeDb();
});

describe('Time Tracking', () => {
  it('creates a time record for a task', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Time-tracked task',
      createdBy: 'test-user',
    });

    const record = timeRepo.createTimeRecord({
      taskId: task.id,
      agentId,
      minutesSpent: 15,
      statusDuringWork: 'in_progress',
    });

    expect(record.taskId).toBe(task.id);
    expect(record.minutesSpent).toBe(15);
    expect(record.agentId).toBe(agentId);
  });

  it('calculates total minutes for a task', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Total minutes task',
      createdBy: 'test-user',
    });

    timeRepo.createTimeRecord({ taskId: task.id, minutesSpent: 10, statusDuringWork: 'in_progress' });
    timeRepo.createTimeRecord({ taskId: task.id, minutesSpent: 20, statusDuringWork: 'in_progress' });

    const total = timeRepo.getTotalMinutesForTask(task.id);
    expect(total).toBe(30);
  });

  it('updates task time metrics', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Metrics task',
      createdBy: 'test-user',
      estimatedMinutes: 60,
    });

    timeRepo.createTimeRecord({ taskId: task.id, minutesSpent: 30, statusDuringWork: 'in_progress' });
    timeRepo.updateTaskTimeMetrics(task.id);

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.actualMinutes).toBe(30);
  });

  it('returns task time report', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Report task',
      createdBy: 'test-user',
      estimatedMinutes: 30,
    });

    timeRepo.createTimeRecord({ taskId: task.id, minutesSpent: 10, statusDuringWork: 'in_progress' });
    timeRepo.updateTaskTimeMetrics(task.id);

    const report = timeService.getTaskTimeReport(task.id);
    expect(report).not.toBeNull();
    expect(report!.estimatedMinutes).toBe(30);
    expect(report!.actualMinutes).toBe(10);
    expect(report!.heartbeatHistory).toHaveLength(1);
  });

  it('returns board metrics', () => {
    const task1 = taskRepo.createTask({
      featureId,
      title: 'Metrics task 1',
      createdBy: 'test-user',
      estimatedMinutes: 60,
    });

    timeRepo.createTimeRecord({ taskId: task1.id, minutesSpent: 30, statusDuringWork: 'in_progress' });
    taskRepo.updateTask(task1.id, { actualMinutes: 30, completedAt: new Date().toISOString() });

    const metrics = timeService.getBoardMetrics(boardId);
    expect(metrics).toBeDefined();
    expect(metrics.totalActualMinutes).toBeGreaterThanOrEqual(30);
  });

  it('calculates completion metrics', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Completion task',
      createdBy: 'test-user',
      estimatedMinutes: 120,
    });

    const pastDate = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    taskRepo.updateTask(task.id, { status: 'claimed', assignedAgentId: agentId, claimedAt: pastDate });
    taskRepo.updateTask(task.id, { status: 'in_progress', startedAt: pastDate });

    timeRepo.createTimeRecord({ taskId: task.id, minutesSpent: 60, statusDuringWork: 'in_progress' });
    timeRepo.updateTaskTimeMetrics(task.id);

    timeService.calculateAndSetCompletionMetrics(task.id);

    const updated = taskRepo.getTaskById(task.id);
    expect(updated?.actualMinutes).toBe(60);
    expect(updated?.cycleTimeMinutes).toBeGreaterThanOrEqual(0);
    expect(updated?.completedAt).not.toBeNull();
  });

  it('recalculates feature metrics', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Feature metrics task',
      createdBy: 'test-user',
      estimatedMinutes: 60,
    });

    timeRepo.createTimeRecord({ taskId: task.id, minutesSpent: 30, statusDuringWork: 'in_progress' });
    timeRepo.updateTaskTimeMetrics(task.id);
    timeRepo.recalculateFeatureMetrics(featureId);

    const feature = featureRepo.getFeatureById(featureId);
    expect(feature?.plannedMinutes).toBe(60);
    expect(feature?.actualMinutes).toBe(30);
  });
});

describe('Dependency Validation', () => {
  it('adds a task dependency', () => {
    const task1 = taskRepo.createTask({ featureId, title: 'Task 1', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ featureId, title: 'Task 2', createdBy: 'test-user' });

    const result = dependencyService.addTaskDependency(task1.id, task2.id);
    expect(result.success).toBe(true);
  });

  it('prevents self-dependency', () => {
    const task = taskRepo.createTask({ featureId, title: 'Self dep task', createdBy: 'test-user' });

    const result = dependencyService.addTaskDependency(task.id, task.id);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('self_dependency');
  });

  it('prevents circular dependencies', () => {
    const task1 = taskRepo.createTask({ featureId, title: 'Circular 1', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ featureId, title: 'Circular 2', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);

    const result = dependencyService.addTaskDependency(task2.id, task1.id);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('circular_dependency');
  });

  it('removes a task dependency', () => {
    const task1 = taskRepo.createTask({ featureId, title: 'Remove dep 1', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ featureId, title: 'Remove dep 2', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);
    const removed = dependencyService.removeTaskDependency(task1.id, task2.id);
    expect(removed).toBe(true);
  });

  it('gets task dependencies', () => {
    const task1 = taskRepo.createTask({ featureId, title: 'Get dep 1', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ featureId, title: 'Get dep 2', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);

    const deps = dependencyService.getTaskDependencies(task1.id);
    expect(deps.dependsOn).toHaveLength(1);
    expect(deps.dependsOn[0].taskId).toBe(task2.id);
  });

  it('validates task completion with unmet deps', () => {
    const task1 = taskRepo.createTask({ featureId, title: 'Blocked task', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ featureId, title: 'Blocking task', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);

    const validation = dependencyService.validateTaskCompletion(task1.id);
    expect(validation.canComplete).toBe(false);
    expect(validation.reason).toBe('BLOCKED_BY_DEPENDENCIES');
    expect(validation.blockedBy).toHaveLength(1);
  });

  it('validates task completion with met deps', () => {
    const task1 = taskRepo.createTask({ featureId, title: 'Unblocked task', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ featureId, title: 'Done dep', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);
    taskRepo.updateTask(task2.id, { status: 'approved', completedAt: new Date().toISOString() });

    const validation = dependencyService.validateTaskCompletion(task1.id);
    expect(validation.canComplete).toBe(true);
  });

  it('gets dependency graph for a feature', () => {
    const feat2 = featureRepo.createFeature({
      boardId,
      columnId,
      title: 'Dep Feature',
      createdBy: 'test-user',
    });

    dependencyService.addFeatureDependency(feat2.id, featureId);

    const graph = dependencyService.getDependencyGraph(feat2.id);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
  });
});

describe('Quality Gates', () => {
  it('creates a quality checklist template', () => {
    const template = qualityRepo.createTemplate({
      name: 'Test Template',
      category: 'testing',
      items: [
        { title: 'Unit tests pass', required: true },
        { title: 'Coverage maintained', required: false },
      ],
    });

    expect(template.name).toBe('Test Template');
    expect(template.category).toBe('testing');

    const items = qualityRepo.getTemplateItems(template.id);
    expect(items).toHaveLength(2);
    expect(items[0].title).toBe('Unit tests pass');
    expect(items[0].required).toBe(true);
    expect(items[1].required).toBe(false);
  });

  it('lists templates', () => {
    qualityRepo.seedDefaultTemplates();
    const templates = qualityRepo.listTemplates();
    expect(templates.length).toBeGreaterThanOrEqual(4);
  });

  it('creates task checklists from template', () => {
    const template = qualityRepo.createTemplate({
      name: 'Test Checklist',
      category: 'testing',
      items: [{ title: 'Item 1', required: true }],
    });
    const task = taskRepo.createTask({ featureId, title: 'Quality task', createdBy: 'test-user' });

    const checklist = qualityRepo.createTaskChecklist(task.id, template.id);
    expect(checklist.taskId).toBe(task.id);
    expect(checklist.status).toBe('pending');

    const items = qualityRepo.getChecklistItems(checklist.id);
    expect(items.length).toBeGreaterThan(0);
  });

  it('updates checklist items', () => {
    const template = qualityRepo.createTemplate({
      name: 'Update Test',
      category: 'testing',
      items: [{ title: 'Check item', required: true }],
    });
    const task = taskRepo.createTask({ featureId, title: 'Update item task', createdBy: 'test-user' });
    const checklist = qualityRepo.createTaskChecklist(task.id, template.id);
    const items = qualityRepo.getChecklistItems(checklist.id);

    const updated = qualityService.updateChecklistItem(
      task.id,
      checklist.id,
      items[0].id,
      { isCompleted: true, evidenceUrl: 'https://ci.example.com/build/123', notes: 'All tests pass' }
    );

    expect(updated?.isCompleted).toBe(true);
    expect(updated?.evidenceUrl).toBe('https://ci.example.com/build/123');
  });

  it('updates checklist status to passed when all required items complete', () => {
    const template = qualityRepo.createTemplate({
      name: 'Status Test',
      category: 'testing',
      items: [{ title: 'Required item', required: true }, { title: 'Optional item', required: false }],
    });
    const task = taskRepo.createTask({ featureId, title: 'Status task', createdBy: 'test-user' });
    const checklist = qualityRepo.createTaskChecklist(task.id, template.id);
    const items = qualityRepo.getChecklistItems(checklist.id);

    const requiredItem = items.find(i => {
      const ti = qualityRepo.getTemplateItems(template.id);
      return ti.find(t => t.id === i.itemId)?.required;
    });

    if (requiredItem) {
      qualityRepo.updateChecklistItem(checklist.id, requiredItem.id, { isCompleted: true });
    }

    const status = qualityRepo.updateChecklistStatus(checklist.id);
    expect(status).toBe('passed');
  });

  it('validates quality gates', () => {
    const template = qualityRepo.createTemplate({
      name: 'Test Validate',
      category: 'testing',
      isRequired: true,
      items: [{ title: 'Tests pass', required: true }],
    });
    const task = taskRepo.createTask({ featureId, title: 'Validate task', createdBy: 'test-user' });
    qualityRepo.createTaskChecklist(task.id, template.id);

    const validation = qualityService.validateQualityGates(task.id);
    expect(validation.passed).toBe(false);
    expect(validation.failures.length).toBeGreaterThan(0);
  });

  it('generates quality report', () => {
    const template = qualityRepo.createTemplate({
      name: 'Test Report',
      category: 'testing',
      isRequired: true,
      items: [{ title: 'Tests pass', required: true }],
    });
    const task = taskRepo.createTask({ featureId, title: 'Report task', createdBy: 'test-user' });
    qualityRepo.createTaskChecklist(task.id, template.id);

    const report = qualityService.getQualityReport(task.id);
    expect(report.taskId).toBe(task.id);
    expect(report.checklists.length).toBeGreaterThan(0);
    expect(report.overallStatus).toBe('blocked');
    expect(report.canApprove).toBe(false);
  });

  it('returns approval status', () => {
    const template = qualityRepo.createTemplate({
      name: 'Test Approval',
      category: 'testing',
      isRequired: true,
      items: [{ title: 'Tests pass', required: true }],
    });
    const task = taskRepo.createTask({ featureId, title: 'Approval task', createdBy: 'test-user' });
    qualityRepo.createTaskChecklist(task.id, template.id);

    const status = qualityService.getApprovalStatus(task.id);
    expect(status.canBeApproved).toBe(false);
    expect(status.reasons.length).toBeGreaterThan(0);
  });

  it('seeds default templates', () => {
    qualityRepo.seedDefaultTemplates();
    const templates = qualityRepo.listTemplates();
    const categories = templates.map(t => t.category);
    expect(categories).toContain('code_review');
    expect(categories).toContain('testing');
    expect(categories).toContain('documentation');
    expect(categories).toContain('deployment');
  });
});

describe('Submit Task Quality Gate Validation', () => {
  let featureId: string;
  let agentId: string;

  beforeEach(async () => {
    await initTestDb();

    const { board, columns } = boardService.createBoard({ name: 'Test Board', defaultColumns: true });
    const feature = featureRepo.createFeature({
      boardId: board.id,
      columnId: columns[0].id,
      title: 'Quality Submit Test',
      createdBy: 'test-user',
    });
    featureId = feature.id;

    const { agent } = agentRepo.createAgent({
      name: `submit-test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'claude-code',
      domain: 'fullstack',
      capabilities: ['typescript'],
    });
    agentId = agent.id;
  });

  afterEach(() => {
    closeDb();
  });

  function prepareTaskForSubmit() {
    const task = taskRepo.createTask({
      featureId,
      title: 'Submit test task',
      createdBy: 'test-user',
    });
    claimTask(task.id, agentId);
    startTask(task.id, agentId);
    return task;
  }

  it('submitTask returns error when quality gates are not met', () => {
    qualityRepo.seedDefaultTemplates();
    const task = prepareTaskForSubmit();

    const result = submitTask(task.id, agentId, 'Done', []);

    expect(result.task).toBeNull();
    expect(result.error).toBe('QUALITY_GATES_NOT_MET');
    expect(result.missingQualityItems).toBeDefined();
    expect(result.missingQualityItems!.length).toBeGreaterThan(0);
  });

  it('submitTask proceeds normally when all gates are complete', () => {
    qualityRepo.seedDefaultTemplates();
    const task = prepareTaskForSubmit();

    const checklists = qualityRepo.getTaskChecklists(task.id);
    for (const checklist of checklists) {
      const items = qualityRepo.getChecklistItems(checklist.id);
      for (const item of items) {
        qualityRepo.updateChecklistItem(checklist.id, item.id, { isCompleted: true });
      }
      qualityRepo.updateChecklistStatus(checklist.id);
    }

    const result = submitTask(task.id, agentId, 'Done', []);

    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('submitted');
    expect(result.error).toBeUndefined();
  });

  it('submitTask proceeds when no checklists exist for the task', () => {
    const task = prepareTaskForSubmit();

    const result = submitTask(task.id, agentId, 'Done with no checklists', []);

    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('submitted');
    expect(result.error).toBeUndefined();
  });

  it('integration: create task with checklists -> submit blocked -> complete checklists -> submit succeeds', () => {
    qualityRepo.seedDefaultTemplates();
    const task = prepareTaskForSubmit();

    const firstResult = submitTask(task.id, agentId, 'Attempt 1', []);
    expect(firstResult.task).toBeNull();
    expect(firstResult.error).toBe('QUALITY_GATES_NOT_MET');

    const checklists = qualityRepo.getTaskChecklists(task.id);
    for (const checklist of checklists) {
      const items = qualityRepo.getChecklistItems(checklist.id);
      for (const item of items) {
        qualityRepo.updateChecklistItem(checklist.id, item.id, { isCompleted: true });
      }
      qualityRepo.updateChecklistStatus(checklist.id);
    }

    const secondResult = submitTask(task.id, agentId, 'Attempt 2', []);
    expect(secondResult.task).not.toBeNull();
    expect(secondResult.task!.status).toBe('submitted');
    expect(secondResult.error).toBeUndefined();
  });
});
