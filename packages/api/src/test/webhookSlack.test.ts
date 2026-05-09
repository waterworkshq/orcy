import { describe, it, expect } from 'vitest';
import { formatSlackPayload } from '../services/webhook-formatters/slack.js';
import type { EventEnrichment } from '../services/webhook-formatters/standard.js';

const taskEnrichment: EventEnrichment = {
  boardName: 'Test Board',
  task: {
    id: 'task-1',
    title: 'My Task',
    status: 'pending',
    priority: 'high',
    assignedAgentId: 'agent-1',
    assignedAgentName: 'Agent One',
    result: null,
    artifacts: [],
  },
};

const noTaskEnrichment: EventEnrichment = {
  boardName: 'Test Board',
};

describe('webhook-formatters/slack', () => {
  it('produces valid Slack Block Kit JSON', () => {
    const result = formatSlackPayload(taskEnrichment, 'task.created') as Record<string, unknown>;
    expect(result).toHaveProperty('text');
    expect(result).toHaveProperty('blocks');
    expect(Array.isArray(result.blocks)).toBe(true);
  });

  it('has header block with emoji and title', () => {
    const result = formatSlackPayload(taskEnrichment, 'task.created') as { blocks: Array<Record<string, unknown>> };
    const header = result.blocks[0] as Record<string, unknown>;
    expect(header.type).toBe('header');
    const text = header.text as Record<string, unknown>;
    expect(text.text).toContain('🆕');
    expect(text.text).toContain('Task Created');
  });

  it('includes task fields section', () => {
    const result = formatSlackPayload(taskEnrichment, 'task.claimed') as { blocks: Array<Record<string, unknown>> };
    const section = result.blocks[1] as Record<string, unknown>;
    expect(section.type).toBe('section');
    const fields = section.fields as Array<Record<string, unknown>>;
    expect(fields.some(f => (f as Record<string, unknown>).text?.toString().includes('My Task'))).toBe(true);
  });

  it('includes agent section when assignedAgentName present', () => {
    const result = formatSlackPayload(taskEnrichment, 'task.claimed') as { blocks: Array<Record<string, unknown>> };
    const hasAgentBlock = result.blocks.some(b => {
      const fields = (b as Record<string, unknown>).fields as Array<Record<string, unknown>> | undefined;
      return fields?.some(f => (f as Record<string, unknown>).text?.toString().includes('Agent One'));
    });
    expect(hasAgentBlock).toBe(true);
  });

  it('falls back to clipboard emoji for unknown events', () => {
    const result = formatSlackPayload(noTaskEnrichment, 'unknown.event') as { blocks: Array<Record<string, unknown>> };
    const header = result.blocks[0] as Record<string, unknown>;
    const text = header.text as Record<string, unknown>;
    expect(text.text).toContain('🐋');
  });

  it('text field includes task title or empty', () => {
    const withTask = formatSlackPayload(taskEnrichment, 'task.created') as Record<string, unknown>;
    expect(withTask.text).toContain('My Task');

    const withoutTask = formatSlackPayload(noTaskEnrichment, 'task.created') as Record<string, unknown>;
    expect(withoutTask.text).toContain('Task Created');
  });
});
