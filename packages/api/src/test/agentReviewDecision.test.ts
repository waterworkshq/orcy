/**
 * Agent review decision restoration — behavior-first contract tests.
 *
 * Scope (implementation contract, capability-recovery epic):
 *  - Only approve/reject decision routes admit agents. Agent admission
 *    requires a pending typed agent reviewer row; identity (id AND type)
 *    derives from the authenticated principal, never the request body.
 *  - Human decision semantics are unchanged: role gate, existence-based
 *    reviewer check, idempotent re-approve, approved-then-reject allowed.
 *  - Typed identity: a human row never satisfies an agent principal and
 *    vice versa; ids are never coerced between registries; offline agents
 *    remain valid reviewers (status is not a validity criterion).
 *  - Typed anti-self: reviewerType 'agent' + reviewerId === current
 *    assignedAgentId is self-review and is refused at creation AND at
 *    decision time (in-transaction recheck). Equal human/agent id strings
 *    are NOT self-review.
 *  - Terminal transitions surface CAS/rowcount failure: a lost conditional
 *    UPDATE returns null — never a refetched task as false success.
 *  - Creation validation at both explicit entrypoints (human POST route,
 *    automation request_review action): typed registry resolution, typed
 *    anti-self, idempotent duplicates, explicit type-mismatch failure, no
 *    phantom rows. Automation failures are action results, not HTTP.
 *  - Team habitats: agent reviewer rows are PERMITTED targets (contract
 *    decision; preserves creatable-by-authorized-humans status quo).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as reviewFinality from "../services/reviewFinalityService.js";
import { appendReviewDecisionWithClient, getRequirementWithClient } from "../repositories/reviewSafety.js";
import { getDb, closeDb, initTestDb } from '../db/index.js';
import * as agentRepo from '../repositories/agent.js';
import * as habitatRepo from '../repositories/habitat.js';
import * as columnRepo from '../repositories/column.js';
import * as missionRepo from '../repositories/mission.js';
import * as taskRepo from '../repositories/task.js';
import * as taskReviewerRepo from '../repositories/taskReviewer.js';
import * as taskService from '../services/tasks/index.js';
import * as reviewAssignment from '../services/reviewAssignmentService.js';
import * as automationExecutor from '../services/automationExecutor.js';
import * as reviewRuleRepo from '../repositories/reviewRule.js';
import { taskLifecycleRoutes } from '../routes/tasks/lifecycle.js';
import { reviewRuleRoutes } from '../routes/reviewRules.js';
import { authorizeTaskAction } from '../middleware/taskAuth.js';
import { sseBroadcaster } from '../sse/broadcaster.js';
import * as enrollmentRepo from '../repositories/pluginEnrollment.js';
import * as pluginManager from '../plugins/pluginManager.js';
import {
  agents,
  users,
  tasks,
  taskEvents,
  habitats,
  teams,
  teamMembers,
  organizations,
} from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { isAppError } from '../errors.js';
import type { Task } from '../models/index.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type RouteHandler = (req: any, reply: any) => Promise<void>;

interface CapturedRoute {
  method: string;
  path: string;
  handler: RouteHandler;
}

function captureRoutes(register: (f: any) => void): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    addHook: vi.fn(),
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
    patch: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'PATCH', path, handler: typeof opts === 'function' ? opts : handler });
    }),
    delete: vi.fn((path: string, opts: any, handler: any) => {
      routes.push({ method: 'DELETE', path, handler: typeof opts === 'function' ? opts : handler });
    }),
  };
  register(fakeFastify);
  return routes;
}

function findRoute(routes: CapturedRoute[], method: string, pathPattern: string): RouteHandler {
  const r = routes.find((route) => route.method === method && route.path.includes(pathPattern));
  if (!r) throw new Error(`Route ${method} ${pathPattern} not found`);
  return r.handler;
}

function mockReqRes(overrides: Record<string, any> = {}) {
  const request: any = {
    params: {},
    query: {},
    body: {},
    agent: undefined,
    user: undefined,
    ...overrides,
  };
  const reply: any = {
    code: vi.fn((c: number) => {
      (reply as any).sentCode = c;
      return reply;
    }),
    send: vi.fn((b: any) => {
      (reply as any).sentBody = b;
      return reply;
    }),
  };
  return { request, reply };
}

async function callHandler(handler: RouteHandler, request: any, reply: any) {
  let returned: unknown;
  try {
    returned = await handler(request, reply);
  } catch (err) {
    if (isAppError(err)) {
      (reply as any).sentCode = err.statusCode;
      (reply as any).sentBody = { error: err.message, code: err.code };
      return { code: err.statusCode, body: (reply as any).sentBody };
    }
    throw err;
  }
  if ((reply as any).sentCode === undefined || (reply as any).sentCode === null) {
    // Fastify semantics: a returned value with no explicit code is a 200.
    if (returned !== undefined) {
      return { code: 200, body: returned };
    }
    return { code: (reply as any).sentCode, body: (reply as any).sentBody };
  }
  return { code: (reply as any).sentCode, body: (reply as any).sentBody ?? returned };
}

interface Board {
  habitatId: string;
  missionId: string;
  taskId: string;
}

function setupBoard(): Board {
  const habitat = habitatRepo.createHabitat({ name: 'Agent Review Habitat' });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: 'Backlog' });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: 'Agent Review Mission',
    createdBy: 'test',
  });
  return { habitatId: habitat.id, missionId: mission.id, taskId: '' };
}

/** Creates a task claimed+started+submitted by `workerAgentId` (repo-level — no reviewer side effects). */
function setupSubmittedTask(workerAgentId: string): Board {
  const board = setupBoard();
  const task = taskRepo.createTask({
    missionId: board.missionId,
    title: 'Reviewable Task',
    createdBy: 'test',
  });
  taskRepo.claimTask(task.id, workerAgentId);
  taskRepo.startTask(task.id, workerAgentId);
  const submitted = taskRepo.submitTask(task.id, workerAgentId, 'work result', []);
  if (!submitted) throw new Error('test fixture: submitTask failed');
  return { ...board, taskId: task.id };
}

function makeAgent(name: string, domain = 'fullstack'): string {
  const { agent } = agentRepo.createAgent({ name, type: 'codex', domain });
  return agent.id;
}

function setAgentStatus(agentId: string, status: 'idle' | 'working' | 'offline'): void {
  getDb().update(agents).set({ status }).where(eq(agents.id, agentId)).run();
}

function insertUser(id: string, username: string, role: 'admin' | 'editor' | 'viewer' = 'editor'): void {
  getDb()
    .insert(users)
    .values({ id, username, passwordHash: 'x', displayName: username, role })
    .run();
}

function getRow(taskId: string, reviewerId: string) {
  return taskReviewerRepo.findByTaskAndReviewer(taskId, reviewerId);
}

/** Flips the task row back to `submitted` to model a later review window (rework cycle). */
function reopenForReview(taskId: string): void {
  getDb().update(tasks).set({ status: 'submitted' }).where(eq(tasks.id, taskId)).run();
}

function countTaskEvents(taskId: string, action: string): number {
  const rows = getDb().select().from(taskEvents).all() as Array<{
    taskId: string;
    action: string;
  }>;
  return rows.filter((r) => r.taskId === taskId && r.action === action).length;
}

const pendingAgentEligibility = (taskId: string) => (_tid: string, agentId: string) =>
  reviewAssignment.hasPendingAgentReviewerRow(taskId, agentId);

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('Agent review decisions — admission', () => {
  let workerId: string;
  let reviewerId: string;
  let board: Board;
  let task: Task;
  let routes: CapturedRoute[];

  beforeEach(async () => {
    await initTestDb();
    workerId = makeAgent('worker-agent');
    reviewerId = makeAgent('reviewer-agent');
    board = setupSubmittedTask(workerId);
    task = taskRepo.getTaskById(board.taskId)!;
    routes = captureRoutes(taskLifecycleRoutes);
  });

  afterEach(() => closeDb());

  it('agent holding a pending typed reviewer row may approve', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const result = authorizeTaskAction(task, { type: 'agent', id: reviewerId }, 'approve', {
      hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
    });
    expect(result.allowed).toBe(true);
  });

  it('agent holding a pending typed reviewer row may reject', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const result = authorizeTaskAction(task, { type: 'agent', id: reviewerId }, 'reject', {
      hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
    });
    expect(result.allowed).toBe(true);
  });

  it('agent without any reviewer row is denied and told why', () => {
    const result = authorizeTaskAction(task, { type: 'agent', id: reviewerId }, 'approve', {
      hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
    });
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('reviewer');
  });

  it('agent whose only row is human-typed (id-string collision) is denied — no cross-type piggyback', () => {
    taskReviewerRepo.create(board.taskId, 'human', reviewerId);
    const result = authorizeTaskAction(task, { type: 'agent', id: reviewerId }, 'approve', {
      hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
    });
    expect(result.allowed).toBe(false);
  });

  it('agent whose row is RAW-approved without decision evidence ADMITS a fresh decision (uncredited legacy evidence)', () => {
    // Review-safety cutover: a raw approved row with NO generation-tagged
    // decision is uncredited historical evidence — its slot projects PENDING
    // and admits a fresh eligible decision (never auto-credits). Denial now
    // keys on DECIDED slots, which the service layer enforces.
    const row = taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    taskReviewerRepo.updateStatus(row.id, 'approved');
    const result = authorizeTaskAction(task, { type: 'agent', id: reviewerId }, 'approve', {
      hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
    });
    expect(result.allowed).toBe(true);
  });

  it('offline agent reviewer remains admissible — status is not a validity criterion', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    setAgentStatus(reviewerId, 'offline');
    const result = authorizeTaskAction(task, { type: 'agent', id: reviewerId }, 'approve', {
      hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
    });
    expect(result.allowed).toBe(true);
  });

  it('human admin/editor admission unchanged; viewer still denied', () => {
    expect(
      authorizeTaskAction(task, { type: 'human', id: 'h1', role: 'admin' }, 'approve', {
        hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
      }).allowed,
    ).toBe(true);
    expect(
      authorizeTaskAction(task, { type: 'human', id: 'h1', role: 'editor' }, 'approve', {
        hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
      }).allowed,
    ).toBe(true);
    expect(
      authorizeTaskAction(task, { type: 'human', id: 'h1', role: 'viewer' }, 'approve', {
        hasPendingAgentReviewerRow: pendingAgentEligibility(board.taskId),
      }).allowed,
    ).toBe(false);
  });

  it('route: real handler admits agent with pending row and persists the approval', async () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const handler = findRoute(routes, 'POST', '/tasks/:id/approve');
    const { request, reply } = mockReqRes({
      params: { id: board.taskId },
      agent: { id: reviewerId, name: 'reviewer-agent', domain: 'fullstack' },
    });
    const result = await callHandler(handler, request, reply);
    expect(result.code).toBe(200);
    const after = taskRepo.getTaskById(board.taskId)!;
    expect(after.status).toBe('approved');
    expect(getRow(board.taskId, reviewerId)?.status).toBe('approved');
  });

  it('route: agent without a pending row gets 403, task untouched', async () => {
    const handler = findRoute(routes, 'POST', '/tasks/:id/approve');
    const { request, reply } = mockReqRes({
      params: { id: board.taskId },
      agent: { id: reviewerId, name: 'reviewer-agent', domain: 'fullstack' },
    });
    const result = await callHandler(handler, request, reply);
    expect(result.code).toBe(403);
    expect(taskRepo.getTaskById(board.taskId)!.status).toBe('submitted');
    expect(getRow(board.taskId, reviewerId)).toBeNull();
  });

  it('route: agent reject with pending row persists rejection with reason', async () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const handler = findRoute(routes, 'POST', '/tasks/:id/reject');
    const { request, reply } = mockReqRes({
      params: { id: board.taskId },
      body: { reason: 'not good enough' },
      agent: { id: reviewerId, name: 'reviewer-agent', domain: 'fullstack' },
    });
    const result = await callHandler(handler, request, reply);
    expect(result.code).toBe(200);
    const after = taskRepo.getTaskById(board.taskId)!;
    expect(after.status).toBe('rejected');
    expect(after.rejectionReason).toBe('not good enough');
  });

  it('route: human approve still derives reviewer from the authenticated user', async () => {
    taskReviewerRepo.create(board.taskId, 'human', 'human-42');
    const handler = findRoute(routes, 'POST', '/tasks/:id/approve');
    const { request, reply } = mockReqRes({
      params: { id: board.taskId },
      user: { id: 'human-42', role: 'admin' },
    });
    const result = await callHandler(handler, request, reply);
    expect(result.code).toBe(200);
    expect(taskRepo.getTaskById(board.taskId)!.status).toBe('approved');
    expect(getRow(board.taskId, 'human-42')?.status).toBe('approved');
  });
});

describe('Agent review decisions — typed predicates and human parity', () => {
  let workerId: string;
  let reviewerId: string;
  let board: Board;

  beforeEach(async () => {
    await initTestDb();
    workerId = makeAgent('worker-agent');
    reviewerId = makeAgent('reviewer-agent');
    board = setupSubmittedTask(workerId);
  });

  afterEach(() => closeDb());

  it('agent-typed row: service approve records the row and completes review', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const approved = taskService.approveTask(board.taskId, reviewerId, 'agent');
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('approved');
    expect(getRow(board.taskId, reviewerId)?.status).toBe('approved');
  });

  it('human-typed row does not satisfy an agent principal (typed lookup, no coercion)', () => {
    taskReviewerRepo.create(board.taskId, 'human', reviewerId);
    const approved = taskService.approveTask(board.taskId, reviewerId, 'agent');
    expect(approved).toBeNull();
    expect(taskRepo.getTaskById(board.taskId)!.status).toBe('submitted');
    expect(getRow(board.taskId, reviewerId)?.status).toBe('pending');
  });

  it('agent-typed row does not satisfy a human principal', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const approved = taskService.approveTask(board.taskId, reviewerId, 'human');
    expect(approved).toBeNull();
    expect(taskRepo.getTaskById(board.taskId)!.status).toBe('submitted');
  });

  it('agent re-approve of an already-DECIDED slot is idempotent (human parity; pending-projection admission)', () => {
    // Review-safety cutover: the decided slot projects approved — a repeated
    // approval records nothing new and re-evaluates finality idempotently,
    // exactly like the human path below. A CURRENT-ROUND REJECTED slot still
    // refuses agents (pending-projection admission); that matrix is covered
    // in reviewSafetyFinality.test.ts.
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    expect(taskService.approveTask(board.taskId, reviewerId, 'agent')).not.toBeNull();
    reopenForReview(board.taskId);
    const second = taskService.approveTask(board.taskId, reviewerId, 'agent');
    expect(second).not.toBeNull();
  });

  it('human idempotent re-approve is preserved', () => {
    insertUser('human-42', 'h42');
    taskReviewerRepo.create(board.taskId, 'human', 'human-42');
    expect(taskService.approveTask(board.taskId, 'human-42', 'human')).not.toBeNull();
    reopenForReview(board.taskId);
    const again = taskService.approveTask(board.taskId, 'human-42', 'human');
    expect(again).not.toBeNull();
    expect(getRow(board.taskId, 'human-42')?.status).toBe('approved');
  });

  it('human approved-then-reject is still allowed (existing semantics)', () => {
    insertUser('human-42', 'h42');
    taskReviewerRepo.create(board.taskId, 'human', 'human-42');
    expect(taskService.approveTask(board.taskId, 'human-42', 'human')).not.toBeNull();
    reopenForReview(board.taskId);
    const rejected = taskService.rejectTask(board.taskId, 'human-42', 'on reflection', 'human');
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe('rejected');
  });

  it('aggregate required-approval counting considers both human and agent rows', () => {
    insertUser('human-42', 'h42');
    const other = makeAgent('second-reviewer');
    taskReviewerRepo.create(board.taskId, 'human', 'human-42');
    taskReviewerRepo.create(board.taskId, 'agent', other);
    // Partial: human approves, agent still pending → not complete.
    expect(taskService.approveTask(board.taskId, 'human-42', 'human')).not.toBeNull();
    expect(taskRepo.getTaskById(board.taskId)!.status).toBe('submitted');
    // Final: the agent approval completes the review across both types.
    const done = taskService.approveTask(board.taskId, other, 'agent');
    expect(done).not.toBeNull();
    expect(done!.status).toBe('approved');
  });
});

describe('Agent review decisions — typed anti-self at decision time', () => {
  let workerId: string;
  let board: Board;

  beforeEach(async () => {
    await initTestDb();
    workerId = makeAgent('worker-agent');
    board = setupSubmittedTask(workerId);
  });

  afterEach(() => closeDb());

  /** Release → reclaim-by-reviewer → start → submit: the reviewer became the assignee. */
  function reclaimAs(agentId: string): void {
    taskRepo.releaseTask(board.taskId, 'stale state');
    taskRepo.claimTask(board.taskId, agentId);
    taskRepo.startTask(board.taskId, agentId);
    taskRepo.submitTask(board.taskId, agentId, 'reworked', []);
  }

  it('agent reviewer who became the current assignee cannot approve (stale-state recheck)', () => {
    taskReviewerRepo.create(board.taskId, 'agent', workerId);
    reclaimAs(workerId);
    expect(taskRepo.getTaskById(board.taskId)!.assignedAgentId).toBe(workerId);
    const approved = taskService.approveTask(board.taskId, workerId, 'agent');
    expect(approved).toBeNull();
    expect(taskRepo.getTaskById(board.taskId)!.status).toBe('submitted');
  });

  it('agent reviewer who became the current assignee cannot reject (stale-state recheck)', () => {
    taskReviewerRepo.create(board.taskId, 'agent', workerId);
    reclaimAs(workerId);
    const rejected = taskService.rejectTask(board.taskId, workerId, 'self-serving', 'agent');
    expect(rejected).toBeNull();
    expect(taskRepo.getTaskById(board.taskId)!.status).toBe('submitted');
  });

  it('equal human/agent id strings are NOT self-review: human with colliding id still decides', () => {
    taskReviewerRepo.create(board.taskId, 'human', workerId); // human id string == agent assignee id
    const approved = taskService.approveTask(board.taskId, workerId, 'human');
    expect(approved).not.toBeNull();
  });

  it('agent reviewer distinct from assignee still decides after a reclaim by a third agent', () => {
    const third = makeAgent('third-agent');
    const reviewer = makeAgent('innocent-reviewer');
    taskReviewerRepo.create(board.taskId, 'agent', reviewer);
    reclaimAs(third);
    const approved = taskService.approveTask(board.taskId, reviewer, 'agent');
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('approved');
  });
});

describe('Terminal transition integrity — CAS/rowcount surfacing', () => {
  let workerId: string;
  let reviewerId: string;
  let board: Board;

  beforeEach(async () => {
    await initTestDb();
    workerId = makeAgent('worker-agent');
    reviewerId = makeAgent('reviewer-agent');
    board = setupSubmittedTask(workerId);
  });

  afterEach(() => closeDb());

  it('the guarded approval service returns null when the terminal CAS matches no row', () => {
    getDb().update(tasks).set({ status: 'rejected' }).where(eq(tasks.id, board.taskId)).run();
    // Review safety: no raw terminal primitive exists — the service's own
    // reservation refuses a non-submitted row (lost CAS surfaces as null).
    expect(taskService.approveTask(board.taskId, reviewerId, 'agent')).toBeNull();
  });

  it('repo rejectTask returns null when the conditional UPDATE matches no row', () => {
    getDb().update(tasks).set({ status: 'approved' }).where(eq(tasks.id, board.taskId)).run();
    expect(taskRepo.rejectTask(board.taskId, 'late')).toBeNull();
  });

  it('a losing terminal approve emits no second approved transition', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const winner = taskService.approveTask(board.taskId, reviewerId, 'agent');
    expect(winner).not.toBeNull();
    const before = countTaskEvents(board.taskId, 'approved');
    getDb().update(tasks).set({ status: 'rejected' }).where(eq(tasks.id, board.taskId)).run();
    const loser = taskService.approveTask(board.taskId, reviewerId, 'agent');
    // Agent row is already approved → pending-only admission refuses the loser outright.
    expect(loser).toBeNull();
    expect(countTaskEvents(board.taskId, 'approved')).toBe(before);
  });
});

describe('F1 — task.review_completed emission gating (service/event seam)', () => {
  let workerId: string;
  let reviewerId: string;
  let board: Board;
  let published: Array<{ type: string; data: any }>;
  let unsubscribe: (() => void) | null = null;

  beforeEach(async () => {
    await initTestDb();
    workerId = makeAgent('f1-worker');
    reviewerId = makeAgent('f1-reviewer');
    board = setupSubmittedTask(workerId);
    published = [];
  });

  afterEach(() => {
    unsubscribe?.();
    unsubscribe = null;
    pluginManager.resetPlugins();
    closeDb();
  });

  function collectSse(): void {
    unsubscribe = sseBroadcaster.subscribe(board.habitatId, (event) => {
      published.push({ type: event.type, data: (event as any).data });
    });
  }

  const reviewCompleted = () => published.filter((e) => e.type === 'task.review_completed');

  it('positive control: a real accepted agent decision emits task.review_completed exactly once', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    collectSse();
    const approved = taskService.approveTask(board.taskId, reviewerId, 'agent');
    expect(approved).not.toBeNull();
    expect(reviewCompleted()).toHaveLength(1);
    expect(reviewCompleted()[0].data).toMatchObject({ taskId: board.taskId, reviewerId, status: 'approved' });
  });

  it('a vetoed final approval (gate returns veto, recorded=false) emits NO task.review_completed', async () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);

    // Real enrolled pre-veto interceptor for taskApproved (the production veto
    // path — the same mechanism lifecycleInterceptor.test.ts proves).
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const tmpDir = join(tmpdir(), `orcy-f1-veto-${Date.now()}`);
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      join(tmpDir, 'veto-approved.mjs'),
      `export default {
        manifest: {
          id: 'veto-approved',
          version: '1.0.0',
          description: 'F1 test veto',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: 'taskApproved',
            interceptorId: 'block-approve',
            requires: [],
            priority: 0,
          }],
        },
        interceptors: {
          'block-approve': () => ({ allow: false, reason: 'F1 test veto', details: 'gate veto' }),
        },
      };`,
    );
    try {
      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();
      enrollmentRepo.create({
        habitatId: board.habitatId,
        pluginId: 'veto-approved',
        contributionId: 'block-approve',
        contributionKind: 'lifecycleInterceptor',
        enrolledBy: 'test',
        enabled: 1,
      });
      pluginManager.invalidateEnrollmentCache(board.habitatId);

      collectSse();
      expect(() => taskService.approveTask(board.taskId, reviewerId, 'agent')).toThrow();
      // The guard under test: no accepted reviewer-row write means NO
      // review_completed publication — veto/unrecorded outcomes stay silent.
      expect(reviewCompleted()).toHaveLength(0);
      expect(getRow(board.taskId, reviewerId)?.status).toBe('pending');
      expect(taskRepo.getTaskById(board.taskId)!.status).toBe('submitted');
    } finally {
      const { rm } = await import('node:fs/promises');
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('a refused reservation outcome emits NO task.review_completed', () => {
    // Service/event seam (review-safety cutover): the one-reservation service
    // owns admission; a refused outcome (e.g. the row-vanish race) must never
    // announce completion. Driving the refused outcome directly keeps the
    // suppression discriminated (deleting the outcome gate in approveTask's
    // publish must turn this RED).
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    collectSse();
    const gateSpy = vi
      .spyOn(reviewFinality, 'approveWithReservation')
      .mockReturnValue({ outcome: 'refused', reason: 'not_assigned' });
    try {
      const result = taskService.approveTask(board.taskId, reviewerId, 'agent');
      expect(result).toBeNull();
      expect(reviewCompleted()).toHaveLength(0);
    } finally {
      gateSpy.mockRestore();
    }
  });

  it('a current-round rejected slot refuses agents and emits NO task.review_completed', () => {
    // Review safety: a decided (current-round rejected) slot does not admit
    // an agent decision — no reviewer-row write, no completion event.
    const row = taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    void row;
    const requirement = getRequirementWithClient(getDb(), board.taskId);
    if (requirement) {
      appendReviewDecisionWithClient(getDb(), {
        taskId: board.taskId,
        reviewGeneration: requirement.reviewGeneration,
        reviewRound: requirement.reviewRound,
        reviewerType: 'agent',
        reviewerId,
        decision: 'rejected',
        actorType: 'agent',
        actorId: reviewerId,
      });
    }
    collectSse();
    const result = taskService.approveTask(board.taskId, reviewerId, 'agent');
    expect(result).toBeNull();
    expect(reviewCompleted()).toHaveLength(0);
  });
});

describe('F2 — rejectTask in-transaction pending agent row requirement (service seam)', () => {
  let workerId: string;
  let reviewerId: string;
  let board: Board;

  beforeEach(async () => {
    await initTestDb();
    workerId = makeAgent('f2-worker');
    reviewerId = makeAgent('f2-reviewer');
    board = setupSubmittedTask(workerId);
  });

  afterEach(() => closeDb());

  it('agent with a RAW-approved row (no generation decision) CAN reject — the pending projection admits a fresh decision', () => {
    const row = taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    taskReviewerRepo.updateStatus(row.id, 'approved');
    // Reopen the review window: task submitted, row already decided.
    reopenForReview(board.taskId);

    const rejected = taskService.rejectTask(board.taskId, reviewerId, 'late change of mind', 'agent');
    expect(rejected).not.toBeNull();
    expect(taskRepo.getTaskById(board.taskId)!.status).toBe('rejected');
  });

  it('agent with a PENDING row CAN reject at the service seam (positive control)', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const rejected = taskService.rejectTask(board.taskId, reviewerId, 'legitimate concern', 'agent');
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe('rejected');
  });

  it('human with an APPROVED row CAN still reject (approved-then-reject preserved)', () => {
    insertUser('human-f2', 'f2human');
    const row = taskReviewerRepo.create(board.taskId, 'human', 'human-f2');
    taskReviewerRepo.updateStatus(row.id, 'approved');
    reopenForReview(board.taskId);

    const rejected = taskService.rejectTask(board.taskId, 'human-f2', 'on reflection', 'human');
    expect(rejected).not.toBeNull();
    expect(rejected!.status).toBe('rejected');
  });
});

describe('Reviewer creation — POST /tasks/:taskId/reviewers validation', () => {
  let workerId: string;
  let reviewerId: string;
  let board: Board;
  let routes: CapturedRoute[];

  beforeEach(async () => {
    await initTestDb();
    workerId = makeAgent('worker-agent');
    reviewerId = makeAgent('reviewer-agent');
    insertUser('human-42', 'h42');
    board = setupSubmittedTask(workerId);
    routes = captureRoutes(reviewRuleRoutes);
  });

  afterEach(() => closeDb());

  const postReviewer = (body: Record<string, unknown>, params?: Record<string, unknown>) => {
    const handler = findRoute(routes, 'POST', '/tasks/:taskId/reviewers');
    const { request, reply } = mockReqRes({
      params: { taskId: params?.taskId ?? board.taskId, ...(params ?? {}) },
      body,
      user: { id: 'human-42', role: 'admin' },
    });
    return callHandler(handler, request, reply);
  };

  it('valid agent id creates an agent-typed row', async () => {
    const result = await postReviewer({ reviewerId, reviewerType: 'agent' });
    expect(result.code).toBe(201);
    expect(getRow(board.taskId, reviewerId)?.reviewerType).toBe('agent');
  });

  it('valid human id creates a human-typed row (default type preserved)', async () => {
    const result = await postReviewer({ reviewerId: 'human-42' });
    expect(result.code).toBe(201);
    expect(getRow(board.taskId, 'human-42')?.reviewerType).toBe('human');
  });

  it('unknown agent id is rejected with no phantom row', async () => {
    const result = await postReviewer({ reviewerId: 'no-such-agent', reviewerType: 'agent' });
    expect(result.code).toBeGreaterThanOrEqual(400);
    expect(result.code).toBeLessThan(500);
    expect(getRow(board.taskId, 'no-such-agent')).toBeNull();
  });

  it('unknown human id is rejected with no phantom row', async () => {
    const result = await postReviewer({ reviewerId: 'no-such-human', reviewerType: 'human' });
    expect(result.code).toBeGreaterThanOrEqual(400);
    expect(result.code).toBeLessThan(500);
    expect(getRow(board.taskId, 'no-such-human')).toBeNull();
  });

  it('agent reviewer equal to the current assignee is refused (typed anti-self at creation)', async () => {
    const result = await postReviewer({ reviewerId: workerId, reviewerType: 'agent' });
    expect(result.code).toBeGreaterThanOrEqual(400);
    expect(result.code).toBeLessThan(500);
    expect(getRow(board.taskId, workerId)).toBeNull();
  });

  it('human reviewer whose id string equals the assignee id is NOT anti-self', async () => {
    // A user whose id string collides with the (agent) assignee's id.
    insertUser(workerId, 'colliding-human');
    const result = await postReviewer({ reviewerId: workerId, reviewerType: 'human' });
    expect(result.code).toBe(201);
    expect(getRow(board.taskId, workerId)?.reviewerType).toBe('human');
  });

  it('duplicate exact request is idempotent — one row, success response', async () => {
    const first = await postReviewer({ reviewerId, reviewerType: 'agent' });
    expect(first.code).toBe(201);
    const second = await postReviewer({ reviewerId, reviewerType: 'agent' });
    expect(second.code).toBeLessThan(400);
    const rows = taskReviewerRepo
      .getByTaskId(board.taskId)
      .filter((r) => r.reviewerId === reviewerId);
    expect(rows).toHaveLength(1);
  });

  it('same id under a different type fails explicitly (no silent type flip)', async () => {
    // The id resolves in BOTH registries so the flow reaches the type check.
    insertUser(reviewerId, 'dual-registry-human');
    await postReviewer({ reviewerId, reviewerType: 'agent' });
    const result = await postReviewer({ reviewerId, reviewerType: 'human' });
    expect(result.code).toBe(409);
    expect(getRow(board.taskId, reviewerId)?.reviewerType).toBe('agent');
  });

  it('offline agent id is a valid target (offline is not revoked)', async () => {
    setAgentStatus(reviewerId, 'offline');
    const result = await postReviewer({ reviewerId, reviewerType: 'agent' });
    expect(result.code).toBe(201);
  });

  it('team habitat: agent-typed reviewer rows remain creatable (contract: permitted targets)', async () => {
    const db = getDb();
    db.insert(organizations).values({ id: 'org-1', name: 'O', slug: 'org-1' }).run();
    db.insert(teams).values({ id: 'team-1', name: 'T', slug: 'team-1', organizationId: 'org-1' }).run();
    db.update(habitats).set({ teamId: 'team-1' }).where(eq(habitats.id, board.habitatId)).run();
    db.insert(teamMembers).values({ id: 'tm-x', teamId: 'team-1', userId: 'human-42' }).run();
    const result = await postReviewer({ reviewerId, reviewerType: 'agent' });
    expect(result.code).toBe(201);
    expect(getRow(board.taskId, reviewerId)?.reviewerType).toBe('agent');
  });

  it('removal wire: (taskId, reviewerId) resolves at most one row — uniqueness pinned', () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    expect(() => taskReviewerRepo.create(board.taskId, 'human', reviewerId)).toThrow();
  });

  it('removal wire: legacy untyped DELETE still removes the single row', async () => {
    taskReviewerRepo.create(board.taskId, 'agent', reviewerId);
    const handler = findRoute(routes, 'DELETE', '/reviewers/:reviewerId');
    const { request, reply } = mockReqRes({
      params: { taskId: board.taskId, reviewerId },
      user: { id: 'human-42', role: 'admin' },
    });
    const result = await callHandler(handler, request, reply);
    expect(result.code).toBe(204);
    expect(getRow(board.taskId, reviewerId)).toBeNull();
  });
});

describe('Reviewer creation — automation request_review validation', () => {
  let workerId: string;
  let reviewerId: string;
  let board: Board;

  beforeEach(async () => {
    await initTestDb();
    workerId = makeAgent('worker-agent');
    reviewerId = makeAgent('reviewer-agent');
    insertUser('human-42', 'h42');
    board = setupSubmittedTask(workerId);
  });

  afterEach(() => closeDb());

  const runAction = async (action: Record<string, unknown>) => {
    const task = taskRepo.getTaskById(board.taskId)!;
    const rule = { id: 'r1', habitatId: board.habitatId, actions: [] } as any;
    const run = { id: 'run-1' } as any;
    const ctx = { task } as any;
    return automationExecutor.executeAction(action as any, 0, rule, run, ctx);
  };

  it('valid explicit agent assignment creates an agent-typed row and succeeds', async () => {
    const result = await runAction({ type: 'request_review', reviewerId, reviewerType: 'agent' });
    expect(result.status).toBe('succeeded');
    expect(getRow(board.taskId, reviewerId)?.reviewerType).toBe('agent');
  });

  it('valid explicit agent assignment is resolvable: agent reviewer can then approve', async () => {
    await runAction({ type: 'request_review', reviewerId, reviewerType: 'agent' });
    const approved = taskService.approveTask(board.taskId, reviewerId, 'agent');
    expect(approved).not.toBeNull();
    expect(approved!.status).toBe('approved');
  });

  it('unknown agent id fails as an action result with no phantom row (no HTTP semantics)', async () => {
    const result = await runAction({
      type: 'request_review',
      reviewerId: 'ghost',
      reviewerType: 'agent',
    });
    expect(result.status).toBe('failed');
    expect(result.error).toBeTruthy();
    expect(getRow(board.taskId, 'ghost')).toBeNull();
  });

  it('unknown human id fails as an action result with no phantom row', async () => {
    const result = await runAction({
      type: 'request_review',
      reviewerId: 'ghost',
      reviewerType: 'human',
    });
    expect(result.status).toBe('failed');
    expect(getRow(board.taskId, 'ghost')).toBeNull();
  });

  it('agent reviewer equal to the current assignee fails (typed anti-self)', async () => {
    const result = await runAction({
      type: 'request_review',
      reviewerId: workerId,
      reviewerType: 'agent',
    });
    expect(result.status).toBe('failed');
    expect(getRow(board.taskId, workerId)).toBeNull();
  });

  it('invalid reviewerType string fails explicitly — never coerced, never defaulted', async () => {
    const result = await runAction({ type: 'request_review', reviewerId, reviewerType: 'robot' });
    expect(result.status).toBe('failed');
    expect(getRow(board.taskId, reviewerId)).toBeNull();
  });

  it('duplicate valid request is idempotent — one row, succeeded', async () => {
    await runAction({ type: 'request_review', reviewerId, reviewerType: 'agent' });
    const second = await runAction({ type: 'request_review', reviewerId, reviewerType: 'agent' });
    expect(second.status).toBe('succeeded');
    const rows = taskReviewerRepo
      .getByTaskId(board.taskId)
      .filter((r) => r.reviewerId === reviewerId);
    expect(rows).toHaveLength(1);
  });

  it('same id under a different type fails explicitly', async () => {
    await runAction({ type: 'request_review', reviewerId, reviewerType: 'agent' });
    const second = await runAction({ type: 'request_review', reviewerId, reviewerType: 'human' });
    expect(second.status).toBe('failed');
    expect(getRow(board.taskId, reviewerId)?.reviewerType).toBe('agent');
  });

  it('omitted reviewerType keeps the existing agent default (legacy automation behavior)', async () => {
    const result = await runAction({ type: 'request_review', reviewerId });
    expect(result.status).toBe('succeeded');
    expect(getRow(board.taskId, reviewerId)?.reviewerType).toBe('agent');
  });
});

describe('Reviewer assignment plumbing — typed row identity in results', () => {
  beforeEach(async () => {
    await initTestDb();
  });

  afterEach(() => closeDb());

  it('assignReviewers reports the created row type per reviewer', () => {
    const habitat = habitatRepo.createHabitat({ name: 'Assignment Habitat' });
    const db = getDb();
    db.insert(organizations).values({ id: 'org-1', name: 'O', slug: 'org-1' }).run();
    db.insert(teams).values({ id: 'team-1', name: 'T', slug: 'team-1', organizationId: 'org-1' }).run();
    db.update(habitats).set({ teamId: 'team-1' }).where(eq(habitats.id, habitat.id)).run();
    insertUser('human-42', 'h42');
    db.insert(teamMembers).values({ id: 'tm-1', teamId: 'team-1', userId: 'human-42' }).run();

    const column = columnRepo.createColumn({ habitatId: habitat.id, name: 'B' });
    const mission = missionRepo.createMission({
      habitatId: habitat.id,
      columnId: column.id,
      title: 'M',
      createdBy: 'human-42',
    });
    const task = taskRepo.createTask({ missionId: mission.id, title: 'T1', createdBy: 'human-42' });

    reviewRuleRepo.create(habitat.id, { name: 'default', assignmentStrategy: 'least_loaded', enabled: 1, requiredReviews: 1, antiSelfReview: 0 });

    const result = reviewAssignment.assignReviewers(task.id, habitat.id);
    expect(result.assigned.length).toBeGreaterThan(0);
    for (const entry of result.assigned) {
      expect(entry.reviewerType).toBe('human');
    }
  });
});
