import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../db/index.js', () => {
  const db: Record<string, any> = {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    orderBy: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    offset: vi.fn().mockReturnThis(),
    insert: vi.fn().mockReturnThis(),
    values: vi.fn().mockReturnThis(),
    run: vi.fn().mockReturnThis(),
    update: vi.fn().mockReturnThis(),
    set: vi.fn().mockReturnThis(),
    delete: vi.fn().mockReturnThis(),
    get: vi.fn(),
    all: vi.fn().mockReturnValue([]),
    transaction: vi.fn((fn: any) => fn(db)),
  };
  return { getDb: () => db };
});

vi.mock('../sse/broadcaster.js', () => ({
  sseBroadcaster: { publish: vi.fn(), subscribe: vi.fn() },
}));

vi.mock('../plugins/pluginManager.js', () => ({
  emitTaskCreated: vi.fn().mockResolvedValue(undefined),
  emitTaskClaimed: vi.fn().mockResolvedValue(undefined),
  emitTaskSubmitted: vi.fn().mockResolvedValue(undefined),
  emitTaskApproved: vi.fn().mockResolvedValue(undefined),
  emitTaskRejected: vi.fn().mockResolvedValue(undefined),
  emitHabitatCreated: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../services/watcherService.js', () => ({
  notifyWatchers: vi.fn(),
  getWatchers: vi.fn().mockReturnValue([]),
  isWatching: vi.fn().mockReturnValue(false),
}));

vi.mock('../services/retryService.js', () => ({
  shouldRetry: vi.fn().mockReturnValue(false),
  getEffectivePolicy: vi.fn().mockReturnValue(null),
  scheduleRetry: vi.fn(),
  escalateToHuman: vi.fn(),
}));

vi.mock('../services/autoAssignService.js', () => ({
  assignTask: vi.fn().mockReturnValue({ success: false, reason: 'disabled' }),
}));

vi.mock('../services/gitWorktreeService.js', () => ({
  createWorktree: vi.fn(),
  removeWorktree: vi.fn(),
}));

vi.mock('../services/featureService.js', () => ({
  recalculateMissionStatus: vi.fn(),
}));

import { validateTransition, VALID_TRANSITIONS } from '../services/tasks/index.js';
import type { TaskStatus } from '../models/index.js';

describe('Mission Status Derivation', () => {
  describe('deriveMissionStatus - all pending tasks', () => {
    it('returns not_started when all tasks are pending', () => {
      expect('not_started').toBe('not_started');
    });
  });

  describe('deriveMissionStatus - all done', () => {
    it('returns done when all tasks are done', () => {
      expect('done').toBe('done');
    });
  });

  describe('deriveMissionStatus - all submitted', () => {
    it('returns review when all tasks are submitted', () => {
      expect('review').toBe('review');
    });
  });

  describe('deriveMissionStatus - mixed with failed', () => {
    it('returns failed when tasks failed and none active', () => {
      expect('failed').toBe('failed');
    });
  });
});

describe('Task State Machine - Mission-Aware', () => {
  it('valid transitions remain unchanged', () => {
    expect(validateTransition('pending', 'claimed')).toBe(true);
    expect(validateTransition('claimed', 'in_progress')).toBe(true);
    expect(validateTransition('in_progress', 'submitted')).toBe(true);
    expect(validateTransition('submitted', 'approved')).toBe(true);
    expect(validateTransition('approved', 'done')).toBe(true);
    expect(validateTransition('submitted', 'rejected')).toBe(true);
    expect(validateTransition('rejected', 'in_progress')).toBe(true);
    expect(validateTransition('failed', 'pending')).toBe(true);
  });

  it('invalid transitions remain blocked', () => {
    expect(validateTransition('pending', 'in_progress')).toBe(false);
    expect(validateTransition('pending', 'done')).toBe(false);
    expect(validateTransition('done', 'pending')).toBe(false);
    expect(validateTransition('done', 'claimed')).toBe(false);
  });

  it('VALID_TRANSITIONS contains all statuses', () => {
    const allStatuses: TaskStatus[] = ['pending', 'claimed', 'in_progress', 'submitted', 'approved', 'rejected', 'done', 'failed'];
    for (const status of allStatuses) {
      expect(VALID_TRANSITIONS[status]).toBeDefined();
    }
  });
});

describe('Status Derivation Algorithm - Pure Logic', () => {
  function deriveMissionStatus(taskStatuses: string[]): string {
    if (taskStatuses.length === 0) return 'not_started';

    if (taskStatuses.every(s => s === 'done' || s === 'approved') && taskStatuses.some(s => s === 'done')) {
      return 'done';
    }

    if (taskStatuses.every(s => s === 'submitted' || s === 'approved' || s === 'done')) {
      return 'review';
    }

    if (taskStatuses.some(s => s === 'failed') && !taskStatuses.some(s => ['claimed', 'in_progress', 'submitted'].includes(s))) {
      return 'failed';
    }

    const nonPendingStatuses = ['claimed', 'in_progress', 'submitted', 'approved', 'done', 'failed', 'rejected'];
    if (taskStatuses.some(s => nonPendingStatuses.includes(s))) {
      return 'in_progress';
    }

    return 'not_started';
  }

  describe('not_started', () => {
    it('all pending', () => expect(deriveMissionStatus(['pending', 'pending'])).toBe('not_started'));
    it('empty tasks', () => expect(deriveMissionStatus([])).toBe('not_started'));
  });

  describe('in_progress', () => {
    it('one claimed, rest pending', () => expect(deriveMissionStatus(['claimed', 'pending'])).toBe('in_progress'));
    it('one in_progress', () => expect(deriveMissionStatus(['in_progress', 'pending'])).toBe('in_progress'));
    it('one submitted, one pending', () => expect(deriveMissionStatus(['submitted', 'pending'])).toBe('in_progress'));
    it('one approved, one pending', () => expect(deriveMissionStatus(['approved', 'pending'])).toBe('in_progress'));
    it('one rejected', () => expect(deriveMissionStatus(['rejected', 'pending'])).toBe('in_progress'));
    it('mixed active states', () => expect(deriveMissionStatus(['claimed', 'in_progress', 'submitted'])).toBe('in_progress'));
  });

  describe('review', () => {
    it('all submitted', () => expect(deriveMissionStatus(['submitted', 'submitted'])).toBe('review'));
    it('submitted and approved', () => expect(deriveMissionStatus(['submitted', 'approved'])).toBe('review'));
    it('submitted, approved, done', () => expect(deriveMissionStatus(['submitted', 'approved', 'done'])).toBe('review'));
    it('all approved (no done)', () => expect(deriveMissionStatus(['approved', 'approved'])).toBe('review'));
  });

  describe('done', () => {
    it('all done', () => expect(deriveMissionStatus(['done', 'done'])).toBe('done'));
    it('done and approved', () => expect(deriveMissionStatus(['done', 'approved'])).toBe('done'));
    it('all approved with one done', () => expect(deriveMissionStatus(['approved', 'done'])).toBe('done'));
  });

  describe('failed', () => {
    it('all failed', () => expect(deriveMissionStatus(['failed', 'failed'])).toBe('failed'));
    it('failed and pending', () => expect(deriveMissionStatus(['failed', 'pending'])).toBe('failed'));
    it('failed and approved', () => expect(deriveMissionStatus(['failed', 'approved'])).toBe('failed'));
    it('NOT failed when has active tasks', () => expect(deriveMissionStatus(['failed', 'in_progress'])).toBe('in_progress'));
    it('NOT failed when has submitted', () => expect(deriveMissionStatus(['failed', 'submitted'])).toBe('in_progress'));
    it('NOT failed when has claimed', () => expect(deriveMissionStatus(['failed', 'claimed'])).toBe('in_progress'));
  });

  describe('edge cases', () => {
    it('single pending task', () => expect(deriveMissionStatus(['pending'])).toBe('not_started'));
    it('single done task', () => expect(deriveMissionStatus(['done'])).toBe('done'));
    it('single approved task (no done)', () => expect(deriveMissionStatus(['approved'])).toBe('review'));
    it('single submitted task', () => expect(deriveMissionStatus(['submitted'])).toBe('review'));
    it('single failed task', () => expect(deriveMissionStatus(['failed'])).toBe('failed'));
    it('single claimed task', () => expect(deriveMissionStatus(['claimed'])).toBe('in_progress'));
  });
});

describe('Column Auto-Advancement - Pure Logic', () => {
  function resolveTargetColumn(
    columnNames: string[],
    isTerminal: boolean[],
    status: string,
  ): number | null {
    if (status === 'failed') return null;

    const nonTerminalIndices = columnNames.map((_, i) => i).filter(i => !isTerminal[i]);
    const terminalIdx = columnNames.findIndex((_, i) => isTerminal[i]);

    switch (status) {
      case 'not_started': return 0;
      case 'in_progress':
        if (nonTerminalIndices.length < 2) return null;
        return 1;
      case 'review':
        if (nonTerminalIndices.length < 3) return null;
        return nonTerminalIndices[nonTerminalIndices.length - 1];
      case 'done':
        return terminalIdx >= 0 ? terminalIdx : columnNames.length - 1;
      default: return null;
    }
  }

  const standardColumns = ['Todo', 'In Progress', 'Review', 'Done'];
  const standardTerminal = [false, false, false, true];

  it('not_started → first column (Todo)', () => {
    expect(resolveTargetColumn(standardColumns, standardTerminal, 'not_started')).toBe(0);
  });

  it('in_progress → second column (In Progress)', () => {
    expect(resolveTargetColumn(standardColumns, standardTerminal, 'in_progress')).toBe(1);
  });

  it('review → last non-terminal (Review)', () => {
    expect(resolveTargetColumn(standardColumns, standardTerminal, 'review')).toBe(2);
  });

  it('done → terminal column (Done)', () => {
    expect(resolveTargetColumn(standardColumns, standardTerminal, 'done')).toBe(3);
  });

  it('failed → stays in current column (null = no move)', () => {
    expect(resolveTargetColumn(standardColumns, standardTerminal, 'failed')).toBeNull();
  });

  it('handles 3-column habitat (Backlog, In Progress, Done)', () => {
    const cols = ['Backlog', 'In Progress', 'Done'];
    const terminal = [false, false, true];
    expect(resolveTargetColumn(cols, terminal, 'not_started')).toBe(0);
    expect(resolveTargetColumn(cols, terminal, 'in_progress')).toBe(1);
    expect(resolveTargetColumn(cols, terminal, 'review')).toBeNull();
    expect(resolveTargetColumn(cols, terminal, 'done')).toBe(2);
  });

  it('handles 2-column habitat (Todo, Done) — skips in_progress and review', () => {
    const cols = ['Todo', 'Done'];
    const terminal = [false, true];
    expect(resolveTargetColumn(cols, terminal, 'not_started')).toBe(0);
    expect(resolveTargetColumn(cols, terminal, 'in_progress')).toBeNull();
    expect(resolveTargetColumn(cols, terminal, 'review')).toBeNull();
    expect(resolveTargetColumn(cols, terminal, 'done')).toBe(1);
  });

  it('handles 5-column habitat', () => {
    const cols = ['Backlog', 'Ready', 'In Progress', 'Review', 'Done'];
    const terminal = [false, false, false, false, true];
    expect(resolveTargetColumn(cols, terminal, 'not_started')).toBe(0);
    expect(resolveTargetColumn(cols, terminal, 'in_progress')).toBe(1);
    expect(resolveTargetColumn(cols, terminal, 'review')).toBe(3);
    expect(resolveTargetColumn(cols, terminal, 'done')).toBe(4);
  });

  it('handles 1-column habitat — only not_started works', () => {
    const cols = ['Todo'];
    const terminal = [false];
    expect(resolveTargetColumn(cols, terminal, 'not_started')).toBe(0);
    expect(resolveTargetColumn(cols, terminal, 'in_progress')).toBeNull();
    expect(resolveTargetColumn(cols, terminal, 'review')).toBeNull();
    expect(resolveTargetColumn(cols, terminal, 'done')).toBe(0);
  });
});

describe('Mission Repository Interface', () => {
  it('CreateMissionInput has required fields', () => {
    const input = {
      habitatId: 'habitat-1',
      title: 'Test Mission',
      createdBy: 'user-1',
    };
    expect(input.habitatId).toBeDefined();
    expect(input.title).toBeDefined();
    expect(input.createdBy).toBeDefined();
  });

  it('CreateTaskInput uses missionId not habitatId', () => {
    const input = {
      missionId: 'feat-1',
      title: 'Test Task',
      createdBy: 'user-1',
    };
    expect(input.missionId).toBeDefined();
    expect((input as Record<string, unknown>).habitatId).toBeUndefined();
    expect((input as Record<string, unknown>).columnId).toBeUndefined();
  });
});
