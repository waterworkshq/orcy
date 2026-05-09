import { describe, it, expect } from 'vitest';
import { makeTask } from './task.js';
import { makeFeature } from './feature.js';
import { makeBoard } from './board.js';
import { makeColumn } from './column.js';
import { makeAgent } from './agent.js';
import { makeTaskEvent } from './event.js';
import { makeArtifact } from './artifact.js';

describe('factories', () => {
  describe('makeTask', () => {
    it('produces valid Task with all default fields', () => {
      const task = makeTask();
      expect(task.id).toBeDefined();
      expect(task.featureId).toBe('feat-1');
      expect(task.title).toBe('Test task');
      expect(task.description).toBe('A test task description');
      expect(task.priority).toBe('medium');
      expect(task.status).toBe('pending');
      expect(task.assignedAgentId).toBeNull();
      expect(task.delegatedToAgentId).toBeNull();
      expect(task.requiredDomain).toBeNull();
      expect(task.requiredCapabilities).toEqual([]);
      expect(task.claimedAt).toBeNull();
      expect(task.startedAt).toBeNull();
      expect(task.submittedAt).toBeNull();
      expect(task.completedAt).toBeNull();
      expect(task.rejectedCount).toBe(0);
      expect(task.rejectionReason).toBeNull();
      expect(task.result).toBeNull();
      expect(task.artifacts).toEqual([]);
      expect(task.order).toBe(0);
      expect(task.createdBy).toBe('test');
      expect(task.version).toBe(1);
      expect(task.estimatedMinutes).toBeNull();
      expect(task.retryPolicy).toBeNull();
      expect(task.retryCount).toBe(0);
      expect(task.nextRetryAt).toBeNull();
      expect(task.actualMinutes).toBeNull();
      expect(task.cycleTimeMinutes).toBeNull();
      expect(task.leadTimeMinutes).toBeNull();
      expect(task.estimationAccuracy).toBeNull();
      expect(task.createdAt).toBeDefined();
      expect(task.updatedAt).toBeDefined();
    });

    it('overrides work for each field', () => {
      const task = makeTask({
        id: 'custom-id',
        title: 'Custom Title',
        priority: 'critical',
        status: 'in_progress',
        assignedAgentId: 'agent-1',
        requiredCapabilities: ['typescript'],
        rejectedCount: 2,
        version: 5,
      });
      expect(task.id).toBe('custom-id');
      expect(task.title).toBe('Custom Title');
      expect(task.priority).toBe('critical');
      expect(task.status).toBe('in_progress');
      expect(task.assignedAgentId).toBe('agent-1');
      expect(task.requiredCapabilities).toEqual(['typescript']);
      expect(task.rejectedCount).toBe(2);
      expect(task.version).toBe(5);
    });
  });

  describe('makeFeature', () => {
    it('produces valid Feature', () => {
      const feature = makeFeature();
      expect(feature.id).toBeDefined();
      expect(feature.boardId).toBe('board-1');
      expect(feature.title).toBe('Test Feature');
      expect(feature.status).toBe('not_started');
      expect(feature.isArchived).toBe(false);
    });

    it('overrides work', () => {
      const feature = makeFeature({ title: 'Custom', priority: 'high', status: 'in_progress' });
      expect(feature.title).toBe('Custom');
      expect(feature.priority).toBe('high');
      expect(feature.status).toBe('in_progress');
    });
  });

  describe('makeBoard', () => {
    it('produces valid Board', () => {
      const board = makeBoard();
      expect(board.id).toBeDefined();
      expect(board.name).toBe('Test Board');
      expect(board.teamId).toBeNull();
      expect(board.createdAt).toBeDefined();
      expect(board.updatedAt).toBeDefined();
    });

    it('overrides work', () => {
      const board = makeBoard({ name: 'Custom Board', teamId: 'team-1' });
      expect(board.name).toBe('Custom Board');
      expect(board.teamId).toBe('team-1');
    });
  });

  describe('makeColumn', () => {
    it('produces valid Column', () => {
      const column = makeColumn();
      expect(column.id).toBeDefined();
      expect(column.name).toBe('Test Column');
      expect(column.boardId).toBe('board-1');
      expect(column.order).toBe(0);
    });

    it('overrides work', () => {
      const column = makeColumn({ name: 'Done', wipLimit: 5 });
      expect(column.name).toBe('Done');
      expect(column.wipLimit).toBe(5);
    });
  });

  describe('makeAgent', () => {
    it('produces valid Agent', () => {
      const agent = makeAgent();
      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('Test Agent');
      expect(agent.type).toBe('claude-code');
      expect(agent.status).toBe('idle');
      expect(agent.currentTaskId).toBeNull();
    });

    it('overrides work', () => {
      const agent = makeAgent({ name: 'Bot', status: 'working', currentTaskId: 'task-1' });
      expect(agent.name).toBe('Bot');
      expect(agent.status).toBe('working');
      expect(agent.currentTaskId).toBe('task-1');
    });
  });

  describe('makeTaskEvent', () => {
    it('produces valid TaskEvent', () => {
      const event = makeTaskEvent();
      expect(event.id).toBeDefined();
      expect(event.taskId).toBe('task-1');
      expect(event.actorType).toBe('system');
      expect(event.action).toBe('created');
    });

    it('overrides work', () => {
      const event = makeTaskEvent({ action: 'claimed', actorId: 'agent-1' });
      expect(event.action).toBe('claimed');
      expect(event.actorId).toBe('agent-1');
    });
  });

  describe('makeArtifact', () => {
    it('produces valid Artifact', () => {
      const artifact = makeArtifact();
      expect(artifact.type).toBe('file');
      expect(artifact.url).toBe('https://example.com/file.txt');
    });

    it('overrides work', () => {
      const artifact = makeArtifact({ type: 'pr', url: 'https://github.com/pr/1' });
      expect(artifact.type).toBe('pr');
      expect(artifact.url).toBe('https://github.com/pr/1');
    });
  });
});
