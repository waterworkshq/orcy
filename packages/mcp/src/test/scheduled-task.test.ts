import { describe, it, expect, vi } from 'vitest';
import { adminListScheduledTasks, adminCreateScheduledTask, adminRunScheduledTask, adminGetScheduledTask, adminUpdateScheduledTask, adminDeleteScheduledTask, adminToggleScheduledTask } from '../tools/scheduled-task.js';

const mockClient = {
  listScheduledTasks: vi.fn(() => Promise.resolve({ scheduledTasks: [{ id: 'st-1', name: 'Test' }] })),
  createScheduledTask: vi.fn(() => Promise.resolve({ scheduledTask: { id: 'st-2', name: 'New Schedule' } })),
  runScheduledTask: vi.fn(() => Promise.resolve({ success: true, featureId: 'feat-1' })),
  getScheduledTask: vi.fn(() => Promise.resolve({ scheduledTask: { id: 'st-1', name: 'Test' } })),
  updateScheduledTask: vi.fn(() => Promise.resolve({ scheduledTask: { id: 'st-1', name: 'Updated' } })),
  deleteScheduledTask: vi.fn(() => Promise.resolve(undefined)),
  enableScheduledTask: vi.fn(() => Promise.resolve({ scheduledTask: { id: 'st-1', enabled: true } })),
  disableScheduledTask: vi.fn(() => Promise.resolve({ scheduledTask: { id: 'st-1', enabled: false } })),
} as any;

describe('adminListScheduledTasks', () => {
  it('calls client.listScheduledTasks with boardId', async () => {
    const result = await adminListScheduledTasks(mockClient, { boardId: 'board-1' });
    expect(mockClient.listScheduledTasks).toHaveBeenCalledWith('board-1');
    expect(result).toEqual({ scheduledTasks: [{ id: 'st-1', name: 'Test' }] });
  });
});

describe('adminCreateScheduledTask', () => {
  it('calls client.createScheduledTask with boardId and input', async () => {
    const input = {
      boardId: 'board-1',
      name: 'New Schedule',
      scheduleType: 'cron' as const,
      cronExpression: '0 * * * *',
      featureTitle: 'Weekly Review',
    };
    const result = await adminCreateScheduledTask(mockClient, input);
    expect(mockClient.createScheduledTask).toHaveBeenCalledWith('board-1', input);
    expect(result).toEqual({ scheduledTask: { id: 'st-2', name: 'New Schedule' } });
  });
});

describe('adminRunScheduledTask', () => {
  it('calls client.runScheduledTask with scheduledTaskId', async () => {
    const result = await adminRunScheduledTask(mockClient, { scheduledTaskId: 'st-1' });
    expect(mockClient.runScheduledTask).toHaveBeenCalledWith('st-1');
    expect(result).toEqual({ success: true, featureId: 'feat-1' });
  });
});

describe('adminGetScheduledTask', () => {
  it('calls client.getScheduledTask with scheduledTaskId', async () => {
    const result = await adminGetScheduledTask(mockClient, { scheduledTaskId: 'st-1' });
    expect(mockClient.getScheduledTask).toHaveBeenCalledWith('st-1');
    expect(result).toEqual({ scheduledTask: { id: 'st-1', name: 'Test' } });
  });
});

describe('adminUpdateScheduledTask', () => {
  it('calls client.updateScheduledTask with scheduledTaskId and input', async () => {
    const result = await adminUpdateScheduledTask(mockClient, {
      scheduledTaskId: 'st-1',
      name: 'Updated',
      cronExpression: '0 0 * * *',
    });
    expect(mockClient.updateScheduledTask).toHaveBeenCalledWith('st-1', {
      name: 'Updated',
      cronExpression: '0 0 * * *',
    });
    expect(result).toEqual({ scheduledTask: { id: 'st-1', name: 'Updated' } });
  });
});

describe('adminDeleteScheduledTask', () => {
  it('calls client.deleteScheduledTask with scheduledTaskId', async () => {
    const result = await adminDeleteScheduledTask(mockClient, { scheduledTaskId: 'st-1' });
    expect(mockClient.deleteScheduledTask).toHaveBeenCalledWith('st-1');
    expect(result).toBeUndefined();
  });
});

describe('adminToggleScheduledTask', () => {
  it('calls client.enableScheduledTask when enabled is true', async () => {
    const result = await adminToggleScheduledTask(mockClient, { scheduledTaskId: 'st-1', enabled: true });
    expect(mockClient.enableScheduledTask).toHaveBeenCalledWith('st-1');
    expect(result).toEqual({ scheduledTask: { id: 'st-1', enabled: true } });
  });

  it('calls client.disableScheduledTask when enabled is false', async () => {
    const result = await adminToggleScheduledTask(mockClient, { scheduledTaskId: 'st-1', enabled: false });
    expect(mockClient.disableScheduledTask).toHaveBeenCalledWith('st-1');
    expect(result).toEqual({ scheduledTask: { id: 'st-1', enabled: false } });
  });
});
