import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyRequest } from "fastify";

vi.mock("../middleware/auth.js", () => ({
  humanAuth: async (request: any) => { request.user = { id: "test", role: "admin" }; },
  agentAuth: async () => {}, agentOrHumanAuth: async () => {}, registrationAuth: async () => {},
}));

const wiring = vi.hoisted(() => ({
  shutdownAll: vi.fn(async () => {}),
  release: vi.fn(),
  timeoutStart: vi.fn(),
  poll: vi.fn(() => []),
}));
vi.mock("../daemon-wiring.js", () => ({
  getSessionManager: () => ({ get activeSessions() { return wiring.poll(); }, startTimeoutCheck: wiring.timeoutStart, shutdownAll: wiring.shutdownAll }),
  getClaimStrategy: () => ({}),
  releaseSessionManager: wiring.release,
  detectClisOnHost: () => [],
}));

import { initTestDb, closeDb } from "../db/index.js";
import * as repo from "../repositories/daemon.js";
import * as engine from "../services/daemonEngine.js";
import { daemonAdminRoutes, daemonRoutes } from "../routes/daemon.js";

let app: ReturnType<typeof Fastify>;
let id: string;
let externalId: string;

beforeEach(async () => {
  await initTestDb();
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-11-28T00:00:00.000Z"));
  wiring.shutdownAll.mockReset().mockResolvedValue(undefined);
  wiring.release.mockClear();
  wiring.timeoutStart.mockClear();
  wiring.poll.mockClear();
  id = repo.createDaemon({ name: "embedded", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "embedded" }).id;
  externalId = repo.createDaemon({ name: "external", hostname: "test", maxConcurrent: 1, daemonVersion: "external", plainToken: "external" }).id;
  app = Fastify();
  app.addHook("onRequest", async (request: FastifyRequest) => { request.user = { id: "test", role: "admin" } as any; });
  await app.register(daemonAdminRoutes);
  await app.register(daemonRoutes);
  await app.ready();
  engine.start(id);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await engine.shutdownAll();
  await app.close();
  vi.useRealTimers();
  await closeDb();
});

async function statuses() {
  const list = (await app.inject({ method: "GET", url: "/daemons" })).json().daemons;
  const detail = (await app.inject({ method: "GET", url: `/daemons/${id}` })).json().daemon;
  return { embedded: list.find((d: any) => d.id === id).status, external: list.find((d: any) => d.id === externalId).status, detail: detail.status };
}

describe("in-process Stop status", () => {
  it("serves offline immediately with a retained fresh heartbeat, preserving external discovery and restart", async () => {
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
    const heartbeat = repo.getDaemonById(id)!.lastHeartbeatAt;
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(200);
    expect(repo.getDaemonById(id)).toMatchObject({ status: "offline", lastHeartbeatAt: heartbeat });
    expect(engine.isRunning(id)).toBe(false);
    expect(wiring.shutdownAll).toHaveBeenCalledOnce();
    expect(wiring.release).toHaveBeenCalledWith(id);
    expect(await statuses()).toEqual({ embedded: "offline", external: "online", detail: "offline" });
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/start` })).statusCode).toBe(200);
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
  });

  it("keeps the engine online when session shutdown fails", async () => {
    wiring.shutdownAll.mockRejectedValueOnce(new Error("shutdown failed"));
    const response = await app.inject({ method: "POST", url: `/daemons/${id}/stop` });
    expect(response.statusCode).toBe(500);
    expect(repo.getDaemonById(id)!.status).toBe("online");
    expect(engine.isRunning(id)).toBe(true);
    expect(wiring.release).not.toHaveBeenCalled();
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
    expect(wiring.timeoutStart).toHaveBeenCalledTimes(2);
    wiring.poll.mockClear();
    await vi.advanceTimersByTimeAsync(30000);
    expect(wiring.poll).toHaveBeenCalled();
    expect(repo.getDaemonById(id)!.lastHeartbeatAt).toBe(new Date().toISOString());
  });

  it("preserves the shutdown error if restoring the status also fails", async () => {
    const setStatus = repo.setDaemonStatus;
    const spy = vi.spyOn(repo, "setDaemonStatus").mockImplementation((daemonId, status) => {
      if (status === "online") throw new Error("restore failed");
      return setStatus(daemonId, status);
    });
    wiring.shutdownAll.mockRejectedValueOnce(new Error("shutdown failed"));
    await expect(engine.stop(id)).rejects.toThrow("shutdown failed");
    expect(wiring.timeoutStart).toHaveBeenCalledTimes(2);
    spy.mockRestore();
  });

  it("still drains sessions when the offline marker write fails", async () => {
    const spy = vi.spyOn(repo, "setDaemonStatus").mockImplementationOnce(() => { throw new Error("write failed"); });
    const response = await app.inject({ method: "POST", url: `/daemons/${id}/stop` });
    expect(response.statusCode).toBe(500);
    expect(wiring.shutdownAll).toHaveBeenCalledOnce();
    expect(wiring.release).toHaveBeenCalledWith(id);
    expect(engine.isRunning(id)).toBe(false);
    spy.mockRestore();
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(200);
    expect(wiring.shutdownAll).toHaveBeenCalledOnce();
    expect(repo.getDaemonById(id)!.status).toBe("offline");
    expect(await statuses()).toEqual({ embedded: "offline", external: "online", detail: "offline" });
    const heartbeat = await app.inject({ method: "POST", url: "/daemon/heartbeat", headers: { "x-daemon-token": "embedded" }, payload: {} });
    expect(heartbeat.statusCode).toBe(200);
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
  });

  it("keeps the retry pending after another failed write", async () => {
    const spy = vi.spyOn(repo, "setDaemonStatus").mockImplementationOnce(() => { throw new Error("first failure"); }).mockImplementationOnce(() => { throw new Error("retry failure"); });
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(500);
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(500);
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(200);
    expect(wiring.shutdownAll).toHaveBeenCalledOnce();
    expect(await statuses()).toEqual({ embedded: "offline", external: "online", detail: "offline" });
    spy.mockRestore();
  });

  it("preserves a same-millisecond heartbeat received before a failed-write retry", async () => {
    const spy = vi.spyOn(repo, "setDaemonStatus").mockImplementationOnce(() => { throw new Error("write failed"); });
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(500);
    spy.mockRestore();
    const heartbeat = await app.inject({ method: "POST", url: "/daemon/heartbeat", headers: { "x-daemon-token": "embedded" }, payload: {} });
    expect(heartbeat.statusCode).toBe(200);
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(200);
    expect(wiring.shutdownAll).toHaveBeenCalledOnce();
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
  });

  it("preserves a heartbeat during a failed-marker drain before a Stop retry", async () => {
    const spy = vi.spyOn(repo, "setDaemonStatus").mockImplementationOnce(() => { throw new Error("write failed"); });
    let finish!: () => void;
    wiring.shutdownAll.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stopping = app.inject({ method: "POST", url: `/daemons/${id}/stop` }).then((response: any) => response);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect((await app.inject({ method: "POST", url: "/daemon/heartbeat", headers: { "x-daemon-token": "embedded" }, payload: {} })).statusCode).toBe(200);
    finish();
    expect((await stopping).statusCode).toBe(500);
    spy.mockRestore();
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(200);
    expect(wiring.shutdownAll).toHaveBeenCalledOnce();
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
  });

  it("permits restarting after a failed offline write", async () => {
    const spy = vi.spyOn(repo, "setDaemonStatus").mockImplementationOnce(() => { throw new Error("write failed"); });
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/stop` })).statusCode).toBe(500);
    spy.mockRestore();
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/start` })).statusCode).toBe(200);
    expect(engine.isRunning(id)).toBe(true);
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
  });

  it("does not erase a heartbeat arriving while shutdown is pending, even in the same millisecond", async () => {
    let finish!: () => void;
    wiring.shutdownAll.mockImplementationOnce(() => new Promise<void>((resolve) => { finish = resolve; }));
    const stopping = app.inject({ method: "POST", url: `/daemons/${id}/stop` }).then((response: any) => response);
    await vi.waitFor(() => expect(finish).toBeDefined());
    expect(await statuses()).toEqual({ embedded: "offline", external: "online", detail: "offline" });
    expect((await app.inject({ method: "POST", url: `/daemons/${id}/start` })).statusCode).toBe(409);
    const heartbeat = await app.inject({ method: "POST", url: "/daemon/heartbeat", headers: { "x-daemon-token": "embedded" }, payload: {} });
    expect(heartbeat.statusCode).toBe(200);
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
    expect(engine.isRunning(id)).toBe(true);
    let secondSettled = false;
    const second = engine.stop(id).then(() => { secondSettled = true; });
    await Promise.resolve();
    expect(secondSettled).toBe(false);
    expect(wiring.shutdownAll).toHaveBeenCalledTimes(1);
    finish();
    await second;
    expect((await stopping).statusCode).toBe(200);
    expect(repo.getDaemonById(id)!.status).toBe("online");
    expect(await statuses()).toEqual({ embedded: "online", external: "online", detail: "online" });
  });
});
