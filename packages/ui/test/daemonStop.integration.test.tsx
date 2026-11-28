import React from "react";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Fastify } from "../../api/src/test/fastifyTestFactory.js";

vi.mock("../../api/src/middleware/auth.js", () => ({
  humanAuth: async (request: any) => { request.user = { id: "test", role: "admin" }; },
  agentAuth: async () => {}, agentOrHumanAuth: async () => {}, registrationAuth: async () => {},
}));
vi.mock("../../api/src/daemon-wiring.js", () => ({
  getSessionManager: () => ({ activeSessions: [], startTimeoutCheck() {}, shutdownAll: async () => {} }),
  getClaimStrategy: () => ({}), releaseSessionManager: () => {}, detectClisOnHost: () => [],
}));

import { initTestDb, closeDb } from "../../api/src/db/index.js";
import * as repo from "../../api/src/repositories/daemon.js";
import * as engine from "../../api/src/services/daemonEngine.js";
import { daemonAdminRoutes } from "../../api/src/routes/daemon.js";
import { DaemonSection } from "../src/components/habitat/DaemonSection.js";

let app: ReturnType<typeof Fastify>;
afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  await engine.shutdownAll();
  await app?.close();
  await closeDb();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("renders the served offline status after an operator stops the running engine", async () => {
  await initTestDb();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-28T00:00:00.000Z"));
  const daemon = repo.createDaemon({ name: "mounted", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic" });
  engine.start(daemon.id);
  app = Fastify();
  await app.register(daemonAdminRoutes);
  await app.ready();
  const requests: string[] = [];
  vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
    requests.push(`${options.method ?? "GET"} ${url}`);
    const response = await app.inject({ method: (options.method ?? "GET") as "GET" | "POST", url: url.replace(/^\/api/, "") });
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DaemonSection /></QueryClientProvider>);
  expect(await screen.findByText("Online")).toBeTruthy();
  const heartbeat = repo.getDaemonById(daemon.id)!.lastHeartbeatAt;
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Offline")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  expect(repo.getDaemonById(daemon.id)!.lastHeartbeatAt).toBe(heartbeat);
  expect(requests.filter((request) => request === "GET /api/daemons").length).toBeGreaterThanOrEqual(2);
  expect(requests).toContain(`POST /api/daemons/${daemon.id}/stop`);
  await waitFor(() => expect(engine.isRunning(daemon.id)).toBe(false));
  client.clear();
});

it("shows Unknown when a persisted stop intent has no proven outcome", async () => {
  await initTestDb();
  const daemon = repo.createDaemon({ name: "uncertain", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic" });
  repo.beginDaemonStop(daemon.id, "pending-stop");
  app = Fastify();
  await app.register(daemonAdminRoutes);
  await app.ready();
  let retryStatus: number | undefined;
  vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
    const response = await app.inject({ method: (options.method ?? "GET") as "GET" | "POST", url: url.replace(/^\/api/, "") });
    if (options.method === "POST") retryStatus = response.statusCode;
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, statusText: response.statusMessage, json: async () => response.json() };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DaemonSection /></QueryClientProvider>);
  expect(await screen.findByText("Unknown")).toBeTruthy();
  expect(screen.queryByText("Offline")).toBeNull();
  expect(screen.queryByRole("button", { name: "Recover" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Retry Stop" }));
  await waitFor(() => expect(retryStatus).toBe(409));
  expect(screen.getByText("Unknown")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start" })).toBeTruthy();
  client.clear();
});


it("offers a Stop retry after a failed final write and refreshes its served status", async () => {
  await initTestDb();
  const daemon = repo.createDaemon({ name: "retry", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic" });
  engine.start(daemon.id);
  const spy = vi.spyOn(repo, "completeDaemonStop").mockImplementationOnce(() => { throw new Error("synthetic write failure"); });
  app = Fastify();
  await app.register(daemonAdminRoutes);
  await app.ready();
  vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
    const response = await app.inject({ method: (options.method ?? "GET") as "GET" | "POST", url: url.replace(/^\/api/, "") });
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, statusText: response.statusMessage, json: async () => response.json() };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DaemonSection /></QueryClientProvider>);
  expect(await screen.findByText("Online")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Stop" }));
  expect(await screen.findByText("Unknown")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Retry Stop" }));
  expect(await screen.findByText("Offline")).toBeTruthy();
  expect(spy).toHaveBeenCalledTimes(2);
  client.clear();
});

it.each([
  { action: "Retry Stop", pending: "Stopping...", other: "Start" },
  { action: "Start", pending: "Starting...", other: "Retry Stop" },
])("shows $pending only for the pending $action request", async ({ action, pending, other }) => {
  await initTestDb();
  const daemon = repo.createDaemon({ name: "pending", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic" });
  repo.beginDaemonStop(daemon.id, "pending-stop");
  app = Fastify();
  await app.register(daemonAdminRoutes);
  await app.ready();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
    if (options.method === "POST") {
      await gate;
      return { ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "not available" }) };
    }
    const response = await app.inject({ method: "GET", url: url.replace(/^\/api/, "") });
    return { ok: true, status: response.statusCode, json: async () => response.json() };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DaemonSection /></QueryClientProvider>);
  expect(await screen.findByText("Unknown")).toBeTruthy();
  try {
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByRole("button", { name: pending })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: other })).toHaveProperty("disabled", true);
  } finally {
    release();
    client.clear();
  }
});

it.each([
  { action: "Start", pending: "Starting...", nextStatus: "Online" },
  { action: "Retry Stop", pending: "Stopping...", nextStatus: "Offline" },
])("keeps $pending visible if status changes to $nextStatus", async ({ action, pending, nextStatus }) => {
  await initTestDb();
  const daemon = repo.createDaemon({ name: "refresh", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic" });
  repo.beginDaemonStop(daemon.id, "pending-stop");
  app = Fastify();
  await app.register(daemonAdminRoutes);
  await app.ready();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
    if (options.method === "POST") {
      await gate;
      return { ok: false, status: 409, statusText: "Conflict", json: async () => ({ error: "not available" }) };
    }
    const response = await app.inject({ method: "GET", url: url.replace(/^\/api/, "") });
    return { ok: true, status: response.statusCode, json: async () => response.json() };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DaemonSection /></QueryClientProvider>);
  expect(await screen.findByText("Unknown")).toBeTruthy();
  try {
    fireEvent.click(screen.getByRole("button", { name: action }));
    expect(await screen.findByRole("button", { name: pending })).toHaveProperty("disabled", true);
    if (nextStatus === "Online") repo.updateDaemonHeartbeat(daemon.id);
    else repo.completeDaemonStop(daemon.id, "pending-stop", "offline");
    await client.invalidateQueries();
    expect(await screen.findByText(nextStatus)).toBeTruthy();
    expect(screen.getByRole("button", { name: pending })).toHaveProperty("disabled", true);
  } finally {
    release();
    client.clear();
  }
});


it.runIf(process.platform === "linux")("recovers a proven terminated owner from the mounted operator control", async () => {
  await initTestDb();
  const daemon = repo.createDaemon({ name: "recoverable", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic" });
  const moduleUrl = pathToFileURL(resolve(process.cwd(), "../api/src/services/daemonOwnerWitness.ts")).href;
  const script = `import { createDaemonStopIntent } from ${JSON.stringify(moduleUrl)}; process.stdout.write(createDaemonStopIntent());`;
  const intent = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8" });
  repo.beginDaemonStop(daemon.id, intent);
  app = Fastify();
  await app.register(daemonAdminRoutes);
  await app.ready();
  let payload: string | undefined;
  vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
    if (url.endsWith("/recover")) payload = String(options.body);
    const response = await app.inject({ method: (options.method ?? "GET") as "GET" | "POST", url: url.replace(/^\/api/, ""), headers: options.headers as Record<string, string>, payload: options.body as string | undefined });
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, statusText: response.statusMessage, json: async () => response.json() };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DaemonSection /></QueryClientProvider>);
  expect(await screen.findByText("Unknown")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Recover" }));
  expect(await screen.findByText("Offline")).toBeTruthy();
  expect(JSON.parse(payload!).expectedIntent).toEqual(expect.any(String));
  expect(repo.getDaemonById(daemon.id)?.stopIntent).toBeNull();
  client.clear();
});


it.runIf(process.platform === "linux")("keeps the Recover action pending through a status refresh", async () => {
  await initTestDb();
  const daemon = repo.createDaemon({ name: "recover-pending", hostname: "test", maxConcurrent: 1, daemonVersion: "in-process", plainToken: "synthetic" });
  const moduleUrl = pathToFileURL(resolve(process.cwd(), "../api/src/services/daemonOwnerWitness.ts")).href;
  const script = `import { createDaemonStopIntent } from ${JSON.stringify(moduleUrl)}; process.stdout.write(createDaemonStopIntent());`;
  const intent = execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], { encoding: "utf8" });
  repo.beginDaemonStop(daemon.id, intent);
  app = Fastify();
  await app.register(daemonAdminRoutes);
  await app.ready();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  vi.stubGlobal("fetch", async (url: string, options: RequestInit = {}) => {
    if (options.method === "POST") { await gate; return { ok: false, status: 409, json: async () => ({ error: "changed" }) }; }
    const response = await app.inject({ method: "GET", url: url.replace(/^\/api/, "") });
    return { ok: true, status: response.statusCode, json: async () => response.json() };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DaemonSection /></QueryClientProvider>);
  expect(await screen.findByText("Unknown")).toBeTruthy();
  try {
    fireEvent.click(screen.getByRole("button", { name: "Recover" }));
    expect(await screen.findByRole("button", { name: "Recovering..." })).toHaveProperty("disabled", true);
    repo.updateDaemonHeartbeat(daemon.id);
    await client.invalidateQueries();
    expect(await screen.findByText("Online")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Recovering..." })).toHaveProperty("disabled", true);
  } finally {
    release();
    client.clear();
  }
});
