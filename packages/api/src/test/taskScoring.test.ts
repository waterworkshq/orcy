import { describe, it, expect, vi, beforeEach } from 'vitest';
import { scoreTask, sortTasksBySmartScore, PRIORITY_WEIGHTS, computeCapabilityWeight } from '../services/taskScoring.js';
import type { TaskPriority, Feature } from '../models/index.js';
import { makeTask } from './factories/task.js';
import { makeFeature } from './factories/feature.js';

const mockGetFeatureById = vi.hoisted(() => vi.fn<(featureId: string) => Feature | null>().mockReturnValue(null));

vi.mock('../repositories/feature.js', () => ({
  getFeatureById: mockGetFeatureById,
}));

describe('taskScoring', () => {
  describe('scoreTask - priority weights', () => {
    const base = { id: '1', title: 't', createdAt: new Date().toISOString() };

    it('scores critical priority at 40', () => {
      const task = makeTask({ ...base, priority: 'critical' });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(40);
      expect(score).toBeLessThan(41);
    });

    it('scores high priority at 30', () => {
      const task = makeTask({ ...base, priority: 'high' });
      expect(scoreTask(task)).toBeGreaterThanOrEqual(30);
    });

    it('scores medium priority at 20', () => {
      const task = makeTask({ ...base, priority: 'medium' });
      expect(scoreTask(task)).toBeGreaterThanOrEqual(20);
    });

    it('scores low priority at 10', () => {
      const task = makeTask({ ...base, priority: 'low' });
      expect(scoreTask(task)).toBeGreaterThanOrEqual(10);
    });
  });

  describe('scoreTask - urgency weights', () => {
    const base = { id: '1', title: 't', priority: 'medium' as TaskPriority, createdAt: new Date().toISOString() };

    it('adds 30 for overdue tasks', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ dueAt: new Date(Date.now() - 86400000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(50);
    });

    it('adds 25 for tasks due within 24h', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ dueAt: new Date(Date.now() + 3600000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(45);
    });

    it('adds 15 for tasks due within 3 days', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ dueAt: new Date(Date.now() + 2 * 86400000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(35);
    });

    it('adds 5 for tasks due within 7 days', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ dueAt: new Date(Date.now() + 5 * 86400000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(25);
    });

    it('adds 0 for no due date', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ dueAt: null }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeLessThan(21);
    });
  });

  describe('scoreTask - age weights', () => {
    const base = { id: '1', title: 't', priority: 'low' as TaskPriority };

    it('gives ~0 age weight for freshly created tasks', () => {
      const task = makeTask({ ...base, createdAt: new Date().toISOString() });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(10);
      expect(score).toBeLessThan(11);
    });

    it('gives 0.5 per day age weight', () => {
      const fiveDaysAgo = new Date(Date.now() - 5 * 86400000).toISOString();
      const task = makeTask({ ...base, createdAt: fiveDaysAgo });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(12);
      expect(score).toBeLessThan(13);
    });

    it('caps age weight at 10 points', () => {
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString();
      const task = makeTask({ ...base, createdAt: thirtyDaysAgo });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(20);
      expect(score).toBeLessThan(21);
    });
  });

  describe('scoreTask - capability weights', () => {
    const base = { id: '1', title: 't', priority: 'low' as TaskPriority, createdAt: new Date().toISOString() };

    it('adds 10 for domain match', () => {
      const task = makeTask({ ...base, requiredDomain: 'backend' });
      const score = scoreTask(task, 'backend');
      expect(score).toBeGreaterThanOrEqual(20);
    });

    it('adds 0 for domain mismatch', () => {
      const task = makeTask({ ...base, requiredDomain: 'backend' });
      const score = scoreTask(task, 'frontend');
      expect(score).toBeGreaterThanOrEqual(10);
      expect(score).toBeLessThan(11);
    });

    it('adds 5 per matched capability up to 10', () => {
      const task = makeTask({ ...base, requiredCapabilities: ['typescript', 'react'] });
      const score = scoreTask(task, undefined, ['typescript', 'react']);
      expect(score).toBeGreaterThanOrEqual(20);
    });

    it('caps capability match at 10', () => {
      const task = makeTask({ ...base, requiredCapabilities: ['typescript', 'react', 'node', 'python'] });
      const score = scoreTask(task, undefined, ['typescript', 'react', 'node', 'python']);
      expect(score).toBeGreaterThanOrEqual(20);
      expect(score).toBeLessThan(21);
    });

    it('returns 0 when no agent info provided', () => {
      const task = makeTask({ ...base, requiredDomain: 'backend', requiredCapabilities: ['typescript'] });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(10);
      expect(score).toBeLessThan(11);
    });
  });

  describe('scoreTask - SLA urgency weights', () => {
    const base = { id: '1', title: 't', priority: 'medium' as TaskPriority, createdAt: new Date().toISOString() };

    it('adds 35 for breached SLA (deadline in past)', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ slaDeadlineAt: new Date(Date.now() - 86400000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(55);
    });

    it('adds 28 for SLA deadline within 24h', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ slaDeadlineAt: new Date(Date.now() + 3600000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(48);
    });

    it('adds 18 for SLA deadline within 3 days', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ slaDeadlineAt: new Date(Date.now() + 2 * 86400000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(38);
    });

    it('adds 8 for SLA deadline within 7 days', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ slaDeadlineAt: new Date(Date.now() + 5 * 86400000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(28);
    });

    it('adds 0 for SLA deadline far in the future', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ slaDeadlineAt: new Date(Date.now() + 30 * 86400000).toISOString() }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeLessThan(21);
    });

    it('adds 0 for null slaDeadlineAt', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ slaDeadlineAt: null }));
      const task = makeTask({ ...base });
      const score = scoreTask(task);
      expect(score).toBeLessThan(21);
    });

    it('null slaDeadlineAt does not affect total score', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({ slaDeadlineAt: null, dueAt: null }));
      const task = makeTask({ ...base, priority: 'medium' });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(20);
      expect(score).toBeLessThan(21);
    });

    it('SLA and due urgency weights stack', () => {
      mockGetFeatureById.mockReturnValue(makeFeature({
        dueAt: new Date(Date.now() - 86400000).toISOString(),
        slaDeadlineAt: new Date(Date.now() - 86400000).toISOString(),
      }));
      const task = makeTask({ ...base, priority: 'medium' });
      const score = scoreTask(task);
      expect(score).toBeGreaterThanOrEqual(85);
    });
  });

  describe('sortTasksBySmartScore', () => {
    it('sorts tasks by score descending', () => {
      const now = new Date().toISOString();
      const tasks = [
        makeTask({ id: '1', title: 'low', priority: 'low', createdAt: now }),
        makeTask({ id: '2', title: 'critical', priority: 'critical', createdAt: now }),
        makeTask({ id: '3', title: 'high', priority: 'high', createdAt: now }),
      ];

      const sorted = sortTasksBySmartScore(tasks);
      expect(sorted[0].id).toBe('2');
      expect(sorted[1].id).toBe('3');
      expect(sorted[2].id).toBe('1');
    });

    it('prioritizes overdue tasks over non-overdue same priority', () => {
      const now = new Date().toISOString();
      mockGetFeatureById.mockImplementation((id: string) => {
        if (id === 'feat-overdue') return makeFeature({ dueAt: new Date(Date.now() - 86400000).toISOString() });
        return makeFeature({ dueAt: null });
      });
      const taskList = [
        makeTask({ id: '1', title: 'not overdue', priority: 'medium', createdAt: now, featureId: 'feat-future' }),
        makeTask({ id: '2', title: 'overdue', priority: 'medium', createdAt: now, featureId: 'feat-overdue' }),
      ];

      const sorted = sortTasksBySmartScore(taskList);
      expect(sorted[0].id).toBe('2');
    });

    it('considers capability match in ordering', () => {
      const now = new Date().toISOString();
      const tasks = [
        makeTask({ id: '1', title: 'no match', priority: 'medium', createdAt: now, requiredCapabilities: ['python'] }),
        makeTask({ id: '2', title: 'match', priority: 'medium', createdAt: now, requiredCapabilities: ['typescript'] }),
      ];

      const sorted = sortTasksBySmartScore(tasks, undefined, ['typescript']);
      expect(sorted[0].id).toBe('2');
    });

    it('does not mutate the original array', () => {
      const now = new Date().toISOString();
      const tasks = [
        makeTask({ id: '1', title: 'low', priority: 'low', createdAt: now }),
        makeTask({ id: '2', title: 'high', priority: 'high', createdAt: now }),
      ];

      const originalOrder = tasks.map(t => t.id);
      sortTasksBySmartScore(tasks);
      expect(tasks.map(t => t.id)).toEqual(originalOrder);
    });
  });

  describe('exported PRIORITY_WEIGHTS', () => {
    it('contains all priority levels', () => {
      expect(Object.keys(PRIORITY_WEIGHTS)).toEqual(['critical', 'high', 'medium', 'low']);
    });

    it('values match scoreTask base contributions', () => {
      const now = new Date().toISOString();
      for (const [priority, weight] of Object.entries(PRIORITY_WEIGHTS)) {
        const task = makeTask({ id: priority, title: priority, priority: priority as TaskPriority, createdAt: now });
        const score = scoreTask(task);
        expect(score).toBeGreaterThanOrEqual(weight);
        expect(score).toBeLessThan(weight + 1);
      }
    });
  });

  describe('exported computeCapabilityWeight', () => {
    const base = { id: '1', title: 't', priority: 'low' as TaskPriority, createdAt: new Date().toISOString() };

    it('returns 10 for domain match', () => {
      const task = makeTask({ ...base, requiredDomain: 'backend' });
      expect(computeCapabilityWeight(task, 'backend')).toBe(10);
    });

    it('returns 0 for domain mismatch', () => {
      const task = makeTask({ ...base, requiredDomain: 'backend' });
      expect(computeCapabilityWeight(task, 'frontend')).toBe(0);
    });

    it('returns 0 when no agent info provided', () => {
      const task = makeTask({ ...base, requiredDomain: 'backend', requiredCapabilities: ['typescript'] });
      expect(computeCapabilityWeight(task)).toBe(0);
    });

    it('returns 5 per matched capability up to 10', () => {
      const task = makeTask({ ...base, requiredCapabilities: ['typescript', 'react'] });
      expect(computeCapabilityWeight(task, undefined, ['typescript', 'react'])).toBe(10);
    });
  });
});
