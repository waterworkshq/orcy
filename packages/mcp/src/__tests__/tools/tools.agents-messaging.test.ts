import { describe, it, expect } from 'vitest';
import {
  AGENT_DISPATCH_HANDLER,
  MESSAGE_DISPATCH_HANDLER,
} from '../../tools/index.js';
import { createMockClient } from '../__fixtures__/mock-client.js';

describe('agent dispatch list', () => {
  it('returns agents with current task titles', async () => {
    const client = createMockClient();
    const mockAgents = [
      {
        agent: {
          id: 'agent-1',
          name: 'coding-agent',
          type: 'claude-code' as const,
          domain: 'backend',
          capabilities: ['typescript', 'node'],
          status: 'working' as const,
          currentTaskId: 'task-1',
          createdAt: '2026-04-01T00:00:00Z',
          lastHeartbeat: '2026-04-10T10:00:00Z',
          metadata: {},
        },
        currentTaskTitle: 'Fix login bug',
      },
      {
        agent: {
          id: 'agent-2',
          name: 'review-agent',
          type: 'opencode' as const,
          domain: 'frontend',
          capabilities: ['react'],
          status: 'idle' as const,
          currentTaskId: null,
          createdAt: '2026-04-01T00:00:00Z',
          lastHeartbeat: '2026-04-10T10:00:00Z',
          metadata: {},
        },
        currentTaskTitle: null,
      },
    ];
    client.listAgents.mockResolvedValue({ agents: mockAgents });

    const raw = await AGENT_DISPATCH_HANDLER(client, { action: 'list' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].currentTaskTitle).toBe('Fix login bug');
    expect(result.agents[1].currentTaskTitle).toBeNull();
    expect(client.listAgents).toHaveBeenCalledWith({ status: undefined, domain: undefined, include: 'currentTask' });
  });

  it('passes status and domain filters', async () => {
    const client = createMockClient();
    client.listAgents.mockResolvedValue({ agents: [] });

    await AGENT_DISPATCH_HANDLER(client, { action: 'list', status: 'working', domain: 'backend' });

    expect(client.listAgents).toHaveBeenCalledWith({ status: 'working', domain: 'backend', include: 'currentTask' });
  });

  it('returns empty array when no agents match', async () => {
    const client = createMockClient();
    client.listAgents.mockResolvedValue({ agents: [] });

    const raw = await AGENT_DISPATCH_HANDLER(client, { action: 'list', status: 'offline' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.agents).toHaveLength(0);
  });
});

describe('message dispatch send', () => {
  it('sends a message using toAgentId', async () => {
    const client = createMockClient();
    const mockMessage = {
      id: 'msg-1',
      boardId: 'board-1',
      fromAgentId: 'agent-1',
      toAgentId: 'agent-2',
      taskId: null,
      subject: 'Hello',
      body: 'World',
      messageType: 'info' as const,
      priority: 'normal' as const,
      readAt: null,
      createdAt: '2026-04-11T00:00:00Z',
    };
    client.sendMessage.mockResolvedValue({ message: mockMessage });

    const raw = await MESSAGE_DISPATCH_HANDLER(client, {
      action: 'send',
      toAgentId: 'agent-2',
      boardId: 'board-1',
      subject: 'Hello',
      body: 'World',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.message.id).toBe('msg-1');
    expect(client.sendMessage).toHaveBeenCalledWith('agent-2', {
      boardId: 'board-1',
      taskId: undefined,
      subject: 'Hello',
      body: 'World',
      messageType: undefined,
      priority: undefined,
    });
  });

  it('resolves toAgentName to toAgentId', async () => {
    const client = createMockClient();
    const agents = [
      { id: 'agent-1', name: 'coding-agent', type: 'claude-code' as const, domain: 'backend', capabilities: [], status: 'idle' as const, currentTaskId: null, createdAt: '', lastHeartbeat: '', metadata: {} },
      { id: 'agent-2', name: 'review-agent', type: 'opencode' as const, domain: 'frontend', capabilities: [], status: 'idle' as const, currentTaskId: null, createdAt: '', lastHeartbeat: '', metadata: {} },
    ];
    client.listAgents.mockResolvedValue({ agents });
    const mockMessage = {
      id: 'msg-1',
      boardId: 'board-1',
      fromAgentId: 'agent-1',
      toAgentId: 'agent-2',
      taskId: null,
      subject: 'Review needed',
      body: 'Please review my PR',
      messageType: 'request' as const,
      priority: 'high' as const,
      readAt: null,
      createdAt: '2026-04-11T00:00:00Z',
    };
    client.sendMessage.mockResolvedValue({ message: mockMessage });

    const raw = await MESSAGE_DISPATCH_HANDLER(client, {
      action: 'send',
      toAgentName: 'review-agent',
      boardId: 'board-1',
      subject: 'Review needed',
      body: 'Please review my PR',
      messageType: 'request',
      priority: 'high',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.message.toAgentId).toBe('agent-2');
    expect(client.sendMessage).toHaveBeenCalledWith('agent-2', expect.objectContaining({
      boardId: 'board-1',
      subject: 'Review needed',
    }));
  });

  it('throws if agent name not found', async () => {
    const client = createMockClient();
    client.listAgents.mockResolvedValue({ agents: [] });

    await expect(
      MESSAGE_DISPATCH_HANDLER(client, {
        action: 'send',
        toAgentName: 'nonexistent-agent',
        boardId: 'board-1',
        subject: 'Hello',
        body: 'World',
      })
    ).rejects.toThrow('Agent with name "nonexistent-agent" not found');
  });

  it('throws if neither toAgentId nor toAgentName provided', async () => {
    const client = createMockClient();

    await expect(
      MESSAGE_DISPATCH_HANDLER(client, {
        action: 'send',
        boardId: 'board-1',
        subject: 'Hello',
        body: 'World',
      })
    ).rejects.toThrow('Either toAgentId or toAgentName must be provided');
  });

  it('sends task-scoped message', async () => {
    const client = createMockClient();
    const mockMessage = {
      id: 'msg-2',
      boardId: 'board-1',
      fromAgentId: 'agent-1',
      toAgentId: 'agent-2',
      taskId: 'task-1',
      subject: 'Dependency done',
      body: 'Task X is complete',
      messageType: 'alert' as const,
      priority: 'normal' as const,
      readAt: null,
      createdAt: '2026-04-11T00:00:00Z',
    };
    client.sendMessage.mockResolvedValue({ message: mockMessage });

    const raw = await MESSAGE_DISPATCH_HANDLER(client, {
      action: 'send',
      toAgentId: 'agent-2',
      boardId: 'board-1',
      taskId: 'task-1',
      subject: 'Dependency done',
      body: 'Task X is complete',
      messageType: 'alert',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.message.taskId).toBe('task-1');
    expect(client.sendMessage).toHaveBeenCalledWith('agent-2', expect.objectContaining({
      taskId: 'task-1',
    }));
  });
});

describe('message dispatch get-messages', () => {
  it('returns messages with agent name enrichment', async () => {
    const client = createMockClient();
    const mockMessages = [
      {
        id: 'msg-1',
        boardId: 'board-1',
        fromAgentId: 'agent-2',
        toAgentId: 'agent-1',
        taskId: null,
        subject: 'Hello',
        body: 'World',
        messageType: 'info' as const,
        priority: 'normal' as const,
        readAt: null,
        createdAt: '2026-04-11T00:00:00Z',
      },
    ];
    client.getMessages.mockResolvedValue({ messages: mockMessages, total: 1, unreadCount: 1 });
    client.getAgentById.mockResolvedValue({ agent: { id: 'agent-2', name: 'coding-agent' } });

    const raw = await MESSAGE_DISPATCH_HANDLER(client, { action: 'get-messages' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.messages).toHaveLength(1);
    expect(result.total).toBe(1);
    expect(result.unreadCount).toBe(1);
    expect(result.messages[0].fromAgentName).toBe('coding-agent');
  });

  it('passes filter options', async () => {
    const client = createMockClient();
    client.getMessages.mockResolvedValue({ messages: [], total: 0, unreadCount: 0 });

    await MESSAGE_DISPATCH_HANDLER(client, { action: 'get-messages', unreadOnly: true, taskId: 'task-1', limit: 10, offset: 5 });

    expect(client.getMessages).toHaveBeenCalledWith({
      unreadOnly: true,
      taskId: 'task-1',
      limit: 10,
      offset: 5,
    });
  });

  it('falls back to agent ID when agent lookup fails', async () => {
    const client = createMockClient();
    const mockMessages = [
      {
        id: 'msg-1',
        boardId: 'board-1',
        fromAgentId: 'agent-999',
        toAgentId: 'agent-1',
        taskId: null,
        subject: 'Hello',
        body: 'World',
        messageType: 'info' as const,
        priority: 'normal' as const,
        readAt: null,
        createdAt: '2026-04-11T00:00:00Z',
      },
    ];
    client.getMessages.mockResolvedValue({ messages: mockMessages, total: 1, unreadCount: 1 });
    client.getAgentById.mockResolvedValue(null);

    const raw = await MESSAGE_DISPATCH_HANDLER(client, { action: 'get-messages' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.messages[0].fromAgentName).toBe('agent-999');
  });
});

describe('agent dispatch get-stats', () => {
  it('returns agent stats', async () => {
    const client = createMockClient();
    client.getAgent.mockResolvedValue({
      agent: {
        id: 'agent-1',
        name: 'coding-agent',
        type: 'claude-code',
        domain: 'backend',
        capabilities: ['typescript'],
        status: 'working',
        currentTaskId: null,
        createdAt: '2026-04-01T00:00:00Z',
        lastHeartbeat: '2026-04-10T10:00:00Z',
        metadata: {},
      },
    });
    const mockStats = {
      completed: 42,
      failed: 3,
      avgCycleTime: 15.5,
      rejectionRate: 0.05,
      throughput: 8.2,
      streak: 12,
    };
    client.getAgentStats.mockResolvedValue({ stats: mockStats });

    const raw = await AGENT_DISPATCH_HANDLER(client, { action: 'get-stats' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.agentId).toBe('agent-1');
    expect(result.stats.completed).toBe(42);
    expect(result.stats.failed).toBe(3);
    expect(result.stats.avgCycleTime).toBe(15.5);
    expect(result.stats.rejectionRate).toBe(0.05);
    expect(result.stats.throughput).toBe(8.2);
    expect(result.stats.streak).toBe(12);
    expect(client.getAgent).toHaveBeenCalled();
    expect(client.getAgentStats).toHaveBeenCalledWith('agent-1');
  });

  it('propagates API errors from getAgent', async () => {
    const client = createMockClient();
    client.getAgent.mockRejectedValue(new Error('Not authenticated'));

    await expect(AGENT_DISPATCH_HANDLER(client, { action: 'get-stats' })).rejects.toThrow('Not authenticated');
  });
});

describe('agent dispatch register', () => {
  it('does not duplicate API key in free-text message', async () => {
    const client = createMockClient();
    const mockApiKey = 'test-api-key-abc123';
    const mockAgent = {
      id: 'agent-reg-1',
      name: 'secure-agent',
      type: 'claude-code' as const,
      domain: 'backend',
      capabilities: ['typescript'],
      status: 'idle' as const,
      currentTaskId: null,
      createdAt: '2026-04-01T00:00:00Z',
      lastHeartbeat: '2026-04-10T10:00:00Z',
      metadata: {},
    };
    client.registerAgent = async () => ({ agent: mockAgent, apiKey: mockApiKey });

    const raw = await AGENT_DISPATCH_HANDLER(client, {
      action: 'register',
      name: 'secure-agent',
      type: 'claude-code',
      domain: 'backend',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(result.apiKey).toBe(mockApiKey);
    expect(result.agentId).toBe('agent-reg-1');
    expect(result.message).not.toContain(mockApiKey);
    expect(result.message).toContain('store it securely');
  });
});
