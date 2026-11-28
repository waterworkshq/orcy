/**
 * Issue #312 — the mounted Automation Settings Simulate action must reach the
 * human simulation handler.
 *
 * This is a CROSSING test, not a mocked one. The mounted `AutomationTab` uses
 * the production API client (`packages/ui/src/api/transport.ts`), so the
 * request body it puts on the wire is the production serialization. That body
 * is delivered to a REAL Fastify instance serving the REAL
 * `automationRules` route — real Zod schema, real auth-policy guard, real
 * repositories, real (test) database — over a real HTTP socket with a real
 * human JWT. Only the URL origin is supplied by the test (the browser's base
 * URL); the transport, the client, the route and the schema are all the
 * shipped ones.
 *
 * The @orcy/api sources are loaded by RUNTIME-COMPUTED dynamic import on
 * purpose: a static import would pull api sources into the ui tsc program and
 * trip the package's rootDir fence (TS6059) — the same technique
 * `packages/api/src/test/agentMessageSuggestRequestKeyWire.test.ts` uses to
 * reach @orcy/mcp sources. The specifier is unresolvable at compile time, so
 * the ui program stays clean while vitest still loads and runs the REAL
 * served modules.
 */
import React from "react";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AutomationTab } from "./AutomationTab.js";

const HUMAN_ID = "automation-simulate-human";

/** The workspace root — the directory that owns pnpm-workspace.yaml. */
function findWorkspaceRoot(start: string): string {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("workspace root not found");
    dir = parent;
  }
}

const WORKSPACE_ROOT = findWorkspaceRoot(dirname(fileURLToPath(import.meta.url)));
const API_SRC = join(WORKSPACE_ROOT, "packages", "api", "src");
const requireFromApi = createRequire(join(WORKSPACE_ROOT, "packages", "api", "package.json"));

const apiModule = async <T = any>(rel: string): Promise<T> =>
  (await import(/* @vite-ignore */ pathToFileURL(join(API_SRC, rel)).href)) as T;

type FastifyInstance = any;

let app: FastifyInstance;
let closeDb: () => void;
let initTestDb: () => Promise<unknown>;
let habitatRepo: any;
let ruleRepo: any;
let runRepo: any;
let pulseRepo: any;
let baseUrl = "";
let jwt: any;
let signingKey = "";
let fetchHook: ((input: any, init: any) => Promise<Response>) | null = null;

/** Every request the production transport put on the wire. */
const wire: Array<{ method: string; path: string; body: unknown }> = [];

const originalFetch = globalThis.fetch;

beforeAll(async () => {
  signingKey = randomBytes(32).toString("hex");
  process.env.JWT_SECRET = signingKey;

  const Fastify = requireFromApi("fastify");
  jwt = requireFromApi("jsonwebtoken");

  const { setJwtSecret } = await apiModule<any>("middleware/jwt-verification.ts");
  setJwtSecret(signingKey);
  const { automationRoutes } = await apiModule<any>("routes/automationRules.ts");
  const { registerErrorHandler } = await apiModule<any>("errors/plugin.ts");
  const db = await apiModule<any>("db/index.ts");
  initTestDb = db.initTestDb;
  closeDb = db.closeDb;
  habitatRepo = await apiModule<any>("repositories/habitat.ts");
  ruleRepo = await apiModule<any>("repositories/automationRule.ts");
  runRepo = await apiModule<any>("repositories/automationRuleRun.ts");
  pulseRepo = await apiModule<any>("repositories/pulse.ts");

  app = Fastify({ logger: false });
  await registerErrorHandler(app);
  await app.register(automationRoutes, { prefix: "/api" });
  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

  // The browser's base URL is the only thing the test supplies: the request
  // body, headers and auth token all come from the production transport.
  globalThis.fetch = (async (input: any, init: any) => {
    const url = new URL(typeof input === "string" ? input : input.url, baseUrl);
    wire.push({
      method: init?.method ?? "GET",
      path: url.pathname,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (fetchHook) {
      return fetchHook(url, init);
    }
    return originalFetch(url, init);
  }) as typeof fetch;
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await app?.close();
  closeDb?.();
});

beforeEach(async () => {
  await initTestDb();
  wire.length = 0;
  fetchHook = null;
  localStorage.clear();
});

afterEach(() => {
  cleanup();
});

/** A personal habitat (no team) — any authenticated human may access it. */
function seedHabitat(name = "Simulate Habitat") {
  return habitatRepo.createHabitat({ name });
}

function seedRule(
  habitatId: string,
  overrides?: {
    name?: string;
    condition?: Record<string, unknown>;
  },
) {
  return ruleRepo.createAutomationRule({
    habitatId,
    name: overrides?.name ?? "Simulate Rule",
    priority: 0,
    trigger: { type: "event", eventType: "task.rejected" },
    condition: overrides?.condition ?? { type: "always" },
    actions: [{ type: "create_signal", content: "simulated pulse" }],
    cooldownSeconds: 0,
    maxRunsPerHour: 100,
    enabled: true,
    createdBy: "test",
  });
}

function humanToken(): string {
  return jwt.sign({ sub: HUMAN_ID, username: HUMAN_ID, role: "admin" }, signingKey, {
    issuer: "orcy",
  });
}

function renderTab(habitatId: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AutomationTab habitatId={habitatId} boardAutomationSettings={{ executeActions: true }} />
    </QueryClientProvider>,
  );
}

describe("AutomationTab simulate against the served human simulation route", () => {
  it("simulates the default context and renders the returned simulation result", async () => {
    const habitat = seedHabitat();
    const rule = seedRule(habitat.id);
    localStorage.setItem("orcy_token", humanToken());

    renderTab(habitat.id);

    const simButton = await screen.findByTitle("Simulate");
    simButton.click();

    const result = await screen.findByTestId("automation-simulation-result");
    await waitFor(() => {
      expect(result.textContent).toContain('"wouldExecute": true');
      expect(result.textContent).toContain('"ruleName": "Simulate Rule"');
      expect(result.textContent).toContain("simulated pulse");
    });

    const simulateCall = wire.find((r) => r.path.endsWith(`/automation-rules/${rule.id}/simulate`));
    expect(simulateCall).toBeDefined();
    // The default simulation carries NO trigger-event id: the served schema
    // accepts an omitted string, never an explicit null.
    expect(simulateCall?.body).not.toHaveProperty("triggerEventId");
    expect(simulateCall?.body).toEqual({});

    // Simulation is a dry run: no action ran and nothing was persisted.
    expect(pulseRepo.getPulsesByHabitat(habitat.id, { limit: 100, offset: 0 }).total).toBe(0);
    expect(runRepo.listRunsByRule(rule.id, { limit: 100, offset: 0 }).total).toBe(0);
  });

  it("renders non-matching simulation results without executing actions and clears stale output on auth failure", async () => {
    const habitat = seedHabitat();
    const rule = seedRule(habitat.id, {
      name: "Conditional Rule",
      condition: { type: "priority_above", threshold: "high" },
    });
    localStorage.setItem("orcy_token", humanToken());

    renderTab(habitat.id);

    const simButton = await screen.findByTitle("Simulate");
    simButton.click();

    const result = await screen.findByTestId("automation-simulation-result");
    await waitFor(() => {
      expect(result.textContent).toContain('"wouldExecute": false');
      expect(result.textContent).toContain('"skipReason": "condition_false"');
    });

    // Clear auth after initial list+simulate so the next click hits the real 401 handler.
    localStorage.removeItem("orcy_token");
    simButton.click();

    await waitFor(() => {
      expect(screen.queryByTestId("automation-simulation-result")).toBeNull();
    });

    expect(pulseRepo.getPulsesByHabitat(habitat.id, { limit: 100, offset: 0 }).total).toBe(0);
    expect(runRepo.listRunsByRule(rule.id, { limit: 100, offset: 0 }).total).toBe(0);
  });

  it("ignores stale simulation failures that settle after a newer successful simulation", async () => {
    const habitat = seedHabitat();
    const rule = seedRule(habitat.id);
    localStorage.setItem("orcy_token", humanToken());

    let releaseFirstFailure!: () => void;
    const firstFailureGate = new Promise<void>((resolve) => {
      releaseFirstFailure = resolve;
    });
    let markFirstFailureHeld!: () => void;
    const firstFailureHeld = new Promise<void>((resolve) => {
      markFirstFailureHeld = resolve;
    });
    let firstSimulateSeen = false;
    fetchHook = async (url, init) => {
      if (url.pathname.endsWith(`/automation-rules/${rule.id}/simulate`) && !firstSimulateSeen) {
        firstSimulateSeen = true;
        const failedResponse = await originalFetch(url, {
          ...init,
          headers: { ...(init?.headers as Record<string, string>), authorization: "" },
        });
        markFirstFailureHeld();
        await firstFailureGate;
        return failedResponse;
      }
      return originalFetch(url, init);
    };

    renderTab(habitat.id);

    const simButton = await screen.findByTitle("Simulate");
    simButton.click();
    await firstFailureHeld;

    // Second request settles first and succeeds; the earlier 401 failure settles afterward.
    simButton.click();
    const result = await screen.findByTestId("automation-simulation-result");
    await waitFor(() => expect(result.textContent).toContain('"wouldExecute": true'));

    releaseFirstFailure();
    await new Promise((resolve) => setTimeout(resolve, 25));

    expect(screen.getByTestId("automation-simulation-result").textContent).toContain(
      '"wouldExecute": true',
    );
  });

  it("keeps accepting an explicit valid trigger event while rejecting null, typed-invalid, and unauthenticated requests", async () => {
    const habitat = seedHabitat();
    const rule = seedRule(habitat.id);
    const token = humanToken();

    const explicit = await originalFetch(
      `${baseUrl}/api/automation-rules/${rule.id}/simulate`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ triggerEventId: "evt-1" }),
      },
    );
    expect(explicit.status).toBe(200);
    const explicitBody = await explicit.json();
    expect(explicitBody.wouldExecute).toBe(true);
    expect(explicitBody.ruleId).toBe(rule.id);
    expect(explicitBody.actionPreviews).toHaveLength(1);
    expect(explicitBody.context.habitat.id).toBe(habitat.id);
    expect(pulseRepo.getPulsesByHabitat(habitat.id, { limit: 100, offset: 0 }).total).toBe(0);
    expect(runRepo.listRunsByRule(rule.id, { limit: 100, offset: 0 }).total).toBe(0);

    // Explicit null must still fail schema validation — the route contract was not widened.
    const explicitNull = await originalFetch(
      `${baseUrl}/api/automation-rules/${rule.id}/simulate`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ triggerEventId: null }),
      },
    );
    expect(explicitNull.status).toBe(400);
    const explicitNullBody = await explicitNull.json();
    expect(explicitNullBody.code).toBe("VALIDATION_ERROR");
    expect(explicitNullBody.details.fieldErrors.triggerEventId).toEqual([
      "Invalid input: expected string, received null",
    ]);

    const invalid = await originalFetch(
      `${baseUrl}/api/automation-rules/${rule.id}/simulate`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ triggerEventId: 42 }),
      },
    );
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json();
    expect(invalidBody.code).toBe("VALIDATION_ERROR");
    expect(invalidBody.details.fieldErrors.triggerEventId).toEqual([
      "Invalid input: expected string, received number",
    ]);

    // Human authorization is unchanged: no credential, no simulation.
    const unauthenticated = await originalFetch(
      `${baseUrl}/api/automation-rules/${rule.id}/simulate`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    expect(unauthenticated.status).toBe(401);
  });
});
