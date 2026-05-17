import { describe, it, expect, vi, beforeEach } from 'vitest';

let _integrations: Record<string, {
  id: string;
  habitatId: string;
  provider: string;
  webhookUrl: string;
  channelId: string | null;
  botToken: string | null;
  enabled: number;
  events: string[];
  createdAt: string;
  updatedAt: string;
}> = {};

function createMockDb() {
  const doInsert = () => {
    let _vals: any;
    const chain = {
      values: (vals: any) => { _vals = vals; return chain; },
      run: () => {
        _integrations[_vals.id] = {
          id: _vals.id,
          habitatId: _vals.habitatId,
          provider: _vals.provider,
          webhookUrl: _vals.webhookUrl,
          channelId: _vals.channelId ?? null,
          botToken: _vals.botToken ?? null,
          enabled: _vals.enabled ?? 1,
          events: _vals.events ?? [],
          createdAt: _vals.createdAt,
          updatedAt: _vals.updatedAt,
        };
      },
    };
    return chain;
  };

  const doSelect = () => {
    let _table: any;
    let _conditions: any[] = [];
    const chain = {
      from: (table: any) => { _table = table; return chain; },
      where: (...args: any[]) => { _conditions = args; return chain; },
      orderBy: (...args: any[]) => chain,
      all: () => {
        let results = Object.values(_integrations);
        for (const cond of _conditions) {
          if (cond?._type === 'and') {
            for (const c of cond.conditions) {
              if (c?.col === 'habitatId') results = results.filter(r => r.habitatId === c.val);
              if (c?.col === 'enabled') results = results.filter(r => r.enabled === c.val);
            }
          }
          if (cond?.col === 'habitatId') results = results.filter(r => r.habitatId === cond.val);
          if (cond?.col === 'enabled') results = results.filter(r => r.enabled === cond.val);
          if (cond?.col === 'id') results = results.filter(r => r.id === cond.val);
        }
        return results;
      },
    };
    return chain;
  };

  const doUpdate = () => {
    let _vals: any;
    let _condition: any;
    const chain = {
      set: (vals: any) => { _vals = vals; return chain; },
      where: (condition: any) => { _condition = condition; return chain; },
      run: () => {
        const id = _condition?.val;
        if (id && _integrations[id]) {
          if (_vals.webhookUrl !== undefined) _integrations[id].webhookUrl = _vals.webhookUrl;
          if (_vals.channelId !== undefined) _integrations[id].channelId = _vals.channelId;
          if (_vals.botToken !== undefined) _integrations[id].botToken = _vals.botToken;
          if (_vals.enabled !== undefined) _integrations[id].enabled = _vals.enabled;
          if (_vals.events !== undefined) _integrations[id].events = _vals.events;
          if (_vals.updatedAt !== undefined) _integrations[id].updatedAt = _vals.updatedAt;
        }
      },
    };
    return chain;
  };

  const doDelete = () => {
    let _condition: any;
    const chain = {
      where: (condition: any) => { _condition = condition; return chain; },
      run: () => {
        const id = _condition?.val;
        if (id) delete _integrations[id];
      },
    };
    return chain;
  };

  return {
    insert: () => doInsert(),
    select: () => doSelect(),
    update: () => doUpdate(),
    delete: () => doDelete(),
  };
}

vi.mock('../db/index.js', () => ({
  getDb: () => createMockDb(),
  initDb: vi.fn(),
  closeDb: vi.fn(),
}));

vi.mock('drizzle-orm', () => ({
  eq: (col: string, val: any) => ({ col, val }),
  and: (...conditions: any[]) => ({ _type: 'and', conditions }),
  or: (...conditions: any[]) => ({ _type: 'or', conditions }),
  sql: (strings: any, ...values: any[]) => ({ _type: 'sql', strings, values }),
}));

vi.mock('../db/schema/index.js', () => ({
  chatIntegrations: {
    id: 'id',
    habitatId: 'habitatId',
    provider: 'provider',
    webhookUrl: 'webhookUrl',
    channelId: 'channelId',
    botToken: 'botToken',
    enabled: 'enabled',
    events: 'events',
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  agents: { id: 'id', name: 'name', status: 'status', domain: 'domain', capabilities: 'capabilities', apiKey: 'apiKey', currentTaskId: 'currentTaskId', createdAt: 'createdAt', lastHeartbeat: 'lastHeartbeat', metadata: 'metadata', rateLimitPerMinute: 'rateLimitPerMinute', type: 'type' },
  tasks: { id: 'id', habitatId: 'habitatId', columnId: 'columnId', title: 'title', description: 'description', priority: 'priority', labels: 'labels', assignedAgentId: 'assignedAgentId', status: 'status' },
  habitats: { id: 'id', name: 'name' },
}));

vi.mock('uuid', () => ({
  v4: () => 'test-uuid-' + Math.random().toString(36).substring(2, 8),
}));

describe('ChatIntegration Repository', () => {
  beforeEach(() => {
    _integrations = {};
  });

  it('creates and retrieves an integration', async () => {
    const { createIntegration, getIntegrationById } = await import('../repositories/chatIntegration.js');
    const integration = createIntegration({
      habitatId: 'habitat-1',
      provider: 'slack',
      webhookUrl: 'https://hooks.slack.com/services/test',
      channelId: 'C123',
      events: ['task_created', 'task_claimed'],
    });
    expect(integration.habitatId).toBe('habitat-1');
    expect(integration.provider).toBe('slack');
    expect(integration.webhookUrl).toBe('https://hooks.slack.com/services/test');
    expect(integration.events).toEqual(['task_created', 'task_claimed']);
    expect(integration.enabled).toBe(1);

    const fetched = getIntegrationById(integration.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.provider).toBe('slack');
  });

  it('lists integrations by habitat', async () => {
    const { createIntegration, getIntegrationsByHabitat } = await import('../repositories/chatIntegration.js');
    createIntegration({ habitatId: 'habitat-1', provider: 'slack', webhookUrl: 'https://slack.test' });
    createIntegration({ habitatId: 'habitat-1', provider: 'discord', webhookUrl: 'https://discord.test' });
    createIntegration({ habitatId: 'habitat-2', provider: 'slack', webhookUrl: 'https://slack2.test' });

    const list = getIntegrationsByHabitat('habitat-1');
    expect(list.length).toBe(2);
  });

  it('updates an integration', async () => {
    const { createIntegration, updateIntegration, getIntegrationById } = await import('../repositories/chatIntegration.js');
    const integration = createIntegration({ habitatId: 'habitat-1', provider: 'slack', webhookUrl: 'https://old.test' });
    const success = updateIntegration(integration.id, { webhookUrl: 'https://new.test', enabled: false });
    expect(success).toBe(true);
    const updated = getIntegrationById(integration.id);
    expect(updated!.webhookUrl).toBe('https://new.test');
    expect(updated!.enabled).toBe(0);
  });

  it('deletes an integration', async () => {
    const { createIntegration, deleteIntegration, getIntegrationById } = await import('../repositories/chatIntegration.js');
    const integration = createIntegration({ habitatId: 'habitat-1', provider: 'slack', webhookUrl: 'https://test.test' });
    const success = deleteIntegration(integration.id);
    expect(success).toBe(true);
    const fetched = getIntegrationById(integration.id);
    expect(fetched).toBeNull();
  });

  it('getEnabledIntegrations returns only enabled', async () => {
    const { createIntegration, getEnabledIntegrations } = await import('../repositories/chatIntegration.js');
    createIntegration({ habitatId: 'habitat-1', provider: 'slack', webhookUrl: 'https://test1.test' });
    const disabled = createIntegration({ habitatId: 'habitat-1', provider: 'discord', webhookUrl: 'https://test2.test' });
    const { updateIntegration } = await import('../repositories/chatIntegration.js');
    updateIntegration(disabled.id, { enabled: false });
    const enabled = getEnabledIntegrations();
    expect(enabled.length).toBe(1);
    expect(enabled[0].provider).toBe('slack');
  });
});

describe('Slack Service', () => {
  it('parseSlackCommand parses action and args', async () => {
    const { parseSlackCommand } = await import('../services/slackService.js');
    const result = parseSlackCommand('list');
    expect(result.action).toBe('list');
    expect(result.args).toEqual([]);

    const result2 = parseSlackCommand('info task-123');
    expect(result2.action).toBe('info');
    expect(result2.args).toEqual(['task-123']);

    const result3 = parseSlackCommand('reject task-123 not good enough');
    expect(result3.action).toBe('reject');
    expect(result3.args).toEqual(['task-123', 'not', 'good', 'enough']);
  });

  it('parseSlackCommand defaults to help', async () => {
    const { parseSlackCommand } = await import('../services/slackService.js');
    const result = parseSlackCommand('');
    expect(result.action).toBe('help');
  });

  it('formatSlackMessage produces Block Kit', async () => {
    const { formatSlackMessage } = await import('../services/slackService.js');
    const msg = formatSlackMessage('task_created', {
      id: 't1',
      title: 'Test Task',
      status: 'pending',
      priority: 'high',
    });
    expect(msg).toHaveProperty('text');
    expect(msg).toHaveProperty('blocks');
    const blocks = (msg as { blocks: unknown[] }).blocks;
    expect(blocks.length).toBeGreaterThan(0);
  });

  it('formatSlackMessage without task data', async () => {
    const { formatSlackMessage } = await import('../services/slackService.js');
    const msg = formatSlackMessage('task_created');
    expect(msg).toHaveProperty('text');
    expect(msg).toHaveProperty('blocks');
  });

  it('formatSlackTaskList shows tasks', async () => {
    const { formatSlackTaskList } = await import('../services/slackService.js');
    const msg = formatSlackTaskList([
      { id: 't1', title: 'Task 1', status: 'pending', priority: 'high' },
    ]);
    expect(msg).toHaveProperty('blocks');
    const blocks = (msg as { blocks: unknown[] }).blocks;
    expect(blocks.length).toBeGreaterThanOrEqual(2);
  });

  it('formatSlackTaskList empty', async () => {
    const { formatSlackTaskList } = await import('../services/slackService.js');
    const msg = formatSlackTaskList([]);
    expect(msg).toHaveProperty('blocks');
    const blocks = (msg as { blocks: unknown[] }).blocks;
    expect(blocks.length).toBe(1);
  });

  it('formatSlackHelp returns commands', async () => {
    const { formatSlackHelp } = await import('../services/slackService.js');
    const msg = formatSlackHelp();
    expect(msg).toHaveProperty('blocks');
    const blocks = (msg as { blocks: unknown[] }).blocks;
    expect(blocks.length).toBe(2);
  });

  it('verifySlackRequest rejects missing signature', async () => {
    const { verifySlackRequest } = await import('../services/slackService.js');
    expect(verifySlackRequest(undefined, 'body', 'secret')).toBe(false);
  });
});

describe('Discord Service', () => {
  it('parseDiscordCommand parses interaction data', async () => {
    const { parseDiscordCommand } = await import('../services/discordService.js');
    const result = parseDiscordCommand({
      name: 'orcy',
      options: [{ name: 'list', value: '' }],
    });
    expect(result.action).toBe('list');
  });

  it('parseDiscordCommand defaults to help', async () => {
    const { parseDiscordCommand } = await import('../services/discordService.js');
    const result = parseDiscordCommand({});
    expect(result.action).toBe('help');
  });

  it('formatDiscordMessage produces embeds', async () => {
    const { formatDiscordMessage } = await import('../services/discordService.js');
    const msg = formatDiscordMessage('task_created', {
      id: 't1',
      title: 'Test Task',
      status: 'pending',
      priority: 'high',
    });
    expect(msg).toHaveProperty('embeds');
    const embeds = (msg as { embeds: unknown[] }).embeds;
    expect(embeds.length).toBe(1);
  });

  it('formatDiscordTaskList shows tasks', async () => {
    const { formatDiscordTaskList } = await import('../services/discordService.js');
    const msg = formatDiscordTaskList([
      { id: 't1', title: 'Task 1', status: 'pending', priority: 'high' },
    ]);
    expect(msg).toHaveProperty('embeds');
    const embeds = (msg as { embeds: unknown[] }).embeds;
    expect(embeds.length).toBe(1);
  });

  it('formatDiscordTaskList empty', async () => {
    const { formatDiscordTaskList } = await import('../services/discordService.js');
    const msg = formatDiscordTaskList([]);
    expect(msg).toHaveProperty('embeds');
  });

  it('formatDiscordHelp returns commands', async () => {
    const { formatDiscordHelp } = await import('../services/discordService.js');
    const msg = formatDiscordHelp();
    expect(msg).toHaveProperty('embeds');
    const embeds = (msg as { embeds: unknown[] }).embeds;
    expect(embeds.length).toBe(1);
  });

  it('formatDiscordResponse success', async () => {
    const { formatDiscordResponse } = await import('../services/discordService.js');
    const msg = formatDiscordResponse('Task approved', true);
    expect(msg).toHaveProperty('embeds');
    const content = (msg as { content: string }).content;
    expect(content).toContain('✅');
  });

  it('formatDiscordResponse failure', async () => {
    const { formatDiscordResponse } = await import('../services/discordService.js');
    const msg = formatDiscordResponse('Task not found', false);
    const content = (msg as { content: string }).content;
    expect(content).toContain('❌');
  });
});

describe('ChatService processEvent', () => {
  beforeEach(() => {
    _integrations = {};
  });

  it('skips unmapped event types', async () => {
    const { processEvent } = await import('../services/chatService.js');
    await expect(processEvent('habitat.created', 'habitat-1', {})).resolves.toBeUndefined();
  });

  it('skips when no integrations', async () => {
    const { processEvent } = await import('../services/chatService.js');
    await expect(processEvent('task.created', 'habitat-1', {})).resolves.toBeUndefined();
  });
});
