import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as pluginManager from "../plugins/pluginManager.js";

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
