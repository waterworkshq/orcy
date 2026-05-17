import { describe, it, expect } from 'vitest';
import { formatStandardPayload } from '../services/webhook-formatters/standard.js';
import type { EventEnrichment } from '../services/webhook-formatters/standard.js';

const baseEnrichment: EventEnrichment = {
  habitatName: 'Test Habitat',
};

const taskEnrichment: EventEnrichment = {
  habitatName: 'Test Habitat',
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

describe('webhook-formatters/standard', () => {
  it('produces correct JSON envelope with deliveryId', () => {
    const result = formatStandardPayload(baseEnrichment, 'task.created', 'del-123');
    expect(result).toEqual({
      id: 'del-123',
      timestamp: expect.any(String),
      habitatId: 'Test Habitat',
      event: 'task.created',
      data: baseEnrichment,
    });
  });

  it('includes task data in enrichment', () => {
    const result = formatStandardPayload(taskEnrichment, 'task.claimed', 'del-456');
    const obj = result as Record<string, unknown>;
    expect(obj.data).toEqual(taskEnrichment);
  });

  it('produces valid ISO timestamp', () => {
    const result = formatStandardPayload(baseEnrichment, 'test', 'del-1') as Record<string, unknown>;
    expect(new Date(result.timestamp as string).toISOString()).toBe(result.timestamp);
  });
});
