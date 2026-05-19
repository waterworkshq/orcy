import { describe, it, expect, vi } from 'vitest';
import type { Task, TaskPriority, Mission, Agent } from '../models/index.js';
import { scoreTask, computeSlaUrgencyWeight, computeCapabilityWeight } from '../services/taskScoring.js';

const mockGetMissionById = vi.hoisted(() => vi.fn<(missionId: string) => Mission | null>().mockReturnValue(null));

vi.mock('../repositories/feature.js', () => ({
  getMissionById: mockGetMissionById,
}));

function makeMission(overrides?: Partial<Mission>): Mission {
  const now = new Date().toISOString();
  return {
    id: 'feat-1', habitatId: 'habitat-1', columnId: 'col-1',
    title: 'Test', description: '', acceptanceCriteria: '',
    priority: 'medium', labels: [], status: 'not_started',
    displayOrder: 0, dependsOn: [], blocks: [],
    dueAt: null, slaMinutes: null, slaDeadlineAt: null,
    createdBy: 'test', createdAt: now, updatedAt: now,
    version: 1, actualMinutes: null, plannedMinutes: null,
    planningAccuracy: null, completedAt: null, isArchived: false,
    sprintId: null,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'priority' | 'createdAt'>): Task {
  return {
    missionId: 'feat-1',
    description: '',
    assignedAgentId: null,
    delegatedToAgentId: null,
    requiredDomain: null,
    requiredCapabilities: [],
    status: 'pending',
    claimedAt: null,
    startedAt: null,
    submittedAt: null,
    completedAt: null,
    rejectedCount: 0,
    rejectionReason: null,
    result: null,
    artifacts: [],
    order: 0,
    createdBy: 'system',
    updatedAt: new Date().toISOString(),
    version: 1,
    estimatedMinutes: null,
    retryPolicy: null,
    retryCount: 0,
    nextRetryAt: null,
    actualMinutes: null,
    cycleTimeMinutes: null,
    leadTimeMinutes: null,
    estimationAccuracy: null,
    labels: [],
    ...overrides,
  };
}

describe('taskSuggestion scoring factors', () => {
  it('critical priority scores higher than low priority', () => {
    const now = new Date().toISOString();
    const critical = makeTask({ id: '1', title: 'critical', priority: 'critical', createdAt: now });
    const low = makeTask({ id: '2', title: 'low', priority: 'low', createdAt: now });

    expect(scoreTask(critical)).toBeGreaterThan(scoreTask(low));
  });

  it('overdue task scores higher than non-overdue', () => {
    const now = new Date().toISOString();
    mockGetMissionById.mockImplementation((id: string) => {
      if (id === 'feat-overdue') return makeMission({ dueAt: new Date(Date.now() - 86400000).toISOString() });
      return makeMission({ dueAt: null });
    });
    const overdue = makeTask({
      id: '1', title: 'overdue', priority: 'medium', createdAt: now, missionId: 'feat-overdue',
    });
    const future = makeTask({
      id: '2', title: 'future', priority: 'medium', createdAt: now, missionId: 'feat-future',
    });

    expect(scoreTask(overdue)).toBeGreaterThan(scoreTask(future));
  });

  it('domain match adds to score', () => {
    const now = new Date().toISOString();
    const task = makeTask({ id: '1', title: 't', priority: 'low', createdAt: now, requiredDomain: 'backend' });

    expect(scoreTask(task, 'backend')).toBeGreaterThan(scoreTask(task, 'frontend'));
  });

  it('capability match adds to score', () => {
    const now = new Date().toISOString();
    const task = makeTask({ id: '1', title: 't', priority: 'low', createdAt: now, requiredCapabilities: ['typescript'] });

    expect(scoreTask(task, undefined, ['typescript'])).toBeGreaterThan(scoreTask(task, undefined, ['python']));
  });

  it('priority contribution matches expected weights', () => {
    const priorities: TaskPriority[] = ['critical', 'high', 'medium', 'low'];
    const expectedWeights: Record<TaskPriority, number> = { critical: 40, high: 30, medium: 20, low: 10 };
    const now = new Date().toISOString();

    for (const p of priorities) {
      const task = makeTask({ id: p, title: p, priority: p, createdAt: now });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(expectedWeights[p]);
    }
  });

  it('older tasks score slightly higher due to age', () => {
    const fresh = makeTask({ id: '1', title: 'fresh', priority: 'low', createdAt: new Date().toISOString() });
    const old = makeTask({ id: '2', title: 'old', priority: 'low', createdAt: new Date(Date.now() - 10 * 86400000).toISOString() });

    expect(scoreTask(old)).toBeGreaterThan(scoreTask(fresh));
  });

  it('domain specialization provides bonus', () => {
    const now = new Date().toISOString();
    const task = makeTask({
      id: '1', title: 'backend task', priority: 'medium', createdAt: now,
      requiredDomain: 'backend',
    });

    const scoreWithoutDomain = scoreTask(task, 'frontend');
    const scoreWithDomain = scoreTask(task, 'backend');

    expect(scoreWithDomain - scoreWithoutDomain).toBeGreaterThanOrEqual(10);
  });

  it('computeCapabilityWeight is 0 with no domain or capabilities', () => {
    const now = new Date().toISOString();
    const task = makeTask({ id: '1', title: 't', priority: 'low', createdAt: now, requiredDomain: 'backend', requiredCapabilities: ['typescript'] });
    expect(computeCapabilityWeight(task)).toBe(0);
    expect(computeCapabilityWeight(task, undefined)).toBe(0);
    expect(computeCapabilityWeight(task, undefined, [])).toBe(0);
  });

  it('computeCapabilityWeight domain match adds exactly 10', () => {
    const now = new Date().toISOString();
    const task = makeTask({ id: '1', title: 't', priority: 'low', createdAt: now, requiredDomain: 'backend' });

    const matched = computeCapabilityWeight(task, 'backend');
    const unmatched = computeCapabilityWeight(task, 'frontend');

    expect(matched).toBe(10);
    expect(unmatched).toBe(0);
  });

  it('computeCapabilityWeight capability match adds up to 10', () => {
    const now = new Date().toISOString();
    const task = makeTask({ id: '1', title: 't', priority: 'low', createdAt: now, requiredCapabilities: ['typescript', 'node'] });

    expect(computeCapabilityWeight(task, undefined, ['typescript'])).toBe(5);
    expect(computeCapabilityWeight(task, undefined, ['typescript', 'node'])).toBe(10);
    expect(computeCapabilityWeight(task, undefined, ['python'])).toBe(0);
    expect(computeCapabilityWeight(task, undefined, ['typescript', 'python'])).toBe(5);
  });

  it('computeCapabilityWeight domain + capability match stacks to 20', () => {
    const now = new Date().toISOString();
    const task = makeTask({ id: '1', title: 't', priority: 'low', createdAt: now, requiredDomain: 'backend', requiredCapabilities: ['typescript', 'node'] });

    const weight = computeCapabilityWeight(task, 'backend', ['typescript', 'node']);
    expect(weight).toBe(20);
  });

  it('scoreTask domain match contribution is exactly 10, not double-counted', () => {
    const now = new Date().toISOString();
    const task = makeTask({ id: '1', title: 't', priority: 'low', createdAt: now, requiredDomain: 'backend' });

    const diff = scoreTask(task, 'backend') - scoreTask(task, undefined);
    expect(diff).toBe(10);
  });

  it('combined factors produce higher scores for well-matched tasks', () => {
    const now = new Date().toISOString();
    mockGetMissionById.mockReturnValue(makeMission({ dueAt: null }));
    const wellMatched = makeTask({
      id: '1', title: 'matched', priority: 'critical', createdAt: new Date(Date.now() - 5 * 86400000).toISOString(),
      requiredDomain: 'backend',
      requiredCapabilities: ['typescript', 'node'],
    });
    const poorlyMatched = makeTask({
      id: '2', title: 'unmatched', priority: 'low', createdAt: now,
      requiredDomain: 'frontend',
      requiredCapabilities: ['react'],
    });

    const scoreWell = scoreTask(wellMatched, 'backend', ['typescript', 'node']);
    const scorePoor = scoreTask(poorlyMatched, 'backend', ['typescript', 'node']);

    expect(scoreWell).toBeGreaterThan(scorePoor);
  });
});

describe('SLA urgency is not double-counted', () => {
  it('computeSlaUrgencyWeight returns correct values for each threshold', () => {
    expect(computeSlaUrgencyWeight(null)).toBe(0);
    expect(computeSlaUrgencyWeight(new Date(Date.now() + 10 * 86400000).toISOString())).toBe(0);
    expect(computeSlaUrgencyWeight(new Date(Date.now() - 1).toISOString())).toBe(35);
    expect(computeSlaUrgencyWeight(new Date(Date.now() + 12 * 3600000).toISOString())).toBe(28);
    expect(computeSlaUrgencyWeight(new Date(Date.now() + 2 * 86400000).toISOString())).toBe(18);
    expect(computeSlaUrgencyWeight(new Date(Date.now() + 5 * 86400000).toISOString())).toBe(8);
  });

  it('scoreTask already includes SLA urgency weight', () => {
    const now = new Date().toISOString();
    const breachedSla = new Date(Date.now() - 1000).toISOString();
    mockGetMissionById.mockImplementation((id: string) => {
      if (id === 'feat-sla') return makeMission({ slaDeadlineAt: breachedSla });
      return makeMission({ slaDeadlineAt: null });
    });

    const slaTask = makeTask({
      id: 'sla', title: 'sla', priority: 'medium', createdAt: now, missionId: 'feat-sla',
    });
    const noSlaTask = makeTask({
      id: 'nosla', title: 'nosla', priority: 'medium', createdAt: now, missionId: 'feat-nosla',
    });

    const scoreDiff = scoreTask(slaTask) - scoreTask(noSlaTask);
    expect(scoreDiff).toBe(35);
  });

  it('scoreTask SLA contribution is exactly computeSlaUrgencyWeight output', () => {
    const now = new Date().toISOString();
    const within24h = new Date(Date.now() + 12 * 3600000).toISOString();
    mockGetMissionById.mockImplementation((id: string) => {
      if (id === 'feat-sla') return makeMission({ slaDeadlineAt: within24h });
      return makeMission({ slaDeadlineAt: null });
    });

    const slaTask = makeTask({
      id: 'sla', title: 'sla', priority: 'low', createdAt: now, missionId: 'feat-sla',
    });
    const noSlaTask = makeTask({
      id: 'nosla', title: 'nosla', priority: 'low', createdAt: now, missionId: 'feat-nosla',
    });

    const expectedWeight = computeSlaUrgencyWeight(within24h);
    const scoreDiff = scoreTask(slaTask) - scoreTask(noSlaTask);
    expect(scoreDiff).toBe(expectedWeight);
  });
});
