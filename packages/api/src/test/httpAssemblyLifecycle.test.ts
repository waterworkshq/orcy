/**
 * Staged assembly lifecycle (ADR-0049) — the smallest harness that proves the
 * one-way state machine before anything rewires through it.
 *
 *   core_registered → plugins_installed → ready → closed
 *
 * Plugin catalog installation is exactly once and required before
 * finalization (an explicitly empty validated catalog installs too);
 * repeated, skipped, or late installation and repeated or late finalization
 * are boot errors surfaced as `HttpAssemblyLifecycleError`. The executable's
 * bounded surface (listen/inject before readiness, inventory before
 * readiness) rejects out-of-order use the same way.
 *
 * No database is initialized: the probes here exercise lifecycle guards,
 * anonymous 401s, /health, and header staging only — DB-backed behavior is
 * pinned by the characterization and policy suites.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import {
  createHttpApplication,
  HttpAssemblyLifecycleError,
  type HttpRuntimeHandle,
} from "../httpApp.js";

/** Deterministic API-only mode: no UI directory exists. */
let noUiDir: string;
let priorUiPath: string | undefined;

beforeAll(async () => {
  priorUiPath = process.env.ORCY_UI_PATH;
  noUiDir = await mkdtemp(path.join("/tmp", "assembly-lifecycle-noui-"));
  await rm(noUiDir, { recursive: true, force: true }); // existsSync must be false
  process.env.ORCY_UI_PATH = noUiDir;
});

afterAll(() => {
  if (priorUiPath === undefined) delete process.env.ORCY_UI_PATH;
  else process.env.ORCY_UI_PATH = priorUiPath;
});

/** A fully progressed app: empty validated catalog installed, finalized. */
async function readyApp(options: Parameters<typeof createHttpApplication>[0] = {}) {
  const app = await createHttpApplication({ logger: false, ...options });
  await app.installPluginRoutes([]);
  await app.finalize();
  return app;
}

describe("HTTP assembly lifecycle", () => {
  it("progresses one way: core_registered → plugins_installed → ready → closed", async () => {
    const app = await createHttpApplication({ logger: false });
    expect(app.state).toBe("core_registered");

    await app.installPluginRoutes([]); // explicitly empty validated catalog
    expect(app.state).toBe("plugins_installed");

    await app.finalize();
    expect(app.state).toBe("ready");

    await app.close();
    expect(app.state).toBe("closed");
    await app.close(); // terminal no-op, not an error
  });

  it("rejects finalization when plugin installation was skipped", async () => {
    const app = await createHttpApplication({ logger: false });
    await expect(app.finalize()).rejects.toBeInstanceOf(HttpAssemblyLifecycleError);
    expect(app.state).toBe("core_registered");
    await app.close();
  });

  it("rejects repeated plugin installation", async () => {
    const app = await createHttpApplication({ logger: false });
    await app.installPluginRoutes([]);
    await expect(app.installPluginRoutes([])).rejects.toBeInstanceOf(HttpAssemblyLifecycleError);
    expect(app.state).toBe("plugins_installed");
    await app.close();
  });

  it("rejects late plugin installation (after finalization)", async () => {
    const app = await readyApp();
    await expect(app.installPluginRoutes([])).rejects.toBeInstanceOf(HttpAssemblyLifecycleError);
    expect(app.state).toBe("ready");
    await app.close();
  });

  it("rejects repeated finalization", async () => {
    const app = await readyApp();
    await expect(app.finalize()).rejects.toBeInstanceOf(HttpAssemblyLifecycleError);
    expect(app.state).toBe("ready");
    await app.close();
  });

  it("rejects late finalization (after close)", async () => {
    const app = await readyApp();
    await app.close();
    await expect(app.finalize()).rejects.toBeInstanceOf(HttpAssemblyLifecycleError);
    expect(app.state).toBe("closed");
  });

  it("rejects listen and inject before readiness, and everything after close", async () => {
    const booting = await createHttpApplication({ logger: false });
    await expect(booting.listen({ port: 0, host: "127.0.0.1" })).rejects.toBeInstanceOf(
      HttpAssemblyLifecycleError,
    );
    await expect(booting.inject({ method: "GET", url: "/health" })).rejects.toBeInstanceOf(
      HttpAssemblyLifecycleError,
    );
    await booting.close();

    const app = await readyApp();
    await app.close();
    await expect(app.inject({ method: "GET", url: "/health" })).rejects.toBeInstanceOf(
      HttpAssemblyLifecycleError,
    );
    expect(() => app.routeInventory()).toThrow(HttpAssemblyLifecycleError);
  });

  it("the inventory is available only once ready and reflects the served surface", async () => {
    const app = await createHttpApplication({ logger: false });
    expect(() => app.routeInventory()).toThrow(HttpAssemblyLifecycleError);
    await app.installPluginRoutes([]);
    expect(() => app.routeInventory()).toThrow(HttpAssemblyLifecycleError);
    await app.finalize();

    const inventory = app.routeInventory();
    expect(inventory.length).toBeGreaterThan(0);
    const byKey = new Map(inventory.map((e) => [`${e.method} ${e.url}`, e]));
    expect(byKey.get("GET /health")?.effectivePolicy).toBe("anonymous");
    expect(byKey.get("GET /api/v1/habitats")?.effectivePolicy).toBe("local_actor");
    // The framework CORS catch-all is present, policy-less, and normalized.
    const catchAll = byKey.get("OPTIONS *");
    expect(catchAll).toBeDefined();
    expect(catchAll?.effectivePolicy).toBeNull();
    expect(catchAll?.source).toBe("framework");
    expect(catchAll?.generatedTwin).toBe(true);
    // Returning entries are copies: mutating them cannot poison the assembly.
    inventory[0].url = "MUTATED";
    expect(app.routeInventory()[0].url).not.toBe("MUTATED");
    await app.close();
  });

  it("invokes the operational waypoint exactly once — never once per prefix group", async () => {
    // The local API route group is double-mounted (/api/v1 AND /api); a
    // worker started inside that group would start twice. The assembly owns
    // the waypoint between the groups and realtime, so operational effects
    // fire exactly once per boot.
    let waypointCalls = 0;
    const app = await createHttpApplication({
      logger: false,
      onLocalPrefixesRegistered: () => {
        waypointCalls += 1;
      },
    });
    await app.installPluginRoutes([]);
    await app.finalize();
    expect(waypointCalls).toBe(1);
    await app.close();
  });

  it("stamps X-API-Version at onSend on every response; Deprecation only on /api", async () => {
    // The characterized pre-assembly defect (headers written in onResponse
    // never reached the wire) is corrected at the owning assembly seam.
    const app = await readyApp();

    const health = await app.inject({ method: "GET", url: "/health" });
    expect(health.statusCode).toBe(200);
    expect(health.headers["x-api-version"]).toBe("1");
    expect(health.headers.deprecation).toBeUndefined();

    const v1 = await app.inject({ method: "GET", url: "/api/v1/habitats" });
    expect(v1.statusCode).toBe(401);
    expect(v1.headers["x-api-version"]).toBe("1");
    expect(v1.headers.deprecation).toBeUndefined();

    const deprecated = await app.inject({ method: "GET", url: "/api/habitats" });
    expect(deprecated.statusCode).toBe(401);
    expect(deprecated.headers["x-api-version"]).toBe("1");
    expect(deprecated.headers.deprecation).toBe("true");

    // The Remote Participant API is its own scope: no deprecated-prefix leak.
    const shared = await app.inject({ method: "GET", url: "/api/shared/me" });
    expect(shared.statusCode).toBe(401);
    expect(shared.headers.deprecation).toBeUndefined();

    await app.close();
  });

  it("the characterization audit probe registers at finalize and stays out of the inventory", async () => {
    const app = await readyApp({ auditProbeRoute: true });
    const probe = await app.inject({ method: "GET", url: "/__audit-probe__" });
    expect(probe.statusCode).toBe(200);
    expect(probe.json()).toMatchObject({ source: "rest_api", method: "GET" });
    expect(
      app.routeInventory().some((e) => e.url === "/__audit-probe__"),
      "the test-only probe must not appear in the production inventory",
    ).toBe(false);
    await app.close();
  });

  it("exposes the assembly logger for operational boot", async () => {
    const app = await createHttpApplication({ logger: false });
    expect(app.log).toBeDefined();
    expect(typeof app.log.error).toBe("function");
    await app.close();
  });

  it("runs operational onClose callbacks when the application closes", async () => {
    let closed = 0;
    const app = await createHttpApplication({ logger: false });
    await app.installPluginRoutes([]);
    // Operational hooks register before finalization — same constraint as
    // Fastify's own onClose (no hook additions once started).
    app.onClose(() => {
      closed += 1;
    });
    await app.finalize();
    await app.close();
    expect(closed).toBe(1);
  });
});

describe("HTTP assembly lifecycle (HttpRuntimeHandle shape)", () => {
  it("the handle exposes no route registration capability", async () => {
    const app = await createHttpApplication({ logger: false });
    // The closed operation surface of the production handle — get/post/
    // register/route/addHook must never appear on it.
    expect(Object.keys(app).sort()).toEqual([
      "close",
      "finalize",
      "inject",
      "installPluginRoutes",
      "listen",
      "log",
      "onClose",
      "routeInventory",
      "state",
    ]);
    await app.close();
  });
});
