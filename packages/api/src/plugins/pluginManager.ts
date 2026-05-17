import type { FastifyInstance } from 'fastify';
import type { KanbanPlugin, PluginManifest, McpToolDefinition } from './types.js';
import type { Task, Habitat, Agent } from '../models/index.js';
import { readdir, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logger } from '../lib/logger.js';

const loadedPlugins: Map<string, KanbanPlugin> = new Map();
const pluginErrors: Map<string, string> = new Map();
let pluginDirectory: string | null = null;

function getPluginDirectory(): string {
  if (pluginDirectory) return pluginDirectory;
  return process.env.PLUGINS_DIR
    ? resolve(process.env.PLUGINS_DIR)
    : resolve(process.cwd(), 'plugins');
}

export function setPluginDirectory(dir: string): void {
  pluginDirectory = resolve(dir);
}

function validatePlugin(plugin: unknown, source: string): plugin is KanbanPlugin {
  if (!plugin || typeof plugin !== 'object') return false;
  const p = plugin as Record<string, unknown>;
  if (typeof p.name !== 'string' || !p.name) return false;
  if (typeof p.version !== 'string' || !p.version) return false;
  if (p.hooks !== undefined && typeof p.hooks !== 'object') return false;
  if (p.customRoutes !== undefined && typeof p.customRoutes !== 'function') return false;
  if (p.customMcpTools !== undefined) {
    if (!Array.isArray(p.customMcpTools)) return false;
    for (const tool of p.customMcpTools as unknown[]) {
      if (!tool || typeof tool !== 'object') return false;
      const t = tool as Record<string, unknown>;
      if (typeof t.name !== 'string' || typeof t.description !== 'string' || typeof t.handler !== 'function') return false;
    }
  }
  return true;
}

async function loadPluginFromPath(pluginPath: string, name: string): Promise<KanbanPlugin | null> {
  try {
    const fileUrl = pathToFileURL(pluginPath).href;
    const mod = await import(fileUrl);
    const plugin: KanbanPlugin = mod.default ?? mod;
    if (!validatePlugin(plugin, name)) {
      pluginErrors.set(name, `Invalid plugin structure in ${name}`);
      return null;
    }
    if (plugin.name !== name) {
      pluginErrors.set(name, `Plugin name mismatch: expected "${name}", got "${plugin.name}"`);
      return null;
    }
    return plugin;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pluginErrors.set(name, `Failed to load: ${message}`);
    return null;
  }
}

export async function loadPlugins(enabledList?: string[]): Promise<void> {
  const dir = getPluginDirectory();
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }

  const enabled = enabledList ?? parseEnabledFromEnv();

  for (const entry of entries) {
    const entryPath = join(dir, entry);
    let isDir = false;
    try {
      const s = await stat(entryPath);
      isDir = s.isDirectory();
    } catch {
      continue;
    }

    if (enabled.length > 0 && !enabled.includes(entry) && !enabled.includes(entry.replace(/\.(js|mjs|ts)$/, ''))) continue;

    if (isDir) {
      const indexPaths = ['index.ts', 'index.js', 'index.mjs'];
      let loaded = false;
      for (const idx of indexPaths) {
        try {
          await stat(join(entryPath, idx));
        } catch {
          continue;
        }
        const plugin = await loadPluginFromPath(join(entryPath, idx), entry);
        if (plugin) {
          loadedPlugins.set(plugin.name, plugin);
          loaded = true;
        }
        break;
      }
      if (!loaded && !pluginErrors.has(entry)) {
        pluginErrors.set(entry, `No index file found in plugin directory`);
      }
    } else {
      const name = entry.replace(/\.(js|mjs|ts)$/, '');
      const plugin = await loadPluginFromPath(entryPath, name);
      if (plugin) {
        loadedPlugins.set(plugin.name, plugin);
      }
    }
  }
}

function parseEnabledFromEnv(): string[] {
  const envVal = process.env.PLUGINS_ENABLED;
  if (!envVal) return [];
  return envVal.split(',').map(s => s.trim()).filter(Boolean);
}

export async function initializePlugins(fastify: FastifyInstance): Promise<void> {
  for (const [name, plugin] of loadedPlugins) {
    if (plugin.customRoutes) {
      try {
        await fastify.register(plugin.customRoutes);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pluginErrors.set(name, `Failed to register custom routes: ${message}`);
        loadedPlugins.delete(name);
      }
    }
  }
}

export function getLoadedPlugins(): PluginManifest[] {
  const result: PluginManifest[] = [];
  for (const [name, plugin] of loadedPlugins) {
    result.push({ name: plugin.name, version: plugin.version, enabled: true });
  }
  for (const [name, error] of pluginErrors) {
    result.push({ name, version: '0.0.0', enabled: false, error });
  }
  return result;
}

export function getCustomMcpTools(): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  for (const plugin of loadedPlugins.values()) {
    if (plugin.customMcpTools) {
      tools.push(...plugin.customMcpTools);
    }
  }
  return tools;
}

export function resetPlugins(): void {
  loadedPlugins.clear();
  pluginErrors.clear();
  pluginDirectory = null;
}

async function invokeHook(
  hookName: keyof NonNullable<KanbanPlugin['hooks']>,
  ...args: unknown[]
): Promise<void> {
  const promises: (void | Promise<void>)[] = [];
  for (const plugin of loadedPlugins.values()) {
    const hook = plugin.hooks?.[hookName];
    if (hook) {
      try {
        const result = (hook as (...a: unknown[]) => void | Promise<void>)(...args);
        if (result instanceof Promise) {
          promises.push(result.catch(err => {
            logger.error({ err, pluginName: plugin.name, hookName }, 'Plugin hook error');
          }));
        }
      } catch (err) {
        logger.error({ err, pluginName: plugin.name, hookName }, 'Plugin hook error');
      }
    }
  }
  await Promise.all(promises);
}

export async function emitTaskCreated(task: Task, habitat: Habitat | null): Promise<void> {
  await invokeHook('onTaskCreated', task, habitat);
}

export async function emitTaskClaimed(task: Task, agent: Omit<Agent, 'apiKeyHash'>): Promise<void> {
  await invokeHook('onTaskClaimed', task, agent);
}

export async function emitTaskSubmitted(task: Task): Promise<void> {
  await invokeHook('onTaskSubmitted', task);
}

export async function emitTaskApproved(task: Task): Promise<void> {
  await invokeHook('onTaskApproved', task);
}

export async function emitTaskRejected(task: Task, reason: string): Promise<void> {
  await invokeHook('onTaskRejected', task, reason);
}

export async function emitHabitatCreated(habitat: Habitat): Promise<void> {
  await invokeHook('onHabitatCreated', habitat);
}

export async function emitAgentRegistered(agent: Omit<Agent, 'apiKeyHash'>): Promise<void> {
  await invokeHook('onAgentRegistered', agent);
}

export async function emitEvent(eventType: string, data: unknown): Promise<void> {
  await invokeHook('onEvent', eventType, data);
}
