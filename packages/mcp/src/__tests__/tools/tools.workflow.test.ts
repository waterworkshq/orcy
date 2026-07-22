import { describe, it, expect } from 'vitest';
import {
  MISSION_DISPATCH_HANDLER,
  TASK_DISPATCH_HANDLER,
} from '../../tools/index.js';
import { createMockClient } from '../__fixtures__/mock-client.js';

describe('Full MCP workflow - create feature → create task → claim → start → submit', () => {
  it('complete lifecycle with correct agent assignment', async () => {
    const client = createMockClient();
    const agentId = 'agent-123';

    // Step 1: Create feature
    const createdMission = {
      id: 'feat-1', boardId: 'board-1', columnId: 'col-todo',
      title: 'Auth Feature', status: 'not_started' as const, priority: 'high' as const,
      description: 'Implement authentication', acceptanceCriteria: 'Users can log in',
      labels: ['auth'], displayOrder: 0, dependsOn: [], blocks: [],
      dueAt: null, slaMinutes: null, slaDeadlineAt: null,
      createdBy: agentId, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1,
    };
    client.createMission.mockResolvedValue({ mission: createdMission });

    const missionRaw = await MISSION_DISPATCH_HANDLER(client, {
      action: 'create',
      boardId: 'board-1', title: 'Auth Feature', priority: 'high',
    });
    const missionResult = JSON.parse(missionRaw.content[0].text);
    expect(missionResult.mission.status).toBe('not_started');
    expect(missionResult.mission.id).toBe('feat-1');

    // Step 2: Create task within feature
    const createdTask = {
      id: 'task-1', featureId: 'feat-1', title: 'Login endpoint',
      status: 'pending' as const, priority: 'high' as const,
      assignedAgentId: null, createdBy: agentId,
    };
    client.publishTaskInMission.mockResolvedValue({
      outcome: 'created',
      attemptId: 'attempt-1',
      taskId: createdTask.id,
    });
    client.getTask.mockResolvedValue({ task: createdTask });

    const taskRaw = await TASK_DISPATCH_HANDLER(client, {
      action: 'create-in-mission',
      missionId: 'feat-1', title: 'Login endpoint', priority: 'high',
    });
    const taskResult = JSON.parse(taskRaw.content[0].text);
    expect(taskResult.task.status).toBe('pending');
    expect(taskResult.task.featureId).toBe('feat-1');

    // Step 3: Get feature context (read feature brief + sibling results)
    const missionContext = {
      mission: { id: 'feat-1', title: 'Auth Feature', description: 'Implement authentication', acceptanceCriteria: 'Users can log in', status: 'in_progress', priority: 'high', boardId: 'board-1', columnId: 'col-todo', labels: [], displayOrder: 0, dependsOn: [], blocks: [], dueAt: null, slaMinutes: null, slaDeadlineAt: null, createdBy: agentId, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', version: 1, progress: { total: 1, pending: 1, claimed: 0, inProgress: 0, submitted: 0, approved: 0, done: 0, failed: 0, rejected: 0 } },
      tasks: [{ id: 'task-1', title: 'Login endpoint', status: 'pending', result: null, artifacts: [], assignedAgentId: null }],
      dependencies: [],
      blocking: [],
    };
    client.getMissionContext.mockResolvedValue(missionContext);

    const contextRaw = await MISSION_DISPATCH_HANDLER(client, { action: 'get-context', missionId: 'feat-1' });
    const contextResult = JSON.parse(contextRaw.content[0].text);
    expect(contextResult.mission.title).toBe('Auth Feature');
    expect(contextResult.tasks).toHaveLength(1);

    // Step 4: Claim task
    const claimedTask = {
      ...createdTask, status: 'claimed' as const,
      assignedAgentId: agentId, claimedAt: new Date().toISOString(),
    };
    client.claimTask.mockResolvedValue({ success: true, task: claimedTask });
    client.getAgentById.mockResolvedValue({ agent: { id: agentId, name: 'test-agent' } });

    const claimRaw = await TASK_DISPATCH_HANDLER(client, { action: 'claim', taskId: 'task-1' });
    const claimResult = JSON.parse(claimRaw.content[0].text);
    expect(claimResult.success).toBe(true);
    if (claimResult.success) {
      expect(claimResult.task.assignedAgentId).toBe(agentId);
      expect(claimResult.task.assignedAgentName).toBe('test-agent');
    }

    // Step 5: Start task
    const startedTask = {
      ...claimedTask, status: 'in_progress' as const,
      startedAt: new Date().toISOString(),
      assignedAgentName: 'test-agent',
    };
    client.startTask.mockResolvedValue({ task: startedTask });
    client.getAgentById.mockResolvedValue({ agent: { id: agentId, name: 'test-agent' } });

    const startRaw = await TASK_DISPATCH_HANDLER(client, {
      action: 'update',
      taskId: 'task-1', status: 'in_progress',
    });
    const startResult = JSON.parse(startRaw.content[0].text);
    expect(startResult.task.status).toBe('in_progress');

    // Step 6: Submit task
    const submittedTask = {
      ...startedTask, status: 'submitted' as const,
      submittedAt: new Date().toISOString(),
    };
    client.submitTask.mockResolvedValue({
      success: true, task: submittedTask,
      message: 'Task submitted for review.',
    });

    const submitRaw = await TASK_DISPATCH_HANDLER(client, {
      action: 'submit', taskId: 'task-1', result: 'Implemented login endpoint', artifacts: [],
    });
    const submitResult = JSON.parse(submitRaw.content[0].text);
    expect(submitResult.success).toBe(true);
    expect(submitResult.task.status).toBe('submitted');
  });

  it('fail path: in_progress → failed clears agent', async () => {
    const client = createMockClient();

    const failedTask = {
      id: 'task-1', featureId: 'feat-1',
      title: 'Failed task', status: 'failed' as const, priority: 'high' as const,
      assignedAgentId: null, completedAt: new Date().toISOString(),
    };
    client.failTask.mockResolvedValue({ task: failedTask });
    client.getAgentById.mockResolvedValue(null);

    const raw = await TASK_DISPATCH_HANDLER(client, {
      action: 'update',
      taskId: 'task-1', status: 'failed', failureReason: 'Could not complete',
    });
    const result = JSON.parse(raw.content[0].text);

    expect(client.failTask).toHaveBeenCalledWith('task-1', 'Could not complete');
    expect(result.task.status).toBe('failed');
    expect(result.task.assignedAgentId).toBeNull();
  });

  it('agent name enrichment resolves IDs to names', async () => {
    const client = createMockClient();
    const agentId = 'agent-456';

    const task = {
      id: 'task-1', featureId: 'feat-1', status: 'claimed' as const,
      assignedAgentId: agentId,
    };
    client.claimTask.mockResolvedValue({ success: true, task });
    client.getAgentById.mockResolvedValue({ agent: { id: agentId, name: 'opencode' } });

    const raw = await TASK_DISPATCH_HANDLER(client, { action: 'claim', taskId: 'task-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(client.getAgentById).toHaveBeenCalledWith(agentId);
    if (result.success) {
      expect(result.task.assignedAgentName).toBe('opencode');
    }
  });

  it('lists features with progress', async () => {
    const client = createMockClient();
    const mockFeatures = [
      {
        id: 'feat-1', boardId: 'board-1', columnId: 'col-1', title: 'Feature 1',
        description: '', acceptanceCriteria: '', priority: 'high' as const, labels: [],
        status: 'in_progress' as const, displayOrder: 0, dependsOn: [], blocks: [],
        dueAt: null, slaMinutes: null, slaDeadlineAt: null,
        createdBy: 'agent-1', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
        version: 1,
        progress: { total: 3, pending: 1, claimed: 0, inProgress: 1, submitted: 0, approved: 1, done: 0, failed: 0, rejected: 0 },
      },
    ];
    client.listMissions.mockResolvedValue({ missions: mockFeatures, total: 1 });

    const raw = await MISSION_DISPATCH_HANDLER(client, { action: 'list', boardId: 'board-1' });
    const result = JSON.parse(raw.content[0].text);

    expect(result.missions[0].progress.total).toBe(3);
    expect(result.missions[0].progress.inProgress).toBe(1);
  });
});
