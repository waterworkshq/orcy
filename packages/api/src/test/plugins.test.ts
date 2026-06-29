import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as pluginManager from "../plugins/pluginManager.js";

async function cleanup(tmpDir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
}

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-plugins-${name}-${Date.now()}`;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(tmpDir, { recursive: true });
  const code = `export default ${moduleBody};`;
  await writeFile(`${tmpDir}/${name}.mjs`, code);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

const validManifest = (id: string) => `{
  manifest: {
    id: '${id}',
    version: '1.0.0',
    description: 'test plugin',
    contributions: [
      { kind: 'notificationChannel', scope: 'system', channelId: '${id}-ch', label: '${id} channel', requires: [] },
    ],
  },
  channels: { '${id}-ch': async () => ({ success: true }) },
}`;

describe("Plugin Manager (v0.22 manifest contract)", () => {
  beforeEach(() => pluginManager.resetPlugins());
  afterEach(() => pluginManager.resetPlugins());

  describe("getLoadedPlugins", () => {
    it("returns empty array when no plugins loaded", () => {
      expect(pluginManager.getLoadedPlugins()).toEqual([]);
    });

    it("returns manifest views with id/version/description", async () => {
      const dir = await writePlugin("view-test", validManifest("view-test"));
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].id).toBe("view-test");
      expect(loaded[0].version).toBe("1.0.0");
      expect(loaded[0].description).toBe("test plugin");
      expect(loaded[0].error).toBeUndefined();
      await cleanup(dir);
    });
  });

  describe("loadPlugins", () => {
    it("does nothing when plugin directory does not exist", async () => {
      pluginManager.setPluginDirectory("/nonexistent/path");
      await pluginManager.loadPlugins();
      expect(pluginManager.getLoadedPlugins()).toEqual([]);
    });

    it("records error for manifest missing id", async () => {
      const dir = await writePlugin(
        "no-id",
        `{ manifest: { id: '', version: '1.0.0', description: 'x', contributions: [] } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].error).toBeDefined();
      expect(loaded[0].error).toBeTruthy();
      await cleanup(dir);
    });

    it("records error for manifest with empty contributions", async () => {
      const dir = await writePlugin(
        "empty-contrib",
        `{ manifest: { id: 'empty-contrib', version: '1.0.0', description: 'x', contributions: [] } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      await cleanup(dir);
    });

    it("records error for invalid contribution kind", async () => {
      const dir = await writePlugin(
        "bad-kind",
        `{ manifest: { id: 'bad-kind', version: '1.0.0', description: 'x', contributions: [{ kind: 'mystery', requires: [] }] } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      await cleanup(dir);
    });

    it("records error for orphan handler (channel declared but no handler)", async () => {
      const dir = await writePlugin(
        "orphan",
        `{ manifest: { id: 'orphan', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'orphan-ch', label: 'x', requires: [] }] } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      expect(loaded[0].error).toContain("no matching handler");
      await cleanup(dir);
    });

    it("records error for plugin id mismatch", async () => {
      const dir = await writePlugin(
        "right-name",
        `{ manifest: { id: 'wrong-name', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'c', label: 'l', requires: [] }] }, channels: { c: async () => ({ success: true }) } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      expect(loaded[0].error).toContain("mismatch");
      await cleanup(dir);
    });
  });

  describe("capability matrix enforcement", () => {
    it("refuses signalDetector requiring notificationPayload-style capability", async () => {
      const dir = await writePlugin(
        "bad-cap",
        `{ manifest: { id: 'bad-cap', version: '1.0.0', description: 'x', contributions: [{ kind: 'signalDetector', scope: 'habitat', detectorId: 'd1', label: 'l', detects: 'pulseCreated', rateLimitDefaults: { maxDetectionsPerMinute: 10, maxSignalsPerHour: 100 }, requires: ['habitatReader'] }] }, detectors: { d1: async () => [] } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      await cleanup(dir);
    });

    it("refuses pre-phase lifecycleInterceptor requiring pulseWriter", async () => {
      const dir = await writePlugin(
        "bad-pre",
        `{ manifest: { id: 'bad-pre', version: '1.0.0', description: 'x', contributions: [{ kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'i1', phase: 'pre', event: 'taskCreated', priority: 0, requires: ['pulseWriter'] }] }, interceptors: { i1: async () => ({ allow: true }) } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      expect(loaded[0].error).toContain("pulseWriter");
      await cleanup(dir);
    });

    it("refuses notificationChannel declaring requires", async () => {
      const dir = await writePlugin(
        "bad-chan",
        `{ manifest: { id: 'bad-chan', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'c', label: 'l', requires: ['pulseReader'] }] } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      await cleanup(dir);
    });
  });

  describe("id collision refusal", () => {
    it("refuses a channelId already registered by another plugin", async () => {
      const tmpDir = `/tmp/test-plugins-collide-${Date.now()}`;
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(tmpDir, { recursive: true });
      const mk = (id: string) =>
        `export default { manifest: { id: '${id}', version: '1.0.0', description: 'x', contributions: [{ kind: 'notificationChannel', scope: 'system', channelId: 'shared-ch', label: 'l', requires: [] }] }, channels: { 'shared-ch': async () => ({ success: true }) } };`;
      await writeFile(`${tmpDir}/plugin-a.mjs`, mk("plugin-a"));
      await writeFile(`${tmpDir}/plugin-b.mjs`, mk("plugin-b"));
      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();
      const loaded = pluginManager.getLoadedPlugins().filter((p) => !p.error);
      expect(loaded).toHaveLength(1);
      await cleanup(tmpDir);
    });
  });

  describe("old KanbanPlugin shape refusal", () => {
    it("refuses the v0.21 KanbanPlugin shape", async () => {
      const dir = await writePlugin(
        "legacy",
        `{ name: 'legacy', version: '1.0.0', hooks: { onTaskCreated: () => {} } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      await cleanup(dir);
    });
  });

  describe("getCustomMcpTools", () => {
    it("surfaces customMcpTool contributions for display", async () => {
      const dir = await writePlugin(
        "mcp-tool",
        `{ manifest: { id: 'mcp-tool', version: '1.0.0', description: 'x', contributions: [{ kind: 'customMcpTool', scope: 'system', toolName: 'my_tool', description: 'does a thing', inputSchema: { type: 'object' }, requires: [] }] }, mcpHandlers: { my_tool: async () => null } }`,
      );
      const tools = pluginManager.getCustomMcpTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe("my_tool");
      await cleanup(dir);
    });

    it("returns empty array when no plugins declare MCP tools", () => {
      expect(pluginManager.getCustomMcpTools()).toEqual([]);
    });
  });

  describe("resetPlugins", () => {
    it("clears all loaded plugins", async () => {
      const dir = await writePlugin("reset-me", validManifest("reset-me"));
      expect(pluginManager.getLoadedPlugins()).toHaveLength(1);
      pluginManager.resetPlugins();
      expect(pluginManager.getLoadedPlugins()).toEqual([]);
      await cleanup(dir);
    });
  });
});
