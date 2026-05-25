import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as pluginManager from '../plugins/pluginManager.js';
import type { Task, Habitat, Agent } from '../models/index.js';

vi.mock('../lib/logger.js', () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
  },
}));

import { logger } from '../lib/logger.js';

const hookCalls: Array<{ hook: string; args: unknown[] }> = [];
const originalPush = hookCalls.push.bind(hookCalls);

describe('Plugin Manager', () => {
  beforeEach(() => {
    pluginManager.resetPlugins();
    hookCalls.length = 0;
  });

  afterEach(() => {
    pluginManager.resetPlugins();
    hookCalls.length = 0;
  });

  async function writePlugin(name: string, hookBody: string): Promise<string> {
    const tmpDir = `/tmp/test-plugins-${name}-${Date.now()}`;
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(tmpDir, { recursive: true });
    const code = `
      const push = globalThis.__pluginTestPush;
      export default {
        name: '${name}',
        version: '1.0.0',
        hooks: { ${hookBody} },
      };
    `;
    await writeFile(`${tmpDir}/${name}.mjs`, code);
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
    return tmpDir;
  }

  async function cleanup(tmpDir: string) {
    const { rm } = await import('node:fs/promises');
    await rm(tmpDir, { recursive: true });
  }

  describe('getLoadedPlugins', () => {
    it('returns empty array when no plugins loaded', () => {
      expect(pluginManager.getLoadedPlugins()).toEqual([]);
    });
  });

  describe('loadPlugins', () => {
    it('does nothing when plugin directory does not exist', async () => {
      pluginManager.setPluginDirectory('/nonexistent/path');
      await pluginManager.loadPlugins();
      expect(pluginManager.getLoadedPlugins()).toEqual([]);
    });

    it('loads plugins from directory with flat files', async () => {
      const tmpDir = `/tmp/test-plugins-flat-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const pluginCode = `
        export default {
          name: 'test-plugin',
          version: '1.0.0',
          hooks: { onTaskCreated: (task) => {} },
        };
      `;
      await writeFile(`${tmpDir}/test-plugin.mjs`, pluginCode);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('test-plugin');
      expect(loaded[0].version).toBe('1.0.0');
      expect(loaded[0].enabled).toBe(true);

      await rm(tmpDir, { recursive: true });
    });

    it('loads plugins from subdirectories', async () => {
      const tmpDir = `/tmp/test-plugins-dir-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(`${tmpDir}/my-plugin`, { recursive: true });

      const code = `export default { name: 'my-plugin', version: '2.0.0' };`;
      await writeFile(`${tmpDir}/my-plugin/index.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('my-plugin');

      await rm(tmpDir, { recursive: true });
    });

    it('filters plugins by enabled list', async () => {
      const tmpDir = `/tmp/test-plugins-filter-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const codeA = `export default { name: 'plugin-a', version: '1.0.0' };`;
      const codeB = `export default { name: 'plugin-b', version: '1.0.0' };`;

      await writeFile(`${tmpDir}/plugin-a.mjs`, codeA);
      await writeFile(`${tmpDir}/plugin-b.mjs`, codeB);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins(['plugin-a']);

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].name).toBe('plugin-a');

      await rm(tmpDir, { recursive: true });
    });

    it('records error for plugin with missing name', async () => {
      const tmpDir = `/tmp/test-plugins-bad-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const badCode = `export default { version: '1.0.0' };`;
      await writeFile(`${tmpDir}/bad-plugin.mjs`, badCode);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].enabled).toBe(false);
      expect(loaded[0].error).toContain('Invalid plugin structure');

      await rm(tmpDir, { recursive: true });
    });

    it('records error for plugin with missing version', async () => {
      const tmpDir = `/tmp/test-plugins-noversion-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const badCode = `export default { name: 'no-version' };`;
      await writeFile(`${tmpDir}/no-version.mjs`, badCode);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].enabled).toBe(false);
      expect(loaded[0].error).toContain('Invalid plugin structure');

      await rm(tmpDir, { recursive: true });
    });

    it('records error for plugin directory without index file', async () => {
      const tmpDir = `/tmp/test-plugins-noidx-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(`${tmpDir}/no-index`, { recursive: true });
      await writeFile(`${tmpDir}/no-index/readme.txt`, 'readme');

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].enabled).toBe(false);
      expect(loaded[0].error).toContain('No index file found');

      await rm(tmpDir, { recursive: true });
    });

    it('records error for plugin with name mismatch', async () => {
      const tmpDir = `/tmp/test-plugins-mismatch-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const mismatchCode = `export default { name: 'wrong-name', version: '1.0.0' };`;
      await writeFile(`${tmpDir}/right-name.mjs`, mismatchCode);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].enabled).toBe(false);
      expect(loaded[0].error).toContain('name mismatch');

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('emitTaskCreated', () => {
    it('invokes onTaskCreated hook on loaded plugins', async () => {
      const tmpDir = `/tmp/test-plugins-created-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'hook-test',
          version: '1.0.0',
          hooks: { onTaskCreated: (task, habitat) => { globalThis.__pluginTestCalls.push({ hook: 'onTaskCreated', args: [task, habitat] }); } },
        };
      `;
      await writeFile(`${tmpDir}/hook-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeTask = { id: 't1', title: 'Test' } as Task;
      const fakeHabitat = { id: 'b1', name: 'Habitat' } as Habitat;
      await pluginManager.emitTaskCreated(fakeTask, fakeHabitat);

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].hook).toBe('onTaskCreated');
      expect(hookCalls[0].args).toEqual([fakeTask, fakeHabitat]);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('emitTaskClaimed', () => {
    it('invokes onTaskClaimed hook', async () => {
      const tmpDir = `/tmp/test-plugins-claimed-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'claimed-test',
          version: '1.0.0',
          hooks: { onTaskClaimed: (task, agent) => { globalThis.__pluginTestCalls.push({ hook: 'onTaskClaimed', args: [task, agent] }); } },
        };
      `;
      await writeFile(`${tmpDir}/claimed-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeTask = { id: 't1' } as Task;
      const fakeAgent = { id: 'a1', name: 'Bot' } as Omit<Agent, 'apiKeyHash'>;
      await pluginManager.emitTaskClaimed(fakeTask, fakeAgent);

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].args).toEqual([fakeTask, fakeAgent]);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('emitTaskSubmitted', () => {
    it('invokes onTaskSubmitted hook', async () => {
      const tmpDir = `/tmp/test-plugins-submitted-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'submit-test',
          version: '1.0.0',
          hooks: { onTaskSubmitted: (task) => { globalThis.__pluginTestCalls.push({ hook: 'onTaskSubmitted', args: [task] }); } },
        };
      `;
      await writeFile(`${tmpDir}/submit-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeTask = { id: 't1' } as Task;
      await pluginManager.emitTaskSubmitted(fakeTask);

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].args).toEqual([fakeTask]);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('emitTaskApproved', () => {
    it('invokes onTaskApproved hook', async () => {
      const tmpDir = `/tmp/test-plugins-approved-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'approve-test',
          version: '1.0.0',
          hooks: { onTaskApproved: (task) => { globalThis.__pluginTestCalls.push({ hook: 'onTaskApproved', args: [task] }); } },
        };
      `;
      await writeFile(`${tmpDir}/approve-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeTask = { id: 't1' } as Task;
      await pluginManager.emitTaskApproved(fakeTask);

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].args).toEqual([fakeTask]);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('emitTaskRejected', () => {
    it('invokes onTaskRejected hook with reason', async () => {
      const tmpDir = `/tmp/test-plugins-rejected-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'reject-test',
          version: '1.0.0',
          hooks: { onTaskRejected: (task, reason) => { globalThis.__pluginTestCalls.push({ hook: 'onTaskRejected', args: [task, reason] }); } },
        };
      `;
      await writeFile(`${tmpDir}/reject-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeTask = { id: 't1' } as Task;
      await pluginManager.emitTaskRejected(fakeTask, 'bad code');

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].args).toEqual([fakeTask, 'bad code']);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('emitHabitatCreated', () => {
    it('invokes onHabitatCreated hook', async () => {
      const tmpDir = `/tmp/test-plugins-habitat-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'habitat-test',
          version: '1.0.0',
          hooks: { onHabitatCreated: (habitat) => { globalThis.__pluginTestCalls.push({ hook: 'onHabitatCreated', args: [habitat] }); } },
        };
      `;
      await writeFile(`${tmpDir}/habitat-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeHabitat = { id: 'b1', name: 'Habitat' } as Habitat;
      await pluginManager.emitHabitatCreated(fakeHabitat);

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].args).toEqual([fakeHabitat]);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('emitAgentRegistered', () => {
    it('invokes onAgentRegistered hook', async () => {
      const tmpDir = `/tmp/test-plugins-agent-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'agent-test',
          version: '1.0.0',
          hooks: { onAgentRegistered: (agent) => { globalThis.__pluginTestCalls.push({ hook: 'onAgentRegistered', args: [agent] }); } },
        };
      `;
      await writeFile(`${tmpDir}/agent-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeAgent = { id: 'a1', name: 'Bot' } as Omit<Agent, 'apiKeyHash'>;
      await pluginManager.emitAgentRegistered(fakeAgent);

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].args).toEqual([fakeAgent]);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('emitEvent', () => {
    it('invokes onEvent hook', async () => {
      const tmpDir = `/tmp/test-plugins-event-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'event-test',
          version: '1.0.0',
          hooks: { onEvent: (eventType, data) => { globalThis.__pluginTestCalls.push({ hook: 'onEvent', args: [eventType, data] }); } },
        };
      `;
      await writeFile(`${tmpDir}/event-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      await pluginManager.emitEvent('task.created', { id: '123' });

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].args).toEqual(['task.created', { id: '123' }]);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('hook error handling', () => {
    it('catches and logs sync errors in hooks without crashing', async () => {
      const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const tmpDir = `/tmp/test-plugins-err-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'error-test',
          version: '1.0.0',
          hooks: { onTaskCreated: () => { throw new Error('boom'); } },
        };
      `;
      await writeFile(`${tmpDir}/error-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeTask = { id: 't1' } as Task;
      await pluginManager.emitTaskCreated(fakeTask, null);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();

      await rm(tmpDir, { recursive: true });
    });

    it('catches async errors in hooks', async () => {
      const consoleSpy = vi.spyOn(logger, 'error').mockImplementation(() => {});
      const tmpDir = `/tmp/test-plugins-asyncerr-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'async-error-test',
          version: '1.0.0',
          hooks: { onTaskCreated: async () => { throw new Error('async boom'); } },
        };
      `;
      await writeFile(`${tmpDir}/async-error-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeTask = { id: 't1' } as Task;
      await pluginManager.emitTaskCreated(fakeTask, null);

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('custom MCP tools', () => {
    it('collects custom MCP tools from all loaded plugins', async () => {
      const tmpDir = `/tmp/test-plugins-mcp-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'mcp-test',
          version: '1.0.0',
          customMcpTools: [{
            name: 'my-tool',
            description: 'A test tool',
            inputSchema: { type: 'object', properties: { x: { type: 'string' } } },
            handler: async (args) => ({ result: args.x }),
          }],
        };
      `;
      await writeFile(`${tmpDir}/mcp-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const tools = pluginManager.getCustomMcpTools();
      expect(tools).toHaveLength(1);
      expect(tools[0].name).toBe('my-tool');
      expect(tools[0].description).toBe('A test tool');

      const result = await tools[0].handler({ x: 'hello' });
      expect(result).toEqual({ result: 'hello' });

      await rm(tmpDir, { recursive: true });
    });

    it('returns empty array when no plugins have custom tools', () => {
      expect(pluginManager.getCustomMcpTools()).toEqual([]);
    });
  });

  describe('plugin validation', () => {
    it('rejects plugin with non-function customRoutes', async () => {
      const tmpDir = `/tmp/test-plugins-badroutes-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `export default { name: 'bad-routes', version: '1.0.0', customRoutes: 'not-a-function' };`;
      await writeFile(`${tmpDir}/bad-routes.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].enabled).toBe(false);

      await rm(tmpDir, { recursive: true });
    });

    it('rejects plugin with invalid customMcpTools', async () => {
      const tmpDir = `/tmp/test-plugins-badmcp-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `export default { name: 'bad-mcp', version: '1.0.0', customMcpTools: [{ name: 123 }] };`;
      await writeFile(`${tmpDir}/bad-mcp.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].enabled).toBe(false);

      await rm(tmpDir, { recursive: true });
    });

    it('rejects plugin with non-object hooks', async () => {
      const tmpDir = `/tmp/test-plugins-badhooks-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `export default { name: 'bad-hooks', version: '1.0.0', hooks: 'invalid' };`;
      await writeFile(`${tmpDir}/bad-hooks.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(1);
      expect(loaded[0].enabled).toBe(false);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('multiple plugins', () => {
    it('loads and invokes hooks on multiple plugins', async () => {
      const tmpDir = `/tmp/test-plugins-multi-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code1 = `
        export default { name: 'multi-1', version: '1.0.0', hooks: { onTaskCreated: (t) => { globalThis.__pluginTestCalls.push({ hook: 'multi-1', args: [t] }); } } };
      `;
      const code2 = `
        export default { name: 'multi-2', version: '2.0.0', hooks: { onTaskCreated: (t) => { globalThis.__pluginTestCalls.push({ hook: 'multi-2', args: [t] }); } } };
      `;

      await writeFile(`${tmpDir}/multi-1.mjs`, code1);
      await writeFile(`${tmpDir}/multi-2.mjs`, code2);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const loaded = pluginManager.getLoadedPlugins();
      expect(loaded).toHaveLength(2);

      const fakeTask = { id: 't1' } as Task;
      await pluginManager.emitTaskCreated(fakeTask, null);

      expect(hookCalls).toHaveLength(2);
      expect(hookCalls.map(h => h.hook).toSorted()).toEqual(['multi-1', 'multi-2']);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('resetPlugins', () => {
    it('clears all loaded plugins and errors', async () => {
      const tmpDir = `/tmp/test-plugins-reset-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `export default { name: 'reset-test', version: '1.0.0' };`;
      await writeFile(`${tmpDir}/reset-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();
      expect(pluginManager.getLoadedPlugins()).toHaveLength(1);

      pluginManager.resetPlugins();
      expect(pluginManager.getLoadedPlugins()).toEqual([]);

      await rm(tmpDir, { recursive: true });
    });
  });

  describe('async hooks', () => {
    it('awaits async hook before returning', async () => {
      const tmpDir = `/tmp/test-plugins-async-${Date.now()}`;
      const { mkdir, writeFile, rm } = await import('node:fs/promises');
      await mkdir(tmpDir, { recursive: true });

      const code = `
        export default {
          name: 'async-test',
          version: '1.0.0',
          hooks: {
            onTaskCreated: async (task) => {
              await new Promise(r => setTimeout(r, 10));
              globalThis.__pluginTestCalls.push({ hook: 'async-done', args: [task] });
            },
          },
        };
      `;
      await writeFile(`${tmpDir}/async-test.mjs`, code);

      pluginManager.setPluginDirectory(tmpDir);
      await pluginManager.loadPlugins();

      const fakeTask = { id: 't1' } as Task;
      await pluginManager.emitTaskCreated(fakeTask, null);

      expect(hookCalls).toHaveLength(1);
      expect(hookCalls[0].hook).toBe('async-done');
      expect(hookCalls[0].args).toEqual([fakeTask]);

      await rm(tmpDir, { recursive: true });
    });
  });
});

(globalThis as unknown as { __pluginTestCalls: unknown[] }).__pluginTestCalls = hookCalls;
