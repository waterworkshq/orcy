import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createFeatureSchema,
  updateFeatureSchema,
  featureQuerySchema,
  moveFeatureSchema,
  createTaskInFeatureSchema,
} from '../models/schemas.js';

describe('Feature Zod Schemas', () => {
  describe('createFeatureSchema', () => {
    it('accepts valid minimal input', () => {
      const result = createFeatureSchema.safeParse({ title: 'My Feature' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe('My Feature');
        expect(result.data.description).toBe('');
        expect(result.data.acceptanceCriteria).toBe('');
        expect(result.data.priority).toBe('medium');
        expect(result.data.labels).toEqual([]);
        expect(result.data.dependsOn).toEqual([]);
        expect(result.data.blocks).toEqual([]);
      }
    });

    it('accepts full valid input', () => {
      const input = {
        title: 'Full Feature',
        description: 'A detailed description',
        acceptanceCriteria: 'AC1, AC2',
        priority: 'critical',
        labels: ['backend', 'api'],
        dependsOn: ['00000000-0000-0000-0000-000000000001'],
        blocks: ['00000000-0000-0000-0000-000000000002'],
        dueAt: '2026-05-01T00:00:00Z',
        slaMinutes: 120,
        columnId: '00000000-0000-0000-0000-000000000003',
      };
      const result = createFeatureSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('rejects empty title', () => {
      const result = createFeatureSchema.safeParse({ title: '' });
      expect(result.success).toBe(false);
    });

    it('rejects title over 500 chars', () => {
      const result = createFeatureSchema.safeParse({ title: 'x'.repeat(501) });
      expect(result.success).toBe(false);
    });

    it('rejects invalid priority', () => {
      const result = createFeatureSchema.safeParse({ title: 'Feature', priority: 'urgent' });
      expect(result.success).toBe(false);
    });

    it('rejects non-UUID dependsOn', () => {
      const result = createFeatureSchema.safeParse({ title: 'Feature', dependsOn: ['not-a-uuid'] });
      expect(result.success).toBe(false);
    });

    it('rejects negative slaMinutes', () => {
      const result = createFeatureSchema.safeParse({ title: 'Feature', slaMinutes: -5 });
      expect(result.success).toBe(false);
    });

    it('rejects non-datetime dueAt', () => {
      const result = createFeatureSchema.safeParse({ title: 'Feature', dueAt: 'not-a-date' });
      expect(result.success).toBe(false);
    });
  });

  describe('updateFeatureSchema', () => {
    it('accepts partial update', () => {
      const result = updateFeatureSchema.safeParse({ title: 'Updated' });
      expect(result.success).toBe(true);
    });

    it('accepts nullable dueAt', () => {
      const result = updateFeatureSchema.safeParse({ dueAt: null });
      expect(result.success).toBe(true);
    });

    it('accepts nullable slaMinutes', () => {
      const result = updateFeatureSchema.safeParse({ slaMinutes: null });
      expect(result.success).toBe(true);
    });

    it('accepts version for optimistic locking', () => {
      const result = updateFeatureSchema.safeParse({ title: 'Updated', version: 3 });
      expect(result.success).toBe(true);
    });

    it('rejects empty title', () => {
      const result = updateFeatureSchema.safeParse({ title: '' });
      expect(result.success).toBe(false);
    });

    it('rejects description over 10000 chars', () => {
      const result = updateFeatureSchema.safeParse({ description: 'x'.repeat(10001) });
      expect(result.success).toBe(false);
    });
  });

  describe('featureQuerySchema', () => {
    it('applies defaults', () => {
      const result = featureQuerySchema.safeParse({});
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(20);
        expect(result.data.offset).toBe(0);
      }
    });

    it('accepts valid status filter', () => {
      const result = featureQuerySchema.safeParse({ status: 'in_progress' });
      expect(result.success).toBe(true);
    });

    it('rejects invalid status', () => {
      const result = featureQuerySchema.safeParse({ status: 'unknown' });
      expect(result.success).toBe(false);
    });

    it('coerces string limit to number', () => {
      const result = featureQuerySchema.safeParse({ limit: '50' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.limit).toBe(50);
      }
    });

    it('rejects limit over 100', () => {
      const result = featureQuerySchema.safeParse({ limit: 200 });
      expect(result.success).toBe(false);
    });
  });

  describe('moveFeatureSchema', () => {
    it('accepts valid columnId', () => {
      const result = moveFeatureSchema.safeParse({ columnId: '00000000-0000-0000-0000-000000000001' });
      expect(result.success).toBe(true);
    });

    it('rejects non-UUID columnId', () => {
      const result = moveFeatureSchema.safeParse({ columnId: 'not-a-uuid' });
      expect(result.success).toBe(false);
    });

    it('rejects missing columnId', () => {
      const result = moveFeatureSchema.safeParse({});
      expect(result.success).toBe(false);
    });
  });

  describe('createTaskInFeatureSchema', () => {
    it('accepts valid minimal input', () => {
      const result = createTaskInFeatureSchema.safeParse({ title: 'My Task' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.title).toBe('My Task');
        expect(result.data.description).toBe('');
        expect(result.data.priority).toBe('medium');
        expect(result.data.requiredCapabilities).toEqual([]);
        expect(result.data.dependsOn).toEqual([]);
        expect(result.data.order).toBe(0);
      }
    });

    it('accepts full input', () => {
      const input = {
        title: 'Task with details',
        description: 'A description',
        priority: 'high',
        requiredDomain: 'backend',
        requiredCapabilities: ['typescript', 'node'],
        estimatedMinutes: 120,
        dependsOn: ['00000000-0000-0000-0000-000000000001'],
        order: 5,
      };
      const result = createTaskInFeatureSchema.safeParse(input);
      expect(result.success).toBe(true);
    });

    it('rejects empty title', () => {
      const result = createTaskInFeatureSchema.safeParse({ title: '' });
      expect(result.success).toBe(false);
    });

    it('rejects title over 500 chars', () => {
      const result = createTaskInFeatureSchema.safeParse({ title: 'x'.repeat(501) });
      expect(result.success).toBe(false);
    });

    it('rejects invalid priority', () => {
      const result = createTaskInFeatureSchema.safeParse({ title: 'Task', priority: 'urgent' });
      expect(result.success).toBe(false);
    });

    it('rejects negative estimatedMinutes', () => {
      const result = createTaskInFeatureSchema.safeParse({ title: 'Task', estimatedMinutes: -10 });
      expect(result.success).toBe(false);
    });
  });
});
