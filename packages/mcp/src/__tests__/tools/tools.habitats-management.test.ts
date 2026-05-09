import { describe, it, expect } from 'vitest';
import {
  ADMIN_DISPATCH_HANDLER,
  HABITAT_DISPATCH_HANDLER,
} from '../../tools/index.js';
import { createMockClient } from '../__fixtures__/mock-client.js';

describe('admin dispatch list-webhooks', () => {
  it('returns webhooks from the API client', async () => {
    const client = createMockClient();
    const mockWebhooks = [
      {
        id: 'wh-1',
        boardId: 'board-1',
        name: 'Slack Notifier',
        url: 'https://hooks.slack.com/test',
        events: ['task.created', 'task.completed'],
        format: 'slack' as const,
        createdAt: '2026-04-10T10:00:00Z',
        updatedAt: '2026-04-10T10:00:00Z',
      },
    ];
    client.listWebhooks.mockResolvedValue({ webhooks: mockWebhooks });

    const raw = await ADMIN_DISPATCH_HANDLER(client, { action: 'list-webhooks', boardId: 'board-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.webhooks).toHaveLength(1);
    expect(result.webhooks[0].name).toBe('Slack Notifier');
    expect(client.listWebhooks).toHaveBeenCalledWith('board-1');
  });

  it('returns empty array when no webhooks', async () => {
    const client = createMockClient();
    client.listWebhooks.mockResolvedValue({ webhooks: [] });

    const raw = await ADMIN_DISPATCH_HANDLER(client, { action: 'list-webhooks', boardId: 'board-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.webhooks).toHaveLength(0);
  });
});

describe('admin dispatch create-webhook', () => {
  it('creates a webhook with all fields', async () => {
    const client = createMockClient();
    const mockWebhook = {
      id: 'wh-1',
      boardId: 'board-1',
      name: 'Discord Notifier',
      url: 'https://discord.com/api/webhooks/test',
      events: ['task.submitted'],
      format: 'discord' as const,
      createdAt: '2026-04-10T10:00:00Z',
      updatedAt: '2026-04-10T10:00:00Z',
    };
    client.createWebhook.mockResolvedValue({ webhook: mockWebhook });

    const raw = await ADMIN_DISPATCH_HANDLER(client, {
      action: 'create-webhook',
      boardId: 'board-1',
      name: 'Discord Notifier',
      url: 'https://discord.com/api/webhooks/test',
      events: ['task.submitted'],
      format: 'discord',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.webhook.id).toBe('wh-1');
    expect(result.webhook.format).toBe('discord');
    expect(client.createWebhook).toHaveBeenCalledWith('board-1', {
      name: 'Discord Notifier',
      url: 'https://discord.com/api/webhooks/test',
      events: ['task.submitted'],
      format: 'discord',
    });
  });

  it('creates a webhook with default format', async () => {
    const client = createMockClient();
    const mockWebhook = {
      id: 'wh-2',
      boardId: 'board-1',
      name: 'Standard Hook',
      url: 'https://example.com/hook',
      events: ['task.created'],
      format: 'standard' as const,
      createdAt: '2026-04-10T10:00:00Z',
      updatedAt: '2026-04-10T10:00:00Z',
    };
    client.createWebhook.mockResolvedValue({ webhook: mockWebhook });

    const raw = await ADMIN_DISPATCH_HANDLER(client, {
      action: 'create-webhook',
      boardId: 'board-1',
      name: 'Standard Hook',
      url: 'https://example.com/hook',
      events: ['task.created'],
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.webhook.format).toBe('standard');
    expect(client.createWebhook).toHaveBeenCalledWith('board-1', {
      name: 'Standard Hook',
      url: 'https://example.com/hook',
      events: ['task.created'],
      format: undefined,
    });
  });
});

describe('admin dispatch delete-webhook', () => {
  it('deletes a webhook', async () => {
    const client = createMockClient();
    client.deleteWebhook.mockResolvedValue(undefined);

    const raw = await ADMIN_DISPATCH_HANDLER(client, { action: 'delete-webhook', webhookId: 'wh-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual({ success: true });
    expect(client.deleteWebhook).toHaveBeenCalledWith('wh-1');
  });

  it('propagates API errors', async () => {
    const client = createMockClient();
    client.deleteWebhook.mockRejectedValue(new Error('Webhook not found'));

    await expect(
      ADMIN_DISPATCH_HANDLER(client, { action: 'delete-webhook', webhookId: 'wh-999' })
    ).rejects.toThrow('Webhook not found');
  });
});

describe('admin dispatch list-templates', () => {
  it('returns templates from the API client', async () => {
    const client = createMockClient();
    const mockTemplates = [
      {
        id: 'tpl-1',
        boardId: 'board-1',
        name: 'Bug Fix',
        titlePattern: 'Fix: {description}',
        descriptionPattern: 'Bug fix template',
        priority: 'high' as const,
        labels: ['bug'],
        domain: null,
        createdAt: '2026-04-10T10:00:00Z',
        updatedAt: '2026-04-10T10:00:00Z',
      },
    ];
    client.listTemplates.mockResolvedValue({ templates: mockTemplates });

    const raw = await ADMIN_DISPATCH_HANDLER(client, { action: 'list-templates', boardId: 'board-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.templates).toHaveLength(1);
    expect(result.templates[0].name).toBe('Bug Fix');
    expect(client.listTemplates).toHaveBeenCalledWith('board-1');
  });
});

describe('admin dispatch create-template', () => {
  it('creates a template with all fields', async () => {
    const client = createMockClient();
    const mockTemplate = {
      id: 'tpl-1',
      boardId: 'board-1',
      name: 'Feature',
      titlePattern: 'Feature: {title}',
      descriptionPattern: 'Feature description',
      priority: 'medium' as const,
      labels: ['feature'],
      domain: 'backend',
      createdAt: '2026-04-10T10:00:00Z',
      updatedAt: '2026-04-10T10:00:00Z',
    };
    client.createTemplate.mockResolvedValue({ template: mockTemplate });

    const raw = await ADMIN_DISPATCH_HANDLER(client, {
      action: 'create-template',
      boardId: 'board-1',
      name: 'Feature',
      titlePattern: 'Feature: {title}',
      descriptionPattern: 'Feature description',
      priority: 'medium',
      labels: ['feature'],
      domain: 'backend',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.template.id).toBe('tpl-1');
    expect(result.template.name).toBe('Feature');
    expect(client.createTemplate).toHaveBeenCalledWith('board-1', {
      name: 'Feature',
      titlePattern: 'Feature: {title}',
      descriptionPattern: 'Feature description',
      priority: 'medium',
      labels: ['feature'],
      domain: 'backend',
    });
  });

  it('creates a template with only required fields', async () => {
    const client = createMockClient();
    const mockTemplate = {
      id: 'tpl-2',
      boardId: 'board-1',
      name: 'Minimal',
      titlePattern: '',
      descriptionPattern: '',
      priority: null,
      labels: [],
      domain: null,
      createdAt: '2026-04-10T10:00:00Z',
      updatedAt: '2026-04-10T10:00:00Z',
    };
    client.createTemplate.mockResolvedValue({ template: mockTemplate });

    const raw = await ADMIN_DISPATCH_HANDLER(client, {
      action: 'create-template',
      boardId: 'board-1',
      name: 'Minimal',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.template.name).toBe('Minimal');
    expect(client.createTemplate).toHaveBeenCalledWith('board-1', {
      name: 'Minimal',
      titlePattern: undefined,
      descriptionPattern: undefined,
      priority: undefined,
      labels: undefined,
      domain: undefined,
    });
  });
});

describe('admin dispatch delete-template', () => {
  it('deletes a template', async () => {
    const client = createMockClient();
    client.deleteTemplate.mockResolvedValue(undefined);

    const raw = await ADMIN_DISPATCH_HANDLER(client, { action: 'delete-template', templateId: 'tpl-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result).toEqual({ success: true });
    expect(client.deleteTemplate).toHaveBeenCalledWith('tpl-1');
  });

  it('propagates API errors', async () => {
    const client = createMockClient();
    client.deleteTemplate.mockRejectedValue(new Error('Template not found'));

    await expect(
      ADMIN_DISPATCH_HANDLER(client, { action: 'delete-template', templateId: 'tpl-999' })
    ).rejects.toThrow('Template not found');
  });
});

describe('board dispatch get-settings', () => {
  it('returns board settings', async () => {
    const client = createMockClient();
    const mockSettings = {
      id: 'board-1',
      name: 'Sprint 24',
      description: 'Current sprint board',
      columns: [
        { id: 'col-1', boardId: 'board-1', name: 'Todo', order: 0, wipLimit: null, autoAdvance: false, requiresClaim: false, nextColumnId: 'col-2', isTerminal: false },
        { id: 'col-2', boardId: 'board-1', name: 'Done', order: 1, wipLimit: null, autoAdvance: false, requiresClaim: false, nextColumnId: null, isTerminal: true },
      ],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-10T00:00:00Z',
    };
    client.getBoardSettings.mockResolvedValue({ board: mockSettings });

    const raw = await HABITAT_DISPATCH_HANDLER(client, { action: 'get-settings', boardId: 'board-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.board.name).toBe('Sprint 24');
    expect(result.board.columns).toHaveLength(2);
    expect(client.getBoardSettings).toHaveBeenCalledWith('board-1');
  });
});

describe('board dispatch update-settings', () => {
  it('updates board name and description', async () => {
    const client = createMockClient();
    const mockUpdated = {
      id: 'board-1',
      name: 'Sprint 25',
      description: 'Updated description',
      columns: [],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-11T00:00:00Z',
    };
    client.updateBoardSettings.mockResolvedValue({ board: mockUpdated });

    const raw = await HABITAT_DISPATCH_HANDLER(client, {
      action: 'update-settings',
      boardId: 'board-1',
      name: 'Sprint 25',
      description: 'Updated description',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.board.name).toBe('Sprint 25');
    expect(client.updateBoardSettings).toHaveBeenCalledWith('board-1', {
      name: 'Sprint 25',
      description: 'Updated description',
    });
  });

  it('updates only name', async () => {
    const client = createMockClient();
    const mockUpdated = {
      id: 'board-1',
      name: 'New Name',
      description: 'Old description',
      columns: [],
      createdAt: '2026-04-01T00:00:00Z',
      updatedAt: '2026-04-11T00:00:00Z',
    };
    client.updateBoardSettings.mockResolvedValue({ board: mockUpdated });

    const raw = await HABITAT_DISPATCH_HANDLER(client, {
      action: 'update-settings',
      boardId: 'board-1',
      name: 'New Name',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.board.name).toBe('New Name');
    expect(client.updateBoardSettings).toHaveBeenCalledWith('board-1', {
      name: 'New Name',
      description: undefined,
    });
  });
});
