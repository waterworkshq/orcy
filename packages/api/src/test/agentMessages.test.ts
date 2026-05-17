import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as agentRepo from '../repositories/agent.js';
import * as habitatRepo from '../repositories/board.js';
import * as agentMessageRepo from '../repositories/agentMessage.js';

describe('AgentMessage Repository', () => {
  let habitatId: string;
  let agent1Id: string;
  let agent2Id: string;
  let agent1ApiKey: string;
  let agent2ApiKey: string;

  beforeAll(async () => {
    await initTestDb();

    const habitat = habitatRepo.createHabitat({ name: 'Test Habitat Messages', description: 'Test' });
    habitatId = habitat.id;

    const agent1 = agentRepo.createAgent({ name: 'sender-agent', type: 'claude-code', domain: 'backend' });
    agent1Id = agent1.agent.id;
    agent1ApiKey = agent1.plainApiKey;

    const agent2 = agentRepo.createAgent({ name: 'receiver-agent', type: 'opencode', domain: 'frontend' });
    agent2Id = agent2.agent.id;
    agent2ApiKey = agent2.plainApiKey;
  });

  afterAll(() => {
    closeDb();
  });

  it('creates a message', () => {
    const message = agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'Test Subject',
      body: 'Test body content',
    });

    expect(message.id).toBeDefined();
    expect(message.habitatId).toBe(habitatId);
    expect(message.fromAgentId).toBe(agent1Id);
    expect(message.toAgentId).toBe(agent2Id);
    expect(message.subject).toBe('Test Subject');
    expect(message.body).toBe('Test body content');
    expect(message.messageType).toBe('info');
    expect(message.priority).toBe('normal');
    expect(message.readAt).toBeNull();
  });

  it('creates a message with all options', () => {
    const message = agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      taskId: undefined,
      subject: 'Urgent Alert',
      body: 'Please check this',
      messageType: 'alert',
      priority: 'urgent',
    });

    expect(message.messageType).toBe('alert');
    expect(message.priority).toBe('urgent');
  });

  it('gets a message by id', () => {
    const created = agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'Get By ID Test',
      body: 'Content',
    });

    const found = agentMessageRepo.getMessageById(created.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(created.id);
    expect(found!.subject).toBe('Get By ID Test');
  });

  it('returns null for non-existent message', () => {
    const found = agentMessageRepo.getMessageById('nonexistent-id');
    expect(found).toBeNull();
  });

  it('lists messages for an agent', () => {
    agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'List Test 1',
      body: 'Body 1',
    });
    agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'List Test 2',
      body: 'Body 2',
    });

    const result = agentMessageRepo.getMessagesByAgent(agent2Id);
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    expect(result.total).toBeGreaterThanOrEqual(2);
  });

  it('filters unread only', () => {
    const msg = agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'Unread Filter Test',
      body: 'Body',
    });

    agentMessageRepo.markAsRead(msg.id);

    const unread = agentMessageRepo.getMessagesByAgent(agent2Id, { unreadOnly: true });
    const readMsg = unread.messages.find(m => m.id === msg.id);
    expect(readMsg).toBeUndefined();
  });

  it('gets unread count', () => {
    const before = agentMessageRepo.getUnreadCount(agent2Id);

    agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'Unread Count Test',
      body: 'Body',
    });

    const after = agentMessageRepo.getUnreadCount(agent2Id);
    expect(after).toBe(before + 1);
  });

  it('marks a message as read', () => {
    const msg = agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'Mark Read Test',
      body: 'Body',
    });

    expect(msg.readAt).toBeNull();

    const updated = agentMessageRepo.markAsRead(msg.id);
    expect(updated).not.toBeNull();
    expect(updated!.readAt).not.toBeNull();
  });

  it('marks all messages as read', () => {
    agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'Mark All Read 1',
      body: 'Body',
    });
    agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'Mark All Read 2',
      body: 'Body',
    });

    const count = agentMessageRepo.markAllAsRead(agent2Id);
    expect(count).toBeGreaterThanOrEqual(0);

    const unread = agentMessageRepo.getUnreadCount(agent2Id);
    expect(unread).toBe(0);
  });

  it('deletes a message', () => {
    const msg = agentMessageRepo.createMessage({
      habitatId,
      fromAgentId: agent1Id,
      toAgentId: agent2Id,
      subject: 'Delete Test',
      body: 'Body',
    });

    agentMessageRepo.deleteMessage(msg.id);

    const found = agentMessageRepo.getMessageById(msg.id);
    expect(found).toBeNull();
  });
});
