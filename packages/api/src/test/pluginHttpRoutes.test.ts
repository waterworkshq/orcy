/**
 * Core-owned System Plugin HTTP routes (ADR-0050, supersedes ADR-0041).
 *
 * End-to-end seam tests for the declared-route contract: a fixture plugin's
 * validated catalog entries are mounted by the single core installer under
 * BOTH plugin namespaces with fixed `local_actor` policy, handler faults are
 * contained to the request through the global error envelope, execution is
 * exact-once with no mount-time side effects, and no undeclared path can be
 * served. A structural source guard pins that the production plugin seam
 * carries no Fastify registration capability.
 *
 * Auth runs through the production policy installer inside the staged
 * assembly (`createHttpApplication`) with a stateless human JWT — no DB
 * required.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import {
  createHttpApplication,
  type CreateHttpApplicationOptions,
  type HttpRuntimeHandle,
} from "../httpApp.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import {
  validatePluginHttpRouteDeclarations,
  normalizePluginRouteMethod,
  validatePluginRoutePath,
  validatePluginRouteId,
  PLUGIN_ROUTE_PREFIX_CURRENT,
  PLUGIN_ROUTE_PREFIX_DEPRECATED,
  type PluginRouteCatalogEntry,
} from "../plugins/pluginHttpRoutes.js";
import type { PluginHttpHandler, PluginHttpRequest, PluginModule } from "../plugins/types.js";

const JWT_SECRET = "plugin-route-seam-test-secret";

function humanToken(): string {
  return jwt.sign({ sub: "human-1", username: "seam-user", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

/** Log capture: pino options with an in-memory stream, read back as lines. */
function makeCaptureLogger(): {
  lines: string[];
  options: CreateHttpApplicationOptions["logger"];
} {
  const lines: string[] = [];
  const stream = { write: (chunk: string) => lines.push(chunk) };
  return { lines, options: { level: "error", stream } as CreateHttpApplicationOptions["logger"] };
}

function fixtureEntry(overrides: Partial<PluginRouteCatalogEntry> = {}): PluginRouteCatalogEntry {
  return {
    pluginId: "fixture",
    routeId: "status",
    method: "GET",
    path: "/status",
    handler: async (request) => ({
      status: 200,
      body: { fixture: true, actorType: request.actor?.type ?? null },
    }),
    ...overrides,
  };
}

async function buildSeamApp(
  entries: readonly PluginRouteCatalogEntry[],
  logger: CreateHttpApplicationOptions["logger"] = false,
): Promise<HttpRuntimeHandle> {
  // The staged assembly boots the full production core surface, then the
  // catalog installs through the assembly's one-shot lifecycle step — the
  // same path production boot takes (runPluginBoot hands the discovery
  // catalog to installPluginRoutes).
  const app = await createHttpApplication({ logger });
  await app.installPluginRoutes(entries);
  await app.finalize();
  return app;
}

/** Minimal module for direct validator calls. */
function moduleWith(overrides: Partial<PluginModule> & { manifest: PluginModule["manifest"] }): PluginModule {
  return { ...overrides };
}

function routeManifest(contributions: unknown[], pluginId = "p"): PluginModule["manifest"] {
  return {
    id: pluginId,
    version: "1.0.0",
    description: "validator fixture",
    contributions: contributions as PluginModule["manifest"]["contributions"],
  };
}

beforeEach(() => {
  setJwtSecret(JWT_SECRET);
});

// ---------------------------------------------------------------------------
// Normalization primitives
// ---------------------------------------------------------------------------
describe("pluginHttpRoutes: normalization primitives", () => {
  it("normalizes method case and rejects unsupported methods", () => {
    expect(normalizePluginRouteMethod("get")).toBe("GET");
    expect(normalizePluginRouteMethod("DELETE")).toBe("DELETE");
    expect(normalizePluginRouteMethod("TRACE")).toBeNull();
    expect(normalizePluginRouteMethod(123)).toBeNull();
    expect(normalizePluginRouteMethod("")).toBeNull();
  });

  it("accepts canonical relative paths and rejects every escape class", () => {
    expect(validatePluginRoutePath("/status")).toBe("/status");
    expect(validatePluginRoutePath("/a/b/c")).toBe("/a/b/c");
    // Absolute / scheme-bearing.
    expect(validatePluginRoutePath("https://evil.example/x")).toBeNull();
    expect(validatePluginRoutePath("//evil.example/x")).toBeNull();
    // Traversal.
    expect(validatePluginRoutePath("/../secret")).toBeNull();
    expect(validatePluginRoutePath("/a/../../secret")).toBeNull();
    expect(validatePluginRoutePath("/a/./b")).toBeNull();
    // Trailing slash / empty segments / bare root.
    expect(validatePluginRoutePath("/status/")).toBeNull();
    expect(validatePluginRoutePath("/a//b")).toBeNull();
    expect(validatePluginRoutePath("/")).toBeNull();
    // Params, wildcards, percent-encoding, query, fragment, spaces.
    expect(validatePluginRoutePath("/:id")).toBeNull();
    expect(validatePluginRoutePath("/*")).toBeNull();
    expect(validatePluginRoutePath("/a%2fb")).toBeNull();
    expect(validatePluginRoutePath("/a?x=1")).toBeNull();
    expect(validatePluginRoutePath("/a#f")).toBeNull();
    expect(validatePluginRoutePath("/a b")).toBeNull();
    expect(validatePluginRoutePath(42)).toBeNull();
  });

  it("validates routeId as a safe map key / URL segment", () => {
    expect(validatePluginRouteId("status")).toBe("status");
    expect(validatePluginRouteId("a.b_c-d")).toBe("a.b_c-d");
    expect(validatePluginRouteId("../escape")).toBeNull();
    expect(validatePluginRouteId("a/b")).toBeNull();
    expect(validatePluginRouteId("a b")).toBeNull();
    expect(validatePluginRouteId("")).toBeNull();
    expect(validatePluginRouteId(".hidden")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Whole-plugin declaration validation (discovery-time, ADR-0050)
// ---------------------------------------------------------------------------
describe("pluginHttpRoutes: declaration validation", () => {
  const okHandler: PluginHttpHandler = async () => ({ status: 200 });

  it("accepts an exact declaration/handler match", () => {
    const mod = moduleWith({
      manifest: routeManifest([
        { kind: "customHttpRoute", scope: "system", routeId: "status", method: "GET", path: "/status", requires: [] },
      ]),
      httpHandlers: { status: okHandler },
    });
    expect(validatePluginHttpRouteDeclarations(mod)).toBeNull();
  });

  it("accepts a plugin with no route declarations and no handler map", () => {
    const mod = moduleWith({
      manifest: routeManifest([
        { kind: "notificationChannel", scope: "system", channelId: "c", label: "l", requires: [] },
      ]),
    });
    expect(validatePluginHttpRouteDeclarations(mod)).toBeNull();
  });

  it("rejects the legacy routeHandlers export with the migration error", () => {
    const mod = {
      manifest: routeManifest([
        { kind: "customHttpRoute", scope: "system", routeId: "status", method: "GET", path: "/status", requires: [] },
      ]),
      routeHandlers: async () => {},
    } as unknown as PluginModule;
    const error = validatePluginHttpRouteDeclarations(mod);
    expect(error).toContain("routeHandlers is no longer supported");
    expect(error).toContain("httpHandlers keyed by routeId");
  });

  it("rejects a missing handler for a declared route", () => {
    const mod = moduleWith({
      manifest: routeManifest([
        { kind: "customHttpRoute", scope: "system", routeId: "status", method: "GET", path: "/status", requires: [] },
      ]),
    });
    expect(validatePluginHttpRouteDeclarations(mod)).toBe(
      'customHttpRoute "status" declared but no matching handler in module.httpHandlers',
    );
  });

  it("rejects an undeclared extra handler mapping (catalog completeness)", () => {
    const mod = moduleWith({
      manifest: routeManifest([
        { kind: "customHttpRoute", scope: "system", routeId: "status", method: "GET", path: "/status", requires: [] },
      ]),
      httpHandlers: { status: okHandler, smuggled: okHandler },
    });
    const error = validatePluginHttpRouteDeclarations(mod);
    expect(error).toContain('httpHandlers["smuggled"] with no matching customHttpRoute declaration');
  });

  it("rejects handler keys when no customHttpRoute is declared at all", () => {
    const mod = moduleWith({
      manifest: routeManifest([]),
      httpHandlers: { orphan: okHandler },
    });
    expect(validatePluginHttpRouteDeclarations(mod)).toContain(
      "declares no customHttpRoute contributions",
    );
  });

  it("rejects duplicate routeId and duplicate normalized method/path within a manifest", () => {
    const dupId = moduleWith({
      manifest: routeManifest([
        { kind: "customHttpRoute", scope: "system", routeId: "twin", method: "GET", path: "/a", requires: [] },
        { kind: "customHttpRoute", scope: "system", routeId: "twin", method: "POST", path: "/b", requires: [] },
      ]),
      httpHandlers: { twin: okHandler },
    });
    expect(validatePluginHttpRouteDeclarations(dupId)).toBe('duplicate routeId "twin" within manifest');

    const dupPath = moduleWith({
      manifest: routeManifest([
        { kind: "customHttpRoute", scope: "system", routeId: "a", method: "GET", path: "/x", requires: [] },
        { kind: "customHttpRoute", scope: "system", routeId: "b", method: "get", path: "/x", requires: [] },
      ]),
      httpHandlers: { a: okHandler, b: okHandler },
    });
    expect(validatePluginHttpRouteDeclarations(dupPath)).toBe('duplicate route "GET /x" within manifest');
  });

  it("rejects prototype-chain keys (constructor, toString) masquerading as handlers — own-property agreement", async () => {
    // Review finding 1: `{}`["constructor"] is a function via the prototype
    // chain. A declaration keyed by a magic name with NO exported handler
    // must reject — the builtin would otherwise be mounted as the handler.
    for (const magic of ["constructor", "toString"]) {
      const mod = moduleWith({
        manifest: routeManifest([
          { kind: "customHttpRoute", scope: "system", routeId: magic, method: "GET", path: "/x", requires: [] },
        ]),
      });
      expect(validatePluginHttpRouteDeclarations(mod)).toBe(
        `customHttpRoute "${magic}" declared but no matching handler in module.httpHandlers`,
      );
    }
    // And a genuinely exported own-property handler under such a key IS
    // valid — the fix targets inheritance, not the key spelling.
    const mod = moduleWith({
      manifest: routeManifest([
        { kind: "customHttpRoute", scope: "system", routeId: "toString", method: "GET", path: "/x", requires: [] },
      ]),
      httpHandlers: { toString: okHandler },
    });
    expect(validatePluginHttpRouteDeclarations(mod)).toBeNull();
  });

  it("rejects non-Record httpHandlers values (null, array) with the map-shape error", () => {
    for (const bad of [null, ["not-a-map"]]) {
      const mod = {
        manifest: routeManifest([
          { kind: "customHttpRoute", scope: "system", routeId: "s", method: "GET", path: "/s", requires: [] },
        ]),
        httpHandlers: bad,
      } as unknown as PluginModule;
      expect(validatePluginHttpRouteDeclarations(mod)).toBe(
        'module.httpHandlers must be a Record<routeId, handler> when present (plugin "p")',
      );
    }
  });

  it("rejects non-system scope and URL-unsafe plugin ids on route-declaring plugins", () => {
    const badScope = moduleWith({
      manifest: routeManifest([
        { kind: "customHttpRoute", scope: "habitat", routeId: "s", method: "GET", path: "/s", requires: [] },
      ]),
      httpHandlers: { s: okHandler },
    });
    expect(validatePluginHttpRouteDeclarations(badScope)).toContain('must declare scope "system"');

    const badPluginId = moduleWith({
      manifest: routeManifest(
        [{ kind: "customHttpRoute", scope: "system", routeId: "s", method: "GET", path: "/s", requires: [] }],
        "../escape",
      ),
      httpHandlers: { s: okHandler },
    });
    expect(validatePluginHttpRouteDeclarations(badPluginId)).toContain("not URL-segment-safe");
  });
});

// ---------------------------------------------------------------------------
// Core installer — twin namespaces, fixed policy, bounded execution
// ---------------------------------------------------------------------------
describe("pluginHttpRoutes: core installer", () => {
  it("serves an authenticated fixture handler under both namespaces; Deprecation only on the deprecated mirror", async () => {
    const app = await buildSeamApp([fixtureEntry()]);

    const current = await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/status`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toEqual({ fixture: true, actorType: "human" });
    expect(current.headers.deprecation).toBeUndefined();

    const deprecated = await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_DEPRECATED}/fixture/status`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(deprecated.statusCode).toBe(200);
    expect(deprecated.json()).toEqual({ fixture: true, actorType: "human" });
    expect(deprecated.headers.deprecation).toBe("true");

    await app.close();
  });

  it("rejects anonymous requests under both namespaces (fixed local_actor policy)", async () => {
    const app = await buildSeamApp([fixtureEntry()]);
    for (const prefix of [PLUGIN_ROUTE_PREFIX_CURRENT, PLUGIN_ROUTE_PREFIX_DEPRECATED]) {
      const res = await app.inject({ method: "GET", url: `${prefix}/fixture/status` });
      expect(res.statusCode, `${prefix} anonymous`).toBe(401);
      expect(res.json()).toMatchObject({ error: "Missing authentication token" });
    }
    await app.close();
  });

  it("classifies both mirrored routes as local_actor through the assembly inventory", async () => {
    const app = await buildSeamApp([fixtureEntry()]);
    const pluginClassifications = app.routeInventory().filter(
      // Method-explicit: the twin mounts are distinct URLs; only GET matches.
      (c) => c.url.endsWith("/plugins/fixture/status") && c.method === "GET",
    );
    expect(pluginClassifications).toHaveLength(2);
    for (const c of pluginClassifications) {
      expect(c.method).toBe("GET");
      expect(c.effectivePolicy).toBe("local_actor");
      expect(c.source).toBe("plugin");
    }
    const urls = pluginClassifications.map((c) => c.url).sort();
    expect(urls).toEqual([
      "/api/plugins/fixture/status",
      "/api/v1/plugins/fixture/status",
    ]);
    await app.close();
  });

  it("cannot serve an undeclared path — no route exists outside the catalog", async () => {
    const app = await buildSeamApp([fixtureEntry()]);
    for (const prefix of [PLUGIN_ROUTE_PREFIX_CURRENT, PLUGIN_ROUTE_PREFIX_DEPRECATED]) {
      const res = await app.inject({
        method: "GET",
        url: `${prefix}/fixture/undeclared`,
        headers: { authorization: `Bearer ${humanToken()}` },
      });
      expect(res.statusCode, `${prefix} undeclared`).toBe(404);
    }
    await app.close();
  });

  it("bounds the handler input: method/path/query/body/headers/actor, and maps void → 204 / custom status", async () => {
    const seen: PluginHttpRequest[] = [];
    const entry = fixtureEntry({
      routeId: "mirror",
      method: "POST",
      path: "/mirror",
      handler: async (req) => {
        seen.push(req);
        return { status: 201, body: { echoed: true } };
      },
    });
    const voidEntry = fixtureEntry({
      routeId: "noop",
      method: "GET",
      path: "/noop",
      handler: async () => undefined,
    });
    const app = await buildSeamApp([entry, voidEntry]);

    const res = await app.inject({
      method: "POST",
      url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/mirror?flag=on`,
      headers: { authorization: `Bearer ${humanToken()}`, "x-custom": "v" },
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ echoed: true });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("POST");
    expect(seen[0].path).toBe("/mirror");
    expect(seen[0].query).toEqual({ flag: "on" });
    expect(seen[0].body).toEqual({ hello: "world" });
    expect((seen[0].headers as Record<string, unknown>)["x-custom"]).toBe("v");
    expect(seen[0].actor).toEqual({ type: "human", id: "human-1", name: "seam-user" });

    const voidRes = await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/noop`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(voidRes.statusCode).toBe(204);
    expect(voidRes.body).toBe("");

    await app.close();
  });

  it("executes the handler exactly once per request and never at mount time", async () => {
    let calls = 0;
    const entry = fixtureEntry({
      handler: async () => {
        calls += 1;
        return { status: 200, body: { calls } };
      },
    });
    const app = await buildSeamApp([entry]);
    expect(calls).toBe(0); // ready() mounted both mirrors; no execution

    await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/status`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(calls).toBe(1);

    await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_DEPRECATED}/fixture/status`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(calls).toBe(2); // twin mounts dispatch one handler per request

    await app.close();
  });

  it("contains a throwing handler to the request: envelope 500, identity logging, plugin stays live past the quarantine threshold", async () => {
    const log = makeCaptureLogger();
    let calls = 0;
    const boom = fixtureEntry({
      routeId: "boom",
      path: "/boom",
      handler: async () => {
        calls += 1;
        throw new Error("handler-exploded");
      },
    });
    const healthy = fixtureEntry({ routeId: "healthy", path: "/healthy" });
    const app = await buildSeamApp([boom, healthy], log.options);

    // More failures than the default quarantine threshold (10): the seam does
    // not route plugin HTTP faults into quarantine accounting (ADR-0050), so
    // the route must keep executing. The envelope is deliberately generic
    // (raw handler errors never leak to clients); identity lives in the log.
    for (let i = 0; i < 12; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/boom`,
        headers: { authorization: `Bearer ${humanToken()}` },
      });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toMatchObject({ error: "Internal server error" });
    }
    expect(calls).toBe(12);

    // Identity logging: pluginId + routeId + method + path on the fault line.
    const faultLine = log.lines.find((l) => l.includes("Plugin HTTP route handler failed"));
    expect(faultLine).toBeDefined();
    expect(faultLine).toContain('"pluginId":"fixture"');
    expect(faultLine).toContain('"routeId":"boom"');
    expect(faultLine).toContain('"method":"GET"');
    expect(faultLine).toContain('"path":"/boom"');

    // The server and the plugin stay healthy: the sibling route answers, and
    // the faulting route still executes (13th call — no quarantine skip).
    const sibling = await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/healthy`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(sibling.statusCode).toBe(200);
    const stillLive = await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/boom`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(stillLive.statusCode).toBe(500);
    expect(calls).toBe(13);

    await app.close();
  });

  it("enforces the per-agent rate limit on both plugin prefixes (parity with the core API groups)", async () => {
    // Scope-level preHandler runs before the route-level auth guard — the
    // same ordering as the core /api groups — so unauthenticated traffic is
    // ip-keyed at the agent-default limit (60/min). Loop to the limit rather
    // than asserting an exact trip index: sibling tests in this file may
    // have consumed part of the shared window budget.
    const app = await buildSeamApp([fixtureEntry()]);
    let firstLimit: number | undefined;
    let saw429 = false;
    for (let i = 0; i < 70 && !saw429; i += 1) {
      const res = await app.inject({
        method: "GET",
        url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/status`,
      });
      if (i === 0) firstLimit = Number(res.headers["x-ratelimit-limit"]);
      if (res.statusCode === 429) {
        saw429 = true;
        expect(res.headers["retry-after"]).toBeDefined();
        expect(Number(res.headers["x-ratelimit-remaining"])).toBe(0);
      } else {
        expect(res.statusCode).toBe(401); // unauthenticated until limited
      }
    }
    expect(saw429, "plugin route must reach 429 within the configured limit").toBe(true);
    expect(firstLimit, "the configured agent-default limit").toBe(60);

    // Same ip key, same module store: the deprecated mirror enforces the
    // identical limit. A missing hook on that group would answer 401.
    const mirror = await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_DEPRECATED}/fixture/status`,
    });
    expect(mirror.statusCode).toBe(429);
    await app.close();
  });

  it("mounts nothing for an empty catalog", async () => {
    const app = await buildSeamApp([]);
    const res = await app.inject({
      method: "GET",
      url: `${PLUGIN_ROUTE_PREFIX_CURRENT}/fixture/status`,
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// Structural seam guard — no Fastify registration capability on the seam
// ---------------------------------------------------------------------------
describe("pluginHttpRoutes: structural seam guard (ADR-0050)", () => {
  it("the production plugin seam carries no routeHandlers / FastifyPluginCallback", async () => {
    const seamDir = join(import.meta.dirname, "../plugins");
    const files = (await readdir(seamDir)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const source = await readFile(join(seamDir, file), "utf8");

      // The module contract type and the loader must not carry the raw
      // callback capability in any form. (pluginHttpRoutes.ts mentions the
      // legacy field ONLY inside its rejection error + structural read —
      // those are the migration guard, not a capability.)
      if (file === "types.ts" || file === "pluginManager.ts" || file === "pluginBoot.ts") {
        expect(source, `${file} must not reference routeHandlers`).not.toContain("routeHandlers");
        expect(source, `${file} must not use FastifyPluginCallback`).not.toContain(
          "FastifyPluginCallback",
        );
      }
      // Every production seam file is FastifyPluginCallback-free.
      expect(source, `${file} must not use FastifyPluginCallback`).not.toContain(
        "FastifyPluginCallback",
      );
    }
  });
});
