/**
 * Epoch mutation guard — REAL API wire matrix (epoch-mutation-guard ticket).
 *
 * Boots the production HTTP assembly (createHttpApplication) on a REAL TCP
 * socket and drives the four agent lifecycle mutations through real fetch
 * with the X-Agent-API-Key agent auth. No route mocks, no inject.
 *
 * Acceptance mapping (ticket §Acceptance):
 *   1  stale-E1 matrix ×4 → 409 EPOCH_MISMATCH, row untouched under E2
 *   3  omitted / typed-null / correct / legacy-NULL / token-roll
 *   4  409 body shape: code EPOCH_MISMATCH + message names task.executionToken
 *   9  PATCH status-bypass strict schema; system-caller release still works
 *      (structural bypass); approve/reject human paths unchanged
 *
 * The DB is the sql.js in-memory test DB (initTestDb) shared with the
 * in-process app — the wire under test is HTTP, the concurrency proofs live
 * in epochMutationGuardIpc.test.ts on a real better-sqlite3 file DB.
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";

const EPOCH_MISMATCH = "EPOCH_MISMATCH";

let app: HttpRuntimeHandle;
let baseUrl: string;
let habitatId: string;
let columnId: string;
let server: net.Server | null = null;

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

function taskRow(taskId: string) {
  return getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as {
    id: string;
    status: string;
    assignedAgentId: string | null;
    executionToken: string | null;
    version: number;
  };
}

function api(agentKey: string) {
  return {
    async call(method: string, path: string, body?: unknown): Promise<Response> {
      return fetch(`${baseUrl}${path}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Agent-API-Key": agentKey },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    },
  };
}

/** Claim via the real route; returns the claim-epoch token. */
async function claimTask(taskId: string, apiKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-API-Key": apiKey },
    body: "{}",
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { task: { executionToken?: string | null } };
  expect(body.task.executionToken).toBeTruthy();
  return body.task.executionToken!;
}

/** Release + re-claim by the same agent → returns the fresh E2 token. */
async function rollEpoch(taskId: string, apiKey: string): Promise<string> {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/release`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-API-Key": apiKey },
    body: JSON.stringify({ reason: "epoch-roll", executionToken: taskRow(taskId).executionToken }),
  });
  expect(res.status).toBe(200);
  return claimTask(taskId, apiKey);
}

/** Start with the CURRENT token (helper for submit/fail/release setups). */
async function startWithCurrentToken(taskId: string, apiKey: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/tasks/${taskId}/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Agent-API-Key": apiKey },
    body: JSON.stringify({ executionToken: taskRow(taskId).executionToken }),
  });
  expect(res.status).toBe(200);
}

async function expectEpochMismatch(res: Response): Promise<void> {
  expect(res.status).toBe(409);
  const body = (await res.json()) as { error?: string; code?: string };
  expect(body.code).toBe(EPOCH_MISMATCH);
  expect(body.error).toContain("executionToken");
  expect(body.error).toContain("task.executionToken");
}

type Mutation = "start" | "submit" | "fail" | "release";

function mutationRequest(
  mutation: Mutation,
  taskId: string,
  token: unknown,
): { method: string; path: string; body: Record<string, unknown> } {
  const base = { executionToken: token };
  switch (mutation) {
    case "start":
      return { method: "POST", path: `/api/tasks/${taskId}/start`, body: base };
    case "submit":
      return {
        method: "POST",
        path: `/api/tasks/${taskId}/submit`,
        body: { ...base, result: "done" },
      };
    case "fail":
      return {
        method: "POST",
        path: `/api/tasks/${taskId}/fail`,
        body: { ...base, reason: "blocked" },
      };
    case "release":
      return {
        method: "POST",
        path: `/api/tasks/${taskId}/release`,
        body: { ...base, reason: "cannot proceed" },
      };
  }
}

async function callMutation(
  apiKey: string,
  mutation: Mutation,
  taskId: string,
  token: unknown,
): Promise<Response> {
  const req = mutationRequest(mutation, taskId, token);
  return fetch(`${baseUrl}${req.path}`, {
    method: req.method,
    headers: { "Content-Type": "application/json", "X-Agent-API-Key": apiKey },
    body: JSON.stringify(req.body),
  });
}

/**
 * Prepares a task in the status the given mutation requires, under a FRESH
 * epoch, returning the PREVIOUS epoch's token (the stale one the client
 * captured at its own claim).
 */
async function staleE1Setup(
  mutation: Mutation,
): Promise<{ taskId: string; apiKey: string; staleToken: string; freshToken: string }> {
  const agent = seedAgent(`stale-${mutation}-${Math.random().toString(36).slice(2, 8)}`);
  const taskId = seedTask(`stale-${mutation}`);
  const e1 = await claimTask(taskId, agent.apiKey);
  const e2 = await rollEpoch(taskId, agent.apiKey);
  if (mutation !== "start") {
    // submit / fail / release require in_progress (fail is in_progress-only)
    await startWithCurrentToken(taskId, agent.apiKey);
  }
  return { taskId, apiKey: agent.apiKey, staleToken: e1, freshToken: e2 };
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
  const habitat = habitatRepo.createHabitat({ name: "Epoch Guard Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;
});

afterEach(() => {
  server?.close();
  server = null;
});

describe("epoch mutation guard — real API wire matrix", () => {
  const mutations: Mutation[] = ["start", "submit", "fail", "release"];

  it.each(mutations)(
    "stale E1 token on %s → 409 EPOCH_MISMATCH, row untouched under E2",
    async (mutation) => {
      const { taskId, apiKey, staleToken, freshToken } = await staleE1Setup(mutation);
      const before = taskRow(taskId);

      const res = await callMutation(apiKey, mutation, taskId, staleToken);
      await expectEpochMismatch(res);

      const after = taskRow(taskId);
      expect(after.status).toBe(before.status);
      expect(after.assignedAgentId).toBe(before.assignedAgentId);
      expect(after.executionToken).toBe(freshToken);
      expect(after.version).toBe(before.version); // no write landed
    },
  );

  it.each(mutations)("omitted token on tokened task → %s 409 EPOCH_MISMATCH", async (mutation) => {
    const { taskId, apiKey } = await staleE1Setup(mutation);
    const res = await callMutation(apiKey, mutation, taskId, undefined);
    await expectEpochMismatch(res);
  });

  it.each(mutations)(
    "typed-null token ≡ omitted on tokened task → %s 409 EPOCH_MISMATCH",
    async (mutation) => {
      const { taskId, apiKey } = await staleE1Setup(mutation);
      const res = await callMutation(apiKey, mutation, taskId, null);
      await expectEpochMismatch(res);
    },
  );

  it.each(mutations)("correct token → %s succeeds", async (mutation) => {
    const { taskId, apiKey, freshToken } = await staleE1Setup(mutation);
    const res = await callMutation(apiKey, mutation, taskId, freshToken);
    expect(res.status).toBe(200);
    const after = taskRow(taskId);
    const expectedStatus = {
      start: "in_progress",
      submit: "submitted",
      fail: "failed",
      release: "pending",
    }[mutation];
    expect(after.status).toBe(expectedStatus);
  });

  it.each(mutations)("legacy NULL-stored row → %s allowed WITHOUT any token", async (mutation) => {
    const agent = seedAgent(`legacy-${mutation}`);
    const taskId = seedTask(`legacy-${mutation}`);
    // Pre-T1 row: claimed/assigned directly, no minted token.
    getDb()
      .update(tasks)
      .set({ status: mutation === "start" ? "claimed" : "in_progress", assignedAgentId: agent.id })
      .where(eq(tasks.id, taskId))
      .run();

    const res = await callMutation(agent.apiKey, mutation, taskId, undefined);
    expect(res.status).toBe(200);
  });

  it.each(mutations)(
    "legacy NULL-stored row → %s allowed even with an ARBITRARY client token",
    async (mutation) => {
      const agent = seedAgent(`legacy-arb-${mutation}`);
      const taskId = seedTask(`legacy-arb-${mutation}`);
      getDb()
        .update(tasks)
        .set({
          status: mutation === "start" ? "claimed" : "in_progress",
          assignedAgentId: agent.id,
        })
        .where(eq(tasks.id, taskId))
        .run();

      const res = await callMutation(agent.apiKey, mutation, taskId, "not-a-real-epoch-token");
      expect(res.status).toBe(200);
    },
  );

  it("fresh claim rolls the token: the previous epoch's token is rejected, the new one works", async () => {
    const agent = seedAgent("roll-agent");
    const taskId = seedTask("roll-task");
    const e1 = await claimTask(taskId, agent.apiKey);
    const e2 = await rollEpoch(taskId, agent.apiKey);
    expect(e1).not.toBe(e2);

    const stale = await callMutation(agent.apiKey, "start", taskId, e1);
    await expectEpochMismatch(stale);

    const fresh = await callMutation(agent.apiKey, "start", taskId, e2);
    expect(fresh.status).toBe(200);
    expect(taskRow(taskId).status).toBe("in_progress");
  });

  it("NO-BODY start (no Content-Type, no body — the CLI shape): tokened row → 409 EPOCH_MISMATCH, untouched", async () => {
    const agent = seedAgent("nobodied-tokened");
    const taskId = seedTask("nobodied-tokened");
    await claimTask(taskId, agent.apiKey);
    const before = taskRow(taskId);

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/start`, {
      method: "POST",
      headers: { "X-Agent-API-Key": agent.apiKey },
      // no Content-Type, no body — exactly what the CLI's no-token start sends
    });
    await expectEpochMismatch(res);

    const after = taskRow(taskId);
    expect(after.status).toBe(before.status);
    expect(after.version).toBe(before.version);
  });

  it("NO-BODY start on a legacy NULL row → 200 allowed (actor/status checks still apply)", async () => {
    const agent = seedAgent("nobodied-legacy");
    const taskId = seedTask("nobodied-legacy");
    getDb()
      .update(tasks)
      .set({ status: "claimed", assignedAgentId: agent.id })
      .where(eq(tasks.id, taskId))
      .run();

    const res = await fetch(`${baseUrl}/api/tasks/${taskId}/start`, {
      method: "POST",
      headers: { "X-Agent-API-Key": agent.apiKey },
    });
    expect(res.status).toBe(200);
    expect(taskRow(taskId).status).toBe("in_progress");
  });

  it("claim response carries the execution token on the wire (task.executionToken)", async () => {
    const agent = seedAgent("claim-response-agent");
    const taskId = seedTask("claim-response-task");
    const token = await claimTask(taskId, agent.apiKey);
    expect(taskRow(taskId).executionToken).toBe(token);
  });
});

describe("epoch mutation guard — structural boundaries (ticket I5, item 9)", () => {
  it("PATCH /tasks/:id rejects a status field (strict schema — no status-bypass of the guard)", async () => {
    const agent = seedAgent("patch-agent");
    const taskId = seedTask("patch-task");
    await claimTask(taskId, agent.apiKey);
    const res = await fetch(`${baseUrl}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", "X-Agent-API-Key": agent.apiKey },
      body: JSON.stringify({ status: "in_progress" }),
    });
    expect(res.status).toBe(400);
    expect(taskRow(taskId).status).toBe("claimed");
  });

  it("system-caller releaseTask (no token param) still releases a tokened task — structural bypass", async () => {
    const agent = seedAgent("system-release-agent");
    const taskId = seedTask("system-release-task");
    await claimTask(taskId, agent.apiKey);
    expect(taskRow(taskId).executionToken).not.toBeNull();

    // The stale-sweep / automation / plugin call shape: no token argument.
    const released = taskStateMachine.releaseTask(taskId, "system");
    expect(released).not.toBeNull();
    expect(taskRow(taskId).status).toBe("pending");
    expect(taskRow(taskId).executionToken).toBeNull();
  });

  it("repo submitTask without the guard param (system caller shape) still submits a tokened task", async () => {
    const agent = seedAgent("system-submit-agent");
    const taskId = seedTask("system-submit-task");
    await claimTask(taskId, agent.apiKey);
    getDb().update(tasks).set({ status: "in_progress" }).where(eq(tasks.id, taskId)).run();
    const submitted = taskStateMachine.submitTask(taskId, agent.id, "sys", []);
    expect(submitted).not.toBeNull();
    expect(taskRow(taskId).status).toBe("submitted");
  });

  it("approve/reject human review paths are unchanged (no token field on the review routes)", async () => {
    const agent = seedAgent("review-agent");
    const taskId = seedTask("review-task");
    await claimTask(taskId, agent.apiKey);
    await startWithCurrentToken(taskId, agent.apiKey);
    const res = await callMutation(agent.apiKey, "submit", taskId, taskRow(taskId).executionToken);
    expect(res.status).toBe(200);
    expect(taskRow(taskId).status).toBe("submitted");

    // Reject via the service in its exact current shape (reviewer identity is
    // not the executor — a human reviewer row is not required when none are
    // assigned): the review transition must not demand an execution token.
    const { rejectTask } = await import("../services/tasks/index.js");
    const rejected = rejectTask(taskId, "human-reviewer-1", "needs work", "human");
    expect(rejected).not.toBeNull();
    expect(taskRow(taskId).status).toBe("rejected");
  });
});
