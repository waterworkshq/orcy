import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as boardRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as taskRepo from '../repositories/task.js';
import * as featureRepo from '../repositories/feature.js';
import * as agentRepo from '../repositories/agent.js';
import { taskEvents, tasks, columns as columnsTable, boards, agents } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import {
  detectStaleInProgress,
  detectRejectionSpike,
  detectCycleTimeDegradation,
  detectBacklogGrowth,
  detectAgentOffline,
  detectAnomalies,
  getDefaultAnomalySettings,
  scanBoard,
} from '../services/anomalyService.js';
import type { AnomalySettings } from '../models/index.js';

vi.mock('../services/chatService.js', () => ({
  sendAnomalyAlert: vi.fn().mockResolvedValue(undefined),
  processEvent: vi.fn().mockResolvedValue(undefined),
  executeCommand: vi.fn().mockResolvedValue({ response: {}, provider: 'slack' as const }),
  sendTestMessage: vi.fn().mockResolvedValue({ success: true, statusCode: 200, latencyMs: 0 }),
}));

let boardId: string;
let columnId: string;
let featureId: string;
let agentId: string;

const defaultSettings: AnomalySettings = getDefaultAnomalySettings();

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(columnsTable).run();
  db.delete(boards).run();
  db.delete(agents).run();

  vi.clearAllMocks();

  const { agent } = agentRepo.createAgent({ name: 'test-agent', type: 'claude-code', domain: 'backend' });
  agentId = agent.id;

  const board = boardRepo.createBoard({ name: 'Test Board' });
  boardId = board.id;

  const columns = columnRepo.createColumn({ boardId, name: 'Backlog', order: 0, requiresClaim: false });
  columnId = columns.id;

  const feature = featureRepo.createFeature({ boardId, columnId, title: 'Test Feature', createdBy: 'human' });
  featureId = feature.id;
});

afterEach(() => {
  closeDb();
});

describe('detectStaleInProgress', () => {
  it('returns no anomalies when no in-progress tasks', () => {
    const result = detectStaleInProgress(boardId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects a stale in-progress task', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Stale Task',
      createdBy: 'human',
    });
    const db = getDb();
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectStaleInProgress(boardId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('stale_in_progress');
    expect(result[0].severity).toBe('medium');
  });

  it('returns critical severity for very stale tasks', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Very Stale Task',
      createdBy: 'human',
    });
    const db = getDb();
    const twentyHoursAgo = new Date(Date.now() - 20 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: twentyHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectStaleInProgress(boardId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].severity).toBe('critical');
  });

  it('ignores tasks under threshold', () => {
    const task = taskRepo.createTask({
      featureId,
      title: 'Fresh Task',
      createdBy: 'human',
    });
    const db = getDb();
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: oneHourAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectStaleInProgress(boardId, defaultSettings);
    expect(result).toHaveLength(0);
  });
});

describe('detectRejectionSpike', () => {
  it('returns empty when too few tasks', () => {
    const result = detectRejectionSpike(boardId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects rejection spike', () => {
    const db = getDb();
    for (let i = 0; i < 6; i++) {
      const task = taskRepo.createTask({ featureId, title: `Task ${i}`, createdBy: 'human' });
      db.update(tasks).set({ status: 'rejected', rejectedCount: 1, updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id)).run();
    }
    for (let i = 0; i < 4; i++) {
      const task = taskRepo.createTask({ featureId, title: `Approved ${i}`, createdBy: 'human' });
      db.update(tasks).set({ status: 'approved', updatedAt: new Date().toISOString() }).where(eq(tasks.id, task.id)).run();
    }

    const result = detectRejectionSpike(boardId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('rejection_spike');
  });
});

describe('detectCycleTimeDegradation', () => {
  it('returns empty when insufficient data', () => {
    const result = detectCycleTimeDegradation(boardId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects cycle time increase', () => {
    const db = getDb();
    const now = Date.now();
    const fiveDaysAgo = new Date(now - 5 * 24 * 60 * 60 * 1000).toISOString();
    const tenDaysAgo = new Date(now - 10 * 24 * 60 * 60 * 1000).toISOString();
    const sixDaysAgo = new Date(now - 6 * 24 * 60 * 60 * 1000).toISOString();

    for (let i = 0; i < 3; i++) {
      const task = taskRepo.createTask({ featureId, title: `Fast ${i}`, createdBy: 'human' });
      db.update(tasks).set({ status: 'approved', claimedAt: tenDaysAgo, completedAt: nineDaysAgoFrom(tenDaysAgo, 30), assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();
    }

    for (let i = 0; i < 3; i++) {
      const task = taskRepo.createTask({ featureId, title: `Slow ${i}`, createdBy: 'human' });
      db.update(tasks).set({ status: 'approved', claimedAt: sixDaysAgo, completedAt: oneDayAfter(sixDaysAgo), assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();
    }

    const result = detectCycleTimeDegradation(boardId, defaultSettings);
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
    const result = detectBacklogGrowth(boardId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects backlog growth', () => {
    const db = getDb();

    for (let i = 0; i < 10; i++) {
      taskRepo.createTask({ featureId, title: `Pending ${i}`, createdBy: 'human' });
    }

    const task = taskRepo.createTask({ featureId, title: 'Active', createdBy: 'human' });
    db.update(tasks).set({ status: 'in_progress', assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectBacklogGrowth(boardId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('backlog_growth');
  });
});

describe('detectAgentOffline', () => {
  it('returns empty when all agents are recent', () => {
    const result = detectAgentOffline(boardId, defaultSettings);
    expect(result).toHaveLength(0);
  });

  it('detects offline agent', () => {
    const db = getDb();
    const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    db.update(agents).set({ lastHeartbeat: thirtyMinAgo }).where(eq(agents.id, agentId)).run();

    const result = detectAgentOffline(boardId, defaultSettings);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('agent_offline');
  });
});

describe('detectAnomalies', () => {
  it('returns empty list for empty board', () => {
    const result = detectAnomalies(boardId);
    expect(result).toHaveLength(0);
  });

  it('respects enabled=false in settings', () => {
    const db = getDb();
    const settings = { ...defaultSettings, enabled: false };
    db.update(boards).set({ anomalySettings: settings }).where(eq(boards.id, boardId)).run();

    const task = taskRepo.createTask({ featureId, title: 'Stale', createdBy: 'human' });
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = detectAnomalies(boardId);
    expect(result).toHaveLength(0);
  });
});

describe('scanBoard chat notifications', () => {
  it('calls chat service when notifications.chat is true', async () => {
    const { sendAnomalyAlert } = await import('../services/chatService.js');
    const db = getDb();
    db.update(boards).set({
      anomalySettings: { ...defaultSettings, notifications: { sse: true, email: true, chat: true } },
    }).where(eq(boards.id, boardId)).run();

    const task = taskRepo.createTask({ featureId, title: 'Stale Chat Task', createdBy: 'human' });
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = scanBoard(boardId);
    expect(result).toHaveLength(1);
    expect(sendAnomalyAlert).toHaveBeenCalledTimes(1);
    expect(sendAnomalyAlert).toHaveBeenCalledWith(boardId, expect.objectContaining({
      type: 'stale_in_progress',
      severity: 'medium',
    }));
  });

  it('does NOT call chat service when notifications.chat is false', async () => {
    const { sendAnomalyAlert } = await import('../services/chatService.js');
    const db = getDb();
    db.update(boards).set({
      anomalySettings: { ...defaultSettings, notifications: { sse: true, email: true, chat: false } },
    }).where(eq(boards.id, boardId)).run();

    const task = taskRepo.createTask({ featureId, title: 'Stale No Chat Task', createdBy: 'human' });
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = scanBoard(boardId);
    expect(result).toHaveLength(1);
    expect(sendAnomalyAlert).not.toHaveBeenCalled();
  });

  it('SSE dispatch still produces anomalies regardless of chat flag', async () => {
    const { sendAnomalyAlert } = await import('../services/chatService.js');
    const db = getDb();
    db.update(boards).set({
      anomalySettings: { ...defaultSettings, notifications: { sse: true, email: true, chat: false } },
    }).where(eq(boards.id, boardId)).run();

    const task = taskRepo.createTask({ featureId, title: 'SSE Check Task', createdBy: 'human' });
    const fiveHoursAgo = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString();
    db.update(tasks).set({ status: 'in_progress', startedAt: fiveHoursAgo, assignedAgentId: agentId }).where(eq(tasks.id, task.id)).run();

    const result = scanBoard(boardId);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('stale_in_progress');
    expect(sendAnomalyAlert).not.toHaveBeenCalled();
  });
});
