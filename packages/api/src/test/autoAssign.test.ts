import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import * as eventRepo from '../repositories/event.js';
import { taskEvents, tasks, columns as columnsTable, habitats, agents } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
  assignTask,
  getAutoAssignSettings,
  getEligibleAgents,
  getAgentActiveTaskCount,
  selectAgentRoundRobin,
  selectAgentLeastLoaded,
  selectAgentBestMatch,
  getDefaultAutoAssignSettings,
  resetRoundRobinCounter,
} from '../services/autoAssignService.js';
import type { AutoAssignSettings, Task } from '../models/index.js';

let habitatId: string;
let columnId: string;
let missionId: string;

const defaultSettings: AutoAssignSettings = getDefaultAutoAssignSettings();

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(agents).run();
  resetRoundRobinCounter();

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const columns = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = columns.id;

  const mission = missionRepo.createMission({ habitatId, columnId, title: 'Test Mission', createdBy: 'test' });
  missionId = mission.id;
});

afterEach(() => {
  closeDb();
});

function createTestAgent(name: string, domain: string = 'backend', capabilities: string[] = []) {
  return agentRepo.createAgent({ name, type: 'claude-code', domain, capabilities });
}

function createTestTask(title: string, options?: { requiredDomain?: string; requiredCapabilities?: string[] }) {
  return taskRepo.createTask({
    missionId,
    title,
    createdBy: 'test',
    requiredDomain: options?.requiredDomain ?? null,
    requiredCapabilities: options?.requiredCapabilities ?? [],
  });
}

describe('getDefaultAutoAssignSettings', () => {
  it('returns defaults with best_match strategy', () => {
    const settings = getDefaultAutoAssignSettings();
    expect(settings.enabled).toBe(false);
    expect(settings.strategy).toBe('best_match');
    expect(settings.maxTasksPerAgent).toBe(5);
    expect(settings.requireDomainMatch).toBe(false);
    expect(settings.requireCapabilityMatch).toBe(false);
    expect(settings.excludeOfflineAgents).toBe(true);
  });
});

describe('getAutoAssignSettings', () => {
  it('returns defaults when habitat has no settings', () => {
    const settings = getAutoAssignSettings(habitatId);
    expect(settings.enabled).toBe(false);
    expect(settings.strategy).toBe('best_match');
  });

  it('returns habitat settings when configured', () => {
    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'round_robin', maxTasksPerAgent: 3, requireDomainMatch: true, requireCapabilityMatch: false, excludeOfflineAgents: true },
    });
    const settings = getAutoAssignSettings(habitatId);
    expect(settings.enabled).toBe(true);
    expect(settings.strategy).toBe('round_robin');
    expect(settings.maxTasksPerAgent).toBe(3);
  });
});

describe('getAgentActiveTaskCount', () => {
  it('returns 0 for agent with no tasks', () => {
    const { agent } = createTestAgent('agent1');
    expect(getAgentActiveTaskCount(agent.id)).toBe(0);
  });

  it('counts claimed and in_progress tasks', () => {
    const { agent } = createTestAgent('agent1');
    const task1 = createTestTask('task1');
    const task2 = createTestTask('task2');
    taskRepo.claimTask(task1.id, agent.id);
    taskRepo.claimTask(task2.id, agent.id);
    expect(getAgentActiveTaskCount(agent.id)).toBe(2);
  });
});

describe('getEligibleAgents', () => {
  it('returns agents within workload limit', () => {
    const { agent: agent1 } = createTestAgent('agent1');
    const { agent: agent2 } = createTestAgent('agent2');
    const task = createTestTask('task');

    const settings = { ...defaultSettings, enabled: true, maxTasksPerAgent: 5 };
    const eligible = getEligibleAgents(habitatId, task, settings);
    expect(eligible.length).toBe(2);
  });

  it('excludes agents at max workload', () => {
    const { agent: agent1 } = createTestAgent('agent1');
    const { agent: agent2 } = createTestAgent('agent2');

    for (let i = 0; i < 5; i++) {
      const t = createTestTask(`task${i}`);
      taskRepo.claimTask(t.id, agent1.id);
    }

    const task = createTestTask('newTask');
    const settings = { ...defaultSettings, enabled: true, maxTasksPerAgent: 5 };
    const eligible = getEligibleAgents(habitatId, task, settings);
    expect(eligible.length).toBe(1);
    expect(eligible[0].id).toBe(agent2.id);
  });

  it('filters by domain when requireDomainMatch is true', () => {
    const { agent: backendAgent } = createTestAgent('backend-agent', 'backend');
    const { agent: frontendAgent } = createTestAgent('frontend-agent', 'frontend');

    const task = createTestTask('task', { requiredDomain: 'backend' });
    const settings = { ...defaultSettings, enabled: true, requireDomainMatch: true };
    const eligible = getEligibleAgents(habitatId, task, settings);
    expect(eligible.length).toBe(1);
    expect(eligible[0].id).toBe(backendAgent.id);
  });

  it('allows all domains when requireDomainMatch is false', () => {
    createTestAgent('backend-agent', 'backend');
    createTestAgent('frontend-agent', 'frontend');

    const task = createTestTask('task', { requiredDomain: 'backend' });
    const settings = { ...defaultSettings, enabled: true, requireDomainMatch: false };
    const eligible = getEligibleAgents(habitatId, task, settings);
    expect(eligible.length).toBe(2);
  });

  it('filters by capabilities when requireCapabilityMatch is true', () => {
    const { agent: tsAgent } = createTestAgent('ts-agent', 'backend', ['typescript', 'react']);
    const { agent: pyAgent } = createTestAgent('py-agent', 'backend', ['python']);

    const task = createTestTask('task', { requiredCapabilities: ['typescript'] });
    const settings = { ...defaultSettings, enabled: true, requireCapabilityMatch: true };
    const eligible = getEligibleAgents(habitatId, task, settings);
    expect(eligible.length).toBe(1);
    expect(eligible[0].id).toBe(tsAgent.id);
  });

  it('excludes offline agents when excludeOfflineAgents is true', () => {
    const { agent: onlineAgent } = createTestAgent('online-agent');
    const { agent: offlineAgent } = createTestAgent('offline-agent');
    agentRepo.updateAgent(offlineAgent.id, { status: 'offline' });

    const task = createTestTask('task');
    const settings = { ...defaultSettings, enabled: true, excludeOfflineAgents: true };
    const eligible = getEligibleAgents(habitatId, task, settings);
    expect(eligible.length).toBe(1);
    expect(eligible[0].id).toBe(onlineAgent.id);
  });

  it('includes offline agents when excludeOfflineAgents is false', () => {
    createTestAgent('online-agent');
    const { agent: offlineAgent } = createTestAgent('offline-agent');
    agentRepo.updateAgent(offlineAgent.id, { status: 'offline' });

    const task = createTestTask('task');
    const settings = { ...defaultSettings, enabled: true, excludeOfflineAgents: false };
    const eligible = getEligibleAgents(habitatId, task, settings);
    expect(eligible.length).toBe(2);
  });
});

describe('selectAgentRoundRobin', () => {
  it('returns null for empty agents list', () => {
    expect(selectAgentRoundRobin([], habitatId)).toBeNull();
  });

  it('cycles through agents in order', () => {
    const { agent: a1 } = createTestAgent('a1');
    const { agent: a2 } = createTestAgent('a2');
    const agentList = [
      { id: a1.id, name: 'a1', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
      { id: a2.id, name: 'a2', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
    ];

    const first = selectAgentRoundRobin(agentList, habitatId);
    const second = selectAgentRoundRobin(agentList, habitatId);
    const third = selectAgentRoundRobin(agentList, habitatId);

    expect(first!.id).toBe(a1.id);
    expect(second!.id).toBe(a2.id);
    expect(third!.id).toBe(a1.id);
  });
});

describe('selectAgentLeastLoaded', () => {
  it('returns null for empty agents list', () => {
    expect(selectAgentLeastLoaded([])).toBeNull();
  });

  it('selects agent with fewest active tasks', () => {
    const { agent: a1 } = createTestAgent('a1');
    const { agent: a2 } = createTestAgent('a2');

    const t1 = createTestTask('t1');
    taskRepo.claimTask(t1.id, a1.id);

    const agentList = [
      { id: a1.id, name: 'a1', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 1 },
      { id: a2.id, name: 'a2', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
    ];

    const selected = selectAgentLeastLoaded(agentList);
    expect(selected!.id).toBe(a2.id);
  });

  it('breaks ties by oldest heartbeat', () => {
    const { agent: a1 } = createTestAgent('a1');
    const { agent: a2 } = createTestAgent('a2');

    const agentList = [
      { id: a1.id, name: 'a1', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date(Date.now() - 10000).toISOString(), activeTaskCount: 0 },
      { id: a2.id, name: 'a2', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
    ];

    const selected = selectAgentLeastLoaded(agentList);
    expect(selected!.id).toBe(a1.id);
  });
});

describe('selectAgentBestMatch', () => {
  it('returns null for empty agents list', () => {
    const task = createTestTask('t');
    expect(selectAgentBestMatch([], task, habitatId)).toBeNull();
  });

  it('gives bonus for domain match', () => {
    const { agent: matchAgent } = createTestAgent('match', 'backend');
    const { agent: noMatch } = createTestAgent('nomatch', 'frontend');

    const task = createTestTask('t', { requiredDomain: 'backend' });

    const agentList = [
      { id: noMatch.id, name: 'nomatch', domain: 'frontend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
      { id: matchAgent.id, name: 'match', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
    ];

    const selected = selectAgentBestMatch(agentList, task, habitatId);
    expect(selected!.id).toBe(matchAgent.id);
  });

  it('gives bonus for capability overlap', () => {
    const { agent: capAgent } = createTestAgent('cap', 'backend', ['typescript', 'react', 'node', 'jest']);
    const { agent: noCapAgent } = createTestAgent('nocap', 'backend', []);

    const task = createTestTask('t', { requiredCapabilities: ['typescript', 'react'] });

    const agentList = [
      { id: noCapAgent.id, name: 'nocap', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
      { id: capAgent.id, name: 'cap', domain: 'backend', capabilities: ['typescript', 'react', 'node', 'jest'], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
    ];

    const selected = selectAgentBestMatch(agentList, task, habitatId);
    expect(selected!.id).toBe(capAgent.id);
  });

  it('penalizes agents with high workload', () => {
    const { agent: busy } = createTestAgent('busy');
    const { agent: free } = createTestAgent('free');

    const task = createTestTask('t');

    const agentList = [
      { id: busy.id, name: 'busy', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 3 },
      { id: free.id, name: 'free', domain: 'backend', capabilities: [], status: 'idle', lastHeartbeat: new Date().toISOString(), activeTaskCount: 0 },
    ];

    const selected = selectAgentBestMatch(agentList, task, habitatId);
    expect(selected!.id).toBe(free.id);
  });
});

describe('assignTask', () => {
  it('returns no_eligible_agents when no agents exist', () => {
    const task = createTestTask('t');
    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'best_match', maxTasksPerAgent: 5, requireDomainMatch: false, requireCapabilityMatch: false, excludeOfflineAgents: true },
    });
    const result = assignTask(task.id, habitatId);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('no_eligible_agents');
  });

  it('returns auto_assign_disabled when not enabled', () => {
    const task = createTestTask('t');
    createTestAgent('agent1');
    const result = assignTask(task.id, habitatId);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('auto_assign_disabled');
  });

  it('returns already_assigned when task is already claimed', () => {
    const { agent } = createTestAgent('agent1');
    const task = createTestTask('t');
    taskRepo.claimTask(task.id, agent.id);
    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'best_match', maxTasksPerAgent: 5, requireDomainMatch: false, requireCapabilityMatch: false, excludeOfflineAgents: true },
    });
    const result = assignTask(task.id, habitatId);
    expect(result.success).toBe(false);
    expect(result.reason).toBe('already_assigned');
  });

  it('assigns task with best_match strategy', () => {
    const { agent } = createTestAgent('agent1');
    const task = createTestTask('t');
    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'best_match', maxTasksPerAgent: 5, requireDomainMatch: false, requireCapabilityMatch: false, excludeOfflineAgents: true },
    });
    const result = assignTask(task.id, habitatId);
    expect(result.success).toBe(true);
    expect(result.agentId).toBe(agent.id);

    const updatedTask = taskRepo.getTaskById(task.id);
    expect(updatedTask!.assignedAgentId).toBe(agent.id);
    expect(updatedTask!.status).toBe('claimed');
  });

  it('assigns task with round_robin strategy', () => {
    const { agent: a1 } = createTestAgent('a1');
    const { agent: a2 } = createTestAgent('a2');
    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'round_robin', maxTasksPerAgent: 5, requireDomainMatch: false, requireCapabilityMatch: false, excludeOfflineAgents: true },
    });

    const task1 = createTestTask('t1');
    const result1 = assignTask(task1.id, habitatId);
    expect(result1.success).toBe(true);

    const task2 = createTestTask('t2');
    const result2 = assignTask(task2.id, habitatId);
    expect(result2.success).toBe(true);

    expect(result1.agentId).not.toBe(result2.agentId);
    const assignedIds = new Set([result1.agentId, result2.agentId]);
    expect(assignedIds.has(a1.id)).toBe(true);
    expect(assignedIds.has(a2.id)).toBe(true);
  });

  it('assigns task with least_loaded strategy', () => {
    const { agent: busy } = createTestAgent('busy');
    const { agent: free } = createTestAgent('free');

    for (let i = 0; i < 3; i++) {
      const t = createTestTask(`existing${i}`);
      taskRepo.claimTask(t.id, busy.id);
    }

    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'least_loaded', maxTasksPerAgent: 5, requireDomainMatch: false, requireCapabilityMatch: false, excludeOfflineAgents: true },
    });

    const task = createTestTask('t');
    const result = assignTask(task.id, habitatId);
    expect(result.success).toBe(true);
    expect(result.agentId).toBe(free.id);
  });

  it('creates an auto_assign event', () => {
    createTestAgent('agent1');
    const task = createTestTask('t');
    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'best_match', maxTasksPerAgent: 5, requireDomainMatch: false, requireCapabilityMatch: false, excludeOfflineAgents: true },
    });
    assignTask(task.id, habitatId);

    const { events } = eventRepo.getEventsByTaskId(task.id);
    const autoEvent = events.find(e => e.actorId === 'auto_assign');
    expect(autoEvent).toBeDefined();
    expect(autoEvent!.action).toBe('claimed');
    expect(autoEvent!.metadata.autoAssigned).toBe(true);
    expect(autoEvent!.metadata.strategy).toBe('best_match');
  });

  it('respects domain match requirement', () => {
    createTestAgent('frontend-agent', 'frontend');
    const { agent: backendAgent } = createTestAgent('backend-agent', 'backend');

    const task = createTestTask('t', { requiredDomain: 'backend' });
    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'best_match', maxTasksPerAgent: 5, requireDomainMatch: true, requireCapabilityMatch: false, excludeOfflineAgents: true },
    });
    const result = assignTask(task.id, habitatId);
    expect(result.success).toBe(true);
    expect(result.agentId).toBe(backendAgent.id);
  });

  it('respects capability match requirement', () => {
    const { agent: tsAgent } = createTestAgent('ts-agent', 'backend', ['typescript']);
    createTestAgent('py-agent', 'backend', ['python']);

    const task = createTestTask('t', { requiredCapabilities: ['typescript'] });
    habitatRepo.updateHabitat(habitatId, {
      autoAssignSettings: { enabled: true, strategy: 'best_match', maxTasksPerAgent: 5, requireDomainMatch: false, requireCapabilityMatch: true, excludeOfflineAgents: true },
    });
    const result = assignTask(task.id, habitatId);
    expect(result.success).toBe(true);
    expect(result.agentId).toBe(tsAgent.id);
  });
});
