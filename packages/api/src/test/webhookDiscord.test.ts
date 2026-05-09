import { describe, it, expect } from 'vitest';
import { formatDiscordPayload } from '../services/webhook-formatters/discord.js';
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

describe('webhook-formatters/discord', () => {
  it('produces valid Discord embed JSON', () => {
    const result = formatDiscordPayload(taskEnrichment, 'task.created') as Record<string, unknown>;
    expect(result).toHaveProperty('content');
    expect(result).toHaveProperty('embeds');
    expect(Array.isArray(result.embeds)).toBe(true);
  });

  it('content field has emoji and title', () => {
    const result = formatDiscordPayload(taskEnrichment, 'task.created') as Record<string, unknown>;
    expect(result.content).toBe('🆕 Task Created');
  });

  it('embed has color for known event', () => {
    const result = formatDiscordPayload(taskEnrichment, 'task.created') as { embeds: Array<Record<string, unknown>> };
    expect(result.embeds[0].color).toBe(3447003);
  });

  it('embed includes task fields', () => {
    const result = formatDiscordPayload(taskEnrichment, 'task.claimed') as { embeds: Array<Record<string, unknown>> };
    const fields = result.embeds[0].fields as Array<Record<string, unknown>>;
    expect(fields.some(f => (f as Record<string, unknown>).value === 'My Task')).toBe(true);
    expect(fields.some(f => (f as Record<string, unknown>).value === 'high')).toBe(true);
  });

  it('embed includes agent field when present', () => {
    const result = formatDiscordPayload(taskEnrichment, 'task.claimed') as { embeds: Array<Record<string, unknown>> };
    const fields = result.embeds[0].fields as Array<Record<string, unknown>>;
    expect(fields.some(f => (f as Record<string, unknown>).value === 'Agent One')).toBe(true);
  });

  it('no fields when no task in enrichment', () => {
    const result = formatDiscordPayload(noTaskEnrichment, 'task.created') as { embeds: Array<Record<string, unknown>> };
    expect(result.embeds[0].fields).toEqual([]);
  });

  it('falls back to default color for unknown event', () => {
    const result = formatDiscordPayload(noTaskEnrichment, 'unknown.event') as { embeds: Array<Record<string, unknown>> };
    expect(result.embeds[0].color).toBe(5763719);
  });

  it('falls back to clipboard emoji for unknown event', () => {
    const result = formatDiscordPayload(noTaskEnrichment, 'unknown.event') as Record<string, unknown>;
    expect(result.content).toContain('🐋');
  });

  it('embed has valid ISO timestamp', () => {
    const result = formatDiscordPayload(taskEnrichment, 'task.created') as { embeds: Array<Record<string, unknown>> };
    const ts = result.embeds[0].timestamp as string;
    expect(new Date(ts).toISOString()).toBe(ts);
  });
});
