import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { initTestDb, closeDb, getDb } from '../db/index.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/mission.js';
import * as habitatService from '../services/habitatService.js';
import * as columnRepo from '../repositories/column.js';
import * as agentRepo from '../repositories/agent.js';
import * as timeRepo from '../repositories/timeTracking.js';
import * as timeService from '../services/timeTrackingService.js';
import * as dependencyService from '../services/dependencyService.js';
import * as qualityRepo from '../repositories/qualityGate.js';
import * as qualityService from '../services/qualityGateService.js';
import { claimTask, startTask, submitTask } from '../services/tasks/task-lifecycle.js';

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

function setupHabitat() {
  const { habitat, columns } = habitatService.createHabitat({ name: 'Test Habitat', defaultColumns: true });
  habitatId = habitat.id;
  columnId = columns[0].id;

  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: 'Test Mission',
    createdBy: 'test-user',
  });
  missionId = mission.id;

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
  setupHabitat();
});

afterEach(() => {
  closeDb();
});

describe('Time Tracking', () => {
  it('creates a time record for a task', () => {
    const task = taskRepo.createTask({
      missionId,
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
      missionId,
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
      missionId,
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
      missionId,
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

  it('returns habitat metrics', () => {
    const task1 = taskRepo.createTask({
      missionId,
      title: 'Metrics task 1',
      createdBy: 'test-user',
      estimatedMinutes: 60,
    });

    timeRepo.createTimeRecord({ taskId: task1.id, minutesSpent: 30, statusDuringWork: 'in_progress' });
    taskRepo.updateTask(task1.id, { actualMinutes: 30, completedAt: new Date().toISOString() });

    const metrics = timeService.getHabitatMetrics(habitatId);
    expect(metrics).toBeDefined();
    expect(metrics.totalActualMinutes).toBeGreaterThanOrEqual(30);
  });

  it('calculates completion metrics', () => {
    const task = taskRepo.createTask({
      missionId,
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

  it('recalculates mission metrics', () => {
    const task = taskRepo.createTask({
      missionId,
      title: 'Mission metrics task',
      createdBy: 'test-user',
      estimatedMinutes: 60,
    });

    timeRepo.createTimeRecord({ taskId: task.id, minutesSpent: 30, statusDuringWork: 'in_progress' });
    timeRepo.updateTaskTimeMetrics(task.id);
    timeRepo.recalculateMissionMetrics(missionId);

    const mission = missionRepo.getMissionById(missionId);
    expect(mission?.plannedMinutes).toBe(60);
    expect(mission?.actualMinutes).toBe(30);
  });
});

describe('Dependency Validation', () => {
  it('adds a task dependency', () => {
    const task1 = taskRepo.createTask({ missionId, title: 'Task 1', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ missionId, title: 'Task 2', createdBy: 'test-user' });

    const result = dependencyService.addTaskDependency(task1.id, task2.id);
    expect(result.success).toBe(true);
  });

  it('prevents self-dependency', () => {
    const task = taskRepo.createTask({ missionId, title: 'Self dep task', createdBy: 'test-user' });

    const result = dependencyService.addTaskDependency(task.id, task.id);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('self_dependency');
  });

  it('prevents circular dependencies', () => {
    const task1 = taskRepo.createTask({ missionId, title: 'Circular 1', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ missionId, title: 'Circular 2', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);

    const result = dependencyService.addTaskDependency(task2.id, task1.id);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('circular_dependency');
  });

  it('removes a task dependency', () => {
    const task1 = taskRepo.createTask({ missionId, title: 'Remove dep 1', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ missionId, title: 'Remove dep 2', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);
    const removed = dependencyService.removeTaskDependency(task1.id, task2.id);
    expect(removed).toBe(true);
  });

  it('gets task dependencies', () => {
    const task1 = taskRepo.createTask({ missionId, title: 'Get dep 1', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ missionId, title: 'Get dep 2', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);

    const deps = dependencyService.getTaskDependencies(task1.id);
    expect(deps.dependsOn).toHaveLength(1);
    expect(deps.dependsOn[0].taskId).toBe(task2.id);
  });

  it('validates task completion with unmet deps', () => {
    const task1 = taskRepo.createTask({ missionId, title: 'Blocked task', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ missionId, title: 'Blocking task', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);

    const validation = dependencyService.validateTaskCompletion(task1.id);
    expect(validation.canComplete).toBe(false);
    expect(validation.reason).toBe('BLOCKED_BY_DEPENDENCIES');
    expect(validation.blockedBy).toHaveLength(1);
  });

  it('validates task completion with met deps', () => {
    const task1 = taskRepo.createTask({ missionId, title: 'Unblocked task', createdBy: 'test-user' });
    const task2 = taskRepo.createTask({ missionId, title: 'Done dep', createdBy: 'test-user' });

    dependencyService.addTaskDependency(task1.id, task2.id);
    taskRepo.updateTask(task2.id, { status: 'approved', completedAt: new Date().toISOString() });

    const validation = dependencyService.validateTaskCompletion(task1.id);
    expect(validation.canComplete).toBe(true);
  });

  it('gets dependency graph for a mission', () => {
    const feat2 = missionRepo.createMission({
      habitatId,
      columnId,
      title: 'Dep Mission',
      createdBy: 'test-user',
    });

    dependencyService.addMissionDependency(feat2.id, missionId);

    const graph = dependencyService.getDependencyGraph(feat2.id);
    expect(graph.nodes.length).toBeGreaterThanOrEqual(2);
    expect(graph.edges.length).toBeGreaterThanOrEqual(1);
  });

  it('prevents mission self-dependency', () => {
    const result = dependencyService.addMissionDependency(missionId, missionId);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('self_dependency');
  });

  it('prevents circular mission dependencies across a 3-node chain', () => {
    const missionB = missionRepo.createMission({
      habitatId,
      columnId,
      title: 'Circular Mission B',
      createdBy: 'test-user',
    });
    const missionC = missionRepo.createMission({
      habitatId,
      columnId,
      title: 'Circular Mission C',
      createdBy: 'test-user',
    });

    // missionId (A) -> B -> C is the existing forward chain.
    expect(dependencyService.addMissionDependency(missionId, missionB.id).success).toBe(true);
    expect(dependencyService.addMissionDependency(missionB.id, missionC.id).success).toBe(true);

    // Closing the loop (C -> A) must be rejected by wouldCreateMissionCycle.
    const result = dependencyService.addMissionDependency(missionC.id, missionId);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('circular_dependency');
  });

  it('validateMissionCompletion fails with INCOMPLETE_TASKS when mission has undone tasks', () => {
    taskRepo.createTask({ missionId, title: 'Undone task', createdBy: 'test-user' });

    const validation = dependencyService.validateMissionCompletion(missionId);
    expect(validation.canComplete).toBe(false);
    expect(validation.reason).toBe('INCOMPLETE_TASKS');
    expect(validation.incompleteTasks).toHaveLength(1);
    expect(validation.incompleteTasks![0].title).toBe('Undone task');
  });

  it('validateMissionCompletion fails with BLOCKED_BY_FEATURE_DEPENDENCIES when upstream mission not done', () => {
    const upstream = missionRepo.createMission({
      habitatId,
      columnId,
      title: 'Upstream Mission',
      createdBy: 'test-user',
    });

    dependencyService.addMissionDependency(missionId, upstream.id);

    // missionId has no tasks, so the INCOMPLETE_TASKS branch is skipped.
    // The upstream mission defaults to "not_started", which is not "done",
    // so the BLOCKED_BY_FEATURE_DEPENDENCIES branch must fire.
    const validation = dependencyService.validateMissionCompletion(missionId);
    expect(validation.canComplete).toBe(false);
    expect(validation.reason).toBe('BLOCKED_BY_FEATURE_DEPENDENCIES');
    expect(validation.blockedBy).toHaveLength(1);
    expect(validation.blockedBy![0].taskId).toBe(upstream.id);
  });

  it('removeMissionDependency is a no-op for non-existent dependencies', () => {
    const missionX = missionRepo.createMission({
      habitatId,
      columnId,
      title: 'No Dep X',
      createdBy: 'test-user',
    });
    const missionY = missionRepo.createMission({
      habitatId,
      columnId,
      title: 'No Dep Y',
      createdBy: 'test-user',
    });

    // No dependency was ever added between missionX and missionY.
    // The repository DELETE silently affects zero rows, and the service
    // wrapper must surface that as a benign success (idempotent removal)
    // rather than throwing or returning false.
    const removed = dependencyService.removeMissionDependency(missionX.id, missionY.id);
    expect(removed).toBe(true);
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
    const task = taskRepo.createTask({ missionId, title: 'Quality task', createdBy: 'test-user' });

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
    const task = taskRepo.createTask({ missionId, title: 'Update item task', createdBy: 'test-user' });
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
    const task = taskRepo.createTask({ missionId, title: 'Status task', createdBy: 'test-user' });
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
    const task = taskRepo.createTask({ missionId, title: 'Validate task', createdBy: 'test-user' });
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
    const task = taskRepo.createTask({ missionId, title: 'Report task', createdBy: 'test-user' });
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
    const task = taskRepo.createTask({ missionId, title: 'Approval task', createdBy: 'test-user' });
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
  let localMissionId: string;
  let localAgentId: string;

  beforeEach(async () => {
    await initTestDb();

    const { habitat, columns } = habitatService.createHabitat({ name: 'Test Habitat', defaultColumns: true });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: columns[0].id,
      title: 'Quality Submit Test',
      createdBy: 'test-user',
    });
    localMissionId = mission.id;

    const { agent } = agentRepo.createAgent({
      name: `submit-test-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type: 'claude-code',
      domain: 'fullstack',
      capabilities: ['typescript'],
    });
    localAgentId = agent.id;
  });

  afterEach(() => {
    closeDb();
  });

  function prepareTaskForSubmit() {
    const task = taskRepo.createTask({
      missionId: localMissionId,
      title: 'Submit test task',
      createdBy: 'test-user',
    });
    claimTask(task.id, localAgentId);
    startTask(task.id, localAgentId);
    return task;
  }

  it('submitTask returns error when quality gates are not met', () => {
    qualityRepo.seedDefaultTemplates();
    const task = prepareTaskForSubmit();

    const result = submitTask(task.id, localAgentId, 'Done', []);

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

    const result = submitTask(task.id, localAgentId, 'Done', []);

    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('submitted');
    expect(result.error).toBeUndefined();
  });

  it('submitTask proceeds when no checklists exist for the task', () => {
    const task = prepareTaskForSubmit();

    const result = submitTask(task.id, localAgentId, 'Done with no checklists', []);

    expect(result.task).not.toBeNull();
    expect(result.task!.status).toBe('submitted');
    expect(result.error).toBeUndefined();
  });

  it('integration: create task with checklists -> submit blocked -> complete checklists -> submit succeeds', () => {
    qualityRepo.seedDefaultTemplates();
    const task = prepareTaskForSubmit();

    const firstResult = submitTask(task.id, localAgentId, 'Attempt 1', []);
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

    const secondResult = submitTask(task.id, localAgentId, 'Attempt 2', []);
    expect(secondResult.task).not.toBeNull();
    expect(secondResult.task!.status).toBe('submitted');
    expect(secondResult.error).toBeUndefined();
  });
});
