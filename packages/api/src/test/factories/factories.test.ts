import { describe, it, expect } from 'vitest';
import { makeTask } from './task.js';
import { makeMission } from './feature.js';
import { makeHabitat } from './board.js';
import { makeColumn } from './column.js';
import { makeAgent } from './agent.js';
import { makeTaskEvent } from './event.js';
import { makeArtifact } from './artifact.js';

describe('factories', () => {
  describe('makeTask', () => {
    it('produces valid Task with all default fields', () => {
      const task = makeTask();
      expect(task.id).toBeDefined();
      expect(task.missionId).toBe('mission-1');
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

  describe('makeMission', () => {
    it('produces valid Mission', () => {
      const mission = makeMission();
      expect(mission.id).toBeDefined();
      expect(mission.habitatId).toBe('habitat-1');
      expect(mission.title).toBe('Test Mission');
      expect(mission.status).toBe('not_started');
      expect(mission.isArchived).toBe(false);
    });

    it('overrides work', () => {
      const mission = makeMission({ title: 'Custom', priority: 'high', status: 'in_progress' });
      expect(mission.title).toBe('Custom');
      expect(mission.priority).toBe('high');
      expect(mission.status).toBe('in_progress');
    });
  });

  describe('makeHabitat', () => {
    it('produces valid Habitat', () => {
      const habitat = makeHabitat();
      expect(habitat.id).toBeDefined();
      expect(habitat.name).toBe('Test Habitat');
      expect(habitat.teamId).toBeNull();
      expect(habitat.createdAt).toBeDefined();
      expect(habitat.updatedAt).toBeDefined();
    });

    it('overrides work', () => {
      const habitat = makeHabitat({ name: 'Custom Habitat', teamId: 'team-1' });
      expect(habitat.name).toBe('Custom Habitat');
      expect(habitat.teamId).toBe('team-1');
    });
  });

  describe('makeColumn', () => {
    it('produces valid Column', () => {
      const column = makeColumn();
      expect(column.id).toBeDefined();
      expect(column.name).toBe('Test Column');
      expect(column.habitatId).toBe('habitat-1');
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
