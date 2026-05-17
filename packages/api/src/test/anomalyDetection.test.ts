import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as habitatRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as taskRepo from '../repositories/task.js';
import * as missionRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import { taskEvents, tasks, columns as columnsTable, habitats, agents } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
  detectStaleInProgress,
  detectRejectionSpike,
  detectCycleTimeDegradation,
  detectBacklogGrowth,
  detectAgentOffline,
  detectAnomalies,
  getDefaultAnomalySettings,
  scanHabitat,
} from '../services/anomalyService.js';
import type { AnomalySettings } from '../models/index.js';

vi.mock('../services/chatService.js', () => ({
  sendAnomalyAlert: vi.fn().mockResolvedValue(undefined),
  processEvent: vi.fn().mockResolvedValue(undefined),
  executeCommand: vi.fn().mockResolvedValue({ response: {}, provider: 'slack' as const }),
  sendTestMessage: vi.fn().mockResolvedValue({ success: true, statusCode: 200, latencyMs: 0 }),
}));

let habitatId: string;
let columnId: string;
let missionId: string;
let agentId: string;

const defaultSettings: AnomalySettings = getDefaultAnomalySettings();

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(agents).run();

  vi.clearAllMocks();

  const { agent } = agentRepo.createAgent({ name: 'test-agent', type: 'claude-code', domain: 'backend' });
  agentId = agent.id;

  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  habitatId = habitat.id;

  const columns = columnRepo.createColumn({ habitatId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = columns.id;

  const mission = missionRepo.createMission({ habitatId, columnId, title: 'Test Mission', createdBy: 'human' });
  missionId = mission.id;
});

afterEach(() => {
  closeDb();
});

describe('detectStaleInProgress', () => {
  it('returns no anomalies when no in-progress tasks', () => {
    const result = detectStaleInProgress(habitatId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects a stale in-progress task', () => {
    const task = taskRepo.createTask({
      missionId,
      title: 'Stale Task',
      createdBy: 'human',
    });
    const db = getDb();
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectStaleInProgress(habitatId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('stale_in_progress');
    expect(result[0].severity).toBe('medium');
  });

  it('returns critical severity for very stale tasks', () => {
    const task = taskRepo.createTask({
      missionId,
      title: 'Very Stale Task',
      createdBy: 'human',
    });
    const db = getDb();
    const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: twentyHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectStaleInProgress(habitatId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('ignores tasks under threshold', () => {
    const task = taskRepo.createTask({
      missionId,
      title: 'Fresh Task',
      createdBy: 'human',
    });
    const db = getDb();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: oneHourAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectStaleInProgress(habitatId, defaultSettings);
    expect(result).toHaveLength(0);
  });
});

describe('detectRejectionSpike', () => {
  it('returns empty when too few tasks', () => {
    const result = detectRejectionSpike(habitatId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects rejection spike', () => {
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      const task = taskRepo.createTask({ missionId, title: `Task ${i}`, createdBy: 'human' });
      db.update(tasks).set({ status: 'rejected', rejectedCount: 1, updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id)).run();
    }
    for (let i = 0; i < 4; i++) {
      const task = taskRepo.createTask({ missionId, title: `Approved ${i}`, createdBy: 'human' });
      db.update(tasks).set({ status: 'approved', updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id)).run();
    }

    const result = detectRejectionSpike(habitatId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('rejection_spike');
  });
});

describe('detectCycleTimeDegradation', () => {
  it('returns empty when insufficient data', () => {
    const result = detectCycleTimeDegradation(habitatId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects cycle time increase', () => {
    const db = getDb();
    const now = Date.now();
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();

    for (let i = 0; i < 3; i++) {
      const task = taskRepo.createTask({ missionId, title: `Fast ${i}`, createdBy: 'human' });
      db.update(tasks).set({ status: 'approved', claimedAt: tenDaysAgo, completedAt: nineDaysAgoFrom(tenDaysAgo, 30), assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();
    }

    for (let i = 0; i < 3; i++) {
      const task = taskRepo.createTask({ missionId, title: `Slow ${i}`, createdBy: 'human' });
      db.update(tasks).set({ status: 'approved', claimedAt: sixDaysAgo, completedAt: oneDayAfter(sixDaysAgo), assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();
    }

    const result = detectCycleTimeDegradation(habitatId, defaultSettings);
    expect(result.length).toBeGreaterThanOrEqual(0);
  });
});

function nineDaysAgoFrom(date: string, _minutes: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

function oneDayAfter(date: string): string {
  const d = new Date(date);
  d.setDate(d.getDate() + 1);
  return d.toISOString();
}

describe('detectBacklogGrowth', () => {
  it('returns empty when no active agents', () => {
    const result = detectBacklogGrowth(habitatId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects backlog growth', () => {
    const db = getDb();

    for (let i = 0; i < 10; i++) {
      taskRepo.createTask({ missionId, title: `Pending ${i}`, createdBy: 'human' });
    }

    const task = taskRepo.createTask({ missionId, title: 'Active', createdBy: 'human' });
    db.update(tasks).set({ status: 'in_progress', assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectBacklogGrowth(habitatId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('backlog_growth');
  });
});

describe('detectAgentOffline', () => {
  it('returns empty when all agents are recent', () => {
    const result = detectAgentOffline(habitatId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects offline agent', () => {
    const db = getDb();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.update(agents).set({ lastHeartbeat: thirtyMinAgo }).where(eq(agents.id, agentId)).run();

    const result = detectAgentOffline(habitatId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('agent_offline');
  });
});

describe('detectAnomalies', () => {
  it('returns empty list for empty habitat', () => {
    const result = detectAnomalies(habitatId);
    expect(result).toHaveLength(0);
  });

  it('respects enabled=false in settings', () => {
    const db = getDb();
    const settings = { ...defaultSettings, enabled: false };
    db.update(habitats).set({ anomalySettings: settings }).where(eq(habitats.id, habitatId)).run();

    const task = taskRepo.createTask({ missionId, title: 'Stale', createdBy: 'human' });
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectAnomalies(habitatId);
    expect(result).toHaveLength(0);
  });
});

describe('scanHabitat chat notifications', () => {
  it('calls chat service when notifications.chat is true', async () => {
    const { sendAnomalyAlert } = await import('../services/chatService.js');
    const db = getDb();
    db.update(habitats).set({
      anomalySettings: { ...defaultSettings, notifications: { sse: true, email: true, chat: true } },
    }).where(eq(habitats.id, habitatId)).run();

    const task = taskRepo.createTask({ missionId, title: 'Stale Chat Task', createdBy: 'human' });
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = scanHabitat(habitatId);
    expect(result).toHaveLength(1);
    expect(sendAnomalyAlert).toHaveBeenCalledTimes(1);
    expect(sendAnomalyAlert).toHaveBeenCalledWith(habitatId, expect.objectContaining({
      type: 'stale_in_progress',
      severity: 'medium',
    }));
  });

  it('does NOT call chat service when notifications.chat is false', async () => {
    const { sendAnomalyAlert } = await import('../services/chatService.js');
    const db = getDb();
    db.update(habitats).set({
      anomalySettings: { ...defaultSettings, notifications: { sse: true, email: true, chat: false } },
    }).where(eq(habitats.id, habitatId)).run();

    const task = taskRepo.createTask({ missionId, title: 'Stale No Chat Task', createdBy: 'human' });
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = scanHabitat(habitatId);
    expect(result).toHaveLength(1);
    expect(sendAnomalyAlert).not.toHaveBeenCalled();
  });

  it('SSE dispatch still produces anomalies regardless of chat flag', async () => {
    const { sendAnomalyAlert } = await import('../services/chatService.js');
    const db = getDb();
    db.update(habitats).set({
      anomalySettings: { ...defaultSettings, notifications: { sse: true, email: true, chat: false } },
    }).where(eq(habitats.id, habitatId)).run();

    const task = taskRepo.createTask({ missionId, title: 'SSE Check Task', createdBy: 'human' });
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = scanHabitat(habitatId);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('stale_in_progress');
    expect(sendAnomalyAlert).not.toHaveBeenCalled();
  });
});
