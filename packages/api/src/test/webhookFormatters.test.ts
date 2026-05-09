import { describe, it, expect } from 'vitest';
import { EVENT_EMOJI_MAP, formatEventTitle } from '../services/webhook-formatters/shared.js';

describe('webhook-formatters/shared', () => {
  describe('EVENT_EMOJI_MAP', () => {
    it('contains all expected event types', () => {
      expect(EVENT_EMOJI_MAP['task.created']).toBe('🆕');
      expect(EVENT_EMOJI_MAP['task.claimed']).toBe('🤚');
      expect(EVENT_EMOJI_MAP['task.submitted']).toBe('📨');
      expect(EVENT_EMOJI_MAP['task.approved']).toBe('✅');
      expect(EVENT_EMOJI_MAP['task.rejected']).toBe('❌');
      expect(EVENT_EMOJI_MAP['task.completed']).toBe('🎉');
      expect(EVENT_EMOJI_MAP['task.failed']).toBe('⚠️');
      expect(EVENT_EMOJI_MAP['task.released']).toBe('🔓');
      expect(EVENT_EMOJI_MAP['agent.status_changed']).toBe('🤖');
      expect(EVENT_EMOJI_MAP['column.wip_limit_reached']).toBe('🚧');
    });

    it('has 10 entries', () => {
      expect(Object.keys(EVENT_EMOJI_MAP)).toHaveLength(10);
    });
  });

  describe('formatEventTitle', () => {
    it('converts dot-separated event type to title case', () => {
      expect(formatEventTitle('task.created')).toBe('Task Created');
    });

    it('handles underscore-separated event type', () => {
      expect(formatEventTitle('agent.status_changed')).toBe('Agent Status Changed');
    });

    it('handles compound event type (only first underscore replaced)', () => {
      expect(formatEventTitle('column.wip_limit_reached')).toBe('Column Wip Limit_reached');
    });

    it('handles single word', () => {
      expect(formatEventTitle('task')).toBe('Task');
    });
  });
});
