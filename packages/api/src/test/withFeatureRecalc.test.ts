import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { logger } from '../lib/logger.js';
import { withFeatureRecalc } from '../services/tasks/task-lifecycle.js';

describe('withFeatureRecalc', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns callback result on success', () => {
    const result = withFeatureRecalc('task-1', 'feature-1', () => 42);
    expect(result).toBe(42);
  });

  it('returns undefined when callback returns undefined', () => {
    const result = withFeatureRecalc('task-1', 'feature-1', () => {
      // no return
    });
    expect(result).toBeUndefined();
  });

  it('logs error via logger.error when callback throws', () => {
    const error = new Error('recalc failed');
    withFeatureRecalc('task-1', 'feature-1', () => {
      throw error;
    });

    expect(logger.error).toHaveBeenCalledWith(
      { err: error, taskId: 'task-1', featureId: 'feature-1' },
      'Feature recalculation failed'
    );
  });

  it('does not rethrow when callback throws', () => {
    expect(() => {
      withFeatureRecalc('task-1', 'feature-1', () => {
        throw new Error('boom');
      });
    }).not.toThrow();
  });

  it('returns undefined when callback throws', () => {
    const result = withFeatureRecalc('task-1', 'feature-1', () => {
      throw new Error('boom');
    });
    expect(result).toBeUndefined();
  });
});
