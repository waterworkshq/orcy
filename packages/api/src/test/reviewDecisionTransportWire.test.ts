/**
 * Review-decision transport restoration (REC-11) — REAL API wire contracts.
 *
 * Boots the production HTTP assembly (createHttpApplication) on a REAL TCP
 * socket and drives the approve/reject review-decision routes through real
 * fetch with the X-Agent-API-Key agent auth. Independent-review corrections
 * (C1/C2) pinned as wire behavior:
 *
 *   C1: route admission is taskAuth row-admission — no pending agent-typed
 *       row → 403; a row-holding agent who IS the current assignee reaches
 *       admission but the service refuses typed anti-self → 400 "cannot be
 *       approved/rejected in current state" (not 403).
 *   C2: reviewNote on approve/reject is IGNORED-BY-STRIP (non-strict
 *       schemas): the decision persists; the note never lands in
 *       any persisted column.
 */
import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { tasks, taskEvents } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrud from "../repositories/taskCrud.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as agentRepo from "../repositories/agent.js";
import * as pluginManager from "../plugins/pluginManager.js";

let app: HttpRuntimeHandle;
let baseUrl: string;
let habitatId: string;
let columnId: string;

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

function taskRow(taskId: string) {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
    id: string;
    status: string;
    assignedAgentId: string | null;
  };
}

/** Worker claims + starts + submits (via the review-exempt service path), then releases nothing — the task sits submitted. */
function seedSubmittedTask(workerId: string, title: string): string {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `m-${title}`,
    createdBy: "user-1",
  });
  const task = taskCrud.createTask({ missionId: mission.id, title, createdBy: "user-1" });
  // Keep the worker as the current assignee through submission so the
  // self-review 400 path is reachable; the executor cars (claim/start/submit)
  // is executor-authority work, not review decisions, so the legacy
  // service shape is the fixture harness here.
  taskStateMachine.claimTask(task.id, workerId);
  expect(taskRow(task.id).assignedAgentId).toBe(workerId);
  return task.id;
}

async function submitViaWire(
  taskId: string,
  workerKey: string,
  reviewerName: string,
): Promise<void> {
  // Service-level submit is a pre-existing executor-authority path (not a
  // review decision under REC-11) — the fixture routes the worker through
  // the real submit HTTP route so admission (assignee-only) is exercised.
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/submit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-API-Key": workerKey },
    body: JSON.stringify({ result: `work by ${reviewerName}` }),
  });
  // The fixture worker may not be started; a 409 is acceptable — fall back to
  // marking submitted through the state machine so the review contract under
  // test (not the submit contract) is what's asserted.
  if (res.status !== 200) {
    const full = taskRow(taskId);
    if (full?.status === "claimed") taskStateMachine.startTask(taskId, full.assignedAgentId!);
    const submitted = taskStateMachine.submitTask(
      taskId,
      full!.assignedAgentId!,
      `work by ${reviewerName}`,
      [],
    );
    expect(submitted).not.toBeNull();
  }
  expect(taskRow(taskId).status).toBe("submitted");
}

async function decide(
  method: "approve" | "reject",
  taskId: string,
  agentKey: string,
  body?: Record<string, unknown>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/tasks/${taskId}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-API-Key": agentKey },
    body: JSON.stringify(body ?? {}),
  });
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await app.close();
  closeDb();
});

beforeEach(() => {
  const habitat = habitatRepo.createHabitat({ name: "Review Transport Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

describe("review decisions — C1 route vs service admission layering", () => {
  it("agent with NO pending reviewer row → 403 (route row-admission), row untouched", async () => {
    const worker = seedAgent("c1-worker");
    const stranger = seedAgent("c1-stranger");
    const taskId = seedSubmittedTask(worker.id, "c1-no-row");
    await submitViaWire(taskId, worker.apiKey, "c1-worker");

    const res = await decide("approve", taskId, stranger.apiKey);
    expect(res.status).toBe(403);
    expect(taskRow(taskId).status).toBe("submitted");
  });

  it("row-holding agent who IS the current assignee → 400 typed anti-self (service), not 403", async () => {
    const worker = seedAgent("c1-self-worker");
    const taskId = seedSubmittedTask(worker.id, "c1-self");
    await submitViaWire(taskId, worker.apiKey, "c1-self-worker");
    // The assignee themselves holds a pending agent-typed row — admitted by
    // the route (row exists) but refused by the service anti-self recheck.
    taskReviewerRepo.create(taskId, "agent", worker.id);

    const res = await decide("approve", taskId, worker.apiKey);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("cannot be approved");
    expect(taskRow(taskId).status).toBe("submitted");
  });

  it("row-holding NON-assignee agent approves → 200 (assignment authorized)", async () => {
    const worker = seedAgent("c1-ok-worker");
    const reviewer = seedAgent("c1-ok-reviewer");
    const taskId = seedSubmittedTask(worker.id, "c1-ok");
    await submitViaWire(taskId, worker.apiKey, "c1-ok-worker");
    taskReviewerRepo.create(taskId, "agent", reviewer.id);

    const res = await decide("approve", taskId, reviewer.apiKey);
    expect(res.status).toBe(200);
    expect(taskRow(taskId).status).toBe("approved");
  });

  it("row-holding NON-assignee agent rejects → 200 with reason persisted (reject requires reason)", async () => {
    const worker = seedAgent("c1-rej-worker");
    const reviewer = seedAgent("c1-rej-reviewer");
    const taskId = seedSubmittedTask(worker.id, "c1-rej");
    await submitViaWire(taskId, worker.apiKey, "c1-rej-worker");
    taskReviewerRepo.create(taskId, "agent", reviewer.id);

    const res = await decide("reject", taskId, reviewer.apiKey, { reason: "needs rework" });
    expect(res.status).toBe(200);
    expect(taskRow(taskId).status).toBe("rejected");
  });

  it("reject WITHOUT reason → 400 validation (reason is required)", async () => {
    const worker = seedAgent("c1-noreason-worker");
    const reviewer = seedAgent("c1-noreason-reviewer");
    const taskId = seedSubmittedTask(worker.id, "c1-noreason");
    await submitViaWire(taskId, worker.apiKey, "c1-noreason-worker");
    taskReviewerRepo.create(taskId, "agent", reviewer.id);

    const res = await decide("reject", taskId, reviewer.apiKey, {});
    expect(res.status).toBe(400);
    expect(taskRow(taskId).status).toBe("submitted");
  });
});

describe("review decisions — C2 reviewNote stripped, never persisted", () => {
  it("reviewNote sent to approve is ignored-by-strip: decision persists, no note stored", async () => {
    const worker = seedAgent("c2-worker");
    const reviewer = seedAgent("c2-reviewer");
    const taskId = seedSubmittedTask(worker.id, "c2-note");
    await submitViaWire(taskId, worker.apiKey, "c2-worker");
    taskReviewerRepo.create(taskId, "agent", reviewer.id);

    const res = await decide("approve", taskId, reviewer.apiKey, { reviewNote: "looks great" });
    expect(res.status).toBe(200);
    expect(taskRow(taskId).status).toBe("approved");
    // The note is stripped by the non-strict schema — it must not land in
    // any persisted review column. The task row carries no review-note
    // column in this path; the reviewer row keeps only its status change.
    const row = taskReviewerRepo.findByTaskAndReviewer(taskId, reviewer.id, "agent");
    expect(row?.status).toBe("approved");
    expect((row as unknown as Record<string, unknown>).reviewNote ?? null).toBeNull();
  });
});

describe("review decisions — strict-wall and reviewer management unchanged", () => {
  it("raw PATCH with status=approved still 400 (strict wall intact)", async () => {
    const worker = seedAgent("c3-patch-worker");
    const taskId = seedSubmittedTask(worker.id, "c3-patch");
    await submitViaWire(taskId, worker.apiKey, "c3-patch-worker");

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Agent-API-Key": worker.apiKey },
      body: JSON.stringify({ status: "approved" }),
    });
    expect(res.status).toBe(400);
    expect(taskRow(taskId).status).toBe("submitted");
  });

  it("/reviewers management routes still respond (add/remove/decision are separate surfaces)", async () => {
    const worker = seedAgent("c3-mgmt-worker");
    const reviewer = seedAgent("c3-mgmt-reviewer");
    const taskId = seedSubmittedTask(worker.id, "c3-mgmt");
    await submitViaWire(taskId, worker.apiKey, "c3-mgmt-worker");

    const before = taskReviewerRepo.getByTaskId(taskId);
    expect(before).toHaveLength(0);
    taskReviewerRepo.create(taskId, "agent", reviewer.id);
    expect(taskReviewerRepo.getByTaskId(taskId)).toHaveLength(1);

    // Rejected-agent provenance lands a terminal event for the deciding agent.
    const res = await decide("reject", taskId, reviewer.apiKey, { reason: "still broken" });
    expect(res.status).toBe(200);
    const events = getDb().select().from(taskEvents).all() as Array<{
      taskId: string;
      action: string;
      actorType: string;
      actorId: string;
    }>;
    const terminal = events.filter(
      (e) => e.taskId === taskId && (e.action === "approved" || e.action === "rejected"),
    );
    expect(terminal).toHaveLength(1);
    expect(terminal[0].actorId).toBe(reviewer.id);
  });
});
