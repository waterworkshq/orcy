/**
 * v0.28-T1 — plugin registration characterization (9 kinds × 4 behaviors).
 *
 * Purely additive characterization of the four internal registration behaviors
 * being extracted into a `ContributionAdapterCatalog` in v0.28 (Phase 2 / T4).
 * The four target behaviors are:
 *   1. `contributionLabel(c)` — kind→identifier-field mapping
 *   2. `orphanHandler(c, mod)` — does the contribution have a matching handler?
 *   3. `detectIdCollisions(mod)` — within-manifest + cross-plugin id collision detection
 *   4. `register → getter` round-trip — does the registered entry surface through
 *      the kind's exported getter?
 *
 * These tests are observed indirectly through the public `loadPlugins` /
 * `getLoadedPlugins` / `getXxxHandler` / `getXxxEntry` / `getXxxAdapter` /
 * `getCustomMcpTools` surface. The internal functions are not exported and
 * the tests do not modify production code.
 *
 * Per ticket: Tier-C kinds (customMcpTool, customHttpRoute) are documented
 * as having no registry round-trip — runtime exposure for customMcpTool is
 * via the `getCustomMcpTools()` scan, and for customHttpRoute via
 * `initializePlugins()` (Fastify mount). We do not assert a getter round-trip
 * for those two.
 *
 * Per ticket: the lifecycle interceptor "registry round-trip" is asserted by
 * observing the priority-sort after insert. There is no exported getter for
 * the interceptor registry, so the sort is verified by driving the
 * minimum-viable dispatch observation (`runPreInterceptors`) and capturing
 * the call order through a global side-channel populated by the handlers.
 * This is the only way to observe registration order without modifying the
 * module — full dispatch behavior characterization is deferred to T2.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { closeDb, initTestDb } from "../db/index.js";
import * as pluginManager from "../plugins/pluginManager.js";

vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

vi.mock("../repositories/pluginEnrollment.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/pluginEnrollment.js")>();
  return {
    ...actual,
    listByPlugin: vi.fn().mockReturnValue([]),
  };
});

vi.mock("../repositories/pluginRun.js", () => ({
  startRun: vi.fn().mockReturnValue({ id: "run-1" }),
  finishRun: vi.fn(),
}));

vi.mock("../services/pulseService.js", () => ({ onPulseCreated: vi.fn() }));
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-char-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

async function writePluginToDir(
  tmpDir: string,
  name: string,
  moduleBody: string,
  isDir = false,
): Promise<void> {
  if (isDir) {
    await mkdir(`${tmpDir}/${name}`, { recursive: true });
    await writeFile(`${tmpDir}/${name}/index.mjs`, `export default ${moduleBody};`);
  } else {
    await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  }
}

async function cleanup(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

// Returns the first loaded plugin entry whose id matches `id`, or `null`.
function findEntry(id: string) {
  return pluginManager.getLoadedPlugins().find((p) => p.id === id) ?? null;
}

// Returns the first error entry whose error text matches a substring, or `null`.
function findErrorContaining(substring: string) {
  return (
    pluginManager
      .getLoadedPlugins()
      .find((p) => p.error !== undefined && p.error.includes(substring)) ?? null
  );
}

beforeEach(() => {
  pluginManager.resetPlugins();
});

afterEach(() => {
  pluginManager.resetPlugins();
  delete (globalThis as { __intCalls?: string[] }).__intCalls;
});

// ---------------------------------------------------------------------------
// Behavior 1: contributionLabel (kind→id) — 9/9
// Indirectly verified by triggering a capability-matrix violation whose
// error string embeds the kind-specific identifier via `contributionLabel`.
// Each test uses a VALID capability that is NOT in the kind's `allowed` set
// so the error path reaches `contributionLabel` and the embedded id field is
// the kind-specific one. Assertions are byte-for-byte exact via `toBe` to
// preserve quote/whitespace drift as part of the equivalence contract.
// ---------------------------------------------------------------------------
describe("v0.28-T1: contributionLabel (kind→id)", () => {
  it("signalDetector: label returns detectorId", async () => {
    const dir = await writePlugin(
      "lbl-det",
      `{ manifest: { id: 'lbl-det', version: '1.0.0', description: 'x', contributions: [{ kind: 'signalDetector', scope: 'habitat', detectorId: 'lbl-det-id', label: 'l', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 }, requires: ['habitatReader'] }] }, detectors: { 'lbl-det-id': async () => [] } }`,
    );
    // habitatReader is in VALID_CAPABILITIES but NOT in signalDetector.allowed
    const entry = findEntry("lbl-det");
    expect(entry?.error).toBe(
      'signalDetector "lbl-det-id" cannot require capability "habitatReader"',
    );
    await cleanup(dir);
  });

  it("lifecycleInterceptor: label returns interceptorId (post-phase, non-forbidden cap)", async () => {
    const dir = await writePlugin(
      "lbl-int",
      `{ manifest: { id: 'lbl-int', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'lbl-int-id', phase: 'post', event: 'taskCreated', priority: 0, requires: ['taskWriter'] }] }, interceptors: { 'lbl-int-id': async () => ({ signals: [] }) } }`,
    );
    // post-phase + taskWriter (not forbidden, not in allowed) → reaches label lookup
    const entry = findEntry("lbl-int");
    expect(entry?.error).toBe(
      'lifecycleInterceptor "lbl-int-id" cannot require capability "taskWriter"',
    );
    await cleanup(dir);
  });

  it("notificationChannel: label returns channelId", async () => {
    const dir = await writePlugin(
      "lbl-ch",
      `{ manifest: { id: 'lbl-ch', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'lbl-ch-id', label: 'l', requires: ['pulseReader'] }] }, channels: { 'lbl-ch-id': async () => ({ success: true }) } }`,
    );
    const entry = findEntry("lbl-ch");
    expect(entry?.error).toBe(
      'notificationChannel "lbl-ch-id" cannot require capability "pulseReader"',
    );
    await cleanup(dir);
  });

  it("customMcpTool: label returns toolName", async () => {
    const dir = await writePlugin(
      "lbl-mcp",
      `{ manifest: { id: 'lbl-mcp', version: '1.0.0', description: 'x', contributions: [{ kind: 'customMcpTool', scope: 'system', toolName: 'lbl-mcp-id', description: 'x', inputSchema: {}, requires: ['pulseReader'] }] }, mcpHandlers: { 'lbl-mcp-id': async () => null } }`,
    );
    const entry = findEntry("lbl-mcp");
    expect(entry?.error).toBe(
      'customMcpTool "lbl-mcp-id" cannot require capability "pulseReader"',
    );
    await cleanup(dir);
  });

  it("customHttpRoute: label returns path", async () => {
    const dir = await writePlugin(
      "lbl-route",
      `{ manifest: { id: 'lbl-route', version: '1.0.0', description: 'x', contributions: [{ kind: 'customHttpRoute', scope: 'system', method: 'GET', path: '/lbl-route-id', requires: ['pulseReader'] }] }, routeHandlers: async () => {} }`,
    );
    const entry = findEntry("lbl-route");
    expect(entry?.error).toBe(
      'customHttpRoute "/lbl-route-id" cannot require capability "pulseReader"',
    );
    await cleanup(dir);
  });

  it("webhookFormatter: label returns formatId", async () => {
    const dir = await writePlugin(
      "lbl-fmt",
      `{ manifest: { id: 'lbl-fmt', version: '1.0.0', description: 'x', contributions: [{ kind: 'webhookFormatter', scope: 'system', formatId: 'lbl-fmt-id', label: 'l', requires: ['pulseReader'] }] }, formatters: { 'lbl-fmt-id': () => ({}) } }`,
    );
    const entry = findEntry("lbl-fmt");
    expect(entry?.error).toBe(
      'webhookFormatter "lbl-fmt-id" cannot require capability "pulseReader"',
    );
    await cleanup(dir);
  });

  it("automationCondition: label returns conditionId", async () => {
    const dir = await writePlugin(
      "lbl-cond",
      `{ manifest: { id: 'lbl-cond', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationCondition', scope: 'system', conditionId: 'lbl-cond-id', label: 'l', description: 'd', requires: ['pulseReader'] }] }, conditions: { 'lbl-cond-id': () => ({ matched: true, reason: 'x' }) } }`,
    );
    const entry = findEntry("lbl-cond");
    expect(entry?.error).toBe(
      'automationCondition "lbl-cond-id" cannot require capability "pulseReader"',
    );
    await cleanup(dir);
  });

  it("automationAction: label returns actionId", async () => {
    const dir = await writePlugin(
      "lbl-act",
      `{ manifest: { id: 'lbl-act', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationAction', scope: 'system', actionId: 'lbl-act-id', label: 'l', description: 'd', requires: ['pulseReader'] }] }, actions: { 'lbl-act-id': async () => ({ status: 'succeeded' }) } }`,
    );
    const entry = findEntry("lbl-act");
    expect(entry?.error).toBe(
      'automationAction "lbl-act-id" cannot require capability "pulseReader"',
    );
    await cleanup(dir);
  });

  it("integrationProvider: label returns provider", async () => {
    const dir = await writePlugin(
      "lbl-prov",
      `{ manifest: { id: 'lbl-prov', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'l', authMethods: ['pat'], requires: ['pulseReader'] }] }, providers: { github: { listIssues: async () => [], getIssue: async () => null } } }`,
    );
    const entry = findEntry("lbl-prov");
    expect(entry?.error).toBe(
      'integrationProvider "github" cannot require capability "pulseReader"',
    );
    await cleanup(dir);
  });
});

// ---------------------------------------------------------------------------
// Behavior 2: orphanHandler — 9/9
// For each kind, the handler-present case is verified (no error) AND the
// handler-missing case is verified (specific error string per the switch).
// Integration-provider and custom-http-route have shape variance.
// ---------------------------------------------------------------------------
describe("v0.28-T1: orphanHandler (handler present?)", () => {
  it("signalDetector: handler present → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-det-ok",
      `{ manifest: { id: 'orph-det-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'signalDetector', scope: 'habitat', detectorId: 'd1', label: 'l', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 }, requires: [] }] }, detectors: { d1: async () => [] } }`,
    );
    const entry = findEntry("orph-det-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("signalDetector: handler missing → orphan error names module.detectors", async () => {
    const dir = await writePlugin(
      "orph-det-miss",
      `{ manifest: { id: 'orph-det-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'signalDetector', scope: 'habitat', detectorId: 'd1', label: 'l', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 }, requires: [] }] } }`,
    );
    const entry = findEntry("orph-det-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'signalDetector "d1" declared but no matching handler in module.detectors',
    );
    await cleanup(dir);
  });

  it("lifecycleInterceptor: handler present → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-int-ok",
      `{ manifest: { id: 'orph-int-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i1', phase: 'post', event: 'taskCreated', priority: 0, requires: [] }] }, interceptors: { i1: async () => ({ signals: [] }) } }`,
    );
    const entry = findEntry("orph-int-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("lifecycleInterceptor: handler missing → orphan error names module.interceptors", async () => {
    const dir = await writePlugin(
      "orph-int-miss",
      `{ manifest: { id: 'orph-int-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i1', phase: 'post', event: 'taskCreated', priority: 0, requires: [] }] } }`,
    );
    const entry = findEntry("orph-int-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'lifecycleInterceptor "i1" declared but no matching handler in module.interceptors',
    );
    await cleanup(dir);
  });

  it("notificationChannel: handler present → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-ch-ok",
      `{ manifest: { id: 'orph-ch-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'c1', label: 'l', requires: [] }] }, channels: { c1: async () => ({ success: true }) } }`,
    );
    const entry = findEntry("orph-ch-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("notificationChannel: handler missing → orphan error names module.channels", async () => {
    const dir = await writePlugin(
      "orph-ch-miss",
      `{ manifest: { id: 'orph-ch-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'c1', label: 'l', requires: [] }] } }`,
    );
    const entry = findEntry("orph-ch-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'notificationChannel "c1" declared but no matching handler in module.channels',
    );
    await cleanup(dir);
  });

  it("customMcpTool: handler present → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-mcp-ok",
      `{ manifest: { id: 'orph-mcp-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'customMcpTool', scope: 'system', toolName: 't1', description: 'd', inputSchema: {}, requires: [] }] }, mcpHandlers: { t1: async () => null } }`,
    );
    const entry = findEntry("orph-mcp-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("customMcpTool: handler missing → orphan error names module.mcpHandlers", async () => {
    const dir = await writePlugin(
      "orph-mcp-miss",
      `{ manifest: { id: 'orph-mcp-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'customMcpTool', scope: 'system', toolName: 't1', description: 'd', inputSchema: {}, requires: [] }] } }`,
    );
    const entry = findEntry("orph-mcp-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'customMcpTool "t1" declared but no matching handler in module.mcpHandlers',
    );
    await cleanup(dir);
  });

  it("customHttpRoute: routeHandlers function present → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-route-ok",
      `{ manifest: { id: 'orph-route-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'customHttpRoute', scope: 'system', method: 'GET', path: '/r1', requires: [] }] }, routeHandlers: async () => {} }`,
    );
    const entry = findEntry("orph-route-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("customHttpRoute: routeHandlers missing → orphan error names routeHandlers", async () => {
    const dir = await writePlugin(
      "orph-route-miss",
      `{ manifest: { id: 'orph-route-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'customHttpRoute', scope: 'system', method: 'GET', path: '/r1', requires: [] }] } }`,
    );
    const entry = findEntry("orph-route-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      "customHttpRoute declared but module.routeHandlers is missing or not a function",
    );
    await cleanup(dir);
  });

  it("customHttpRoute: routeHandlers is an object, not a function → orphan error", async () => {
    const dir = await writePlugin(
      "orph-route-obj",
      `{ manifest: { id: 'orph-route-obj', version: '1.0.0', description: 'x', contributions: [{ kind: 'customHttpRoute', scope: 'system', method: 'GET', path: '/r2', requires: [] }] }, routeHandlers: { not: 'a function' } }`,
    );
    const entry = findEntry("orph-route-obj");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      "customHttpRoute declared but module.routeHandlers is missing or not a function",
    );
    await cleanup(dir);
  });

  it("webhookFormatter: handler present → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-fmt-ok",
      `{ manifest: { id: 'orph-fmt-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'webhookFormatter', scope: 'system', formatId: 'f1', label: 'l', requires: [] }] }, formatters: { f1: () => ({}) } }`,
    );
    const entry = findEntry("orph-fmt-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("webhookFormatter: handler missing → orphan error names module.formatters", async () => {
    const dir = await writePlugin(
      "orph-fmt-miss",
      `{ manifest: { id: 'orph-fmt-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'webhookFormatter', scope: 'system', formatId: 'f1', label: 'l', requires: [] }] } }`,
    );
    const entry = findEntry("orph-fmt-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'webhookFormatter "f1" declared but no matching handler in module.formatters',
    );
    await cleanup(dir);
  });

  it("automationCondition: handler present → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-cond-ok",
      `{ manifest: { id: 'orph-cond-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationCondition', scope: 'system', conditionId: 'c1', label: 'l', description: 'd', requires: [] }] }, conditions: { c1: () => ({ matched: true, reason: 'x' }) } }`,
    );
    const entry = findEntry("orph-cond-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("automationCondition: handler missing → orphan error names module.conditions", async () => {
    const dir = await writePlugin(
      "orph-cond-miss",
      `{ manifest: { id: 'orph-cond-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationCondition', scope: 'system', conditionId: 'c1', label: 'l', description: 'd', requires: [] }] } }`,
    );
    const entry = findEntry("orph-cond-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'automationCondition "c1" declared but no matching handler in module.conditions',
    );
    await cleanup(dir);
  });

  it("automationAction: handler present → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-act-ok",
      `{ manifest: { id: 'orph-act-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationAction', scope: 'system', actionId: 'a1', label: 'l', description: 'd', requires: [] }] }, actions: { a1: async () => ({ status: 'succeeded' }) } }`,
    );
    const entry = findEntry("orph-act-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("automationAction: handler missing → orphan error names module.actions", async () => {
    const dir = await writePlugin(
      "orph-act-miss",
      `{ manifest: { id: 'orph-act-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationAction', scope: 'system', actionId: 'a1', label: 'l', description: 'd', requires: [] }] } }`,
    );
    const entry = findEntry("orph-act-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'automationAction "a1" declared but no matching handler in module.actions',
    );
    await cleanup(dir);
  });

  it("integrationProvider: handler present (object with listIssues+getIssue) → no orphan error", async () => {
    const dir = await writePlugin(
      "orph-prov-ok",
      `{ manifest: { id: 'orph-prov-ok', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'l', authMethods: ['pat'], requires: [] }] }, providers: { github: { listIssues: async () => [], getIssue: async () => null } } }`,
    );
    const entry = findEntry("orph-prov-ok");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("integrationProvider: providers map missing → orphan error names module.providers", async () => {
    const dir = await writePlugin(
      "orph-prov-miss",
      `{ manifest: { id: 'orph-prov-miss', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'l', authMethods: ['pat'], requires: [] }] } }`,
    );
    const entry = findEntry("orph-prov-miss");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'integrationProvider "github" declared but no matching handler in module.providers',
    );
    await cleanup(dir);
  });

  it("integrationProvider: provider object missing getIssue → orphan error", async () => {
    const dir = await writePlugin(
      "orph-prov-noget",
      `{ manifest: { id: 'orph-prov-noget', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'l', authMethods: ['pat'], requires: [] }] }, providers: { github: { listIssues: async () => [] } } }`,
    );
    const entry = findEntry("orph-prov-noget");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'integrationProvider "github" declared but no matching handler in module.providers',
    );
    await cleanup(dir);
  });

  it("integrationProvider: provider object missing listIssues → orphan error", async () => {
    const dir = await writePlugin(
      "orph-prov-nolist",
      `{ manifest: { id: 'orph-prov-nolist', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'l', authMethods: ['pat'], requires: [] }] }, providers: { github: { getIssue: async () => null } } }`,
    );
    const entry = findEntry("orph-prov-nolist");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'integrationProvider "github" declared but no matching handler in module.providers',
    );
    await cleanup(dir);
  });

  it("integrationProvider: provider is a function (not object) → orphan error", async () => {
    const dir = await writePlugin(
      "orph-prov-fn",
      `{ manifest: { id: 'orph-prov-fn', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'l', authMethods: ['pat'], requires: [] }] }, providers: { github: () => {} } }`,
    );
    const entry = findEntry("orph-prov-fn");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'integrationProvider "github" declared but no matching handler in module.providers',
    );
    await cleanup(dir);
  });
});

// ---------------------------------------------------------------------------
// Behavior 3: detectIdCollisions — 7/9 (Tier-C: no tracking).
// Within-manifest duplicate id → "duplicate X within manifest" error.
// Cross-plugin duplicate id → "X already registered by another plugin" error.
// For lifecycleInterceptor: NO cross-plugin check (only within compound key).
// For detector: cross-plugin key is `${manifest.id}:${detectorId}` — but the
//   manifest-id-vs-filename check in `loadPluginFromPath` prevents two files
//   from sharing a manifest id, so cross-plugin collision is structurally
//   unreachable through disk-based loading. We assert the no-collision
//   behavior (same detectorId in two different plugin files loads both
//   successfully) since the namespaced key is the design.
// For customMcpTool/customHttpRoute: no collision tracking at all — duplicate
//   ids in one manifest and across manifests are both allowed.
// ---------------------------------------------------------------------------
describe("v0.28-T1: detectIdCollisions (within + cross-plugin)", () => {
  it("notificationChannel: within-manifest duplicate channelId → error", async () => {
    const dir = await writePlugin(
      "col-ch-within",
      `{ manifest: { id: 'col-ch-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'dup', label: 'a', requires: [] }, { kind: 'notificationChannel', scope: 'system', channelId: 'dup', label: 'b', requires: [] }] }, channels: { 'dup': async () => ({ success: true }) } }`,
    );
    const entry = findEntry("col-ch-within");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe('duplicate channelId "dup" within manifest');
    await cleanup(dir);
  });

  it("notificationChannel: cross-plugin duplicate channelId → second plugin fails with exact 'already registered' string", async () => {
    const tmpDir = `/tmp/test-char-col-ch-cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(tmpDir, { recursive: true });
    const mk = (id: string) =>
      `export default { manifest: { id: '${id}', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'shared-ch', label: 'l', requires: [] }] }, channels: { 'shared-ch': async () => ({ success: true }) } };`;
    // Filenames 'aa'/'bb' match manifest ids; assertions are order-independent
    // (readdir order is filesystem-dependent, so we pin "exactly one fails", not which).
    await writeFile(`${tmpDir}/aa.mjs`, mk("aa"));
    await writeFile(`${tmpDir}/bb.mjs`, mk("bb"));
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
    const errored = pluginManager.getLoadedPlugins().filter((p) => p.error);
    expect(errored).toHaveLength(1);
    expect(errored[0].error).toBe(
      'channelId "shared-ch" already registered by another plugin',
    );
    const loaded = pluginManager.getLoadedPlugins().filter((p) => !p.error);
    expect(loaded).toHaveLength(1);
    // readdir order is filesystem-dependent; pin exactly one of {aa,bb} fails, the other loads (not which).
    expect([errored[0].id, loaded[0].id].sort()).toEqual(["aa", "bb"]);
    await cleanup(tmpDir);
  });

  it("signalDetector: within-manifest duplicate detectorId → error", async () => {
    const dir = await writePlugin(
      "col-det-within",
      `{ manifest: { id: 'col-det-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'signalDetector', scope: 'habitat', detectorId: 'dup', label: 'a', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 }, requires: [] }, { kind: 'signalDetector', scope: 'habitat', detectorId: 'dup', label: 'b', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 }, requires: [] }] }, detectors: { 'dup': async () => [] } }`,
    );
    const entry = findEntry("col-det-within");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe('duplicate detectorId "dup" within manifest');
    await cleanup(dir);
  });

  it("signalDetector: cross-plugin same detectorId in different pluginIds → both load (namespaced key)", async () => {
    // The cross-plugin key is `${manifest.id}:${detectorId}`. Two distinct
    // plugin files with the same detectorId but different manifest.ids cannot
    // collide, by design. This pins the namespacing behavior — the second
    // plugin does NOT receive a 'already registered' error.
    const tmpDir = `/tmp/test-char-col-det-cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(tmpDir, { recursive: true });
    const mk = (id: string) =>
      `export default { manifest: { id: '${id}', version: '1.0.0', description: 'x', contributions: [{ kind: 'signalDetector', scope: 'habitat', detectorId: 'shared-det', label: 'l', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 }, requires: [] }] }, detectors: { 'shared-det': async () => [] } };`;
    await writeFile(`${tmpDir}/aa.mjs`, mk("aa"));
    await writeFile(`${tmpDir}/bb.mjs`, mk("bb"));
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
    const errors = pluginManager
      .getLoadedPlugins()
      .filter((p) => p.error?.includes("already registered"));
    expect(errors).toHaveLength(0);
    const loaded = pluginManager.getLoadedPlugins().filter((p) => !p.error);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((p) => p.id).slice().sort()).toEqual(["aa", "bb"]);
    await cleanup(tmpDir);
  });

  it("lifecycleInterceptor: within-manifest duplicate (id,phase,event) → error", async () => {
    const dir = await writePlugin(
      "col-int-within",
      `{ manifest: { id: 'col-int-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'dup', phase: 'post', event: 'taskCreated', priority: 0, requires: [] }, { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'dup', phase: 'post', event: 'taskCreated', priority: 5, requires: [] }] }, interceptors: { 'dup': async () => ({ signals: [] }) } }`,
    );
    const entry = findEntry("col-int-within");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe(
      'duplicate interceptorId "dup" (post/taskCreated) within manifest',
    );
    await cleanup(dir);
  });

  it("lifecycleInterceptor: same interceptorId in different phase/event → no within-manifest collision (compound key)", async () => {
    const dir = await writePlugin(
      "col-int-phase",
      `{ manifest: { id: 'col-int-phase', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i', phase: 'pre', event: 'taskCreated', priority: 0, requires: [] }, { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i', phase: 'post', event: 'taskCreated', priority: 0, requires: [] }] }, interceptors: { 'i': async () => ({ allow: true }) } }`,
    );
    // The pre-phase handler can return {allow:true}; the post-phase returns signals.
    // Both register under compound keys (`interceptor:i:pre:taskCreated` and
    // `interceptor:i:post:taskCreated`) so no within-manifest collision.
    const entry = findEntry("col-int-phase");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("lifecycleInterceptor: cross-plugin same (id,phase,event) → NO cross-plugin check (allowed)", async () => {
    const tmpDir = `/tmp/test-char-col-int-cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(tmpDir, { recursive: true });
    const mk = (id: string) =>
      `export default { manifest: { id: '${id}', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i', phase: 'post', event: 'taskCreated', priority: 0, requires: [] }] }, interceptors: { 'i': async () => ({ signals: [] }) } };`;
    await writeFile(`${tmpDir}/aa.mjs`, mk("aa"));
    await writeFile(`${tmpDir}/bb.mjs`, mk("bb"));
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
    const errors = pluginManager
      .getLoadedPlugins()
      .filter((p) => p.error?.includes("already registered"));
    expect(errors).toHaveLength(0);
    const loaded = pluginManager.getLoadedPlugins().filter((p) => !p.error);
    expect(loaded).toHaveLength(2);
    expect(loaded.map((p) => p.id).slice().sort()).toEqual(["aa", "bb"]);
    await cleanup(tmpDir);
  });

  it("webhookFormatter: within-manifest duplicate formatId → error", async () => {
    const dir = await writePlugin(
      "col-fmt-within",
      `{ manifest: { id: 'col-fmt-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'webhookFormatter', scope: 'system', formatId: 'dup', label: 'a', requires: [] }, { kind: 'webhookFormatter', scope: 'system', formatId: 'dup', label: 'b', requires: [] }] }, formatters: { 'dup': () => ({}) } }`,
    );
    const entry = findEntry("col-fmt-within");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe('duplicate formatId "dup" within manifest');
    await cleanup(dir);
  });

  it("webhookFormatter: cross-plugin duplicate formatId → exact 'already registered by another plugin' string", async () => {
    const tmpDir = `/tmp/test-char-col-fmt-cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(tmpDir, { recursive: true });
    const mk = (id: string) =>
      `export default { manifest: { id: '${id}', version: '1.0.0', description: 'x', contributions: [{ kind: 'webhookFormatter', scope: 'system', formatId: 'shared-fmt', label: 'l', requires: [] }] }, formatters: { 'shared-fmt': () => ({}) } };`;
    await writeFile(`${tmpDir}/aa.mjs`, mk("aa"));
    await writeFile(`${tmpDir}/bb.mjs`, mk("bb"));
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
    const errored = pluginManager.getLoadedPlugins().filter((p) => p.error);
    expect(errored).toHaveLength(1);
    expect(errored[0].error).toBe(
      'formatId "shared-fmt" already registered by another plugin',
    );
    const loaded = pluginManager.getLoadedPlugins().filter((p) => !p.error);
    expect(loaded).toHaveLength(1);
    expect([errored[0].id, loaded[0].id].sort()).toEqual(["aa", "bb"]);
    await cleanup(tmpDir);
  });

  it("automationCondition: within-manifest duplicate conditionId → error", async () => {
    const dir = await writePlugin(
      "col-cond-within",
      `{ manifest: { id: 'col-cond-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationCondition', scope: 'system', conditionId: 'dup', label: 'a', description: 'd', requires: [] }, { kind: 'automationCondition', scope: 'system', conditionId: 'dup', label: 'b', description: 'd', requires: [] }] }, conditions: { 'dup': () => ({ matched: true, reason: 'x' }) } }`,
    );
    const entry = findEntry("col-cond-within");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe('duplicate conditionId "dup" within manifest');
    await cleanup(dir);
  });

  it("automationCondition: cross-plugin duplicate conditionId → exact 'already registered by another plugin' string", async () => {
    const tmpDir = `/tmp/test-char-col-cond-cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(tmpDir, { recursive: true });
    const mk = (id: string) =>
      `export default { manifest: { id: '${id}', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationCondition', scope: 'system', conditionId: 'shared-cond', label: 'l', description: 'd', requires: [] }] }, conditions: { 'shared-cond': () => ({ matched: true, reason: 'x' }) } };`;
    await writeFile(`${tmpDir}/aa.mjs`, mk("aa"));
    await writeFile(`${tmpDir}/bb.mjs`, mk("bb"));
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
    const errored = pluginManager.getLoadedPlugins().filter((p) => p.error);
    expect(errored).toHaveLength(1);
    expect(errored[0].error).toBe(
      'conditionId "shared-cond" already registered by another plugin',
    );
    const loaded = pluginManager.getLoadedPlugins().filter((p) => !p.error);
    expect(loaded).toHaveLength(1);
    expect([errored[0].id, loaded[0].id].sort()).toEqual(["aa", "bb"]);
    await cleanup(tmpDir);
  });

  it("automationAction: within-manifest duplicate actionId → error", async () => {
    const dir = await writePlugin(
      "col-act-within",
      `{ manifest: { id: 'col-act-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationAction', scope: 'system', actionId: 'dup', label: 'a', description: 'd', requires: [] }, { kind: 'automationAction', scope: 'system', actionId: 'dup', label: 'b', description: 'd', requires: [] }] }, actions: { 'dup': async () => ({ status: 'succeeded' }) } }`,
    );
    const entry = findEntry("col-act-within");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe('duplicate actionId "dup" within manifest');
    await cleanup(dir);
  });

  it("automationAction: cross-plugin duplicate actionId → exact 'already registered by another plugin' string", async () => {
    const tmpDir = `/tmp/test-char-col-act-cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(tmpDir, { recursive: true });
    const mk = (id: string) =>
      `export default { manifest: { id: '${id}', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationAction', scope: 'system', actionId: 'shared-act', label: 'l', description: 'd', requires: [] }] }, actions: { 'shared-act': async () => ({ status: 'succeeded' }) } };`;
    await writeFile(`${tmpDir}/aa.mjs`, mk("aa"));
    await writeFile(`${tmpDir}/bb.mjs`, mk("bb"));
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
    const errored = pluginManager.getLoadedPlugins().filter((p) => p.error);
    expect(errored).toHaveLength(1);
    expect(errored[0].error).toBe(
      'actionId "shared-act" already registered by another plugin',
    );
    const loaded = pluginManager.getLoadedPlugins().filter((p) => !p.error);
    expect(loaded).toHaveLength(1);
    expect([errored[0].id, loaded[0].id].sort()).toEqual(["aa", "bb"]);
    await cleanup(tmpDir);
  });

  it("integrationProvider: within-manifest duplicate provider → error", async () => {
    const dir = await writePlugin(
      "col-prov-within",
      `{ manifest: { id: 'col-prov-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'a', authMethods: ['pat'], requires: [] }, { kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'b', authMethods: ['pat'], requires: [] }] }, providers: { github: { listIssues: async () => [], getIssue: async () => null } } }`,
    );
    const entry = findEntry("col-prov-within");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe('duplicate provider "github" within manifest');
    await cleanup(dir);
  });

  it("integrationProvider: cross-plugin duplicate provider → exact 'already registered by another plugin' string", async () => {
    const tmpDir = `/tmp/test-char-col-prov-cross-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await mkdir(tmpDir, { recursive: true });
    const mk = (id: string, provider: string) =>
      `export default { manifest: { id: '${id}', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: '${provider}', label: 'l', authMethods: ['pat'], requires: [] }] }, providers: { '${provider}': { listIssues: async () => [], getIssue: async () => null } } };`;
    await writeFile(`${tmpDir}/aa.mjs`, mk("aa", "github"));
    await writeFile(`${tmpDir}/bb.mjs`, mk("bb", "github"));
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
    const errored = pluginManager.getLoadedPlugins().filter((p) => p.error);
    expect(errored).toHaveLength(1);
    expect(errored[0].error).toBe(
      'provider "github" already registered by another plugin',
    );
    const loaded = pluginManager.getLoadedPlugins().filter((p) => !p.error);
    expect(loaded).toHaveLength(1);
    expect([errored[0].id, loaded[0].id].sort()).toEqual(["aa", "bb"]);
    await cleanup(tmpDir);
  });

  it("customMcpTool: NO collision tracking — duplicate toolName in same manifest loads", async () => {
    // Tier-C kind: no collision tracking, no error.
    const dir = await writePlugin(
      "col-mcp-within",
      `{ manifest: { id: 'col-mcp-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'customMcpTool', scope: 'system', toolName: 'same', description: 'a', inputSchema: {}, requires: [] }, { kind: 'customMcpTool', scope: 'system', toolName: 'same', description: 'b', inputSchema: {}, requires: [] }] }, mcpHandlers: { 'same': async () => null } }`,
    );
    const entry = findEntry("col-mcp-within");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("customHttpRoute: NO collision tracking — duplicate path in same manifest loads", async () => {
    // Tier-C kind: no collision tracking, no error.
    const dir = await writePlugin(
      "col-route-within",
      `{ manifest: { id: 'col-route-within', version: '1.0.0', description: 'x', contributions: [{ kind: 'customHttpRoute', scope: 'system', method: 'GET', path: '/dup', requires: [] }, { kind: 'customHttpRoute', scope: 'system', method: 'POST', path: '/dup', requires: [] }] }, routeHandlers: async () => {} }`,
    );
    const entry = findEntry("col-route-within");
    expect(entry?.error).toBeUndefined();
    await cleanup(dir);
  });

  it("multi-contribution manifest: first-error ordering is preserved (channel wins over later duplicate channel)", async () => {
    // Two duplicate channels → second one trips the within-manifest check.
    // The first error returned names the SECOND contribution's id, not the
    // first's, because the loop hits the duplicate on iteration 2.
    const dir = await writePlugin(
      "col-multi-order",
      `{ manifest: { id: 'col-multi-order', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'first', label: 'l1', requires: [] }, { kind: 'notificationChannel', scope: 'system', channelId: 'first', label: 'l2', requires: [] }] }, channels: { 'first': async () => ({ success: true }) } }`,
    );
    const entry = findEntry("col-multi-order");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe('duplicate channelId "first" within manifest');
    await cleanup(dir);
  });

  it("multi-contribution manifest: differing kinds with first-kind id collision trips first-kind branch", async () => {
    // Two channels, then a third channel with the same id as the second.
    // The within-manifest set uses prefixed keys per-kind so the
    // `channel:` namespace is what's checked.
    const dir = await writePlugin(
      "col-multi-mix",
      `{ manifest: { id: 'col-multi-mix', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'alpha', label: 'l', requires: [] }, { kind: 'webhookFormatter', scope: 'system', formatId: 'beta', label: 'l', requires: [] }, { kind: 'notificationChannel', scope: 'system', channelId: 'alpha', label: 'l2', requires: [] }] }, channels: { 'alpha': async () => ({ success: true }) }, formatters: { 'beta': () => ({}) } }`,
    );
    const entry = findEntry("col-multi-mix");
    expect(entry?.error).toBeDefined();
    expect(entry?.error).toBe('duplicate channelId "alpha" within manifest');
    await cleanup(dir);
  });

  it("multi-contribution cross-kind: TWO real collisions present, formatter-dup at pos 3 wins over channel-dup at pos 4", async () => {
    // Manifest order: [formatter-beta, channel-alpha, formatter-beta-dup, channel-alpha-dup]
    // Iteration: formatter-beta adds `formatter:beta`; channel-alpha adds `channel:alpha`.
    // formatter-beta-dup (pos 3) hits `formatter:beta` in seen → returns error.
    // channel-alpha-dup (pos 4) is never reached.
    // Pins "manifest order wins" — pos 3 trips before pos 4 regardless of kind.
    const dir = await writePlugin(
      "col-xkind-fmt-wins",
      `{ manifest: { id: 'col-xkind-fmt-wins', version: '1.0.0', description: 'x', contributions: [
        { kind: 'webhookFormatter', scope: 'system', formatId: 'beta', label: 'l', requires: [] },
        { kind: 'notificationChannel', scope: 'system', channelId: 'alpha', label: 'l', requires: [] },
        { kind: 'webhookFormatter', scope: 'system', formatId: 'beta', label: 'l2', requires: [] },
        { kind: 'notificationChannel', scope: 'system', channelId: 'alpha', label: 'l2', requires: [] }
      ] }, formatters: { 'beta': () => ({}) }, channels: { 'alpha': async () => ({ success: true }) } }`,
    );
    const entry = findEntry("col-xkind-fmt-wins");
    expect(entry?.error).toBe('duplicate formatId "beta" within manifest');
    await cleanup(dir);
  });

  it("multi-contribution cross-kind (inverse): TWO real collisions present, channel-dup at pos 3 wins over formatter-dup at pos 4", async () => {
    // Inverse of the previous test — channel-dup comes first in manifest order.
    // Manifest order: [channel-alpha, formatter-beta, channel-alpha-dup, formatter-beta-dup]
    // Iteration: channel-alpha adds `channel:alpha`; formatter-beta adds `formatter:beta`.
    // channel-alpha-dup (pos 3) hits `channel:alpha` in seen → returns error.
    // formatter-beta-dup (pos 4) is never reached.
    // This proves the contract is "manifest order wins", not "kind order wins".
    const dir = await writePlugin(
      "col-xkind-ch-wins",
      `{ manifest: { id: 'col-xkind-ch-wins', version: '1.0.0', description: 'x', contributions: [
        { kind: 'notificationChannel', scope: 'system', channelId: 'alpha', label: 'l', requires: [] },
        { kind: 'webhookFormatter', scope: 'system', formatId: 'beta', label: 'l', requires: [] },
        { kind: 'notificationChannel', scope: 'system', channelId: 'alpha', label: 'l2', requires: [] },
        { kind: 'webhookFormatter', scope: 'system', formatId: 'beta', label: 'l2', requires: [] }
      ] }, channels: { 'alpha': async () => ({ success: true }) }, formatters: { 'beta': () => ({}) } }`,
    );
    const entry = findEntry("col-xkind-ch-wins");
    expect(entry?.error).toBe('duplicate channelId "alpha" within manifest');
    await cleanup(dir);
  });
});

// ---------------------------------------------------------------------------
// validatePlugin check order — multi-violation fixtures.
// The current `validatePlugin` (pluginManager.ts:350-388) checks each
// contribution in this exact order:
//   1. VALID_KINDS membership of c.kind
//   2. c.requires is an array
//   3. every cap in c.requires is in VALID_CAPABILITIES
//   4. capabilityMatrixViolation (matrix + forbiddenByPhase)
//   5. orphanHandler
// The fixtures below pair the target violation with a missing handler so that
// if any later check ran first, the error would change. Each fixture asserts
// the EARLIEST error in the chain, byte-for-byte.
// ---------------------------------------------------------------------------
describe("v0.28-T1: validatePlugin check order (multi-violation)", () => {
  it("requires-not-array beats unknown-capability and orphan (notificationChannel)", async () => {
    // c.requires = "not-array" trips check #2 first. orphan (missing handler) is
    // the LAST check; if any later check ran first, the orphan error would win.
    const dir = await writePlugin(
      "ord-requires-not-array",
      `{ manifest: { id: 'ord-requires-not-array', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'ord-ch', label: 'l', requires: 'not-array' }] } }`,
    );
    const entry = findEntry("ord-requires-not-array");
    expect(entry?.error).toBe("Contribution requires must be an array");
    await cleanup(dir);
  });

  it("unknown-capability beats capability-matrix and orphan (notificationChannel)", async () => {
    // "notACapability" trips check #3 first. Even though pulseReader would
    // also fail matrix (channel allows only chatIntegrationReader) AND the
    // handler is missing, the unknown-capability error wins because it's checked
    // before both.
    const dir = await writePlugin(
      "ord-unknown-cap",
      `{ manifest: { id: 'ord-unknown-cap', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'ord-ch', label: 'l', requires: ['notACapability', 'pulseReader'] }] } }`,
    );
    const entry = findEntry("ord-unknown-cap");
    expect(entry?.error).toBe(
      'Unknown capability "notACapability" in contribution requires',
    );
    await cleanup(dir);
  });

  it("capability-matrix beat orphan (notificationChannel with disallowed pulseReader + missing handler)", async () => {
    // pulseReader is in VALID_CAPABILITIES but not in notificationChannel.allowed.
    // The handler is intentionally missing so orphan would be the LAST error.
    // check #4 (capability matrix) trips before check #5 (orphan).
    const dir = await writePlugin(
      "ord-matrix-beats-orphan",
      `{ manifest: { id: 'ord-matrix-beats-orphan', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'ord-ch', label: 'l', requires: ['pulseReader'] }] } }`,
    );
    const entry = findEntry("ord-matrix-beats-orphan");
    expect(entry?.error).toBe(
      'notificationChannel "ord-ch" cannot require capability "pulseReader"',
    );
    await cleanup(dir);
  });

  it("forbidden-by-phase beats allowed-check and orphan (pre lifecycleInterceptor with pulseWriter)", async () => {
    // For pre-phase lifecycleInterceptor, `forbiddenByPhase.pre = ["pulseWriter"]`
    // trips BEFORE the allowed-check (matrix) and BEFORE orphan. The handler is
    // intentionally missing to prove forbidden-by-phase wins over orphan.
    const dir = await writePlugin(
      "ord-forbidden-beats-orphan",
      `{ manifest: { id: 'ord-forbidden-beats-orphan', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'ord-int', phase: 'pre', event: 'taskCreated', priority: 0, requires: ['pulseWriter'] }] } }`,
    );
    const entry = findEntry("ord-forbidden-beats-orphan");
    expect(entry?.error).toBe(
      'lifecycleInterceptor "ord-int" is pre-phase and cannot require "pulseWriter"',
    );
    await cleanup(dir);
  });
});

// ---------------------------------------------------------------------------
// Behavior 4: register → getter round-trip — 5/9 (Tier-A/B registry kinds).
// - notificationChannel → getChannelHandler
// - signalDetector → getDetectorEntry (key is `${pluginId}:${detectorId}`)
// - lifecycleInterceptor → registry priority sort (no exported getter;
//   verified via minimum-viable dispatch observation in the dedicated
//   sub-describe at the bottom of this file, which uses a real DB so
//   `isEnrolled` returns true and the handlers can fire)
// - webhookFormatter → getFormatterHandler
// - automationCondition → getConditionHandler
// - automationAction → getActionEntry
// - integrationProvider → getProviderAdapter
// Tier-C kinds (customMcpTool, customHttpRoute) are explicitly NOT asserted
// here per the ticket.
// ---------------------------------------------------------------------------
describe("v0.28-T1: register → getter round-trip (registry kinds)", () => {
  it("notificationChannel: getChannelHandler returns the registered handler", async () => {
    const dir = await writePlugin(
      "rt-ch",
      `{ manifest: { id: 'rt-ch', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'rt-ch-id', label: 'l', requires: [] }] }, channels: { 'rt-ch-id': async () => ({ success: true, attemptId: 'att-1' }) } }`,
    );
    const handler = pluginManager.getChannelHandler("rt-ch-id");
    expect(handler).toBeTypeOf("function");
    const result = await handler!(
      { runId: "x" } as never,
      { delivery: {} as never, event: {} as never },
    );
    expect(result).toEqual({ success: true, attemptId: "att-1" });
    await cleanup(dir);
  });

  it("signalDetector: getDetectorEntry returns entry with namespaced key `pluginId:detectorId`", async () => {
    const dir = await writePlugin(
      "rt-det",
      `{ manifest: { id: 'rt-det', version: '1.0.0', description: 'x', contributions: [{ kind: 'signalDetector', scope: 'habitat', detectorId: 'rt-det-id', label: 'l', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 }, requires: [] }] }, detectors: { 'rt-det-id': async () => [] } }`,
    );
    const entry = pluginManager.getDetectorEntry("rt-det:rt-det-id");
    expect(entry).not.toBeNull();
    expect(entry!.pluginId).toBe("rt-det");
    expect(entry!.contribution.kind).toBe("signalDetector");
    expect(entry!.contribution.detectorId).toBe("rt-det-id");
    expect(entry!.handler).toBeTypeOf("function");
    // Miss for non-namespaced key or wrong pluginId
    expect(pluginManager.getDetectorEntry("rt-det-id")).toBeNull();
    expect(pluginManager.getDetectorEntry("other:rt-det-id")).toBeNull();
    await cleanup(dir);
  });

  it("webhookFormatter: getFormatterHandler returns the registered handler", async () => {
    const dir = await writePlugin(
      "rt-fmt",
      `{ manifest: { id: 'rt-fmt', version: '1.0.0', description: 'x', contributions: [{ kind: 'webhookFormatter', scope: 'system', formatId: 'rt-fmt-id', label: 'l', requires: [] }] }, formatters: { 'rt-fmt-id': (enrichment, eventType) => ({ kind: 'rt', eventType }) } }`,
    );
    const handler = pluginManager.getFormatterHandler("rt-fmt-id");
    expect(handler).toBeTypeOf("function");
    const out = (handler as (e: unknown, et: string) => object)({}, "task.assigned");
    expect(out).toEqual({ kind: "rt", eventType: "task.assigned" });
    // Miss → undefined
    expect(pluginManager.getFormatterHandler("nonexistent")).toBeUndefined();
    await cleanup(dir);
  });

  it("automationCondition: getConditionHandler returns the registered handler", async () => {
    const dir = await writePlugin(
      "rt-cond",
      `{ manifest: { id: 'rt-cond', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationCondition', scope: 'system', conditionId: 'rt-cond-id', label: 'l', description: 'd', requires: [] }] }, conditions: { 'rt-cond-id': () => ({ matched: true, reason: 'rt' }) } }`,
    );
    const handler = pluginManager.getConditionHandler("rt-cond-id");
    expect(handler).toBeTypeOf("function");
    const out = (handler as (e: unknown, p: unknown) => { matched: boolean })({}, {});
    expect(out).toEqual({ matched: true, reason: "rt" });
    expect(pluginManager.getConditionHandler("nonexistent")).toBeUndefined();
    await cleanup(dir);
  });

  it("automationAction: getActionEntry returns entry with handler + pluginId + (optional) timeoutMs", async () => {
    const dir = await writePlugin(
      "rt-act",
      `{ manifest: { id: 'rt-act', version: '1.0.0', description: 'x', contributions: [{ kind: 'automationAction', scope: 'system', actionId: 'rt-act-id', label: 'l', description: 'd', timeoutMs: 1234, requires: [] }] }, actions: { 'rt-act-id': async () => ({ status: 'succeeded' }) } }`,
    );
    const entry = pluginManager.getActionEntry("rt-act-id");
    expect(entry).not.toBeNull();
    expect(entry!.pluginId).toBe("rt-act");
    expect(entry!.handler).toBeTypeOf("function");
    expect(entry!.timeoutMs).toBe(1234);
    expect(pluginManager.getActionEntry("nonexistent")).toBeNull();
    await cleanup(dir);
  });

  it("integrationProvider: getProviderAdapter returns the registered adapter with listIssues+getIssue", async () => {
    const dir = await writePlugin(
      "rt-prov",
      `{ manifest: { id: 'rt-prov', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'l', authMethods: ['pat'], requires: [] }] }, providers: { github: { listIssues: async () => [{ provider: 'github', externalId: '1', externalKey: 'g1', title: 't', body: '', status: 'open', labels: [], url: 'https://e/1', updatedAt: '2024-01-01' }], getIssue: async () => null } } }`,
    );
    const adapter = pluginManager.getProviderAdapter("github");
    expect(adapter).not.toBeNull();
    expect(typeof adapter!.listIssues).toBe("function");
    expect(typeof adapter!.getIssue).toBe("function");
    const issues = await adapter!.listIssues({} as never);
    expect(issues).toHaveLength(1);
    expect(issues[0].provider).toBe("github");
    expect(pluginManager.getProviderAdapter("jira")).toBeNull();
    await cleanup(dir);
  });

  it("customMcpTool: getCustomMcpTools surfaces the tool definition (no handler getter)", async () => {
    // Tier-C: not a getter round-trip on a handler; the contribution is
    // surfaced through getCustomMcpTools() per the ticket.
    const dir = await writePlugin(
      "rt-mcp",
      `{ manifest: { id: 'rt-mcp', version: '1.0.0', description: 'x', contributions: [{ kind: 'customMcpTool', scope: 'system', toolName: 'rt-mcp-id', description: 'rt desc', inputSchema: { type: 'object' }, requires: [] }] }, mcpHandlers: { 'rt-mcp-id': async () => null } }`,
    );
    const tools = pluginManager.getCustomMcpTools();
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      name: "rt-mcp-id",
      description: "rt desc",
      inputSchema: { type: "object" },
    });
    await cleanup(dir);
  });
});

// ---------------------------------------------------------------------------
// Interceptor priority sort — observed via minimum-viable dispatch.
//
// There is no exported getter for the lifecycleInterceptor registry. The
// priority sort is observable by loading multiple interceptors for the same
// event with different priorities, then driving `runPreInterceptors` and
// capturing the call order through a global side-channel populated by the
// handlers themselves.
//
// To make `isEnrolled` return true, we use a real DB (`initTestDb` +
// `enrollmentRepo.create` + `invalidateEnrollmentCache`) — the file-level
// `vi.mock` of `enrollmentRepo` is restored per-test so the real repo runs.
// ---------------------------------------------------------------------------
describe("v0.28-T1: register round-trip (lifecycleInterceptor priority sort)", () => {
  beforeEach(async () => {
    pluginManager.resetPlugins();
    await initTestDb();
  });

  afterEach(async () => {
    pluginManager.resetPlugins();
    closeDb();
    delete (globalThis as { __intCalls?: string[] }).__intCalls;
  });

  it("pre-phase handlers are iterated in priority-ascending order after insert (5,1,3 → 1,3,5)", async () => {
    // The plugin module pushes its interceptorId into globalThis.__intCalls
    // each time the handler runs, so we can observe the call order.
    const dir = await writePlugin(
      "rt-int-prio",
      `{
        manifest: {
          id: 'rt-int-prio',
          version: '1.0.0',
          description: 'priority sort',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i-pri-5', phase: 'pre', event: 'taskClaimed', priority: 5, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i-pri-1', phase: 'pre', event: 'taskClaimed', priority: 1, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i-pri-3', phase: 'pre', event: 'taskClaimed', priority: 3, requires: [] },
          ],
        },
        interceptors: {
          'i-pri-5': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('i-pri-5'); return { allow: true }; },
          'i-pri-1': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('i-pri-1'); return { allow: true }; },
          'i-pri-3': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('i-pri-3'); return { allow: true }; },
        },
      }`,
    );

    // Create a habitat and enroll the rt-int-prio plugin for the same event
    // so isEnrolled() returns true when runPreInterceptors iterates.
    const { createHabitat } = await import("../repositories/habitat.js");
    const { create: createEnrollment } = await import(
      "../repositories/pluginEnrollment.js"
    );
    const habitat = createHabitat({ name: "rt-int-prio habitat" });
    createEnrollment({
      habitatId: habitat.id,
      pluginId: "rt-int-prio",
      contributionId: "i-pri-1",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    createEnrollment({
      habitatId: habitat.id,
      pluginId: "rt-int-prio",
      contributionId: "i-pri-3",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    createEnrollment({
      habitatId: habitat.id,
      pluginId: "rt-int-prio",
      contributionId: "i-pri-5",
      contributionKind: "lifecycleInterceptor",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitat.id);

    const result = pluginManager.runPreInterceptors("task-x", "taskClaimed", habitat.id, {
      actor: "test",
    } as never);
    expect(result).toBeNull();
    expect((globalThis as { __intCalls?: string[] }).__intCalls).toEqual([
      "i-pri-1",
      "i-pri-3",
      "i-pri-5",
    ]);

    await cleanup(dir);
  });

  it("post-phase handlers are iterated in priority-ascending order after insert", async () => {
    // runPostInterceptors is fire-and-forget; we await a microtask so the
    // dispatch chain (which calls startPluginRun and createDetectedSignal)
    // has a chance to complete. The plugin's contribution `requires:[]`
    // so buildPluginContext has no capabilities, and the handler returns
    // synchronously to keep the test deterministic.
    const dir = await writePlugin(
      "rt-int-post",
      `{
        manifest: {
          id: 'rt-int-post',
          version: '1.0.0',
          description: 'post priority sort',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'p-pri-7', phase: 'post', event: 'taskClaimed', priority: 7, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'p-pri-2', phase: 'post', event: 'taskClaimed', priority: 2, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'p-pri-4', phase: 'post', event: 'taskClaimed', priority: 4, requires: [] },
          ],
        },
        interceptors: {
          'p-pri-7': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('p-pri-7'); return { signals: [] }; },
          'p-pri-2': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('p-pri-2'); return { signals: [] }; },
          'p-pri-4': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('p-pri-4'); return { signals: [] }; },
        },
      }`,
    );

    const { createHabitat } = await import("../repositories/habitat.js");
    const { create: createEnrollment } = await import(
      "../repositories/pluginEnrollment.js"
    );
    const habitat = createHabitat({ name: "rt-int-post habitat" });
    for (const cid of ["p-pri-2", "p-pri-4", "p-pri-7"]) {
      createEnrollment({
        habitatId: habitat.id,
        pluginId: "rt-int-post",
        contributionId: cid,
        contributionKind: "lifecycleInterceptor",
        enrolledBy: "test",
        enabled: 1,
      });
    }
    pluginManager.invalidateEnrollmentCache(habitat.id);

    pluginManager.runPostInterceptors("task-y", "taskClaimed", habitat.id, {
      actor: "test",
    } as never);
    // Give the fire-and-forget dispatch chain a few microtask ticks to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((globalThis as { __intCalls?: string[] }).__intCalls).toEqual([
      "p-pri-2",
      "p-pri-4",
      "p-pri-7",
    ]);

    await cleanup(dir);
  });
});
