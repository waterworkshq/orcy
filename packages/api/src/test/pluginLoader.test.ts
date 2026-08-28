import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify from "fastify";
import * as pluginManager from "../plugins/pluginManager.js";
import { installPluginRoutes } from "../plugins/pluginHttpRoutes.js";

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../repositories/pluginEnrollment.js", () => ({
  listEnabledByHabitat: vi.fn().mockReturnValue([]),
}));

vi.mock("../repositories/pluginRun.js", () => ({
  startRun: vi.fn().mockReturnValue({ id: "run-1" }),
  finishRun: vi.fn(),
}));

vi.mock("../services/pulseService.js", () => ({ onPulseCreated: vi.fn() }));
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-loader-${name}-${Date.now()}`;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

async function cleanup(tmpDir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
}

describe("pluginLoader: manifest validation", () => {
  beforeEach(() => pluginManager.resetPlugins());
  afterEach(() => pluginManager.resetPlugins());

  it("accepts a valid manifest/module pair", async () => {
    const dir = await writePlugin(
      "valid",
      `{ manifest: { id: 'valid', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'valid-ch', label: 'l', requires: [] }] }, channels: { 'valid-ch': async () => ({ success: true }) } }`,
    );
    expect(pluginManager.getLoadedPlugins()[0].error).toBeUndefined();
    await cleanup(dir);
  });

  it("rejects manifest missing id", async () => {
    const dir = await writePlugin(
      "no-id",
      `{ manifest: { id: '', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'c', label: 'l', requires: [] }] }, channels: { c: async () => ({ success: true }) } }`,
    );
    expect(pluginManager.getLoadedPlugins()[0].error).toBeDefined();
    await cleanup(dir);
  });

  it("rejects manifest with empty contributions array", async () => {
    const dir = await writePlugin(
      "empty",
      `{ manifest: { id: 'empty', version: '1.0.0', description: 'x', contributions: [] } }`,
    );
    expect(pluginManager.getLoadedPlugins()[0].error).toBeDefined();
    await cleanup(dir);
  });

  it("rejects manifest with invalid contribution kind", async () => {
    const dir = await writePlugin(
      "badkind",
      `{ manifest: { id: 'badkind', version: '1.0.0', description: 'x', contributions: [{ kind: 'fake', requires: [] }] } }`,
    );
    expect(pluginManager.getLoadedPlugins()[0].error).toBeDefined();
    await cleanup(dir);
  });

  it("rejects orphan handler (channel declared, no handler)", async () => {
    const dir = await writePlugin(
      "orphan",
      `{ manifest: { id: 'orphan', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'c', label: 'l', requires: [] }] } }`,
    );
    expect(pluginManager.getLoadedPlugins()[0].error).toContain("no matching handler");
    await cleanup(dir);
  });
});

describe("pluginLoader: capability enforcement", () => {
  beforeEach(() => pluginManager.resetPlugins());
  afterEach(() => pluginManager.resetPlugins());

  it("refuses detector requiring a non-allowed capability (habitatReader)", async () => {
    const dir = await writePlugin(
      "det-bad",
      `{ manifest: { id: 'det-bad', version: '1.0.0', description: 'x', contributions: [{ kind: 'signalDetector', scope: 'habitat', detectorId: 'd', label: 'l', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 }, requires: ['habitatReader'] }] }, detectors: { d: async () => [] } }`,
    );
    expect(pluginManager.getLoadedPlugins()[0].error).toBeDefined();
    await cleanup(dir);
  });

  it("refuses pre-phase interceptor requiring pulseWriter", async () => {
    const dir = await writePlugin(
      "pre-bad",
      `{ manifest: { id: 'pre-bad', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i', phase: 'pre', event: 'taskCreated', priority: 0, requires: ['pulseWriter'] }] }, interceptors: { i: async () => ({ allow: true }) } }`,
    );
    const entry = pluginManager.getLoadedPlugins()[0];
    expect(entry.error).toBeDefined();
    expect(entry.error).toContain("pulseWriter");
    await cleanup(dir);
  });

  it("accepts post-phase interceptor requiring pulseWriter", async () => {
    const dir = await writePlugin(
      "post-ok",
      `{ manifest: { id: 'post-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i', phase: 'post', event: 'taskCreated', priority: 0, requires: ['pulseWriter'] }] }, interceptors: { i: async () => ({ signals: [] }) } }`,
    );
    expect(pluginManager.getLoadedPlugins()[0].error).toBeUndefined();
    await cleanup(dir);
  });
});

describe("pluginLoader: old KanbanPlugin shape refusal", () => {
  beforeEach(() => pluginManager.resetPlugins());
  afterEach(() => pluginManager.resetPlugins());

  it("refuses the v0.21 KanbanPlugin shape", async () => {
    const dir = await writePlugin(
      "legacy",
      `{ name: 'legacy', version: '1.0.0', hooks: { onTaskCreated: () => {} } }`,
    );
    expect(pluginManager.getLoadedPlugins()[0].error).toBeDefined();
    await cleanup(dir);
  });
});

describe("pluginLoader: registry construction", () => {
  beforeEach(() => pluginManager.resetPlugins());
  afterEach(() => pluginManager.resetPlugins());

  it("builds channel registry from a loaded notificationChannel plugin", async () => {
    const dir = await writePlugin(
      "chan",
      `{ manifest: { id: 'chan', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'teams', label: 'Teams', requires: [] }] }, channels: { teams: async () => ({ success: true }) } }`,
    );
    const handler = pluginManager.getChannelHandler("teams");
    expect(handler).toBeTypeOf("function");
    await cleanup(dir);
  });

  it("returns undefined for an unknown channelId", () => {
    expect(pluginManager.getChannelHandler("nonexistent")).toBeUndefined();
  });
});

describe("pluginLoader: core-owned HTTP seam (ADR-0050, supersedes ADR-0041)", () => {
  beforeEach(() => pluginManager.resetPlugins());
  afterEach(() => pluginManager.resetPlugins());

  it("rejects a plugin exporting legacy routeHandlers with the migration error, while a later valid plugin still loads", async () => {
    // Breaking plugin-SDK contract: the unrestricted callback is gone. The
    // rejection is a structural LOAD fault (whole plugin, scan continues) —
    // not a mount-time crash. There is no mount-time plugin execution anymore.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = `/tmp/test-loader-legacy-${Date.now()}`;
    await mkdir(`${dir}/aa-legacy`, { recursive: true });
    await mkdir(`${dir}/bb-good`, { recursive: true });
    await writeFile(
      `${dir}/aa-legacy/index.mjs`,
      `export default { manifest: { id: 'aa-legacy', version: '1.0.0', description: 'old sdk', contributions: [{ kind: 'customHttpRoute', scope: 'system', routeId: 'legacy-route', method: 'GET', path: '/legacy', requires: [] }] }, routeHandlers: async () => {} };`,
    );
    await writeFile(
      `${dir}/bb-good/index.mjs`,
      `export default { manifest: { id: 'bb-good', version: '1.0.0', description: 'new sdk', contributions: [{ kind: 'customHttpRoute', scope: 'system', routeId: 'good-route', method: 'GET', path: '/good', requires: [] }] }, httpHandlers: { 'good-route': async () => ({ status: 200, body: { ok: true } }) } };`,
    );
    pluginManager.setPluginDirectory(dir);
    await pluginManager.loadPlugins();

    const legacy = pluginManager.getLoadedPlugins().find((p) => p.id === "aa-legacy");
    expect(legacy?.error).toContain("routeHandlers is no longer supported");
    expect(legacy?.error).toContain("httpHandlers keyed by routeId");
    expect(pluginManager.getPluginManifest("aa-legacy")).toBeNull();

    // Whole-plugin containment: the later valid plugin still loads and its
    // route reaches the validated catalog.
    const good = pluginManager.getLoadedPlugins().find((p) => p.id === "bb-good");
    expect(good?.error).toBeUndefined();
    const catalog = pluginManager.getPluginRouteCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ pluginId: "bb-good", routeId: "good-route", method: "GET", path: "/good" });

    await cleanup(dir);
  });

  it("prototype-chain 'handler' (constructor) with no own export rejects the whole plugin; a later valid plugin still loads", async () => {
    // Review finding 1 at the loader level: `{}`["constructor"] resolves to
    // a function through the prototype chain. Without the own-property
    // check, this plugin validated and the builtin was mounted as the
    // handler. It must reject during discovery and leave the catalog empty
    // of its entries while the later valid plugin loads.
    const { mkdir, writeFile } = await import("node:fs/promises");
    const dir = `/tmp/test-loader-magic-${Date.now()}`;
    await mkdir(`${dir}/aa-magic`, { recursive: true });
    await mkdir(`${dir}/bb-good`, { recursive: true });
    await writeFile(
      `${dir}/aa-magic/index.mjs`,
      // `httpHandlers: {}` is load-bearing: an ordinary empty object whose
      // inherited `constructor`/`toString` ARE the defect under test. Without
      // an own-property check, `{}`["constructor"] resolves through the
      // prototype chain and the builtin would be accepted as the handler.
      `export default { manifest: { id: 'aa-magic', version: '1.0.0', description: 'magic key', contributions: [{ kind: 'customHttpRoute', scope: 'system', routeId: 'constructor', method: 'GET', path: '/magic', requires: [] }, { kind: 'customHttpRoute', scope: 'system', routeId: 'toString', method: 'GET', path: '/stringify', requires: [] }] }, httpHandlers: {} };`,
    );
    await writeFile(
      `${dir}/bb-good/index.mjs`,
      `export default { manifest: { id: 'bb-good', version: '1.0.0', description: 'good', contributions: [{ kind: 'customHttpRoute', scope: 'system', routeId: 'good-route', method: 'GET', path: '/good', requires: [] }] }, httpHandlers: { 'good-route': async () => ({ status: 200, body: { ok: true } }) } };`,
    );
    pluginManager.setPluginDirectory(dir);
    await pluginManager.loadPlugins();

    const magic = pluginManager.getLoadedPlugins().find((p) => p.id === "aa-magic");
    expect(magic?.error).toBe(
      'customHttpRoute "constructor" declared but no matching handler in module.httpHandlers',
    );
    expect(pluginManager.getPluginManifest("aa-magic")).toBeNull();

    const catalog = pluginManager.getPluginRouteCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({ pluginId: "bb-good", routeId: "good-route" });
    expect(catalog[0].handler).toBeTypeOf("function");

    await cleanup(dir);
  });

  it("repeated loadPlugins() without resetPlugins() converges: one identity-keyed catalog entry", async () => {
    // Review finding 2: the sibling registries are identity-keyed Maps whose
    // re-set converges; the catalog must not append duplicates on a repeated
    // identical scan (a duplicate would double-register the same route at
    // install and pollute the Ticket 06 handoff).
    const dir = await writePlugin(
      "idem",
      `{ manifest: { id: 'idem', version: '1.0.0', description: 'x', contributions: [{ kind: 'customHttpRoute', scope: 'system', routeId: 'the-route', method: 'GET', path: '/x', requires: [] }] }, httpHandlers: { 'the-route': async () => ({ status: 200, body: { idem: true } }) } }`,
    );
    // writePlugin already ran one loadPlugins(); run it twice more without
    // any resetPlugins() between scans.
    await pluginManager.loadPlugins();
    await pluginManager.loadPlugins();

    const catalog = pluginManager.getPluginRouteCatalog();
    expect(catalog).toHaveLength(1);
    expect(catalog[0]).toMatchObject({
      pluginId: "idem",
      routeId: "the-route",
      method: "GET",
      path: "/x",
    });
    await cleanup(dir);
  });

  it("a throwing httpHandler loads fine — mount stays clean and the fault is request-scoped", async () => {
    // The superseded ADR-0041 crash-loud contract pinned a mount-time throw
    // poisoning the instance. Under ADR-0050 the handler runs only inside a
    // request: staged catalog installation resolves, ready resolves, one inject
    // fails that one request without deactivating the plugin.
    const manifest = {
      id: "thrower",
      version: "1.0.0",
      description: "throws per request",
      contributions: [
        { kind: "customHttpRoute", scope: "system", routeId: "boom", method: "GET", path: "/boom", requires: [] },
      ],
    };
    const dir = `/tmp/test-loader-thrower-${Date.now()}`;
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(dir, { recursive: true });
    await writeFile(
      `${dir}/thrower.mjs`,
      `export default { manifest: ${JSON.stringify(manifest)}, httpHandlers: { boom: async () => { throw new Error('boom-per-request'); } } };`,
    );
    pluginManager.setPluginDirectory(dir);
    await pluginManager.loadPlugins();

    const entry = pluginManager.getLoadedPlugins().find((p) => p.id === "thrower");
    expect(entry?.error).toBeUndefined();

    const fastify = Fastify({ logger: false });
    await expect(
      installPluginRoutes(fastify, pluginManager.getPluginRouteCatalog()),
    ).resolves.toBeUndefined();
    let readyError: unknown;
    try {
      await fastify.ready();
    } catch (err) {
      readyError = err;
    }
    expect(readyError).toBeUndefined(); // no mount-time execution reached the handler

    // Bare instance (no auth installer): the request reaches the handler and
    // the throw fails exactly that request. Plugin stays loaded.
    const res = await fastify.inject({ method: "GET", url: "/api/v1/plugins/thrower/boom" });
    expect(res.statusCode).toBe(500);
    expect(pluginManager.getPluginManifest("thrower")).not.toBeNull();

    await fastify.close();
    await cleanup(dir);
  });
});

describe("pluginLoader: non-fatal loadPlugins path (regression pin)", () => {
  beforeEach(() => pluginManager.resetPlugins());
  afterEach(() => pluginManager.resetPlugins());

  it("loadPlugins failures (import/validation) are non-fatal — server can still boot", async () => {
    // Pins the OTHER regime: loadPlugins errors must remain swallowable so
    // a malformed plugin does not block boot. This test exists so the two
    // regimes (load = non-fatal, initialize = fatal) don't get re-conflated
    // by a future refactor.
    //
    // Validation failure: a manifest with a bad contribution kind is
    // rejected by loadPlugins; loadPlugins itself does NOT throw — it sets
    // pluginErrors and the server is free to boot without the bad plugin.
    const dir = await writePlugin(
      "nonfatal",
      `{ manifest: { id: 'nonfatal', version: '1.0.0', description: 'x', contributions: [{ kind: 'fake', requires: [] }] } }`,
    );

    // loadPlugins resolves (does not throw on validation failures — the bad
    // plugin is recorded in pluginErrors and skipped).
    await expect(pluginManager.loadPlugins()).resolves.toBeUndefined();

    // The plugin is recorded as errored, NOT loaded.
    const entry = pluginManager.getLoadedPlugins().find((p) => p.id === "nonfatal");
    expect(entry).toBeDefined();
    expect(entry?.error).toBeDefined();
    expect(pluginManager.getPluginManifest("nonfatal")).toBeNull();

    // Catalog installation still resolves cleanly — no plugins are loaded,
    // so route installation is a no-op. Load-time faults never reach the
    // fatal boot regime; under ADR-0050 only a core registration fault would.
    const fastify = Fastify({ logger: false });
    await expect(
      installPluginRoutes(fastify, pluginManager.getPluginRouteCatalog()),
    ).resolves.toBeUndefined();

    await fastify.close();
    await cleanup(dir);
  });
});
