/**
 * Daemon worker contract — REAL wire matrix (acceptance items 1-HTTP-half
 * and 14's spoof discriminator).
 *
 * Boots the production HTTP assembly (createHttpApplication) on a REAL TCP
 * socket. No route mocks, no inject. The standalone transport's terminal
 * PATCH (`X-Daemon-Token`) must drive the full task-side bundle inside the
 * awaited request; the embedded transport's `InProcessSessionUpdater` seam
 * must drive synchronously behind its async facade.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { eq, and } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import {
  tasks,
  taskEvents,
  effectReceipts,
  daemonSessions,
  habitatSkillSignals,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as daemonInstanceRepo from "../repositories/daemonInstance.js";
import { createDaemonSessionWithClient } from "../repositories/daemonSession.js";
import * as daemonEngine from "../services/daemonEngine.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { InProcessSessionUpdater } from "../services/inProcessSessionUpdater.js";
import { processEffectReceipts } from "../services/effects/effectDeliverer.js";
import type { EventAction } from "../models/index.js";

let app: HttpRuntimeHandle;
let baseUrl: string;
let habitatId: string;
let columnId: string;
let agentId: string;
let daemonToken: string;
let daemonId: string;
let wireAgentApiKey: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function seedAgent(name: string): { id: string; apiKey: string } {
  const created = agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  return { id: created.agent.id, apiKey: created.plainApiKey };
}

function seedTask(title: string): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy: "user-1" }).id;
}

function claimStarted(taskId: string): { id: string; token: string } {
  const claim = taskStateMachine.claimTask(taskId, agentId);
  expect(claim.success).toBe(true);
  const started = taskStateMachine.startTask(taskId, agentId);
  expect(started?.status).toBe("in_progress");
  return { id: taskId, token: started!.executionToken! };
}

function seedSession(taskId: string, token: string): string {
  const { id } = createDaemonSessionWithClient(
    getDb(),
    { daemonId, agentId, taskId, habitatId, workdir: "/tmp/wd" },
    token,
  );
  return id;
}

function eventsFor(taskId: string, action: EventAction) {
  return getDb()
    .select()
    .from(taskEvents)
    .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, action)))
    .all();
}

beforeAll(async () => {
  const server = net.createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve((server.address() as net.AddressInfo).port));
  });
  server.close();
  app = await createHttpApplication();
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
});

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Daemon Recovery Wire" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({ habitatId, name: "T", order: 0, requiresClaim: false }).id;
  const seeded = seedAgent("wire-agent");
  agentId = seeded.id;
  wireAgentApiKey = seeded.apiKey;
  const reg = daemonEngine.registerHttpDaemon({
    name: "wire-daemon",
    hostname: "test",
    maxConcurrent: 4,
    daemonVersion: "test",
    habitatIds: [habitatId],
    detectedClis: [{ type: "claude-code", path: "/bin/claude" }],
  });
  daemonId = reg.daemonId;
  daemonToken = reg.daemonToken;
  void daemonInstanceRepo;
});

afterEach(async () => {
  await closeDb();
});

describe("acceptance 1 — standalone transport: daemon-auth terminal PATCH drives the fail bundle", () => {
  it("PATCH /daemon/sessions/:id {status:failed} lands the task-side effects inside the awaited request", async () => {
    const taskId = seedTask("wire-fail");
    const { token } = claimStarted(taskId);
    const sessionId = seedSession(taskId, token);

    const res = await fetch(`${baseUrl}/api/daemon/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "X-Daemon-Token": daemonToken, "content-type": "application/json" },
      body: JSON.stringify({ status: "failed" }),
    });
    expect(res.status).toBe(200);

    const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as any;
    expect(row.status).toBe("failed");
    expect(row.executionToken).toBeNull();
    expect(row.lastFailureEventId).not.toBeNull();

    const consumers = getDb()
      .select()
      .from(effectReceipts)
      .where(eq(effectReceipts.taskId, taskId))
      .all()
      .map((r) => r.consumer)
      .sort();
    expect(consumers).toEqual([
      "detector_dispatch",
      "failure_context",
      "retry_ladder",
      "skill_ingestion",
      "workflow_gates",
    ]);
    const [ev] = eventsFor(taskId, "failed");
    expect(ev.actorType).toBe("system");
    expect(ev.actorId).toBe("daemon-recovery");
    expect((ev.metadata as any).reason).toBe("daemon_session_failed");

    // Session row itself terminal via the monotonic guard.
    const sess = getDb()
      .select()
      .from(daemonSessions)
      .where(eq(daemonSessions.id, sessionId))
      .get()!;
    expect(sess.status).toBe("failed");
    expect(sess.endedAt).not.toBeNull();
  });

  it("PATCH {status:released} on a claimed task releases WITH effects (P2 shape over HTTP)", async () => {
    const taskId = seedTask("wire-release");
    const claim = taskStateMachine.claimTask(taskId, agentId);
    expect(claim.success).toBe(true);
    const token = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!.executionToken!;
    const sessionId = seedSession(taskId, token);

    const res = await fetch(`${baseUrl}/api/daemon/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "X-Daemon-Token": daemonToken, "content-type": "application/json" },
      body: JSON.stringify({ status: "released" }),
    });
    expect(res.status).toBe(200);

    const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as any;
    expect(row.status).toBe("pending");
    expect(row.lastReleaseEventId).not.toBeNull();
    expect(
      getDb()
        .select()
        .from(effectReceipts)
        .where(eq(effectReceipts.taskId, taskId))
        .all()
        .map((r) => r.consumer)
        .sort(),
    ).toEqual(["failure_context", "workflow_gates"]);
    const [ev] = eventsFor(taskId, "released");
    expect((ev.metadata as any).reason).toBe("daemon_session_released");
  });
});

describe("acceptance 1 — embedded transport: InProcessSessionUpdater drives behind the async facade", () => {
  it("updateSession(released) releases the claimed task with effects before the promise resolves", async () => {
    const taskId = seedTask("embedded-release");
    const claim = taskStateMachine.claimTask(taskId, agentId);
    expect(claim.success).toBe(true);
    const token = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()!.executionToken!;
    const sessionId = seedSession(taskId, token);

    const updater = new InProcessSessionUpdater();
    await updater.updateSession(sessionId, { status: "released" });

    const row = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as any;
    expect(row.status).toBe("pending");
    expect(row.lastReleaseEventId).not.toBeNull();
    const [ev] = eventsFor(taskId, "released");
    expect((ev.metadata as any).reason).toBe("daemon_session_released");
  });
});

describe("acceptance 14 — spoof discriminator: agent reason text can never reach system attribution", () => {
  it("agent /fail with reason daemon_session_lost stays agent-attributed", async () => {
    const taskId = seedTask("spoof");
    const { token } = claimStarted(taskId);

    // The REAL agent-auth route with a spoofed system-reason body.
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/fail`, {
      method: "POST",
      headers: { "X-Agent-API-Key": wireAgentApiKey, "content-type": "application/json" },
      body: JSON.stringify({ reason: "daemon_session_lost", executionToken: token }),
    });
    expect(res.status).toBe(200);

    await processEffectReceipts();

    const signals = getDb()
      .select()
      .from(habitatSkillSignals)
      .where(eq(habitatSkillSignals.habitatId, habitatId))
      .all()
      .filter((r) => (r.sourceTaskIds ?? "").includes(taskId));
    expect(signals.length).toBeGreaterThan(0);
    // Spoofed reason text does NOT flip the auth-derived classification:
    // the agent keeps its binding (the reason prefix is not trusted).
    expect(signals.some((r) => (r.corroboratingAgentIds ?? "").includes(agentId))).toBe(true);
    expect(
      getDb()
        .select()
        .from(taskEvents)
        .where(and(eq(taskEvents.taskId, taskId), eq(taskEvents.action, "failed")))
        .all(),
    ).toHaveLength(1);
  });
});
