import { describe, it, expect, vi } from 'vitest';
import type { Task, TaskPriority, Feature, Agent } from '../models/index.js';
import { scoreTask, computeSlaUrgencyWeight } from '../services/taskScoring.js';

const mockGetFeatureById = vi.hoisted(() => vi.fn<(featureId: string) => Feature | null>().mockReturnValue(null));

vi.mock('../repositories/feature.js', () => ({
  getFeatureById: mockGetFeatureById,
}));

function makeFeature(overrides?: Partial<Feature>): Feature {
  const now = new Date().toISOString();
  return {
    id: 'feat-1', boardId: 'board-1', columnId: 'col-1',
    title: 'Test', description: '', acceptanceCriteria: '',
    priority: 'medium', labels: [], status: 'not_started',
    displayOrder: 0, dependsOn: [], blocks: [],
    dueAt: null, slaMinutes: null, slaDeadlineAt: null,
    createdBy: 'test', createdAt: now, updatedAt: now,
    version: 1, actualMinutes: null, plannedMinutes: null,
    planningAccuracy: null, completedAt: null, isArchived: false,
    ...overrides,
  };
}

function makeTask(overrides: Partial<Task> & Pick<Task, 'id' | 'title' | 'priority' | 'createdAt'>): Task {
  return {
    featureId: 'feat-1',
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
    mockGetFeatureById.mockImplementation((id: string) => {
      if (id === 'feat-overdue') return makeFeature({ dueAt: new Date(Date.now() - 86400000).toISOString() });
      return makeFeature({ dueAt: null });
    });
    const overdue = makeTask({
      id: '1', title: 'overdue', priority: 'medium', createdAt: now, featureId: 'feat-overdue',
    });
    const future = makeTask({
      id: '2', title: 'future', priority: 'medium', createdAt: now, featureId: 'feat-future',
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

  it('combined factors produce higher scores for well-matched tasks', () => {
    const now = new Date().toISOString();
    mockGetFeatureById.mockReturnValue(makeFeature({ dueAt: null }));
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
    mockGetFeatureById.mockImplementation((id: string) => {
      if (id === 'feat-sla') return makeFeature({ slaDeadlineAt: breachedSla });
      return makeFeature({ slaDeadlineAt: null });
    });

    const slaTask = makeTask({
      id: 'sla', title: 'sla', priority: 'medium', createdAt: now, featureId: 'feat-sla',
    });
    const noSlaTask = makeTask({
      id: 'nosla', title: 'nosla', priority: 'medium', createdAt: now, featureId: 'feat-nosla',
    });

    const scoreDiff = scoreTask(slaTask) - scoreTask(noSlaTask);
    expect(scoreDiff).toBe(35);
  });

  it('scoreTask SLA contribution is exactly computeSlaUrgencyWeight output', () => {
    const now = new Date().toISOString();
    const within24h = new Date(Date.now() + 12 * 3600000).toISOString();
    mockGetFeatureById.mockImplementation((id: string) => {
      if (id === 'feat-sla') return makeFeature({ slaDeadlineAt: within24h });
      return makeFeature({ slaDeadlineAt: null });
    });

    const slaTask = makeTask({
      id: 'sla', title: 'sla', priority: 'low', createdAt: now, featureId: 'feat-sla',
    });
    const noSlaTask = makeTask({
      id: 'nosla', title: 'nosla', priority: 'low', createdAt: now, featureId: 'feat-nosla',
    });

    const expectedWeight = computeSlaUrgencyWeight(within24h);
    const scoreDiff = scoreTask(slaTask) - scoreTask(noSlaTask);
    expect(scoreDiff).toBe(expectedWeight);
  });
});
