import { describe, it, expect } from 'vitest';
import { validateTransition } from '../services/tasks/index.js';
import type { TaskStatus } from '../models/index.js';

describe('Task State Machine', () => {
  describe('validateTransition', () => {
    it('pending can transition to claimed', () => {
      expect(validateTransition('pending', 'claimed')).toBe(true);
    });

    it('pending cannot transition to in_progress directly', () => {
      expect(validateTransition('pending', 'in_progress')).toBe(false);
    });

    it('claimed can transition to in_progress', () => {
      expect(validateTransition('claimed', 'in_progress')).toBe(true);
    });

    it('claimed can transition back to pending (release)', () => {
      expect(validateTransition('claimed', 'pending')).toBe(true);
    });

    it('in_progress can transition to submitted', () => {
      expect(validateTransition('in_progress', 'submitted')).toBe(true);
    });

    it('in_progress can transition back to pending (release)', () => {
      expect(validateTransition('in_progress', 'pending')).toBe(true);
    });

    it('in_progress can transition to failed', () => {
      expect(validateTransition('in_progress', 'failed')).toBe(true);
    });

    it('submitted can transition to approved', () => {
      expect(validateTransition('submitted', 'approved')).toBe(true);
    });

    it('submitted can transition to rejected', () => {
      expect(validateTransition('submitted', 'rejected')).toBe(true);
    });

    it('rejected can transition back to in_progress', () => {
      expect(validateTransition('rejected', 'in_progress')).toBe(true);
    });

    it('approved can transition to done', () => {
      expect(validateTransition('approved', 'done')).toBe(true);
    });

    it('failed can transition to pending (retry)', () => {
      expect(validateTransition('failed', 'pending')).toBe(true);
    });

    it('done cannot transition to any state', () => {
      const allStatuses: TaskStatus[] = [
        'pending', 'claimed', 'in_progress', 'submitted',
        'approved', 'rejected', 'done', 'failed'
      ];
      for (const status of allStatuses) {
        expect(validateTransition('done', status)).toBe(false);
      }
    });

    it('pending cannot skip to submitted', () => {
      expect(validateTransition('pending', 'submitted')).toBe(false);
    });

    it('in_progress cannot skip to approved', () => {
      expect(validateTransition('in_progress', 'approved')).toBe(false);
    });

    it('claimed cannot skip to submitted', () => {
      expect(validateTransition('claimed', 'submitted')).toBe(false);
    });

    it('submitted cannot transition to pending directly', () => {
      expect(validateTransition('submitted', 'pending')).toBe(false);
    });
  });
});
