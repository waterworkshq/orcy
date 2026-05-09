import { describe, it, expect } from 'vitest';
import { validateTransition } from '../services/tasks/index.js';
import type { TaskStatus } from '../models/index.js';

describe('Task State Machine - Complete Lifecycle', () => {
  describe('full lifecycle paths', () => {
    it('happy path: pending → claimed → in_progress → submitted → approved → done', () => {
      expect(validateTransition('pending', 'claimed')).toBe(true);
      expect(validateTransition('claimed', 'in_progress')).toBe(true);
      expect(validateTransition('in_progress', 'submitted')).toBe(true);
      expect(validateTransition('submitted', 'approved')).toBe(true);
      expect(validateTransition('approved', 'done')).toBe(true);
    });

    it('rejection path: submitted → rejected → in_progress → submitted → approved', () => {
      expect(validateTransition('submitted', 'rejected')).toBe(true);
      expect(validateTransition('rejected', 'in_progress')).toBe(true);
      expect(validateTransition('in_progress', 'submitted')).toBe(true);
    });

    it('failure path: in_progress → failed → pending → claimed', () => {
      expect(validateTransition('in_progress', 'failed')).toBe(true);
      expect(validateTransition('failed', 'pending')).toBe(true);
      expect(validateTransition('pending', 'claimed')).toBe(true);
    });

    it('release path: claimed → pending → claimed (re-claim)', () => {
      expect(validateTransition('claimed', 'pending')).toBe(true);
      expect(validateTransition('pending', 'claimed')).toBe(true);
    });

    it('release path: in_progress → pending → claimed', () => {
      expect(validateTransition('in_progress', 'pending')).toBe(true);
      expect(validateTransition('pending', 'claimed')).toBe(true);
    });
  });

  describe('invalid transitions that must be blocked', () => {
    const invalidPairs: [string, string][] = [
      ['pending', 'in_progress'],
      ['pending', 'submitted'],
      ['pending', 'approved'],
      ['pending', 'done'],
      ['claimed', 'submitted'],
      ['claimed', 'approved'],
      ['claimed', 'done'],
      ['in_progress', 'approved'],
      ['in_progress', 'done'],
      ['submitted', 'pending'],
      ['submitted', 'in_progress'],
      ['approved', 'pending'],
      ['approved', 'in_progress'],
      ['approved', 'submitted'],
      ['rejected', 'claimed'],
      ['rejected', 'submitted'],
      ['rejected', 'approved'],
      ['done', 'pending'],
      ['done', 'claimed'],
      ['done', 'in_progress'],
      ['failed', 'claimed'],
      ['failed', 'in_progress'],
      ['failed', 'submitted'],
    ];

    invalidPairs.forEach(([from, to]) => {
      it(`cannot: ${from} → ${to}`, () => {
        expect(validateTransition(from as TaskStatus, to as TaskStatus)).toBe(false);
      });
    });
  });

  describe('terminal and non-terminal states', () => {
    it('done is terminal - no outbound transitions', () => {
      const allStatuses = [
        'pending', 'claimed', 'in_progress', 'submitted',
        'approved', 'rejected', 'done', 'failed'
      ] as const;
      for (const status of allStatuses) {
        expect(validateTransition('done', status)).toBe(false);
      }
    });

    it('failed can retry back to pending', () => {
      expect(validateTransition('failed', 'pending')).toBe(true);
    });

    it('rejected can return to in_progress for rework', () => {
      expect(validateTransition('rejected', 'in_progress')).toBe(true);
    });
  });

  describe('idempotent transitions', () => {
    it('status to same status is always invalid (no-op transitions blocked)', () => {
      const allStatuses = [
        'pending', 'claimed', 'in_progress', 'submitted',
        'approved', 'rejected', 'done', 'failed'
      ] as const;
      for (const status of allStatuses) {
        expect(validateTransition(status, status)).toBe(false);
      }
    });
  });
});

describe('Claiming Rules Validation', () => {
  it('only pending tasks can be claimed', () => {
    expect(validateTransition('pending', 'claimed')).toBe(true);
    expect(validateTransition('claimed', 'claimed')).toBe(false);
    expect(validateTransition('in_progress', 'claimed')).toBe(false);
    expect(validateTransition('submitted', 'claimed')).toBe(false);
    expect(validateTransition('rejected', 'claimed')).toBe(false);
    expect(validateTransition('done', 'claimed')).toBe(false);
    expect(validateTransition('failed', 'claimed')).toBe(false);
  });

  it('a claimed task cannot be claimed by another agent', () => {
    expect(validateTransition('claimed', 'claimed')).toBe(false);
  });

  it('failed task can be re-claimed after system retry', () => {
    expect(validateTransition('failed', 'pending')).toBe(true);
  });

  it('rejected task returns to in_progress, not pending', () => {
    expect(validateTransition('rejected', 'in_progress')).toBe(true);
    expect(validateTransition('rejected', 'pending')).toBe(false);
  });
});
