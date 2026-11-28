import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { fork, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import Database from "better-sqlite3";
import { sql } from "drizzle-orm";
import { initDb, closeDb, getDb } from "../db/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import * as repo from "../repositories/daemon.js";
import { createDaemonStopIntent } from "../services/daemonOwnerWitness.js";
import * as agentRepo from "../repositories/agent.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";

let app: HttpRuntimeHandle;
let dir = "";
let path = "";
let daemonId = "";
let owner: ChildProcess | undefined;
let ownerExit: Promise<void> | undefined;
const secret = "verified-recovery-synthetic-test-secret";
const priorEnv = Object.fromEntries(["SLACK_SIGNING_SECRET", "DISCORD_PUBLIC_KEY", "ORCY_REGISTRATION_TOKEN", "HOST"].map((key) => [key, process.env[key]]));
const linuxIt = process.platform === "linux" ? it : it.skip;
const token = (role: string) => `Bearer ${jwt.sign({ sub: role, username: role, role }, secret, { issuer: "orcy" })}`;
const admin = () => ({ authorization: token("admin") });

async function startOwner(mode?: "reserve" | "start" | "register" | "external") {
  if (!mode || mode === "register" || mode === "external") getDb().run(sql.raw("CREATE TRIGGER fail_offline BEFORE UPDATE OF status ON daemon_instances WHEN NEW.status = 'offline' BEGIN SELECT RAISE(FAIL, 'synthetic final failure'); END"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  writeFileSync(join(binDir, "claude"), "#!/bin/sh\nprintf '1.0.0\\n'\n", { mode: 0o755 });
  owner = fork(join(import.meta.dirname, "fixtures", "daemon-recovery-owner.ts"), [path, daemonId, ...(mode ? [mode] : [])], { execArgv: ["--import", "tsx"], stdio: ["ignore", "ignore", "ignore", "ipc"], env: { ...process.env, PATH: `${binDir}:/usr/bin:/bin` } });
  ownerExit = new Promise<void>((resolve) => owner!.once("exit", () => resolve()));
  const result = await new Promise<any>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("owner fixture timed out")), 30000);
    owner!.once("message", (message) => { clearTimeout(timeout); resolve(message); });
    owner!.once("error", (error) => { clearTimeout(timeout); reject(error); });
    owner!.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`owner exited early: ${code}`)); });
  });
  if (!mode || mode === "register") {
    expect(result).toEqual({ type: "ready", daemonId: expect.any(String) });
    daemonId = result.daemonId;
    expect(repo.getDaemonAgentsByDaemonId(daemonId)).toHaveLength(mode === "register" ? 1 : 0);
  } else {
    expect(result).toEqual({ type: "ready" });
  }
  if (!mode || mode === "register" || mode === "external") getDb().run(sql.raw("DROP TRIGGER fail_offline"));
}
async function exitOwner() { owner!.send("exit"); await ownerExit; owner = undefined; }
async function detail() { return (await app.inject({ method: "GET", url: `/api/daemons/${daemonId}`, headers: admin() })).json().daemon; }
async function recover(expectedIntent: string, headers = admin()) {
  return app.inject({ method: "POST", url: `/api/daemons/${daemonId}/recover`, headers, payload: { expectedIntent } });
}

beforeEach(async () => {
  process.env.SLACK_SIGNING_SECRET = "synthetic-slack";
  process.env.DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "synthetic-registration";
  delete process.env.HOST;
  dir = mkdtempSync(join(tmpdir(), "orcy-verified-recovery-"));
  path = join(dir, "orcy.sqlite");
  await initDb(path);
  setJwtSecret(secret);
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  daemonId = repo.createDaemon({ name: "recovery", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic-daemon" }).id;
}, 120_000);

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  if (owner && owner.exitCode === null) { owner.kill("SIGKILL"); await ownerExit; }
  owner = undefined;
  await app?.close();
  closeDb();
  if (dir) rmSync(dir, { recursive: true, force: true });
  for (const [key, value] of Object.entries(priorEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

linuxIt("refuses a live owner and accepts a terminated owner with no active sessions", async () => {
  const unrelated = repo.getDaemonById(daemonId)!;
  await startOwner("register");
  const before = await detail();
  expect(before.status).toBe("unknown");
  expect(before.stopIntentRef).toEqual(expect.any(String));
  const intent = repo.getDaemonById(daemonId)!.stopIntent!;
  const witness = JSON.parse(Buffer.from(intent.slice("owner-v1:".length), "base64url").toString("utf8"));
  expect(witness).toMatchObject({ pid: owner!.pid, nonce: before.stopIntentRef });
  expect(process.kill(owner!.pid!, 0)).toBe(true);
  expect((await app.inject({ method: "POST", url: `/api/daemons/${daemonId}/recover`, payload: { expectedIntent: before.stopIntentRef } })).statusCode).toBe(401);
  expect((await recover(before.stopIntentRef, { authorization: token("viewer") })).statusCode).toBe(403);
  expect((await recover(before.stopIntentRef, { authorization: token("editor") })).statusCode).toBe(403);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  expect(await detail()).toMatchObject({ status: "unknown", stopIntentRef: before.stopIntentRef });
  await exitOwner();
  expect((await recover(before.stopIntentRef)).statusCode).toBe(200);
  expect((await detail()).status).toBe("offline");
  expect(repo.getDaemonById(unrelated.id)).toEqual(unrelated);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
}, 120_000);

it("leaves legacy ownerless intents unknown", async () => {
  repo.beginDaemonStop(daemonId, "legacy-intent");
  expect((await detail()).status).toBe("unknown");
  expect((await recover("00000000-0000-4000-8000-000000000000")).statusCode).toBe(409);
  expect((await detail()).status).toBe("unknown");
}, 120_000);

linuxIt("refuses to reconcile a terminated owner with an active null-PID session", async () => {
  await startOwner();
  const before = await detail();
  const agent = agentRepo.createAgent({ name: "active", type: "claude-code", domain: "fullstack", capabilities: [] });
  const habitat = habitatRepo.createHabitat({ name: "recovery" });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: column.id, title: "Mission", createdBy: "admin" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", createdBy: "admin" });
  const session = repo.createDaemonSession({ daemonId, agentId: agent.agent.id, taskId: task.id, habitatId: habitat.id, workdir: "/synthetic" });
  expect(session).toMatchObject({ status: "starting", pid: null });
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  expect(repo.getSessionById(session.id)).toMatchObject({ status: "starting", pid: null });
  await exitOwner();
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  expect(repo.getSessionById(session.id)).toMatchObject({ status: "starting", pid: null });
  expect(await detail()).toMatchObject({ status: "unknown", stopIntentRef: before.stopIntentRef });
  getDb().run(sql`UPDATE daemon_sessions SET status = 'unrecognized' WHERE id = ${session.id}`);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  expect(repo.getSessionById(session.id)?.status).toBe("unrecognized");
  getDb().run(sql`UPDATE daemon_sessions SET status = 'completed' WHERE id = ${session.id}`);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(200);
  expect(repo.getSessionById(session.id)?.status).toBe("completed");
}, 120_000);


linuxIt("refuses when owner visibility or namespace is ambiguous", async () => {
  await startOwner();
  const before = await detail();
  const intent = repo.getDaemonById(daemonId)!.stopIntent!;
  const ownerPid = owner!.pid!;
  await exitOwner();
  const realKill = process.kill.bind(process);
  const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === ownerPid && signal === 0) throw Object.assign(new Error("unobservable"), { code: "EPERM" });
    return realKill(pid, signal);
  }) as typeof process.kill);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  kill.mockRestore();
  const witness = JSON.parse(Buffer.from(intent.slice("owner-v1:".length), "base64url").toString("utf8"));
  for (const change of [
    { namespace: "pid:[1]" },
    { boot: "00000000-0000-0000-0000-000000000000" },
    { uid: witness.uid + 1 },
    { startTicks: "invalid" },
  ]) {
    const changed = { ...witness, ...change };
    repo.beginDaemonStop(daemonId, "owner-v1:" + Buffer.from(JSON.stringify(changed)).toString("base64url"));
    expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
    expect((await detail()).status).toBe("unknown");
  }
}, 120_000);

linuxIt.each(["heartbeat", "intent"] as const)("does not overwrite a newer same-tick %s committed during owner verification", async (change) => {
  await startOwner();
  const before = await detail();
  const old = repo.getDaemonById(daemonId)!;
  const ownerPid = owner!.pid!;
  await exitOwner();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(old.lastHeartbeatAt!));
  const realKill = process.kill.bind(process);
  let raced = false;
  const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    try { return realKill(pid, signal); }
    catch (error) {
      if (pid === ownerPid && (error as NodeJS.ErrnoException).code === "ESRCH" && !raced) {
        raced = true;
        const writer = new Database(path);
        try {
          if (change === "heartbeat") writer.prepare("UPDATE daemon_instances SET status = 'online', stop_intent = NULL, last_heartbeat_at = ?, updated_at = ? WHERE id = ?").run(old.lastHeartbeatAt, old.lastHeartbeatAt, daemonId);
          else writer.prepare("UPDATE daemon_instances SET stop_intent = 'newer-intent' WHERE id = ?").run(daemonId);
        } finally { writer.close(); }
      }
      throw error;
    }
  }) as typeof process.kill);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  expect(raced).toBe(true);
  kill.mockRestore();
  const after = repo.getDaemonById(daemonId)!;
  if (change === "heartbeat") expect(after).toMatchObject({ status: "online", stopIntent: null, lastHeartbeatAt: old.lastHeartbeatAt });
  else expect(after.stopIntent).toBe("newer-intent");
  vi.useRealTimers();
}, 120_000);


linuxIt("refuses recovery of an old intent while a new owner is starting", async () => {
  await startOwner();
  const oldRef = (await detail()).stopIntentRef;
  await exitOwner();
  await startOwner("reserve");
  const newRef = (await detail()).stopIntentRef;
  expect(newRef).toEqual(expect.any(String));
  expect(newRef).not.toBe(oldRef);
  expect((await recover(oldRef)).statusCode).toBe(409);
  expect((await recover(newRef)).statusCode).toBe(409);
  expect(await detail()).toMatchObject({ status: "unknown", stopIntentRef: newRef });
  await exitOwner();
  expect((await recover(newRef)).statusCode).toBe(200);
  expect((await detail()).status).toBe("offline");
}, 120_000);

linuxIt("does not recover an older intent after an independent Start", async () => {
  await startOwner();
  const oldRef = (await detail()).stopIntentRef;
  await exitOwner();
  await startOwner("start");
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-28T00:00:00.000Z"));
  expect((await detail()).status).toBe("online");
  expect((await recover(oldRef)).statusCode).toBe(409);
  expect((await detail()).status).toBe("online");
}, 120_000);

linuxIt("rechecks a newly committed active session inside the recovery transaction", async () => {
  await startOwner();
  const before = await detail();
  const ownerPid = owner!.pid!;
  await exitOwner();
  const agent = agentRepo.createAgent({ name: "late", type: "claude-code", domain: "fullstack", capabilities: [] });
  const habitat = habitatRepo.createHabitat({ name: "late" });
  const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0 });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: column.id, title: "Mission", createdBy: "admin" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", createdBy: "admin" });
  const realKill = process.kill.bind(process);
  let sessionId = "";
  const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    try { return realKill(pid, signal); }
    catch (error) {
      if (pid === ownerPid && (error as NodeJS.ErrnoException).code === "ESRCH") {
        sessionId = repo.createDaemonSession({ daemonId, agentId: agent.agent.id, taskId: task.id, habitatId: habitat.id, workdir: "/synthetic" }).id;
      }
      throw error;
    }
  }) as typeof process.kill);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  kill.mockRestore();
  expect(sessionId).not.toBe("");
  expect(repo.getSessionById(sessionId)).toMatchObject({ status: "starting", pid: null });
  expect(await detail()).toMatchObject({ status: "unknown", stopIntentRef: before.stopIntentRef });
}, 120_000);


linuxIt("does not overwrite an independent same-tick Start that races recovery", async () => {
  await startOwner();
  const before = await detail();
  const old = repo.getDaemonById(daemonId)!;
  const ownerPid = owner!.pid!;
  await exitOwner();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(old.lastHeartbeatAt!));
  const realKill = process.kill.bind(process);
  let startExit: number | null | undefined;
  const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    try { return realKill(pid, signal); }
    catch (error) {
      if (pid === ownerPid && (error as NodeJS.ErrnoException).code === "ESRCH" && startExit === undefined) {
        const result = spawnSync(process.execPath, ["--import", "tsx", join(import.meta.dirname, "fixtures", "daemon-stop-reader.ts"), path, daemonId, "start"], { encoding: "utf8", timeout: 30000 });
        startExit = result.status;
      }
      throw error;
    }
  }) as typeof process.kill);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  kill.mockRestore();
  expect(startExit).toBe(0);
  expect(repo.getDaemonById(daemonId)).toMatchObject({ status: "online", stopIntent: null, lastHeartbeatAt: old.lastHeartbeatAt });
  vi.useRealTimers();
}, 120_000);

it("keeps legacy-schema recovery unavailable without disrupting reads or heartbeats", async () => {
  getDb().run(sql.raw("ALTER TABLE daemon_instances DROP COLUMN stop_intent"));
  expect((await detail()).status).toBe("online");
  expect((await recover("00000000-0000-4000-8000-000000000000")).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url: "/api/daemon/heartbeat", headers: { "x-daemon-token": "synthetic-daemon" }, payload: {} })).statusCode).toBe(200);
  expect((await detail()).status).toBe("online");
}, 120_000);

linuxIt("refuses recovery when the verifying platform is unsupported", async () => {
  await startOwner();
  const before = await detail();
  await exitOwner();
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    Object.defineProperty(process, "platform", { ...original, value: "darwin" });
    expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
    expect(await detail()).toMatchObject({ status: "unknown", stopIntentRef: before.stopIntentRef });
  } finally {
    Object.defineProperty(process, "platform", original);
  }
}, 120_000);


it("creates an ownerless intent on unsupported platforms and keeps it unrecoverable", async () => {
  const original = Object.getOwnPropertyDescriptor(process, "platform")!;
  let intent: string;
  try {
    Object.defineProperty(process, "platform", { ...original, value: "darwin" });
    intent = createDaemonStopIntent();
  } finally {
    Object.defineProperty(process, "platform", original);
  }
  repo.beginDaemonStop(daemonId, intent!);
  expect(await detail()).toMatchObject({ status: "unknown", stopIntentRef: null });
  expect((await recover("00000000-0000-4000-8000-000000000000")).statusCode).toBe(409);
  expect(repo.getDaemonById(daemonId)?.stopIntent).toBe(intent!);
}, 120_000);

linuxIt("refuses a contradictory absent-PID signal while the owner is visible in proc", async () => {
  await startOwner();
  const before = await detail();
  const ownerPid = owner!.pid!;
  const realKill = process.kill.bind(process);
  const kill = vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
    if (pid === ownerPid && signal === 0) throw Object.assign(new Error("contradictory"), { code: "ESRCH" });
    return realKill(pid, signal);
  }) as typeof process.kill);
  expect((await recover(before.stopIntentRef)).statusCode).toBe(409);
  kill.mockRestore();
  expect(await detail()).toMatchObject({ status: "unknown", stopIntentRef: before.stopIntentRef });
}, 120_000);


linuxIt("keeps a non-UI daemon row ownerless even if an embedded engine stopped it", async () => {
  await startOwner("external");
  expect((await detail()).status).toBe("unknown");
  await exitOwner();
  const after = await detail();
  expect(after.stopIntentRef).toBeNull();
  expect((await recover("00000000-0000-4000-8000-000000000000")).statusCode).toBe(409);
  expect((await detail()).status).toBe("unknown");
  expect((await app.inject({ method: "POST", url: "/api/daemon/heartbeat", headers: { "x-daemon-token": "synthetic-daemon" }, payload: {} })).statusCode).toBe(200);
}, 120_000);


it("does not mistake a standalone registration's self-reported version for UI provenance", async () => {
  const habitat = habitatRepo.createHabitat({ name: "standalone habitat" });
  const registration = await app.inject({ method: "POST", url: "/api/daemon/register", headers: { "x-registration-token": "synthetic-registration" }, payload: {
    name: "standalone", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process",
    detectedClis: [{ type: "claude-code", path: "/synthetic" }], habitatIds: [habitat.id],
  } });
  expect(registration.statusCode).toBe(201);
  const registered = registration.json();
  expect((await app.inject({ method: "POST", url: `/api/daemons/${registered.daemonId}/start`, headers: admin() })).statusCode).toBe(409);
  expect((await app.inject({ method: "POST", url: "/api/daemon/heartbeat", headers: { "x-daemon-token": registered.daemonToken }, payload: {} })).statusCode).toBe(200);
  const result = await app.inject({ method: "GET", url: `/api/daemons/${registered.daemonId}`, headers: admin() });
  expect(result.json().daemon).toMatchObject({ status: "online", stopIntentRef: null });
}, 120_000);
