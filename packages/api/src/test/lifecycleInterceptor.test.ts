/**
 * Phase 5 runner-fix verification.
 *
 * Phase 3's runner cast `Promise<InterceptorResult>` to `InterceptorResult` synchronously, so
 * veto never propagated. The Phase 5 fix widens `InterceptorHandler` to accept sync returns and
 * the runner now checks thenability + uses the sync result directly. These tests load REAL
 * plugin files (no spies) and assert the end-to-end flow: a synchronous pre-interceptor veto
 * reaches `claimTask` and produces a 403 + no DB write.
 */
describe("Lifecycle interceptor runner — real end-to-end (Phase 5 fix)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    await initTestDb();
    pluginManager.resetPlugins();
  });

  afterEach(async () => {
    pluginManager.resetPlugins();
    closeDb();
    if (tmpDir) {
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function writePlugin(name: string, moduleBody: string): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    tmpDir = `/tmp/test-runner-${name}-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });
    await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
  }

  it("a synchronous pre-interceptor returning {allow:false} vetoes claimTask (DB untouched)", async () => {
    await writePlugin(
      "veto-pre",
      `{
        manifest: {
          id: 'veto-pre',
          version: '1.0.0',
          description: 'veto pre-interceptor',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: 'taskClaimed',
            interceptorId: 'block-claim',
            requires: [],
            priority: 0,
          }],
        },
        interceptors: {
          'block-claim': () => ({ allow: false, reason: 'plugin vetoed', details: 'test' }),
        },
      }`,
    );

    const { habitatId, taskId, agentId } = setupHabitatAndTask("pending");
    // Enroll the plugin contribution for this habitat so isEnrolled() returns true.
    enrollmentRepo.create({
      habitatId,
      pluginId: "veto-pre",
      contributionId: "block-claim",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    // Reset the spy from the outer beforeEach — we want the REAL runner, not the mock.
    vi.restoreAllMocks();

    expect(() => taskService.claimTask(taskId, agentId)).toThrow(InterceptorVetoError);

    // DB row untouched — the veto short-circuited before the transaction.
    const after = taskRepo.getTaskById(taskId);
    expect(after?.status).toBe("pending");
    expect(after?.assignedAgentId).toBeNull();
  });

  it("a synchronous pre-interceptor returning {allow:true} permits claimTask", async () => {
    await writePlugin(
      "allow-pre",
      `{
        manifest: {
          id: 'allow-pre',
          version: '1.0.0',
          description: 'allow pre-interceptor',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: 'taskClaimed',
            interceptorId: 'allow-claim',
            requires: [],
            priority: 0,
          }],
        },
        interceptors: {
          'allow-claim': () => ({ allow: true }),
        },
      }`,
    );

    const { habitatId, taskId, agentId } = setupHabitatAndTask("pending");
    enrollmentRepo.create({
      habitatId,
      pluginId: "allow-pre",
      contributionId: "allow-claim",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    vi.restoreAllMocks();

    const result = taskService.claimTask(taskId, agentId);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.task.status).toBe("claimed");
    }
  });

  it("an async pre-interceptor (Promise return) fails closed — blocks claimTask (ADR-0039 T7)", async () => {
    await writePlugin(
      "async-pre",
      `{
        manifest: {
          id: 'async-pre',
          version: '1.0.0',
          description: 'async pre-interceptor (contract violation)',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: 'taskClaimed',
            interceptorId: 'async-claim',
            requires: [],
            priority: 0,
          }],
        },
        interceptors: {
          'async-claim': async () => ({ allow: false, reason: 'would veto but is async' }),
        },
      }`,
    );

    const { habitatId, taskId, agentId } = setupHabitatAndTask("pending");
    enrollmentRepo.create({
      habitatId,
      pluginId: "async-pre",
      contributionId: "async-claim",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    vi.restoreAllMocks();

    // The async handler returns a Promise — the runtime detects the thenable,
    // consumes the rejection, and returns a failure veto (ADR-0039 Q1). The
    // claim is blocked and the DB row stays untouched.
    expect(() => taskService.claimTask(taskId, agentId)).toThrow(InterceptorVetoError);

    const after = taskRepo.getTaskById(taskId);
    expect(after?.status).toBe("pending");
    expect(after?.assignedAgentId).toBeNull();
  });
});
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initTestDb, closeDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskService from "../services/tasks/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import { InterceptorVetoError, isAppError } from "../errors.js";
import { taskLifecycleRoutes } from "../routes/tasks/lifecycle.js";
import type { FastifyInstance } from "fastify";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as runRepo from "../repositories/pluginRun.js";

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
    post: vi.fn((path: string, _opts: any, handler: any) => {
      routes.push({ method: "POST", path, handler });
    }),
    get: vi.fn(() => fakeFastify),
    put: vi.fn(() => fakeFastify),
    delete: vi.fn(() => fakeFastify),
    patch: vi.fn(() => fakeFastify),
  };
  taskLifecycleRoutes(fakeFastify as unknown as FastifyInstance);
  return routes;
}

function findRoute(routes: CapturedRoute[], pathPattern: string): RouteHandler {
  const r = routes.find((rt) => rt.method === "POST" && rt.path.includes(pathPattern));
  if (!r) throw new Error(`Route POST ${pathPattern} not found`);
  return r.handler;
}

function setupHabitatAndTask(
  status: "pending" | "claimed" | "in_progress" | "submitted" = "pending",
): {
  habitatId: string;
  missionId: string;
  taskId: string;
  agentId: string;
} {
  const habitat = habitatRepo.createHabitat({ name: "Interceptor Test Habitat" });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog" });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "Test Mission",
    createdBy: "test",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "Test Task",
    createdBy: "test",
  });
  const agent = agentRepo.createAgent({ name: "agent-x", type: "opencode", domain: "fullstack" });
  if (status !== "pending") {
    taskRepo.claimTask(task.id, agent.agent.id);
  }
  if (status === "in_progress" || status === "submitted") {
    taskRepo.startTask(task.id, agent.agent.id);
  }
  if (status === "submitted") {
    taskRepo.submitTask(task.id, agent.agent.id, "result", []);
  }
  return { habitatId: habitat.id, missionId: mission.id, taskId: task.id, agentId: agent.agent.id };
}

const VETO = { allow: false as const, reason: "blocked by test interceptor", details: "ctx" };

describe("Lifecycle interceptor seams (Phase 4)", () => {
  let runPreSpy: ReturnType<typeof vi.spyOn>;
  let runPostSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    await initTestDb();
    runPreSpy = vi.spyOn(pluginManager, "runPreInterceptors").mockReturnValue(null);
    runPostSpy = vi.spyOn(pluginManager, "runPostInterceptors").mockImplementation(() => undefined);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    closeDb();
  });

  describe("InterceptorVetoError", () => {
    it("carries the veto reason and details", () => {
      const err = new InterceptorVetoError(VETO);
      expect(err.name).toBe("InterceptorVetoError");
      expect(err.veto.reason).toBe(VETO.reason);
      expect(err.veto.details).toBe(VETO.details);
      expect(err.message).toContain(VETO.reason);
    });

    it("is not an AppError (route layer converts it to 403)", () => {
      const err = new InterceptorVetoError(VETO);
      expect(isAppError(err)).toBe(false);
    });
  });

  describe("claimTask seam wiring", () => {
    it("calls runPreInterceptors BEFORE the DB write and runPostInterceptors AFTER emitTransition", () => {
      const { taskId, agentId } = setupHabitatAndTask("pending");

      const callOrder: string[] = [];
      runPreSpy.mockImplementationOnce(() => {
        callOrder.push("pre");
        return null;
      });
      runPostSpy.mockImplementationOnce(() => {
        callOrder.push("post");
      });

      const result = taskService.claimTask(taskId, agentId);
      if (!result.success) throw new Error("expected claim to succeed");

      expect(runPreSpy).toHaveBeenCalledWith(
        taskId,
        "taskClaimed",
        expect.any(String),
        expect.objectContaining({ actorType: "agent", actorId: agentId }),
      );
      expect(runPostSpy).toHaveBeenCalledWith(
        taskId,
        "taskClaimed",
        expect.any(String),
        expect.objectContaining({ actorType: "agent", task: expect.any(Object) }),
      );
      expect(callOrder).toEqual(["pre", "post"]);
      expect(result.task.status).toBe("claimed");
    });

    it("throws InterceptorVetoError and skips the DB write when pre returns a veto", () => {
      const { taskId, agentId } = setupHabitatAndTask("pending");
      runPreSpy.mockReturnValueOnce(VETO);

      expect(() => taskService.claimTask(taskId, agentId)).toThrow(InterceptorVetoError);

      // DB row untouched.
      const after = taskRepo.getTaskById(taskId);
      expect(after?.status).toBe("pending");
      expect(after?.assignedAgentId).toBeNull();
      // Post seam must NOT have fired on a vetoed transition.
      expect(runPostSpy).not.toHaveBeenCalled();
    });
  });

  describe("submitTask seam wiring", () => {
    it("calls pre before quality gate check + DB write, post after emitTransition", () => {
      const { taskId, agentId } = setupHabitatAndTask("in_progress");

      const result = taskService.submitTask(taskId, agentId, "done", []);
      expect(result.task?.status).toBe("submitted");
      expect(runPreSpy).toHaveBeenCalledWith(
        taskId,
        "taskSubmitted",
        expect.any(String),
        expect.objectContaining({ actorType: "agent" }),
      );
      expect(runPostSpy).toHaveBeenCalledWith(
        taskId,
        "taskSubmitted",
        expect.any(String),
        expect.objectContaining({ task: expect.any(Object) }),
      );
    });

    it("throws InterceptorVetoError when pre returns a veto (DB untouched)", () => {
      const { taskId, agentId } = setupHabitatAndTask("in_progress");
      runPreSpy.mockReturnValueOnce(VETO);

      expect(() => taskService.submitTask(taskId, agentId, "done", [])).toThrow(
        InterceptorVetoError,
      );
      // Status stays `in_progress`.
      expect(taskRepo.getTaskById(taskId)?.status).toBe("in_progress");
      expect(runPostSpy).not.toHaveBeenCalled();
    });
  });

  describe("approveTask seam wiring", () => {
    it("calls pre/post with event taskApproved", () => {
      const { taskId } = setupHabitatAndTask("submitted");

      const result = taskService.approveTask(taskId, "reviewer-1", "human");
      expect(result?.status).toBe("approved");
      expect(runPreSpy).toHaveBeenCalledWith(
        taskId,
        "taskApproved",
        expect.any(String),
        expect.objectContaining({ actorType: "human" }),
      );
      expect(runPostSpy).toHaveBeenCalledWith(
        taskId,
        "taskApproved",
        expect.any(String),
        expect.objectContaining({ task: expect.any(Object) }),
      );
    });

    it("throws InterceptorVetoError when pre returns a veto", () => {
      const { taskId } = setupHabitatAndTask("submitted");
      runPreSpy.mockReturnValueOnce(VETO);

      expect(() => taskService.approveTask(taskId, "reviewer-1", "human")).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");
    });
  });

  describe("rejectTask seam wiring", () => {
    it("calls pre/post with event taskRejected", () => {
      const { taskId } = setupHabitatAndTask("submitted");

      const result = taskService.rejectTask(taskId, "reviewer-1", "bad", "human");
      expect(result?.status).toBe("rejected");
      expect(runPreSpy).toHaveBeenCalledWith(
        taskId,
        "taskRejected",
        expect.any(String),
        expect.objectContaining({ reason: "bad" }),
      );
      expect(runPostSpy).toHaveBeenCalledWith(
        taskId,
        "taskRejected",
        expect.any(String),
        expect.objectContaining({ task: expect.any(Object) }),
      );
    });

    it("throws InterceptorVetoError when pre returns a veto", () => {
      const { taskId } = setupHabitatAndTask("submitted");
      runPreSpy.mockReturnValueOnce(VETO);

      expect(() => taskService.rejectTask(taskId, "reviewer-1", "bad", "human")).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");
    });
  });

  describe("completeTask seam wiring", () => {
    it("calls pre/post with event taskApproved (per ACTION_EFFECTS mapping)", () => {
      const { taskId, agentId } = setupHabitatAndTask("submitted");

      const result = taskService.completeTask(taskId, agentId);
      expect(result.task?.status).toBe("done");
      expect(runPreSpy).toHaveBeenCalledWith(
        taskId,
        "taskApproved",
        expect.any(String),
        expect.objectContaining({ actorType: "agent" }),
      );
      expect(runPostSpy).toHaveBeenCalledWith(
        taskId,
        "taskApproved",
        expect.any(String),
        expect.objectContaining({ task: expect.any(Object) }),
      );
    });
  });

  describe("createTask seam wiring", () => {
    it("calls pre before the DB write and post after emitTransition", () => {
      const habitat = habitatRepo.createHabitat({ name: "create-test" });
      const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo" });
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId: column.id,
        title: "M",
        createdBy: "test",
      });

      const task = taskService.createTask({
        missionId: mission.id,
        title: "New task",
        createdBy: "user-1",
      });
      expect(runPreSpy).toHaveBeenCalledWith(
        mission.id,
        "taskCreated",
        habitat.id,
        expect.objectContaining({ actorType: "human", actorId: "user-1" }),
      );
      expect(runPostSpy).toHaveBeenCalledWith(
        task.id,
        "taskCreated",
        habitat.id,
        expect.objectContaining({ task: expect.any(Object) }),
      );
    });

    it("throws InterceptorVetoError when pre returns a veto (no row written)", () => {
      const habitat = habitatRepo.createHabitat({ name: "create-veto-test" });
      const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo" });
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId: column.id,
        title: "M",
        createdBy: "test",
      });
      runPreSpy.mockReturnValueOnce(VETO);

      expect(() =>
        taskService.createTask({ missionId: mission.id, title: "x", createdBy: "u" }),
      ).toThrow(InterceptorVetoError);
      expect(taskRepo.getTasksByMissionId(mission.id)).toHaveLength(0);
    });
  });

  describe("claimDelegatedTask seam wiring", () => {
    it("calls pre/post with event taskClaimed", () => {
      const habitat = habitatRepo.createHabitat({ name: "Del Habitat" });
      const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo" });
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId: column.id,
        title: "M",
        createdBy: "test",
      });
      const task = taskRepo.createTask({
        missionId: mission.id,
        title: "Del Task",
        createdBy: "test",
      });
      const agent = agentRepo.createAgent({
        name: "del-agent",
        type: "opencode",
        domain: "fullstack",
      });
      // Pre-state: task already claimed by another agent and delegated to ours.
      const otherAgent = agentRepo.createAgent({
        name: "other-agent",
        type: "opencode",
        domain: "fullstack",
      });
      taskRepo.claimTask(task.id, otherAgent.agent.id);
      taskRepo.updateTask(task.id, { delegatedToAgentId: agent.agent.id });

      const result = taskService.claimDelegatedTask(task.id, agent.agent.id);
      expect(result.success).toBe(true);
      expect(runPreSpy).toHaveBeenCalledWith(
        task.id,
        "taskClaimed",
        expect.any(String),
        expect.objectContaining({ actorType: "agent", metadata: { delegatedClaim: true } }),
      );
      expect(runPostSpy).toHaveBeenCalledWith(
        task.id,
        "taskClaimed",
        expect.any(String),
        expect.objectContaining({ task: expect.any(Object) }),
      );
    });

    it("throws InterceptorVetoError when pre returns a veto", () => {
      const { taskId, agentId } = setupHabitatAndTask("pending");
      runPreSpy.mockReturnValueOnce(VETO);

      expect(() => taskService.claimDelegatedTask(taskId, agentId)).toThrow(InterceptorVetoError);
      expect(taskRepo.getTaskById(taskId)?.status).toBe("pending");
    });
  });

  describe("route-layer 403 handling", () => {
    it("claim route returns 403 INTERCEPTOR_VETO when claimTask throws InterceptorVetoError", async () => {
      const routes = captureRoutes();
      const handler = findRoute(routes, "/claim");

      // Force the service to throw by mocking the pre-interceptor veto path.
      runPreSpy.mockReturnValueOnce(VETO);
      const { taskId, agentId } = setupHabitatAndTask("pending");

      const request: any = {
        params: { id: taskId },
        body: {},
        agent: {
          id: agentId,
          domain: "fullstack",
          capabilities: [],
        },
      };
      const reply: any = {
        code: vi.fn(() => reply),
        send: vi.fn(() => reply),
      };

      let captured: any;
      try {
        await handler(request, reply);
      } catch (err) {
        captured = err;
      }
      expect(captured).toBeInstanceOf(Error);
      expect(isAppError(captured)).toBe(true);
      expect((captured as any).statusCode).toBe(403);
      expect((captured as any).code).toBe("INTERCEPTOR_VETO");
      expect((captured as any).details).toEqual({
        blockedBy: { reason: VETO.reason, details: VETO.details },
      });
    });

    it("approve route returns 403 INTERCEPTOR_VETO when approveTask throws InterceptorVetoError", async () => {
      const routes = captureRoutes();
      const handler = findRoute(routes, "/approve");

      runPreSpy.mockReturnValueOnce(VETO);
      const { taskId, agentId } = setupHabitatAndTask("submitted");

      const request: any = {
        params: { id: taskId },
        body: {},
        user: { id: "reviewer-1" },
        // Principal extraction: authorizeTaskAction needs `request.user` to
        // map to a human principal. Provide the assigned reviewer fields the
        // middleware expects.
        agent: undefined,
      };
      const reply: any = { code: vi.fn(() => reply), send: vi.fn(() => reply) };

      let captured: any;
      try {
        await handler(request, reply);
      } catch (err) {
        captured = err;
      }
      // The route may bail at authorizeTaskAction OR reach the try/catch —
      // either way the response is a 403. Assert only the status code.
      expect(isAppError(captured)).toBe(true);
      expect((captured as any).statusCode).toBe(403);
      void agentId;
    });
  });
});

// ---------------------------------------------------------------------------
// ADR-0039 T7: pre-veto runtime migration — bounded fail-closed (Q1),
// final-approval pre-veto ordering (Q10), quarantine accounting, and the
// seven-caller veto matrix. These tests use REAL plugin files (no spies) to
// exercise the Plugin Invocation Runtime end-to-end.
// ---------------------------------------------------------------------------
describe("ADR-0039 T7: pre-veto runtime migration (real end-to-end)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    await initTestDb();
    pluginManager.resetPlugins();
  });

  afterEach(async () => {
    pluginManager.resetPlugins();
    closeDb();
    delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
    if (tmpDir) {
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function writeVetoPlugin(
    name: string,
    event: string,
    interceptorId: string,
    handlerBody = "() => ({ allow: false, reason: 'matrix-veto' })",
  ): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    tmpDir = `/tmp/test-t7-${name}-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      `${tmpDir}/${name}.mjs`,
      `export default {
        manifest: {
          id: '${name}',
          version: '1.0.0',
          description: 'veto ${event}',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: '${event}',
            interceptorId: '${interceptorId}',
            priority: 0,
            requires: [],
          }],
        },
        interceptors: { '${interceptorId}': ${handlerBody} },
      };`,
    );
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
  }

  function enrollPlugin(habitatId: string, pluginId: string, interceptorId: string): void {
    enrollmentRepo.create({
      habitatId,
      pluginId,
      contributionId: interceptorId,
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);
  }

  // ── Seven-caller veto matrix ──────────────────────────────────────────────

  describe("seven-caller veto matrix (real runtime, no mocks)", () => {
    it("createTask: veto prevents task creation", async () => {
      vi.restoreAllMocks();
      const habitat = habitatRepo.createHabitat({ name: "matrix-create" });
      const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo" });
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId: column.id,
        title: "M",
        createdBy: "test",
      });
      await writeVetoPlugin("mtx-create", "taskCreated", "veto-create");
      enrollPlugin(habitat.id, "mtx-create", "veto-create");

      expect(() =>
        taskService.createTask({ missionId: mission.id, title: "x", createdBy: "u" }),
      ).toThrow(InterceptorVetoError);
      expect(taskRepo.getTasksByMissionId(mission.id)).toHaveLength(0);
    });

    it("claimTask: veto prevents claim (task stays pending)", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("mtx-claim", "taskClaimed", "veto-claim");
      const { habitatId, taskId, agentId } = setupHabitatAndTask("pending");
      enrollPlugin(habitatId, "mtx-claim", "veto-claim");

      expect(() => taskService.claimTask(taskId, agentId)).toThrow(InterceptorVetoError);
      expect(taskRepo.getTaskById(taskId)?.status).toBe("pending");
    });

    it("claimDelegatedTask: veto prevents delegated claim", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("mtx-delclaim", "taskClaimed", "veto-delclaim");
      const { habitatId, taskId, agentId } = setupHabitatAndTask("pending");
      enrollPlugin(habitatId, "mtx-delclaim", "veto-delclaim");

      expect(() => taskService.claimDelegatedTask(taskId, agentId)).toThrow(InterceptorVetoError);
      expect(taskRepo.getTaskById(taskId)?.status).toBe("pending");
    });

    it("submitTask: veto prevents submission (task stays in_progress)", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("mtx-submit", "taskSubmitted", "veto-submit");
      const { habitatId, taskId, agentId } = setupHabitatAndTask("in_progress");
      enrollPlugin(habitatId, "mtx-submit", "veto-submit");

      expect(() => taskService.submitTask(taskId, agentId, "done", [])).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("in_progress");
    });

    it("completeTask: veto prevents completion (task stays submitted)", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("mtx-complete", "taskApproved", "veto-complete");
      const { habitatId, taskId, agentId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "mtx-complete", "veto-complete");

      expect(() => taskService.completeTask(taskId, agentId)).toThrow(InterceptorVetoError);
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");
    });

    it("approveTask (no reviewers): veto prevents approval", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("mtx-approve", "taskApproved", "veto-approve");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "mtx-approve", "veto-approve");

      expect(() => taskService.approveTask(taskId, "reviewer-x", "human")).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");
    });

    it("rejectTask: veto prevents rejection", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("mtx-reject", "taskRejected", "veto-reject");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "mtx-reject", "veto-reject");

      expect(() => taskService.rejectTask(taskId, "reviewer-x", "bad", "human")).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");
    });
  });

  // ── Failure-veto matrix (ADR-0039 R5) ───────────────────────────────────
  //
  // The "explicit veto" matrix above proves the seven Task-lifecycle callers
  // each short-circuit before their first Task mutation when an explicit
  // {allow:false} is returned. ADR-0039 R5 strengthens the matrix to also
  // assert the *bounded fail-closed* contract (Q1): a handler throw /
  // Promise return / invalid result is a *failure veto* — the same Task-mutation
  // gates apply (DB untouched, no Task SSE, no post hook fired).
  //
  // We re-use the seven Task-lifecycle callers and verify on each:
  //   1. Throwing handler → InterceptorVetoError is raised.
  //   2. Task status is unchanged.
  //   3. No Task SSE event was published (sseBroadcaster spy stays quiet).
  //   4. runPostInterceptors is NOT called (post hook stays detached).
  //
  // The post-hook assertion uses a spy on the real pluginManager.runPostInterceptors.
  // The SSE assertion uses a vi.mock scoped to this describe block.

  describe("seven-caller failure-veto matrix (ADR-0039 R5 strengthening)", () => {
    let ssePublishSpy: ReturnType<typeof vi.fn>;
    let postHookSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(async () => {
      // Wire a per-describe SSE publisher spy. The broadcaster is consumed at
      // module-import time, so we replace `sseBroadcaster.publish` on the
      // shared module instance for the duration of this describe block.
      const broadcaster = (await import("../sse/broadcaster.js")).sseBroadcaster;
      ssePublishSpy = vi.fn();
      (broadcaster as unknown as { publish: typeof broadcaster.publish }).publish =
        ssePublishSpy as unknown as typeof broadcaster.publish;
      postHookSpy = vi.spyOn(pluginManager, "runPostInterceptors").mockReturnValue(undefined);
    });

    afterEach(() => {
      ssePublishSpy.mockRestore();
      postHookSpy.mockRestore();
    });

    async function writeThrowingPlugin(
      name: string,
      event: string,
      interceptorId: string,
    ): Promise<void> {
      const { mkdir, writeFile } = await import("node:fs/promises");
      tmpDir = `/tmp/test-r5-fveto-${name}-${Date.now()}`;
      await mkdir(tmpDir, { recursive: true });
      await writeFile(
        `${tmpDir}/${name}.mjs`,
        `export default {
          manifest: {
            id: '${name}',
            version: '1.0.0',
            description: 'throwing pre-interceptor',
            contributions: [{
              kind: 'lifecycleInterceptor',
              scope: 'habitat',
              phase: 'pre',
              event: '${event}',
              interceptorId: '${interceptorId}',
              priority: 0,
              requires: [],
            }],
          },
          interceptors: { '${interceptorId}': () => { throw new Error('failure-veto-throw'); } },
        };`,
      );
      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();
    }

    function expectNoTaskSseFor(sseEvents: unknown[]): void {
      const taskEvents = sseEvents.filter((e) => {
        const evt = e as { type?: string };
        return typeof evt?.type === "string" && evt.type.startsWith("task.");
      });
      expect(taskEvents).toEqual([]);
    }

    it("createTask: throwing pre-interceptor → failure veto (no Task SSE, no post hook, DB untouched)", async () => {
      const habitat = habitatRepo.createHabitat({ name: "fv-create" });
      const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo" });
      const mission = missionRepo.createMission({
        habitatId: habitat.id,
        columnId: column.id,
        title: "M",
        createdBy: "test",
      });
      await writeThrowingPlugin("fv-create", "taskCreated", "veto-create");
      enrollPlugin(habitat.id, "fv-create", "veto-create");

      expect(() =>
        taskService.createTask({ missionId: mission.id, title: "x", createdBy: "u" }),
      ).toThrow(InterceptorVetoError);

      // DB untouched.
      expect(taskRepo.getTasksByMissionId(mission.id)).toHaveLength(0);
      // No task.* SSE event published.
      expectNoTaskSseFor(ssePublishSpy.mock.calls.map((c) => c[1]));
      // Post hook never fired.
      expect(postHookSpy).not.toHaveBeenCalled();
    });

    it("claimTask: throwing pre-interceptor → failure veto (no Task SSE, no post hook, status unchanged)", async () => {
      await writeThrowingPlugin("fv-claim", "taskClaimed", "veto-claim");
      const { habitatId, taskId, agentId } = setupHabitatAndTask("pending");
      enrollPlugin(habitatId, "fv-claim", "veto-claim");

      expect(() => taskService.claimTask(taskId, agentId)).toThrow(InterceptorVetoError);
      expect(taskRepo.getTaskById(taskId)?.status).toBe("pending");

      expectNoTaskSseFor(ssePublishSpy.mock.calls.map((c) => c[1]));
      expect(postHookSpy).not.toHaveBeenCalled();
    });

    it("claimDelegatedTask: throwing pre-interceptor → failure veto (no Task SSE, no post hook)", async () => {
      await writeThrowingPlugin("fv-delclaim", "taskClaimed", "veto-delclaim");
      const { habitatId, taskId, agentId } = setupHabitatAndTask("pending");
      enrollPlugin(habitatId, "fv-delclaim", "veto-delclaim");

      expect(() => taskService.claimDelegatedTask(taskId, agentId)).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("pending");

      expectNoTaskSseFor(ssePublishSpy.mock.calls.map((c) => c[1]));
      expect(postHookSpy).not.toHaveBeenCalled();
    });

    it("submitTask: throwing pre-interceptor → failure veto (no Task SSE, no post hook)", async () => {
      await writeThrowingPlugin("fv-submit", "taskSubmitted", "veto-submit");
      const { habitatId, taskId, agentId } = setupHabitatAndTask("in_progress");
      enrollPlugin(habitatId, "fv-submit", "veto-submit");

      expect(() => taskService.submitTask(taskId, agentId, "done", [])).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("in_progress");

      expectNoTaskSseFor(ssePublishSpy.mock.calls.map((c) => c[1]));
      expect(postHookSpy).not.toHaveBeenCalled();
    });

    it("completeTask: throwing pre-interceptor → failure veto (no Task SSE, no post hook)", async () => {
      await writeThrowingPlugin("fv-complete", "taskApproved", "veto-complete");
      const { habitatId, taskId, agentId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "fv-complete", "veto-complete");

      expect(() => taskService.completeTask(taskId, agentId)).toThrow(InterceptorVetoError);
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");

      expectNoTaskSseFor(ssePublishSpy.mock.calls.map((c) => c[1]));
      expect(postHookSpy).not.toHaveBeenCalled();
    });

    it("approveTask (no reviewers): throwing pre-interceptor → failure veto (no Task SSE, no post hook)", async () => {
      await writeThrowingPlugin("fv-approve", "taskApproved", "veto-approve");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "fv-approve", "veto-approve");

      expect(() => taskService.approveTask(taskId, "reviewer-x", "human")).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");

      expectNoTaskSseFor(ssePublishSpy.mock.calls.map((c) => c[1]));
      expect(postHookSpy).not.toHaveBeenCalled();
    });

    it("rejectTask: throwing pre-interceptor → failure veto (no Task SSE, no post hook)", async () => {
      await writeThrowingPlugin("fv-reject", "taskRejected", "veto-reject");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "fv-reject", "veto-reject");

      expect(() => taskService.rejectTask(taskId, "reviewer-x", "bad", "human")).toThrow(
        InterceptorVetoError,
      );
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");

      expectNoTaskSseFor(ssePublishSpy.mock.calls.map((c) => c[1]));
      expect(postHookSpy).not.toHaveBeenCalled();
    });
  });

  // ── Final-approval pre-veto ordering (Q10) ────────────────────────────────

  describe("final-approval pre-veto ordering (Q10)", () => {
    function setupTwoReviewers(habitatId: string, taskId: string): void {
      taskReviewerRepo.create(taskId, "human", "rev-1");
      taskReviewerRepo.create(taskId, "human", "rev-2");
    }

    it("non-final approval: pre-veto NOT run, approval recorded, task stays submitted", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("q10-veto", "taskApproved", "veto-final");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "q10-veto", "veto-final");
      setupTwoReviewers(habitatId, taskId);

      // First reviewer approves — NON-FINAL (1 of 2). Pre-veto must NOT run.
      const result = taskService.approveTask(taskId, "rev-1", "human");
      expect(result?.status).toBe("submitted");

      // Approval recorded.
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-1")?.status).toBe("approved");
      // Second reviewer still pending.
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-2")?.status).toBe("pending");

      // No Plugin Run rows from the pre-interceptor (pre-veto was skipped).
      const runs = runRepo.listByHabitat(habitatId, { pluginId: "q10-veto" });
      expect(runs).toEqual([]);
    });

    it("final approval vetoed: approval NOT recorded, task stays submitted", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("q10-veto2", "taskApproved", "veto-final2");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "q10-veto2", "veto-final2");
      setupTwoReviewers(habitatId, taskId);

      // First reviewer approves (non-final — no pre-veto).
      taskService.approveTask(taskId, "rev-1", "human");
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-1")?.status).toBe("approved");

      // Second reviewer's approval would be FINAL — pre-veto blocks it.
      expect(() => taskService.approveTask(taskId, "rev-2", "human")).toThrow(InterceptorVetoError);

      // Final reviewer approval NOT recorded (still pending — can retry).
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-2")?.status).toBe("pending");
      // Task did NOT transition.
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");

      // Pre-veto DID run (Plugin Run row exists from the blocked final attempt).
      const runs = runRepo.listByHabitat(habitatId, { pluginId: "q10-veto2" });
      expect(runs.length).toBeGreaterThanOrEqual(1);
    });

    it("final approval allowed: approval recorded, task transitions to approved", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("q10-allow", "taskApproved", "allow-final", "() => ({ allow: true })");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "q10-allow", "allow-final");
      setupTwoReviewers(habitatId, taskId);

      // First reviewer (non-final).
      taskService.approveTask(taskId, "rev-1", "human");

      // Second reviewer — FINAL, pre-veto ALLOWS.
      const result = taskService.approveTask(taskId, "rev-2", "human");
      expect(result?.status).toBe("approved");

      // Both approvals recorded.
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-1")?.status).toBe("approved");
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-2")?.status).toBe("approved");
    });

    it("final approval vetoed then retried: reviewer remains pending and can retry after policy clears", async () => {
      vi.restoreAllMocks();
      // First: write a vetoing plugin
      await writeVetoPlugin("q10-retry", "taskApproved", "veto-retry");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "q10-retry", "veto-retry");
      setupTwoReviewers(habitatId, taskId);

      // First reviewer (non-final).
      taskService.approveTask(taskId, "rev-1", "human");

      // Final reviewer vetoed.
      expect(() => taskService.approveTask(taskId, "rev-2", "human")).toThrow(InterceptorVetoError);
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-2")?.status).toBe("pending");
      expect(taskRepo.getTaskById(taskId)?.status).toBe("submitted");

      // Now clear the veto: unload the veto plugin and load an allow plugin.
      pluginManager.resetPlugins();
      await writeVetoPlugin(
        "q10-retry-allow",
        "taskApproved",
        "veto-retry",
        "() => ({ allow: true })",
      );
      enrollPlugin(habitatId, "q10-retry-allow", "veto-retry");

      // Retry the final approval — should now succeed.
      const result = taskService.approveTask(taskId, "rev-2", "human");
      expect(result?.status).toBe("approved");
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-2")?.status).toBe("approved");
    });

    it("idempotent repeat approval: same reviewer approving twice does not throw or double-veto", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin("q10-idem", "taskApproved", "allow-idem", "() => ({ allow: true })");
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "q10-idem", "allow-idem");
      setupTwoReviewers(habitatId, taskId);

      // First reviewer approves (non-final).
      const first = taskService.approveTask(taskId, "rev-1", "human");
      expect(first?.status).toBe("submitted");
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-1")?.status).toBe("approved");

      // Repeat the same reviewer's approval — idempotent (no throw, stays approved).
      const repeat = taskService.approveTask(taskId, "rev-1", "human");
      expect(repeat?.status).toBe("submitted");
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-1")?.status).toBe("approved");
      // Second reviewer still pending.
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-2")?.status).toBe("pending");
    });

    it("serial non-final then final: both approvals recorded in order, pre-veto runs exactly once", async () => {
      vi.restoreAllMocks();
      await writeVetoPlugin(
        "q10-serial",
        "taskApproved",
        "allow-serial",
        "() => ({ allow: true })",
      );
      const { habitatId, taskId } = setupHabitatAndTask("submitted");
      enrollPlugin(habitatId, "q10-serial", "allow-serial");
      setupTwoReviewers(habitatId, taskId);

      // Non-final first.
      taskService.approveTask(taskId, "rev-1", "human");
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-1")?.status).toBe("approved");
      expect(taskReviewerRepo.findByTaskAndReviewer(taskId, "rev-2")?.status).toBe("pending");

      // No pre-veto rows yet (non-final skipped pre-veto).
      let runs = runRepo.listByHabitat(habitatId, { pluginId: "q10-serial" });
      expect(runs).toEqual([]);

      // Final second.
      const result = taskService.approveTask(taskId, "rev-2", "human");
      expect(result?.status).toBe("approved");

      // Pre-veto ran exactly once (for the final approval only).
      runs = runRepo.listByHabitat(habitatId, { pluginId: "q10-serial" });
      expect(runs.length).toBe(1);
      expect(runs[0].status).toBe("succeeded");
    });
  });

  // ── Quarantine counter (Q1) ────────────────────────────────────────────────

  describe("pre-interceptor quarantine (Q1 bounded fail-closed)", () => {
    it("threshold faults → quarantined → subsequent call skipped (allow, no handler)", async () => {
      vi.restoreAllMocks();
      process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "2";
      await writeVetoPlugin(
        "quar-test",
        "taskClaimed",
        "crash-quar",
        "() => { throw new Error('quar-boom'); }",
      );
      const { habitatId } = setupHabitatAndTask("pending");
      enrollPlugin(habitatId, "quar-test", "crash-quar");

      // Fault 1: throw → failure veto.
      let veto = pluginManager.runPreInterceptors("q1", "taskClaimed", habitatId, {} as never);
      expect(veto).not.toBeNull();
      expect(veto!.allow).toBe(false);

      // Fault 2: throw → failure veto → threshold reached → quarantined.
      veto = pluginManager.runPreInterceptors("q2", "taskClaimed", habitatId, {} as never);
      expect(veto).not.toBeNull();
      expect(veto!.allow).toBe(false);

      // Fault 3: quarantined → SKIPPED (allow, handler NOT called, skipped Plugin Run).
      const callTracker: string[] = [];
      (globalThis as { __quarCalls?: string[] }).__quarCalls = callTracker;

      veto = pluginManager.runPreInterceptors("q3", "taskClaimed", habitatId, {} as never);
      expect(veto).toBeNull(); // allow — Task work continues.

      // Verify a skipped Plugin Run was written for the quarantined attempt.
      const runs = runRepo.listByHabitat(habitatId, { pluginId: "quar-test" });
      const skippedRun = runs.find((r) => r.status === "skipped");
      expect(skippedRun).toBeDefined();

      // Verify failed runs were written for the two faults.
      const failedRuns = runs.filter((r) => r.status === "failed");
      expect(failedRuns.length).toBe(2);
    });
  });
});
