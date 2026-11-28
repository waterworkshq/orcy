import React from "react";
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
  vi.stubGlobal("fetch", async (url: string) => {
    const response = await app.inject({ method: "GET", url: url.replace(/^\/api/, "") });
    return { ok: response.statusCode >= 200 && response.statusCode < 300, status: response.statusCode, json: async () => response.json() };
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><DaemonSection /></QueryClientProvider>);
  expect(await screen.findByText("Unknown")).toBeTruthy();
  expect(screen.queryByText("Offline")).toBeNull();
  client.clear();
});
