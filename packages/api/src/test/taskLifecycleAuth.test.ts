import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initTestDb, closeDb } from '../db/index.js';
import * as agentRepo from '../repositories/agent.js';
import * as habitatRepo from '../repositories/board.js';
import * as columnRepo from '../repositories/column.js';
import * as missionRepo from '../repositories/feature.js';
import * as taskRepo from '../repositories/task.js';
import * as taskService from '../services/tasks/index.js';
import { taskLifecycleRoutes } from '../routes/tasks/lifecycle.js';
import {
  authorizeTaskAction,
  getPrincipalFromRequest,
  isAssignedAgent,
  isHumanReviewer,
} from '../middleware/taskAuth.js';
import type { Principal } from '../middleware/taskAuth.js';
import type { Task } from '../models/index.js';
import { isAppError } from '../errors.js';

function mockReqRes(overrides: Record<string, any> = {}) {
  const request: any = {
    params: {},
    query: {},
    body: {},
    agent: undefined,
    user: undefined,
    ...overrides,
  };

  const sent: any = { code: null, body: null };
  const reply: any = {
    code: vi.fn((c: number) => { sent.code = c; return reply; }),
    send: vi.fn((b: any) => { sent.body = b; return reply; }),
  };
  return { request, reply, sent };
}

async function callHandler(handler: RouteHandler, request: any, reply: any): Promise<{ code: number | null; body: any }> {
  const sent: any = { code: null, body: null };
  try {
    await handler(request, reply);
  } catch (err) {
    if (isAppError(err)) {
      sent.code = err.statusCode;
      sent.body = { error: err.message, code: err.code };
    } else {
      throw err;
    }
  }
  return sent;
}

type RouteHandler = (req: any, reply: any) => Promise<void>;
interface CapturedRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

function captureRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    post: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'POST', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    get: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'GET', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    put: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'PUT', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'DELETE', path, handler: typeof opts === 'function' ? opts : handler });
    }),
  };
  taskLifecycleRoutes(fakeFastify);
  return routes;
}

function findRoute(routes: CapturedRoute[], pathPattern: string): RouteHandler {
  const r = routes.find(route => route.method === 'POST' && route.path.includes(pathPattern));
  if (!r) throw new Error(`Route POST ${pathPattern} not found`);
  return r.handler;
}

function setupBoardWithTask(
  agentId: string,
  status: string = 'pending'
): { habitatId: string; missionId: string; taskId: string } {
  const habitat = habitatRepo.createHabitat({ name: 'Test Habitat' });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: 'Backlog' });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: 'Test Mission',
    createdBy: 'test',
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: 'Test Task',
    createdBy: 'test',
  });

  if (status !== 'pending') {
    if (status === 'claimed' || status === 'in_progress' || status === 'submitted') {
      taskRepo.claimTask(task.id, agentId);
    }
    if (status === 'in_progress' || status === 'submitted') {
      taskRepo.startTask(task.id, agentId);
    }
    if (status === 'submitted') {
      taskRepo.submitTask(task.id, agentId, 'result', []);
    }
  }

  return { habitatId: habitat.id, missionId: mission.id, taskId: task.id };
}

describe('Task Lifecycle Authorization', () => {
  let agent1Id: string;
  let agent2Id: string;
  let routes: CapturedRoute[];

  beforeEach(async () => {
    await initTestDb();

    const a1 = agentRepo.createAgent({ name: 'agent-a', type: 'claude-code', domain: 'fullstack' });
    agent1Id = a1.agent.id;

    const a2 = agentRepo.createAgent({ name: 'agent-b', type: 'opencode', domain: 'frontend' });
    agent2Id = a2.agent.id;

    routes = captureRoutes();
  });

  afterEach(() => { closeDb(); });

  describe('Authorization matrix — authorizeTaskAction', () => {
    let claimedTask: Task;

    beforeEach(() => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      claimedTask = taskRepo.getTaskById(taskId)!;
    });

    it('assigned agent can start its own task', () => {
      const principal: Principal = { type: 'agent', id: agent1Id };
      expect(authorizeTaskAction(claimedTask, principal, 'start').allowed).toBe(true);
    });

    it('non-assigned agent cannot start task', () => {
      const principal: Principal = { type: 'agent', id: agent2Id };
      const result = authorizeTaskAction(claimedTask, principal, 'start');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('assigned agent');
    });

    it('assigned agent can submit its own task', () => {
      const principal: Principal = { type: 'agent', id: agent1Id };
      expect(authorizeTaskAction(claimedTask, principal, 'submit').allowed).toBe(true);
    });

    it('non-assigned agent cannot submit task', () => {
      const principal: Principal = { type: 'agent', id: agent2Id };
      const result = authorizeTaskAction(claimedTask, principal, 'submit');
      expect(result.allowed).toBe(false);
    });

    it('assigned agent can release its own task', () => {
      const principal: Principal = { type: 'agent', id: agent1Id };
      expect(authorizeTaskAction(claimedTask, principal, 'release').allowed).toBe(true);
    });

    it('non-assigned agent cannot release task', () => {
      const principal: Principal = { type: 'agent', id: agent2Id };
      const result = authorizeTaskAction(claimedTask, principal, 'release');
      expect(result.allowed).toBe(false);
    });

    it('assigned agent can fail its own task', () => {
      const principal: Principal = { type: 'agent', id: agent1Id };
      expect(authorizeTaskAction(claimedTask, principal, 'fail').allowed).toBe(true);
    });

    it('non-assigned agent cannot fail task', () => {
      const principal: Principal = { type: 'agent', id: agent2Id };
      const result = authorizeTaskAction(claimedTask, principal, 'fail');
      expect(result.allowed).toBe(false);
    });

    it('assigned agent can complete its own task', () => {
      const principal: Principal = { type: 'agent', id: agent1Id };
      expect(authorizeTaskAction(claimedTask, principal, 'complete').allowed).toBe(true);
    });

    it('human admin can approve task', () => {
      const principal: Principal = { type: 'human', id: 'human-1', role: 'admin' };
      expect(authorizeTaskAction(claimedTask, principal, 'approve').allowed).toBe(true);
    });

    it('human editor can approve task', () => {
      const principal: Principal = { type: 'human', id: 'human-1', role: 'editor' };
      expect(authorizeTaskAction(claimedTask, principal, 'approve').allowed).toBe(true);
    });

    it('human viewer cannot approve task', () => {
      const principal: Principal = { type: 'human', id: 'human-1', role: 'viewer' };
      const result = authorizeTaskAction(claimedTask, principal, 'approve');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('reviewer');
    });

    it('agent cannot approve task', () => {
      const principal: Principal = { type: 'agent', id: agent1Id };
      const result = authorizeTaskAction(claimedTask, principal, 'approve');
      expect(result.allowed).toBe(false);
    });

    it('human admin can reject task', () => {
      const principal: Principal = { type: 'human', id: 'human-1', role: 'admin' };
      expect(authorizeTaskAction(claimedTask, principal, 'reject').allowed).toBe(true);
    });

    it('agent cannot reject task', () => {
      const principal: Principal = { type: 'agent', id: agent1Id };
      const result = authorizeTaskAction(claimedTask, principal, 'reject');
      expect(result.allowed).toBe(false);
    });

    it('human admin can release any task', () => {
      const principal: Principal = { type: 'human', id: 'human-1', role: 'admin' };
      expect(authorizeTaskAction(claimedTask, principal, 'release').allowed).toBe(true);
    });

    it('human admin can fail any task', () => {
      const principal: Principal = { type: 'human', id: 'human-1', role: 'admin' };
      expect(authorizeTaskAction(claimedTask, principal, 'fail').allowed).toBe(true);
    });

    it('unauthenticated principal is denied all actions', () => {
      const result = authorizeTaskAction(claimedTask, undefined, 'start');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('Authentication required');
    });

    it('unblock is always denied via authorizeTaskAction', () => {
      const principal: Principal = { type: 'agent', id: agent1Id };
      const result = authorizeTaskAction(claimedTask, principal, 'unblock');
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('internal-only');
    });
  });

  describe('Helper functions', () => {
    it('isAssignedAgent returns true for matching agent', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      const task = taskRepo.getTaskById(taskId)!;
      expect(isAssignedAgent(task, { type: 'agent', id: agent1Id })).toBe(true);
    });

    it('isAssignedAgent returns false for non-matching agent', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      const task = taskRepo.getTaskById(taskId)!;
      expect(isAssignedAgent(task, { type: 'agent', id: agent2Id })).toBe(false);
    });

    it('isHumanReviewer returns true for admin', () => {
      expect(isHumanReviewer({ type: 'human', id: 'h1', role: 'admin' })).toBe(true);
    });

    it('isHumanReviewer returns true for editor', () => {
      expect(isHumanReviewer({ type: 'human', id: 'h1', role: 'editor' })).toBe(true);
    });

    it('isHumanReviewer returns false for viewer', () => {
      expect(isHumanReviewer({ type: 'human', id: 'h1', role: 'viewer' })).toBe(false);
    });

    it('getPrincipalFromRequest extracts agent principal', () => {
      const req = mockReqRes({ agent: { id: agent1Id } }).request;
      const p = getPrincipalFromRequest(req);
      expect(p).toEqual({ type: 'agent', id: agent1Id });
    });

    it('getPrincipalFromRequest extracts human principal', () => {
      const req = mockReqRes({ user: { id: 'h1', role: 'admin' as const } }).request;
      const p = getPrincipalFromRequest(req);
      expect(p).toEqual({ type: 'human', id: 'h1', role: 'admin' });
    });

    it('getPrincipalFromRequest returns undefined for unauthenticated', () => {
      expect(getPrincipalFromRequest(mockReqRes().request)).toBeUndefined();
    });
  });

  describe('Service-layer defense-in-depth', () => {
    it('startTask rejects non-assigned agent', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      const result = taskService.startTask(taskId, agent2Id);
      expect(result).toBeNull();
    });

    it('submitTask rejects non-assigned agent', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'in_progress');
      const result = taskService.submitTask(taskId, agent2Id, 'result', []);
      expect(result.task).toBeNull();
    });

    it('completeTask rejects non-assigned agent', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'submitted');
      const result = taskService.completeTask(taskId, agent2Id, 'note');
      expect(result.task).toBeNull();
    });

    it('releaseTask rejects non-assigned agent', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      const result = taskService.releaseTask(taskId, agent2Id, 'reason');
      expect(result).toBeNull();
    });

    it('failTask rejects non-assigned agent (agentType=agent)', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'in_progress');
      const result = taskService.failTask(taskId, agent2Id, 'agent', 'reason');
      expect(result).toBeNull();
    });

    it('failTask allows system actor regardless of assignment', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'in_progress');
      const result = taskService.failTask(taskId, 'system-actor', 'system', 'timeout');
      expect(result).not.toBeNull();
    });

    it('assigned agent can start own task via service', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      const result = taskService.startTask(taskId, agent1Id);
      expect(result).not.toBeNull();
      expect(result!.status).toBe('in_progress');
    });

    it('assigned agent can submit own task via service', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'in_progress');
      const result = taskService.submitTask(taskId, agent1Id, 'done', []);
      expect(result.task).not.toBeNull();
      expect(result.task!.status).toBe('submitted');
    });
  });

  describe('Route-level integration tests', () => {
    it('assigned agent can submit its claimed task via route', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'in_progress');
      const handler = findRoute(routes, '/tasks/:id/submit');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: { result: 'Completed work' },
        agent: { id: agent1Id, name: 'agent-a', domain: 'fullstack', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBeNull();
    });

    it('non-assigned agent cannot release another agent\'s claimed task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      const handler = findRoute(routes, '/tasks/:id/release');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: { reason: 'stealing' },
        agent: { id: agent2Id, name: 'agent-b', domain: 'frontend', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
      expect(result.body.error).toContain('assigned agent');
    });

    it('non-assigned agent cannot fail another agent\'s task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'in_progress');
      const handler = findRoute(routes, '/tasks/:id/fail');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: { reason: 'sabotage' },
        agent: { id: agent2Id, name: 'agent-b', domain: 'frontend', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
    });

    it('agent cannot approve submitted task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'submitted');
      const handler = findRoute(routes, '/tasks/:id/approve');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: {},
        agent: { id: agent1Id, name: 'agent-a', domain: 'fullstack' },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
    });

    it('agent cannot reject submitted task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'submitted');
      const handler = findRoute(routes, '/tasks/:id/reject');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: { reason: 'bad' },
        agent: { id: agent1Id, name: 'agent-a', domain: 'fullstack' },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
    });

    it('anonymous unblock request returns 401', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'pending');
      const handler = findRoute(routes, '/tasks/:id/unblock');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(401);
    });

    it('authenticated agent receives 403 for unblock', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'pending');
      const handler = findRoute(routes, '/tasks/:id/unblock');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        agent: { id: agent1Id, name: 'agent-a', domain: 'fullstack' },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
      expect(result.body.error).toContain('internal-only');
    });

    it('non-assigned agent receives 403 for unblock', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'pending');
      const handler = findRoute(routes, '/tasks/:id/unblock');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        agent: { id: agent2Id, name: 'agent-b', domain: 'frontend' },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
      expect(result.body.error).toContain('internal-only');
    });

    it('non-assigned agent cannot start another agent\'s task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      const handler = findRoute(routes, '/tasks/:id/start');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        agent: { id: agent2Id, name: 'agent-b', domain: 'frontend', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
    });

    it('non-assigned agent cannot submit another agent\'s task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'in_progress');
      const handler = findRoute(routes, '/tasks/:id/submit');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: { result: 'spoofed' },
        agent: { id: agent2Id, name: 'agent-b', domain: 'frontend', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
    });

    it('non-assigned agent cannot complete another agent\'s task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'submitted');
      const handler = findRoute(routes, '/tasks/:id/complete');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: { reviewNote: 'note' },
        agent: { id: agent2Id, name: 'agent-b', domain: 'frontend', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
    });

    it('assigned agent can release own task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'claimed');
      const handler = findRoute(routes, '/tasks/:id/release');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: { reason: 'done' },
        agent: { id: agent1Id, name: 'agent-a', domain: 'fullstack', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBeNull();
    });

    it('assigned agent can fail own task', async () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'in_progress');
      const handler = findRoute(routes, '/tasks/:id/fail');

      const { request, reply } = mockReqRes({
        params: { id: taskId },
        body: { reason: 'stuck' },
        agent: { id: agent1Id, name: 'agent-a', domain: 'fullstack', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBeNull();
    });
  });

  describe('Atomic claim and domain mismatch preservation', () => {
    it('claim still works for pending task', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'pending');
      const result = taskService.claimTask(taskId, agent1Id);
      expect(result.success).toBe(true);
    });

    it('domain mismatch still blocks claim at route level', async () => {
      const habitat = habitatRepo.createHabitat({ name: 'Domain Habitat' });
      const column = columnRepo.createColumn({ habitatId: habitat.id, name: 'Col' });
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId: column.id,
        title: 'Domain Mission',
        createdBy: 'test',
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: 'Backend Task',
        requiredDomain: 'backend',
        createdBy: 'test',
      });

      const handler = findRoute(routes, '/tasks/:id/claim');

      const { request, reply } = mockReqRes({
        params: { id: task.id },
        body: {},
        agent: { id: agent2Id, name: 'agent-b', domain: 'frontend', capabilities: [] },
      });

      const result = await callHandler(handler, request, reply);
      expect(result.code).toBe(403);
      expect(result.body.error).toContain('Domain mismatch');
    });

    it('claim race condition still returns already_claimed', () => {
      const { taskId } = setupBoardWithTask(agent1Id, 'pending');
      taskService.claimTask(taskId, agent1Id);

      const result = taskService.claimTask(taskId, agent2Id);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.reason).toBe('already_claimed');
      }
    });
  });
});
