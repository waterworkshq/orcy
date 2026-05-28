import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { closeDb, getDb, initTestDb } from '../db/index.js';
import * as agentRepo from '../repositories/agent.js';
import * as columnRepo from '../repositories/column.js';
import * as habitatRepo from '../repositories/board.js';
import * as missionRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import { getAgentStats, getAllAgentStats } from '../repositories/events/event-agent-stats.js';
import { agents, columns, habitats, missions, taskEvents, tasks } from '../db/schema/index.js';
import type { Artifact } from '../models/index.js';

const NOW = new Date('2026-05-27T12:00:00.000Z');

function iso(minutesAgo: number): string {
  return new Date(NOW.getTime() - minutesAgo * 60_000).toISOString();
}

function createHabitatFixture() {
  const habitat = habitatRepo.createHabitat({ name: 'Agent Stats Habitat' });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: 'Todo',
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: 'Agent Stats Mission',
    createdBy: 'test-user',
  });
  return { habitat, column, mission };
}

function createAssignedTask(input: {
  missionId: string;
  agentId: string;
  idHint: string;
  status: 'approved' | 'done' | 'failed' | 'claimed' | 'in_progress' | 'submitted' | 'rejected';
  claimedAt?: string | null;
  completedAt?: string | null;
  rejectedCount?: number;
  artifacts?: Artifact[];
}) {
  const task = taskRepo.createTask({
    missionId: input.missionId,
    title: `${input.idHint} task`,
    createdBy: 'test-user',
  });

  getDb()
    .update(tasks)
    .set({
      assignedAgentId: input.agentId,
      status: input.status,
      claimedAt: input.claimedAt ?? null,
      completedAt: input.completedAt ?? null,
      rejectedCount: input.rejectedCount ?? 0,
      artifacts: input.artifacts ?? [],
    })
    .where(eq(tasks.id, task.id))
    .run();

  return task;
}

function insertEvent(input: {
  id: string;
  taskId: string;
  actorType?: 'human' | 'agent' | 'system';
  actorId: string;
  action: 'submitted' | 'approved' | 'rejected' | 'completed';
  timestamp: string;
}) {
  getDb()
    .insert(taskEvents)
    .values({
      id: input.id,
      taskId: input.taskId,
      actorType: input.actorType ?? 'agent',
      actorId: input.actorId,
      action: input.action,
      metadata: {},
      timestamp: input.timestamp,
    })
    .run();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columns).run();
  db.delete(habitats).run();
  db.delete(agents).run();
});

afterEach(() => {
  vi.useRealTimers();
  closeDb();
});

describe('event-agent-stats repository', () => {
  it('returns null for an unknown agent id', () => {
    expect(getAgentStats('missing-agent')).toBeNull();
  });

  it('returns zeroed stats for an agent with no assigned tasks', () => {
    const { agent } = agentRepo.createAgent({
      name: 'idle-agent',
      type: 'claude-code',
      domain: 'backend',
    });

    const result = getAgentStats(agent.id);

    expect(result).toEqual({
      agentId: agent.id,
      agentName: 'idle-agent',
      tasks: { completed: 0, failed: 0, inProgress: 0, rejected: 0, totalAssigned: 0 },
      cycleTime: { averageMinutes: 0, medianMinutes: 0, count: 0 },
      throughput: { today: 0, last7d: 0, last30d: 0 },
      quality: { rejectionRate: 0, approvalRate: 0, currentStreak: 0, totalRejections: 0 },
      artifacts: { total: 0, byType: {} },
    });
  });

  it('aggregates task statuses, cycle time, throughput, rejection counts, and artifacts', () => {
    const { mission } = createHabitatFixture();
    const { agent } = agentRepo.createAgent({
      name: 'aggregate-agent',
      type: 'codex',
      domain: 'backend',
    });

    createAssignedTask({
      missionId: mission.id,
      agentId: agent.id,
      idHint: 'approved',
      status: 'approved',
      claimedAt: iso(120),
      completedAt: iso(60),
      rejectedCount: 2,
      artifacts: [
        { type: 'pr', url: 'https://example.com/pr/1', description: 'PR' },
        { type: 'file', url: 'file:///tmp/report.md', description: 'Report' },
      ],
    });
    createAssignedTask({
      missionId: mission.id,
      agentId: agent.id,
      idHint: 'done',
      status: 'done',
      claimedAt: iso(300),
      completedAt: iso(180),
      artifacts: [{ type: 'pr', url: 'https://example.com/pr/2', description: 'PR 2' }],
    });
    createAssignedTask({ missionId: mission.id, agentId: agent.id, idHint: 'failed', status: 'failed' });
    createAssignedTask({ missionId: mission.id, agentId: agent.id, idHint: 'active', status: 'in_progress' });
    createAssignedTask({ missionId: mission.id, agentId: agent.id, idHint: 'rejected', status: 'rejected' });

    const result = getAgentStats(agent.id)!;

    expect(result.tasks).toEqual({
      completed: 2,
      failed: 1,
      inProgress: 1,
      rejected: 1,
      totalAssigned: 5,
    });
    expect(result.cycleTime).toEqual({ averageMinutes: 90, medianMinutes: 90, count: 2 });
    expect(result.throughput).toEqual({ today: 2, last7d: 2, last30d: 2 });
    expect(result.quality.totalRejections).toBe(2);
    expect(result.artifacts).toEqual({ total: 3, byType: { pr: 2, file: 1 } });
  });

  it('computes quality rates and current streak from agent-authored events only', () => {
    const { mission } = createHabitatFixture();
    const { agent } = agentRepo.createAgent({
      name: 'quality-agent',
      type: 'opencode',
      domain: 'frontend',
    });
    const { agent: otherAgent } = agentRepo.createAgent({
      name: 'other-quality-agent',
      type: 'codex',
      domain: 'backend',
    });
    const task = createAssignedTask({
      missionId: mission.id,
      agentId: agent.id,
      idHint: 'quality',
      status: 'approved',
    });

    insertEvent({ id: 'submitted-1', taskId: task.id, actorId: agent.id, action: 'submitted', timestamp: iso(50) });
    insertEvent({ id: 'submitted-2', taskId: task.id, actorId: agent.id, action: 'submitted', timestamp: iso(40) });
    insertEvent({ id: 'approved-1', taskId: task.id, actorId: agent.id, action: 'approved', timestamp: iso(30) });
    insertEvent({ id: 'rejected-1', taskId: task.id, actorId: agent.id, action: 'rejected', timestamp: iso(20) });
    insertEvent({ id: 'completed-1', taskId: task.id, actorId: agent.id, action: 'completed', timestamp: iso(10) });
    insertEvent({ id: 'approved-2', taskId: task.id, actorId: agent.id, action: 'approved', timestamp: iso(5) });
    insertEvent({ id: 'other-agent', taskId: task.id, actorId: otherAgent.id, action: 'approved', timestamp: iso(1) });
    insertEvent({
      id: 'human-event',
      taskId: task.id,
      actorType: 'human',
      actorId: 'human-1',
      action: 'approved',
      timestamp: iso(1),
    });

    const result = getAgentStats(agent.id)!;

    expect(result.quality).toMatchObject({
      approvalRate: 1,
      rejectionRate: 0.5,
      currentStreak: 2,
    });
  });

  it('returns all agents with summary totals and zero-task agents included', () => {
    const { mission } = createHabitatFixture();
    const { agent: busy } = agentRepo.createAgent({
      name: 'busy-agent',
      type: 'claude-code',
      domain: 'backend',
    });
    const { agent: idle } = agentRepo.createAgent({
      name: 'zero-task-agent',
      type: 'codex',
      domain: 'devops',
    });
    const completedTask = createAssignedTask({
      missionId: mission.id,
      agentId: busy.id,
      idHint: 'completed',
      status: 'approved',
      claimedAt: iso(80),
      completedAt: iso(20),
    });
    createAssignedTask({ missionId: mission.id, agentId: busy.id, idHint: 'failed', status: 'failed' });
    insertEvent({ id: 'all-submitted', taskId: completedTask.id, actorId: busy.id, action: 'submitted', timestamp: iso(15) });
    insertEvent({ id: 'all-approved', taskId: completedTask.id, actorId: busy.id, action: 'approved', timestamp: iso(10) });
    insertEvent({ id: 'all-completed', taskId: completedTask.id, actorId: busy.id, action: 'completed', timestamp: iso(5) });

    const result = getAllAgentStats();

    expect(result.summary).toEqual({
      totalTasksCompleted: 1,
      totalTasksFailed: 1,
      totalAgentsActive: 1,
    });
    expect(result.agents).toEqual([
      expect.objectContaining({
        agentId: busy.id,
        agentName: 'busy-agent',
        domain: 'backend',
        status: 'idle',
        completed: 1,
        failed: 1,
        inProgress: 0,
        avgCycleMinutes: 60,
        approvalRate: 1,
        currentStreak: 2,
      }),
      expect.objectContaining({
        agentId: idle.id,
        agentName: 'zero-task-agent',
        completed: 0,
        failed: 0,
        inProgress: 0,
        avgCycleMinutes: 0,
        approvalRate: 0,
        currentStreak: 0,
      }),
    ]);
  });
});
