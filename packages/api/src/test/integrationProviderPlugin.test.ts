import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as pluginManager from "../plugins/pluginManager.js";

async function cleanup(tmpDir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(tmpDir, { recursive: true, force: true });
}

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-provider-${name}-${Date.now()}`;
  const { mkdir, writeFile } = await import("node:fs/promises");
  await mkdir(tmpDir, { recursive: true });
  const code = `export default ${moduleBody};`;
  await writeFile(`${tmpDir}/${name}.mjs`, code);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

const providerManifest = (id: string, provider: string) => `{
  manifest: {
    id: '${id}',
    version: '1.0.0',
    description: '${provider} provider plugin',
    contributions: [
      { kind: 'integrationProvider', scope: 'system', provider: '${provider}', label: '${provider}', authMethods: ['api_key'], requires: [] },
    ],
  },
  providers: {
    '${provider}': {
      listIssues: async () => [{ provider: '${provider}', externalId: '1', externalKey: '${provider}-1', title: 'test', body: '', status: 'open', labels: [], url: 'https://example.com/1', updatedAt: '2024-01-01' }],
      getIssue: async () => null,
    },
  },
}`;

describe("Integration Provider Plugin (ADR-0028)", () => {
  beforeEach(() => pluginManager.resetPlugins());
  afterEach(() => pluginManager.resetPlugins());

  describe("getProviderAdapter", () => {
    it("returns null when no provider plugin loaded", () => {
      expect(pluginManager.getProviderAdapter("github")).toBeNull();
    });

    it("returns the adapter when a provider plugin is loaded", async () => {
      const dir = await writePlugin("github-prov", providerManifest("github-prov", "github"));
      const adapter = pluginManager.getProviderAdapter("github");
      expect(adapter).not.toBeNull();
      expect(typeof adapter!.listIssues).toBe("function");
      expect(typeof adapter!.getIssue).toBe("function");
      await cleanup(dir);
    });

    it("delegates listIssues to the plugin handler", async () => {
      const dir = await writePlugin("github-prov", providerManifest("github-prov", "github"));
      const adapter = pluginManager.getProviderAdapter("github")!;
      const issues = await adapter.listIssues({} as any);
      expect(issues).toHaveLength(1);
      expect(issues[0].externalId).toBe("1");
      await cleanup(dir);
    });
  });

  describe("loadPlugins — validation", () => {
    it("records error for integrationProvider with orphan handler (no providers map)", async () => {
      const dir = await writePlugin(
        "orphan-provider",
        `{ manifest: { id: 'orphan-provider', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'GitHub', authMethods: ['pat'], requires: [] }] } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      expect(loaded[0].error).toContain("no matching handler");
      await cleanup(dir);
    });

    it("records error for integrationProvider with malformed handler (missing getIssue)", async () => {
      const dir = await writePlugin(
        "bad-handler",
        `{ manifest: { id: 'bad-handler', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'GitHub', authMethods: ['pat'], requires: [] }] }, providers: { github: { listIssues: async () => [] } } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      expect(loaded[0].error).toContain("no matching handler");
      await cleanup(dir);
    });

    it("refuses integrationProvider requiring a capability (none allowed)", async () => {
      const dir = await writePlugin(
        "bad-cap",
        `{ manifest: { id: 'bad-cap', version: '1.0.0', description: 'x', contributions: [{ kind: 'integrationProvider', scope: 'system', provider: 'github', label: 'GitHub', authMethods: ['pat'], requires: ['pulseReader'] }] }, providers: { github: { listIssues: async () => [], getIssue: async () => null } } }`,
      );
      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded[0].error).toBeDefined();
      expect(loaded[0].error).toContain("cannot require capability");
      await cleanup(dir);
    });
  });

  describe("loadPlugins — collision detection", () => {
    it("refuses duplicate provider across two plugins", async () => {
      const tmpDir = `/tmp/test-provider-dup-${Date.now()}`;
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${tmpDir}/plugin-a`, { recursive: true });
      await mkdir(`${tmpDir}/plugin-b`, { recursive: true });
      await writeFile(
        `${tmpDir}/plugin-a/index.mjs`,
        `export default ${providerManifest("plugin-a", "github")};`,
      );
      await writeFile(
        `${tmpDir}/plugin-b/index.mjs`,
        `export default ${providerManifest("plugin-b", "github")};`,
      );
      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const errors = pluginManager
        .getLoadedPlugins()
        .filter((p) => p.error && p.error.includes("already registered"));
      expect(errors.length).toBeGreaterThanOrEqual(1);
      await cleanup(tmpDir);
    });

    it("allows different providers in separate plugins", async () => {
      const tmpDir = `/tmp/test-provider-multi-${Date.now()}`;
      const { mkdir, writeFile } = await import("node:fs/promises");
      await mkdir(`${tmpDir}/gh`, { recursive: true });
      await mkdir(`${tmpDir}/jira`, { recursive: true });
      await writeFile(
        `${tmpDir}/gh/index.mjs`,
        `export default ${providerManifest("gh", "github")};`,
      );
      await writeFile(
        `${tmpDir}/jira/index.mjs`,
        `export default ${providerManifest("jira", "jira")};`,
      );
      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      expect(pluginManager.getProviderAdapter("github")).not.toBeNull();
      expect(pluginManager.getProviderAdapter("jira")).not.toBeNull();
      await cleanup(tmpDir);
    });
  });

  describe("resetPlugins clears providerRegistry", () => {
    it("returns null again after reset", async () => {
      const dir = await writePlugin("tmp-prov", providerManifest("tmp-prov", "github"));
      expect(pluginManager.getProviderAdapter("github")).not.toBeNull();
      pluginManager.resetPlugins();
      expect(pluginManager.getProviderAdapter("github")).toBeNull();
      await cleanup(dir);
    });
  });
});
