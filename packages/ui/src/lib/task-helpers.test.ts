import { describe, it, expect } from 'vitest';
import {
  formatDuration,
  formatTimestamp,
  getActorDisplayName,
  getStatusBadgeClass,
  getTimeComparisonClass,
  getAgentDisplayName,
  initEditForm,
} from '../lib/task-helpers.js';
import type { Task, TaskEvent } from '../types/index.js';

describe('task-helpers', () => {
  describe('formatDuration', () => {
    it('returns < 1m for durations under 60s', () => {
      expect(formatDuration(30000)).toBe('< 1m');
    });

    it('returns minutes for under 60m', () => {
      expect(formatDuration(120000)).toBe('2m');
    });

    it('returns hours and minutes', () => {
      expect(formatDuration(9000000)).toBe('2h 30m');
    });

    it('returns days and hours', () => {
      expect(formatDuration(93600000)).toBe('1d 2h');
    });
  });

  describe('formatTimestamp', () => {
    it('returns em-dash for null', () => {
      expect(formatTimestamp(null)).toBe('—');
    });

    it('returns formatted date for valid ISO string', () => {
      const result = formatTimestamp('2025-06-15T10:30:00Z');
      expect(result).toContain('Jun');
    });
  });

  describe('getActorDisplayName', () => {
    const agents = [{ id: 'agent-1', name: 'Bot' }] as any;

    it('returns agent name for agent type', () => {
      const event = { actorType: 'agent', actorId: 'agent-1', id: 'e1', taskId: 't1', action: 'created', fromColumnId: null, toColumnId: null, fromStatus: null, toStatus: null, metadata: {}, timestamp: '' } as TaskEvent;
      expect(getActorDisplayName(event, agents)).toBe('Bot');
    });

    it('returns actorId when agent not found', () => {
      const event = { actorType: 'agent', actorId: 'unknown', id: 'e1', taskId: 't1', action: 'created', fromColumnId: null, toColumnId: null, fromStatus: null, toStatus: null, metadata: {}, timestamp: '' } as TaskEvent;
      expect(getActorDisplayName(event, agents)).toBe('unknown');
    });

    it('returns system for system type', () => {
      const event = { actorType: 'system', actorId: '', id: 'e1', taskId: 't1', action: 'created', fromColumnId: null, toColumnId: null, fromStatus: null, toStatus: null, metadata: {}, timestamp: '' } as TaskEvent;
      expect(getActorDisplayName(event, agents)).toBe('system');
    });

    it('returns anonymous for unknown type with no actorId', () => {
      const event = { actorType: 'human', actorId: '', id: 'e1', taskId: 't1', action: 'created', fromColumnId: null, toColumnId: null, fromStatus: null, toStatus: null, metadata: {}, timestamp: '' } as TaskEvent;
      expect(getActorDisplayName(event, agents)).toBe('anonymous');
    });
  });

  describe('getStatusBadgeClass', () => {
    it('returns correct class for pending', () => {
      expect(getStatusBadgeClass('pending')).toContain('glass-badge-low');
    });

    it('returns correct class for in_progress', () => {
      expect(getStatusBadgeClass('in_progress')).toContain('glass-badge-active');
    });

    it('returns correct class for done', () => {
      expect(getStatusBadgeClass('done')).toContain('glass-badge-done');
    });

    it('returns default class for unknown status', () => {
      expect(getStatusBadgeClass('unknown' as any)).toContain('glass-badge-low');
    });
  });

  describe('getTimeComparisonClass', () => {
    it('returns red for positive diff', () => {
      expect(getTimeComparisonClass(1)).toContain('text-red-600');
    });

    it('returns green for negative diff', () => {
      expect(getTimeComparisonClass(-1)).toContain('text-green-600');
    });

    it('returns muted for zero diff', () => {
      expect(getTimeComparisonClass(0)).toBe('text-muted-foreground');
    });
  });

  describe('getAgentDisplayName', () => {
    const agents = [{ id: 'a1', name: 'Alice' }] as any;

    it('returns Unassigned for null', () => {
      expect(getAgentDisplayName(null, agents)).toBe('Unassigned');
    });

    it('returns agent name when found', () => {
      expect(getAgentDisplayName('a1', agents)).toBe('Alice');
    });

    it('returns Agent not found when not found', () => {
      expect(getAgentDisplayName('x', agents)).toBe('Agent not found');
    });
  });

  describe('initEditForm', () => {
    it('initializes form from task', () => {
      const task = {
        title: 'My Task',
        description: 'Desc',
        priority: 'high',
        requiredDomain: 'backend',
      } as Partial<Task>;
      const result = initEditForm(task as Task);
      expect(result.title).toBe('My Task');
      expect(result.labels).toBe('');
      expect(result.priority).toBe('high');
      expect(result.requiredDomain).toBe('backend');
    });
  });
});
