import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fork } from "node:child_process";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";

const wiring = vi.hoisted(() => ({ shutdownAll: vi.fn(async () => {}), release: vi.fn(), sessions: [] as Array<{ id: string; agentId: string }> }));
vi.mock("../daemon-wiring.js", () => ({
  getSessionManager: () => ({ get activeSessions() { return wiring.sessions; }, startTimeoutCheck() {}, shutdownAll: wiring.shutdownAll }),
  getClaimStrategy: () => ({}), releaseSessionManager: wiring.release, detectClisOnHost: () => [],
}));

import { initDb, closeDb, getDb } from "../db/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import * as repo from "../repositories/daemon.js";
import * as engine from "../services/daemonEngine.js";

let app: HttpRuntimeHandle | undefined;
let releasePending: (() => void) | undefined;
let dir = "";
const secret = "durable-stop-synthetic-test-secret";
const priorEnv = Object.fromEntries(["SLACK_SIGNING_SECRET", "DISCORD_PUBLIC_KEY", "ORCY_REGISTRATION_TOKEN", "HOST"].map((key) => [key, process.env[key]]));

async function independentApi(path: string, id: string, mode?: "start"): Promise<unknown> {
  const child = fork(join(import.meta.dirname, "fixtures", "daemon-stop-reader.ts"), [path, id, ...(mode ? [mode] : [])], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const childExit = new Promise<void>((resolve, reject) => child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`reader exited ${code}`))));
  const childResult = await new Promise<unknown>((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill(); reject(new Error("reader timed out")); }, 30000);
    child.once("message", (message) => { clearTimeout(timeout); resolve(message); });
    child.once("error", (error) => { clearTimeout(timeout); reject(error); });
    child.once("exit", (code) => { if (code !== 0) { clearTimeout(timeout); reject(new Error(`reader exited ${code}`)); } });
  });
  await childExit;
  return childResult;
}

beforeEach(() => { wiring.shutdownAll.mockReset().mockResolvedValue(undefined); wiring.release.mockClear(); wiring.sessions = []; });

afterEach(async () => {
  releasePending?.();
  releasePending = undefined;
  vi.restoreAllMocks();
  await engine.shutdownAll();
  await app?.close();
  app = undefined;
  closeDb();
  vi.useRealTimers();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(priorEnv)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

it("keeps a failed final offline write indeterminate across reopening, then honors a same-tick heartbeat", async () => {
  process.env.SLACK_SIGNING_SECRET = "synthetic-slack";
  process.env.DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "synthetic-registration";
  delete process.env.HOST;
  dir = mkdtempSync(join(tmpdir(), "orcy-stop-durable-"));
  const path = join(dir, "orcy.sqlite");
  await initDb(path);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-28T00:00:00.000Z"));
  setJwtSecret(secret);
  const auth = { authorization: `Bearer ${jwt.sign({ sub: "admin", username: "admin", role: "admin" }, secret, { issuer: "orcy" })}` };
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  const daemon = repo.createDaemon({ name: "durable", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic-daemon" });
  const external = repo.createDaemon({ name: "external", hostname: "test", maxConcurrent: 1, daemonVersion: "cli", plainToken: "external-daemon" });
  engine.start(daemon.id);
  expect((await app.inject({ method: "POST", url: "/api/daemon/heartbeat", headers: { "x-daemon-token": "external-daemon" }, payload: {} })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: "/api/daemons" })).statusCode).toBe(401);
  const viewer = { authorization: `Bearer ${jwt.sign({ sub: "viewer", username: "viewer", role: "viewer" }, secret, { issuer: "orcy" })}` };
  expect((await app.inject({ method: "GET", url: "/api/daemons", headers: viewer })).statusCode).toBe(403);
  getDb().run(sql.raw("CREATE TRIGGER fail_intent BEFORE UPDATE OF stop_intent ON daemon_instances WHEN NEW.stop_intent IS NOT NULL BEGIN SELECT RAISE(FAIL, 'synthetic intent failure'); END"));
  expect((await app.inject({ method: "POST", url: `/api/daemons/${daemon.id}/stop`, headers: auth })).statusCode).toBe(500);
  expect(engine.isRunning(daemon.id)).toBe(true);
  expect(wiring.shutdownAll).not.toHaveBeenCalled();
  expect((await app.inject({ method: "GET", url: `/api/daemons/${daemon.id}`, headers: auth })).json().daemon.status).toBe("online");
  getDb().run(sql.raw("DROP TRIGGER fail_intent"));
  let finish!: () => void;
  wiring.shutdownAll.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; releasePending = resolve; }));
  getDb().run(sql.raw("CREATE TRIGGER fail_offline BEFORE UPDATE OF status ON daemon_instances WHEN NEW.status = 'offline' BEGIN SELECT RAISE(FAIL, 'synthetic offline failure'); END"));
  const stopping = app.inject({ method: "POST", url: `/api/daemons/${daemon.id}/stop`, headers: auth }).then((response) => response);
  await vi.waitFor(() => expect(finish).toBeDefined());
  const independentReader = new Database(path, { readonly: true });
  const persisted = independentReader.prepare("SELECT stop_intent FROM daemon_instances WHERE id = ?").get(daemon.id) as { stop_intent: string | null };
  expect(persisted.stop_intent).toBeTruthy();
  independentReader.close();
  expect((await app.inject({ method: "GET", url: `/api/daemons/${daemon.id}`, headers: auth })).json().daemon.status).toBe("unknown");
  expect((await app.inject({ method: "POST", url: `/api/daemons/${daemon.id}/start`, headers: auth })).statusCode).toBe(409);
  finish();
  releasePending = undefined;
  expect((await stopping).statusCode).toBe(500);
  expect(wiring.shutdownAll).toHaveBeenCalledOnce();
  const list = await app.inject({ method: "GET", url: "/api/daemons", headers: auth });
  const detail = await app.inject({ method: "GET", url: `/api/daemons/${daemon.id}`, headers: auth });
  expect(list.statusCode).toBe(200);
  expect(detail.statusCode).toBe(200);
  expect(list.json().daemons.find((d: any) => d.id === daemon.id).status).toBe("unknown");
  expect(list.json().daemons.find((d: any) => d.id === external.id).status).toBe("online");
  expect(detail.json().daemon.status).toBe("unknown");
  expect(await independentApi(path, daemon.id)).toEqual({ list: "unknown", detail: "unknown", retryStatus: 409 });
  await app.close();
  app = undefined;
  closeDb();
  await initDb(path);
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  const reopened = await app.inject({ method: "GET", url: `/api/daemons/${daemon.id}`, headers: auth });
  expect(reopened.json().daemon.status).toBe("unknown");
  expect((await app.inject({ method: "POST", url: "/api/daemon/heartbeat", headers: { "x-daemon-token": "synthetic-daemon" }, payload: {} })).statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: `/api/daemons/${daemon.id}`, headers: auth })).json().daemon.status).toBe("online");
}, 120_000);


it("does not let an older completion overwrite an independently committed same-tick heartbeat", async () => {
  process.env.SLACK_SIGNING_SECRET = "synthetic-slack";
  process.env.DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "synthetic-registration";
  delete process.env.HOST;
  dir = mkdtempSync(join(tmpdir(), "orcy-stop-race-"));
  const path = join(dir, "orcy.sqlite");
  await initDb(path);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-28T00:00:00.000Z"));
  setJwtSecret(secret);
  const auth = { authorization: `Bearer ${jwt.sign({ sub: "admin", username: "admin", role: "admin" }, secret, { issuer: "orcy" })}` };
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  const daemon = repo.createDaemon({ name: "race", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "race-token" });
  engine.start(daemon.id);
  const before = repo.getDaemonById(daemon.id)!.lastHeartbeatAt;
  let finish!: () => void;
  wiring.shutdownAll.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; releasePending = resolve; }));
  const stopping = app.inject({ method: "POST", url: `/api/daemons/${daemon.id}/stop`, headers: auth }).then((response) => response);
  await vi.waitFor(() => expect(finish).toBeDefined());
  const independentWriter = new Database(path);
  independentWriter.prepare("UPDATE daemon_instances SET status = 'online', stop_intent = NULL, last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(before, before, daemon.id);
  independentWriter.close();
  expect((await app.inject({ method: "GET", url: `/api/daemons/${daemon.id}`, headers: auth })).json().daemon.status).toBe("online");
  finish();
  releasePending = undefined;
  expect((await stopping).statusCode).toBe(200);
  expect(repo.getDaemonById(daemon.id)).toMatchObject({ status: "online", stopIntent: null, lastHeartbeatAt: before });
  expect((await app.inject({ method: "GET", url: `/api/daemons/${daemon.id}`, headers: auth })).json().daemon.status).toBe("online");

  const restarted = repo.createDaemon({ name: "restart-race", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "restart-token" });
  engine.start(restarted.id);
  let finishRestart!: () => void;
  wiring.shutdownAll.mockImplementationOnce(() => new Promise<void>((resolve) => { finishRestart = resolve; releasePending = resolve; }));
  const oldStop = app.inject({ method: "POST", url: `/api/daemons/${restarted.id}/stop`, headers: auth }).then((response) => response);
  await vi.waitFor(() => expect(finishRestart).toBeDefined());
  expect(await independentApi(path, restarted.id, "start")).toEqual({ startStatus: 200, detail: "online" });
  expect(repo.getDaemonById(restarted.id)).toMatchObject({ stopIntent: null, lastHeartbeatAt: before });
  finishRestart();
  releasePending = undefined;
  expect((await oldStop).statusCode).toBe(200);
  expect(repo.getDaemonById(restarted.id)).toMatchObject({ status: "online", stopIntent: null, lastHeartbeatAt: before });
}, 120_000);

it("keeps legacy-schema reads and heartbeats available but refuses Stop before draining", async () => {
  process.env.SLACK_SIGNING_SECRET = "synthetic-slack";
  process.env.DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "synthetic-registration";
  delete process.env.HOST;
  dir = mkdtempSync(join(tmpdir(), "orcy-stop-legacy-"));
  const path = join(dir, "orcy.sqlite");
  await initDb(path);
  getDb().run(sql.raw("ALTER TABLE daemon_instances DROP COLUMN stop_intent"));
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-28T00:00:00.000Z"));
  setJwtSecret(secret);
  const auth = { authorization: `Bearer ${jwt.sign({ sub: "admin", username: "admin", role: "admin" }, secret, { issuer: "orcy" })}` };
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  wiring.sessions = [{ id: "synthetic-active-session", agentId: "synthetic-agent" }];
  const daemon = repo.createDaemon({ name: "legacy", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "legacy-token" });
  engine.start(daemon.id);
  const running = engine.getRunningDaemon(daemon.id)!;
  const pollTimer = running.pollTimer;
  const heartbeatTimer = running.heartbeatTimer;
  const heartbeat = await app.inject({ method: "POST", url: "/api/daemon/heartbeat", headers: { "x-daemon-token": "legacy-token" }, payload: {} });
  expect(heartbeat.statusCode).toBe(200);
  expect((await app.inject({ method: "GET", url: `/api/daemons/${daemon.id}`, headers: auth })).json().daemon.status).toBe("online");
  const stop = await app.inject({ method: "POST", url: `/api/daemons/${daemon.id}/stop`, headers: auth });
  expect(stop.statusCode).toBe(503);
  expect(stop.json().error).toContain("migration");
  expect(wiring.shutdownAll).not.toHaveBeenCalled();
  expect(engine.getRunningDaemon(daemon.id)).toBe(running);
  expect(running.sessionManager.activeSessions).toEqual([{ id: "synthetic-active-session", agentId: "synthetic-agent" }]);
  expect(running.pollTimer).toBe(pollTimer);
  expect(running.heartbeatTimer).toBe(heartbeatTimer);
  await vi.advanceTimersByTimeAsync(30000);
  expect(repo.getDaemonById(daemon.id)!.lastHeartbeatAt).toBe(new Date().toISOString());
  // Teardown must not leave the synthetic engine registered when the schema blocks Stop.
  getDb().run(sql.raw("ALTER TABLE daemon_instances ADD COLUMN stop_intent text"));
}, 120_000);
