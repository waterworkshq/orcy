import type { FastifyInstance } from "fastify";
import type {
  PluginManifest,
  Contribution,
  PluginCapabilityName,
  InterceptorEvent,
  SignalDetectorContribution,
  LifecycleInterceptorContribution,
  DetectedSignalInput,
} from "@orcy/shared";
import type {
  PluginModule,
  PluginContext,
  ChannelHandler,
  ChannelHandlerResult,
  DetectorHandler,
  InterceptorHandler,
  McpToolHandler,
  FormatterHandler,
  ConditionHandler,
  ActionListener,
  ProviderHandler,
  PluginManifestView,
  EventSourceRef,
  InterceptorPreResult,
} from "./types.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";
import { buildPluginContext } from "./context.js";
import {
  CAPABILITY_MATRIX,
  CONTRIBUTION_KIND_KEYS,
  buildContributionCatalog,
  type CapabilityPolicy,
  type ContributionKind,
  type PluginRegistries,
} from "./contributionAdapters.js";
import { readdir, stat, realpath } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../lib/logger.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as quarantineRepo from "../repositories/pluginQuarantine.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as pulseService from "../services/pulseService.js";
import * as taskLifecycle from "../services/tasks/task-lifecycle.js";
import * as commentService from "../services/commentService.js";

/** Valid contribution kinds (ADR-0011 discriminated union). Derived from the static
 * catalog key set so kind-validity is independent of factory construction. */
const VALID_KINDS: ReadonlySet<ContributionKind> = new Set<ContributionKind>(
  CONTRIBUTION_KIND_KEYS,
);

/** The whitelisted capability names (ADR-0012 + ADR-0019 + ADR-0020). */
const VALID_CAPABILITIES: ReadonlySet<PluginCapabilityName> = new Set<PluginCapabilityName>([
  "pulseReader",
  "pulseWriter",
  "commentReader",
  "taskReader",
  "habitatReader",
  "chatIntegrationReader",
  "taskWriter",
  "notificationSender",
  "webhookCaller",
]);

const loadedPlugins: Map<string, PluginModule> = new Map();
const pluginErrors: Map<string, string> = new Map();
let pluginDirectory: string | null = null;

const channelRegistry: Map<
  string,
  { pluginId: string; handler: ChannelHandler; timeoutMs?: number }
> = new Map();
const formatterRegistry: Map<string, { pluginId: string; handler: FormatterHandler }> = new Map();
const conditionRegistry: Map<string, { pluginId: string; handler: ConditionHandler }> = new Map();
const actionRegistry: Map<
  string,
  { pluginId: string; handler: ActionListener; timeoutMs?: number }
> = new Map();
const providerRegistry: Map<string, { pluginId: string; handler: ProviderHandler }> = new Map();
const detectorRegistry: Map<
  string,
  { pluginId: string; contribution: SignalDetectorContribution; handler: DetectorHandler }
> = new Map();
const interceptorRegistry: {
  pre: Map<
    InterceptorEvent,
    Array<{
      pluginId: string;
      contribution: LifecycleInterceptorContribution;
      handler: InterceptorHandler;
    }>
  >;
  post: Map<
    InterceptorEvent,
    Array<{
      pluginId: string;
      contribution: LifecycleInterceptorContribution;
      handler: InterceptorHandler;
    }>
  >;
} = { pre: new Map(), post: new Map() };

/** Bag of the 7 module-level registries passed to the catalog factory. Also passed (by
 * reference) to each adapter's `register` callback for downstream flexibility, even
 * though the built-in adapters close over the Maps from the factory destructure. */
const REGISTRIES: PluginRegistries = {
  channelRegistry,
  detectorRegistry,
  interceptorRegistry,
  formatterRegistry,
  conditionRegistry,
  actionRegistry,
  providerRegistry,
};

/** v0.28 catalog of per-kind registration behavior (label/orphanCheck/collisionKey/register).
 * Built once at module init; collapsed switches in this file delegate to it.
 * Exported (read-only) so consumers like `pluginEnrollmentService.findContribution`
 * can use the single canonical adapter record for label lookups without building
 * a duplicate catalog instance. */
export const CATALOG = buildContributionCatalog(REGISTRIES);

const enrollmentCache: Map<string, Set<string>> = new Map();
const quarantineSet: Set<string> = new Set();
const errorCounters: Map<string, { count: number; windowStart: number }> = new Map();
const activeRuns: Map<string, number> = new Map();

/** Default timeoutMs per contribution kind when the manifest doesn't declare one (ADR-0014 + ADR-0015 risk notes). 0 means no timeout. */
const DEFAULT_TIMEOUT_MS: Record<string, number> = {
  signalDetector: 5000,
  lifecycleInterceptor: 0,
  notificationChannel: 0,
  customMcpTool: 5000,
  customHttpRoute: 0,
  integrationProvider: 0,
};

/**
 * Wraps a plugin handler Promise in a timeout race. On timeout, rejects with a
 * `PluginTimeoutError` that the caller treats identically to a handler throw
 * (incrementError + finishRun failed). A `timeoutMs` of 0 disables the watchdog.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, pluginKey: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  // Suppress late rejection if timeout wins the race — the handler promise may
  // later reject with no consumer, causing an unhandledRejection event. This  // no-op catch ensures the rejection is swallowed silently.
  promise.catch(() => {});
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Plugin ${pluginKey} timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Creates a plugin run record and builds the per-invocation PluginContext.
 * Shared startup boilerplate extracted from the 3 dispatchers (channel, detector,
 * interceptor). Each dispatcher calls this, then sets kind-specific payload fields
 * on the returned context before invoking the handler.
 */
function startPluginRun(opts: {
  pluginId: string;
  contributionId: string;
  contributionKind: string;
  habitatId: string;
  triggerEventId: string | null;
  triggerType: string;
  requires: PluginCapabilityName[];
}): { runId: string; ctx: PluginContext } {
  const run = runRepo.startRun({
    habitatId: opts.habitatId,
    pluginId: opts.pluginId,
    contributionId: opts.contributionId,
    contributionKind: opts.contributionKind,
    triggerEventId: opts.triggerEventId,
    triggerType: opts.triggerType,
  });
  const ctx = buildPluginContext({
    pluginId: opts.pluginId,
    contributionId: opts.contributionId,
    habitatId: opts.habitatId,
    runId: run.id,
    requires: opts.requires,
  });
  return { runId: run.id, ctx };
}

/** Custom MCP tool definition surfaced via `GET /plugins` (display-only in v0.22.0 per ADR-0018). */
export interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

function getPluginDirectory(): string {
  if (pluginDirectory) return pluginDirectory;
  return process.env.PLUGINS_DIR
    ? resolve(process.env.PLUGINS_DIR)
    : resolve(process.cwd(), "plugins");
}

export function setPluginDirectory(dir: string): void {
  pluginDirectory = resolve(dir);
}

function capabilityMatrixViolation(c: Contribution): string | null {
  const policy = CAPABILITY_MATRIX[c.kind];
  if (!policy) {
    return `No capability policy defined for contribution kind "${c.kind}"`;
  }

  const allowedSet = new Set(policy.allowed);

  if (c.kind === "lifecycleInterceptor" && policy.forbiddenByPhase) {
    const forbidden = policy.forbiddenByPhase[c.phase];
    if (forbidden) {
      for (const cap of c.requires) {
        if (forbidden.includes(cap)) {
          return `lifecycleInterceptor "${c.interceptorId}" is ${c.phase}-phase and cannot require "${cap}"`;
        }
      }
    }
  }

  for (const cap of c.requires) {
    if (!allowedSet.has(cap)) {
      const id = contributionLabel(c);
      return `${c.kind} "${id}" cannot require capability "${cap}"`;
    }
  }
  return null;
}

/** Extracts the human-readable identifier from a contribution for error messages. */
function contributionLabel(c: Contribution): string {
  return CATALOG[c.kind].label(c);
}

function orphanHandler(c: Contribution, mod: PluginModule): string | null {
  return CATALOG[c.kind].orphanCheck(c, mod);
}

function validatePlugin(mod: unknown, _source: string): mod is PluginModule {
  if (!mod || typeof mod !== "object") return false;
  const m = mod as Record<string, unknown>;
  const manifest = m.manifest;
  if (!manifest || typeof manifest !== "object") return false;
  const man = manifest as PluginManifest;
  if (typeof man.id !== "string" || !man.id) return false;
  if (typeof man.version !== "string" || !man.version) return false;
  if (typeof man.description !== "string" || !man.description) return false;
  if (!Array.isArray(man.contributions) || man.contributions.length === 0) return false;

  for (const c of man.contributions as Contribution[]) {
    if (!c || typeof c.kind !== "string" || !VALID_KINDS.has(c.kind as ContributionKind)) {
      pluginErrors.set(man.id, `Invalid contribution kind in manifest`);
      return false;
    }
    if (!Array.isArray(c.requires)) {
      pluginErrors.set(man.id, `Contribution requires must be an array`);
      return false;
    }
    for (const cap of c.requires) {
      if (!VALID_CAPABILITIES.has(cap)) {
        pluginErrors.set(man.id, `Unknown capability "${cap}" in contribution requires`);
        return false;
      }
    }
    const matrixViolation = capabilityMatrixViolation(c);
    if (matrixViolation) {
      pluginErrors.set(man.id, matrixViolation);
      return false;
    }
    const orphan = orphanHandler(c, m as unknown as PluginModule);
    if (orphan) {
      pluginErrors.set(man.id, orphan);
      return false;
    }
  }
  return true;
}

async function loadPluginFromPath(pluginPath: string, name: string): Promise<PluginModule | null> {
  try {
    const fileUrl = pathToFileURL(pluginPath).href;
    const imported = await import(fileUrl);
    const mod: PluginModule = (imported.manifest ? imported : imported.default) ?? imported;
    const idCandidate =
      mod && typeof mod === "object" && "manifest" in mod && mod.manifest?.id
        ? String(mod.manifest.id)
        : name;
    if (!validatePlugin(mod, name)) {
      if (!pluginErrors.has(idCandidate)) {
        pluginErrors.set(idCandidate, `Invalid plugin structure in ${name}`);
      }
      return null;
    }
    if (mod.manifest.id !== name) {
      pluginErrors.set(
        mod.manifest.id,
        `Plugin id mismatch: expected "${name}", got "${mod.manifest.id}"`,
      );
      return null;
    }
    return mod;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    pluginErrors.set(name, `Failed to load: ${message}`);
    return null;
  }
}

function detectIdCollisions(mod: PluginModule): string | null {
  const seenWithinManifest = new Set<string>();
  for (const c of mod.manifest.contributions) {
    const adapter = CATALOG[c.kind];
    const key = adapter.collisionKey?.(c, mod.manifest.id);
    if (!key) continue;
    if (seenWithinManifest.has(key.within)) {
      return adapter.collisions!.withinError(c);
    }
    seenWithinManifest.add(key.within);
    if (key.cross !== undefined && adapter.collisions?.crossRegistry) {
      if (adapter.collisions.crossRegistry.has(key.cross)) {
        return adapter.collisions.crossError!(c);
      }
    }
  }
  return null;
}

function registerContributions(mod: PluginModule): void {
  for (const c of mod.manifest.contributions) {
    CATALOG[c.kind].register?.(c, mod, REGISTRIES);
  }
}

/**
 * Reverses `registerContributions` for a single plugin. Walks the manifest's
 * contributions and drops each from its kind's registry. Used to roll back a
 * plugin whose `fastify.register` failed mid-`initializePlugins` — without
 * this, admin surfaces (`getLoadedPlugins`) report the plugin as not-loaded
 * while its contributions remain callable.
 *
 * Tier-C kinds (`customMcpTool`, `customHttpRoute`) have no per-plugin
 * registry; removing the plugin from `loadedPlugins` is sufficient
 * (`getCustomMcpTools` iterates `loadedPlugins`, and the failing
 * `fastify.register` call is what this rollback is responding to).
 */
function unregisterContributions(mod: PluginModule): void {
  const pluginId = mod.manifest.id;
  for (const c of mod.manifest.contributions) {
    switch (c.kind) {
      case "notificationChannel":
        if (channelRegistry.get(c.channelId)?.pluginId === pluginId) {
          channelRegistry.delete(c.channelId);
        }
        break;
      case "signalDetector":
        // Detector keys are namespaced by `${pluginId}:${detectorId}`, so
        // the plugin ownership is inherent to the key — no owner check.
        detectorRegistry.delete(`${pluginId}:${c.detectorId}`);
        break;
      case "lifecycleInterceptor": {
        const bucket = interceptorRegistry[c.phase];
        const list = bucket.get(c.event);
        if (!list) break;
        const remaining = list.filter(
          (entry) =>
            !(
              entry.pluginId === pluginId &&
              entry.contribution.interceptorId === c.interceptorId &&
              entry.contribution.phase === c.phase &&
              entry.contribution.event === c.event
            ),
        );
        if (remaining.length === 0) {
          bucket.delete(c.event);
        } else {
          bucket.set(c.event, remaining);
        }
        break;
      }
      case "webhookFormatter":
        if (formatterRegistry.get(c.formatId)?.pluginId === pluginId) {
          formatterRegistry.delete(c.formatId);
        }
        break;
      case "automationCondition":
        if (conditionRegistry.get(c.conditionId)?.pluginId === pluginId) {
          conditionRegistry.delete(c.conditionId);
        }
        break;
      case "automationAction":
        if (actionRegistry.get(c.actionId)?.pluginId === pluginId) {
          actionRegistry.delete(c.actionId);
        }
        break;
      case "integrationProvider":
        if (providerRegistry.get(c.provider)?.pluginId === pluginId) {
          providerRegistry.delete(c.provider);
        }
        break;
      // Tier-C kinds fall through — see function header.
      default:
        break;
    }
  }
}

export async function loadPlugins(enabledList?: string[]): Promise<void> {
  const dir = resolve(getPluginDirectory());
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

    // Path traversal guard: resolve symlinks and verify the real path stays
    // inside the plugin directory. Prevents a symlinked entry from causing
    // import() of code outside the trusted PLUGINS_DIR.
    try {
      const real = await realpath(entryPath);
      const rel = relative(dir, real);
      if (rel.startsWith("..") || resolve(dir, rel) !== real) {
        pluginErrors.set(entry, `Plugin path escapes plugin directory (symlink?)`);
        continue;
      }
    } catch {
      continue;
    }

    if (
      enabled.length > 0 &&
      !enabled.includes(entry) &&
      !enabled.includes(entry.replace(/\.(js|mjs|ts)$/, ""))
    )
      continue;

    if (isDir) {
      const indexPaths = ["index.ts", "index.js", "index.mjs"];
      let loaded = false;
      for (const idx of indexPaths) {
        try {
          await stat(join(entryPath, idx));
        } catch {
          continue;
        }
        const mod = await loadPluginFromPath(join(entryPath, idx), entry);
        if (mod) {
          const collision = detectIdCollisions(mod);
          if (collision) {
            pluginErrors.set(mod.manifest.id, collision);
            break;
          }
          loadedPlugins.set(mod.manifest.id, mod);
          registerContributions(mod);
          loaded = true;
        }
        break;
      }
      if (!loaded && !pluginErrors.has(entry)) {
        pluginErrors.set(entry, `No index file found in plugin directory`);
      }
    } else {
      const name = entry.replace(/\.(js|mjs|ts)$/, "");
      const mod = await loadPluginFromPath(entryPath, name);
      if (mod) {
        const collision = detectIdCollisions(mod);
        if (collision) {
          pluginErrors.set(mod.manifest.id, collision);
        } else {
          loadedPlugins.set(mod.manifest.id, mod);
          registerContributions(mod);
        }
      }
    }
  }

  enrollmentCache.clear();
}

function parseEnabledFromEnv(): string[] {
  const envVal = process.env.PLUGINS_ENABLED;
  if (!envVal) return [];
  return envVal
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function initializePlugins(fastify: FastifyInstance): Promise<void> {
  for (const [id, mod] of loadedPlugins) {
    if (mod.routeHandlers) {
      try {
        await fastify.register(mod.routeHandlers);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        pluginErrors.set(id, `Failed to register custom routes: ${message}`);
        // Roll back every contribution this plugin published during
        // `loadPlugins()` so admin surfaces and the dispatch path agree
        // on which plugins are active.
        unregisterContributions(mod);
        loadedPlugins.delete(id);
      }
    }
  }
  registerDetectorHooks();
}

export function getLoadedPlugins(): PluginManifestView[] {
  const result: PluginManifestView[] = [];
  for (const [, mod] of loadedPlugins) {
    result.push({
      id: mod.manifest.id,
      version: mod.manifest.version,
      description: mod.manifest.description,
    });
  }
  for (const [name, error] of pluginErrors) {
    result.push({ id: name, version: "0.0.0", description: "", error });
  }
  return result;
}

/**
 * Returns the full manifest for a loaded plugin, or `null` if no plugin with
 * that id is loaded. Used by the enrollment service to look up contributions
 * and their config schemas (ADR-0016).
 */
export function getPluginManifest(pluginId: string): PluginManifest | null {
  return loadedPlugins.get(pluginId)?.manifest ?? null;
}

export function getCustomMcpTools(): McpToolDefinition[] {
  const tools: McpToolDefinition[] = [];
  for (const mod of loadedPlugins.values()) {
    for (const c of mod.manifest.contributions) {
      if (c.kind === "customMcpTool") {
        tools.push({
          name: c.toolName,
          description: c.description,
          inputSchema: c.inputSchema,
        });
      }
    }
  }
  return tools;
}

export function getChannelHandler(channelId: string): ChannelHandler | undefined {
  return channelRegistry.get(channelId)?.handler;
}

/**
 * Returns the issue-provider adapter for a provider from the plugin registry, or `null`.
 * The integration route's `getAdapter()` calls this first; a miss falls through to the
 * in-tree dynamic `require()` (gradual migration per ADR-0017/ADR-0028).
 */
export function getProviderAdapter(provider: string): ProviderHandler | null {
  return providerRegistry.get(provider)?.handler ?? null;
}

/**
 * Returns the formatter handler for a format ID from the plugin registry, or `undefined`.
 * The webhook dispatcher calls this first; a miss falls through to the in-tree FORMATTER_REGISTRY.
 */
export function getFormatterHandler(formatId: string): FormatterHandler | undefined {
  return formatterRegistry.get(formatId)?.handler;
}

/**
 * Returns the condition handler for a condition ID from the plugin registry, or `undefined`.
 * The automation evaluator calls this when encountering a `{ type: "plugin" }` condition.
 */
export function getConditionHandler(conditionId: string): ConditionHandler | undefined {
  return conditionRegistry.get(conditionId)?.handler;
}

/**
 * Returns the action handler entry for an action ID from the plugin registry, or `null`.
 * The automation executor calls this when encountering a `{ type: "plugin" }` action.
 */
export function getActionEntry(
  actionId: string,
): { pluginId: string; handler: ActionListener; timeoutMs?: number } | null {
  return actionRegistry.get(actionId) ?? null;
}

/**
 * Dispatches a plugin action handler with full run tracking, context building,
 * and timeout (ADR-0023). Called by the automation executor for `type: "plugin"` actions.
 */
export async function dispatchActionHandler(
  entry: { pluginId: string; handler: ActionListener; timeoutMs?: number },
  actionId: string,
  habitatId: string,
  evaluationCtx: import("@orcy/shared").PluginEvaluationContext,
  params: Record<string, unknown>,
): Promise<{ status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string }> {
  // Look up the contribution's requires from the loaded plugin manifest
  const manifest = loadedPlugins.get(entry.pluginId)?.manifest;
  const contribution = manifest?.contributions.find(
    (c) => c.kind === "automationAction" && c.actionId === actionId,
  );
  const requires = contribution && "requires" in contribution ? contribution.requires : [];

  const { runId, ctx } = startPluginRun({
    pluginId: entry.pluginId,
    contributionId: actionId,
    contributionKind: "automationAction",
    habitatId,
    triggerEventId: null,
    triggerType: "automation:plugin-action",
    requires,
  });

  try {
    const effectiveTimeout = entry.timeoutMs ?? 0;
    const result = await withTimeout(
      entry.handler(ctx, evaluationCtx, params),
      effectiveTimeout,
      entry.pluginId,
    );
    runRepo.finishRun(
      runId,
      result.status === "succeeded" ? "succeeded" : "failed",
      undefined,
      result.error,
    );
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    incrementError(`${entry.pluginId}:${actionId}`);
    runRepo.finishRun(runId, "failed", undefined, message);
    return { status: "failed", error: message };
  }
}

/**
 * Returns the detector registry entry for a `${pluginId}:${detectorId}` key, or `null`.
 * Used by the catch-up scan service to look up a detector's `detects` kind without
 * holding a reference to the private registry.
 */
export function getDetectorEntry(
  key: string,
): { pluginId: string; contribution: SignalDetectorContribution; handler: DetectorHandler } | null {
  return detectorRegistry.get(key) ?? null;
}

/**
 * Dispatches a notification delivery to a registered channel plugin handler.
 * Returns `null` when no plugin has registered a handler for `channel`
 * (caller must fall through to the in-tree switch). On a registry hit, the
 * plugin handler is invoked with a per-run `PluginContext` carrying
 * `notificationPayload`; handler exceptions are caught and surfaced as a
 * failed `ChannelHandlerResult` rather than propagating to the dispatcher.
 */
export async function dispatchToChannelPlugin(
  channel: string,
  delivery: NotificationDelivery,
  event: NotificationEvent,
): Promise<ChannelHandlerResult | null> {
  const entry = channelRegistry.get(channel);
  if (!entry) return null;

  const { runId, ctx } = startPluginRun({
    pluginId: entry.pluginId,
    contributionId: channel,
    contributionKind: "notificationChannel",
    habitatId: delivery.habitatId,
    triggerEventId: delivery.eventId,
    triggerType: `channel:${channel}`,
    requires: [],
  });
  ctx.notificationPayload = { delivery, event };

  try {
    const effectiveTimeout = entry.timeoutMs ?? DEFAULT_TIMEOUT_MS.notificationChannel ?? 0;
    const result = await withTimeout(
      entry.handler(ctx, ctx.notificationPayload),
      effectiveTimeout,
      entry.pluginId,
    );
    runRepo.finishRun(runId, result.success ? "succeeded" : "failed", undefined, result.error);
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runRepo.finishRun(runId, "failed", undefined, message);
    return { success: false, error: message };
  }
}

/**
 * Runs pre-phase interceptors for an event synchronously. Returns the first veto
 * (caller must throw/abort the DB write) or `null` if all allow. Pre-interceptors
 * are the only ones that can block a transition.
 */
export function runPreInterceptors(
  taskId: string,
  event: InterceptorEvent,
  habitatId: string,
  context: import("../services/tasks/transition-emitter.js").TransitionContext,
): { allow: false; reason: string; details?: string } | null {
  const list = interceptorRegistry.pre.get(event) ?? [];
  for (const entry of list) {
    if (!isEnrolled(habitatId, `${entry.pluginId}:${entry.contribution.interceptorId}`)) continue;
    // Pre-interceptors are synchronous validation gates (ADR-0014). They don't get run
    // tracking (no startRun/finishRun) because they're sub-millisecond synchronous checks
    // that never need audit telemetry — the post-interceptor path handles that. A
    // deterministic log correlation ID is used instead of a DB runId.
    const ctx = buildPluginContext({
      pluginId: entry.pluginId,
      contributionId: entry.contribution.interceptorId,
      habitatId,
      runId: `pre:${entry.pluginId}:${entry.contribution.interceptorId}:${taskId}:${event}`,
      requires: entry.contribution.requires,
    });
    ctx.transition = { taskId, action: event, habitatId, context };
    try {
      const raw = entry.handler(ctx, ctx.transition);
      // Pre-phase handlers are contractually synchronous (ADR-0014). A thenable return is a
      // contract violation — fail open (treat as allow) and log, so one misbehaving plugin
      // cannot block transitions by returning a Promise that the synchronous runner would never
      // await. The post-phase runner (`dispatchInterceptorRun`) correctly awaits async handlers.
      if (raw && typeof (raw as Promise<unknown>).then === "function") {
        logger.error(
          { pluginId: entry.pluginId, contributionId: entry.contribution.interceptorId },
          "Pre-phase interceptor returned a Promise — pre-phase handlers must be synchronous. Treating as allow.",
        );
      } else {
        const settled = raw as InterceptorPreResult;
        if (settled && settled.allow === false) {
          return { allow: false, reason: settled.reason, details: settled.details };
        }
      }
    } catch (err) {
      logger.error({ err, pluginId: entry.pluginId }, "Pre-interceptor threw");
    }
  }
  return null;
}

/**
 * Runs post-phase interceptors fire-and-forget. Post-interceptors cannot veto;
 * they may emit detected signals which the server persists via PulseWriter.
 */
export function runPostInterceptors(
  taskId: string,
  event: InterceptorEvent,
  habitatId: string,
  context: import("../services/tasks/transition-emitter.js").TransitionContext,
): void {
  const list = interceptorRegistry.post.get(event) ?? [];
  for (const entry of list) {
    if (!isEnrolled(habitatId, `${entry.pluginId}:${entry.contribution.interceptorId}`)) continue;
    const runId = cryptoRandom();
    void dispatchInterceptorRun(entry, taskId, event, habitatId, context, runId).catch((err) => {
      logger.error({ err, pluginId: entry.pluginId }, "Post-interceptor run failed");
    });
  }
}

async function dispatchInterceptorRun(
  entry: {
    pluginId: string;
    contribution: LifecycleInterceptorContribution;
    handler: InterceptorHandler;
  },
  taskId: string,
  event: InterceptorEvent,
  habitatId: string,
  context: import("../services/tasks/transition-emitter.js").TransitionContext,
  runId: string,
): Promise<void> {
  // runId is passed from runPostInterceptors (generated via cryptoRandom there).
  // We create a separate run record here for audit tracking.
  const { runId: dbRunId, ctx } = startPluginRun({
    pluginId: entry.pluginId,
    contributionId: entry.contribution.interceptorId,
    contributionKind: "lifecycleInterceptor",
    habitatId,
    triggerEventId: taskId,
    triggerType: `${event}:post`,
    requires: entry.contribution.requires,
  });
  ctx.transition = { taskId, action: event, habitatId, context };
  try {
    const effectiveTimeout =
      entry.contribution.timeoutMs ?? DEFAULT_TIMEOUT_MS.lifecycleInterceptor ?? 0;
    const result = await withTimeout(
      entry.handler(ctx, ctx.transition) as Promise<{ signals?: DetectedSignalInput[] }>,
      effectiveTimeout,
      entry.pluginId,
    );
    const signals = result?.signals ?? [];
    for (const signal of signals) {
      await ctx.pulseWriter?.createDetectedSignal(signal);
    }
    runRepo.finishRun(dbRunId, "succeeded", signals.length);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    runRepo.finishRun(dbRunId, "failed", undefined, message);
    throw err;
  }
}

/**
 * Fire-and-forget detector dispatch. Checks enrollment, quarantine, rate limit,
 * and per-habitat concurrency before invoking each eligible detector handler.
 */
export function dispatchDetectionEvent(kind: EventSourceRef["kind"], ref: EventSourceRef): boolean {
  let dispatched = false;
  for (const [key, entry] of detectorRegistry) {
    if (entry.contribution.detects !== kind) continue;
    if (!isEnrolled(ref.habitatId, key)) continue;
    if (quarantineSet.has(key)) continue;
    if (isRateLimited(key)) continue;
    if (!acquireConcurrencySlot(ref.habitatId)) continue;
    dispatched = true;
    void runDetector(entry, ref).catch((err) => {
      logger.error({ err, pluginId: entry.pluginId }, "Detector run failed");
    });
  }
  return dispatched;
}

async function runDetector(
  entry: { pluginId: string; contribution: SignalDetectorContribution; handler: DetectorHandler },
  ref: EventSourceRef,
): Promise<void> {
  const { runId, ctx } = startPluginRun({
    pluginId: entry.pluginId,
    contributionId: entry.contribution.detectorId,
    contributionKind: "signalDetector",
    habitatId: ref.habitatId,
    triggerEventId: ref.sourceId,
    triggerType: ref.kind,
    requires: entry.contribution.requires,
  });
  try {
    const effectiveTimeout = entry.contribution.timeoutMs ?? DEFAULT_TIMEOUT_MS.signalDetector ?? 0;
    const signals = await withTimeout(entry.handler(ctx, ref), effectiveTimeout, entry.pluginId);
    for (const signal of signals) {
      await ctx.pulseWriter?.createDetectedSignal(signal);
    }
    runRepo.finishRun(runId, "succeeded", signals.length);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    incrementError(`${entry.pluginId}:${entry.contribution.detectorId}`);
    runRepo.finishRun(runId, "failed", undefined, message);
  } finally {
    releaseConcurrencySlot(ref.habitatId);
  }
}

function registerDetectorHooks(): void {
  pulseService.onPulseCreated((pulse) => {
    if (!pulse.habitatId) return;
    // Recursion guard: detected signals are themselves detector OUTPUT. Without this check, a
    // detected pulse would re-trigger pulseCreated → dispatchDetectionEvent → detector handler
    // → another detected pulse → infinite loop (ADR-0013). Detected signals are excluded from
    // detector dispatch; they surface via the wiki "Detected Signals" tab instead.
    if (pulse.signalType === "detected") return;
    dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: pulse.id,
      habitatId: pulse.habitatId,
      occurredAt: pulse.createdAt,
    });
  });
  taskLifecycle.onTaskEvent((opts) => {
    dispatchDetectionEvent("taskEvent", {
      kind: "taskEvent",
      sourceId: `${opts.taskId}:${opts.event}`,
      habitatId: opts.habitatId,
      occurredAt: new Date().toISOString(),
    });
  });
  commentService.onCommentCreated((_comment, habitatId) => {
    if (!habitatId) return;
    dispatchDetectionEvent("commentCreated", {
      kind: "commentCreated",
      sourceId: String((_comment as { id?: unknown })?.id ?? ""),
      habitatId,
      occurredAt: new Date().toISOString(),
    });
  });
}

function isEnrolled(habitatId: string, contributionKey: string): boolean {
  let set = enrollmentCache.get(habitatId);
  if (!set) {
    set = reloadEnrollmentCache(habitatId);
  }
  return set.has(contributionKey);
}

function reloadEnrollmentCache(habitatId: string): Set<string> {
  const set = new Set<string>();
  try {
    const rows = enrollmentRepo.listEnabledByHabitat(habitatId);
    for (const row of rows) {
      set.add(`${row.pluginId}:${row.contributionId}`);
    }
  } catch (err) {
    logger.warn({ err, habitatId }, "Failed to load enrollment cache");
  }
  enrollmentCache.set(habitatId, set);
  return set;
}

export function invalidateEnrollmentCache(habitatId: string): void {
  enrollmentCache.delete(habitatId);
  reloadEnrollmentCache(habitatId);
}

function isRateLimited(pluginKey: string): boolean {
  const threshold = Number(process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD ?? "10");
  const entry = errorCounters.get(pluginKey);
  if (!entry) return false;
  const now = Date.now();
  if (now - entry.windowStart > 60_000) {
    errorCounters.delete(pluginKey);
    return false;
  }
  return entry.count >= threshold;
}

function incrementError(pluginKey: string): void {
  const now = Date.now();
  const pluginId = pluginKey.split(":")[0];
  const entry = errorCounters.get(pluginKey);
  if (!entry || now - entry.windowStart > 60_000) {
    errorCounters.set(pluginKey, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
  const threshold = Number(process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD ?? "10");
  if (entry.count >= threshold) {
    quarantineSet.add(pluginKey);
    logger.warn({ pluginKey }, "Plugin quarantined after error threshold");
    // Persist to DB so quarantine survives API restart (ADR-0016, v0.22.3).
    try {
      quarantineRepo.upsert(
        pluginKey,
        pluginId,
        `Error threshold reached (${entry.count} errors in 60s)`,
      );
    } catch (err) {
      logger.warn({ err, pluginKey }, "Failed to persist plugin quarantine");
    }
    // Emit plugin.quarantined SSE to every habitat with this plugin enrolled so
    // the loader cache invalidates and the UI can surface quarantine state.
    try {
      const enrollments = enrollmentRepo.listByPlugin(pluginId);
      const habitats = new Set(enrollments.map((e) => e.habitatId));
      for (const habitatId of habitats) {
        sseBroadcaster.publish(habitatId, {
          type: "plugin.quarantined",
          data: { habitatId, pluginId: pluginKey },
        });
      }
    } catch (err) {
      logger.warn({ err, pluginKey }, "Failed to emit plugin.quarantined SSE");
    }
  }
}

function acquireConcurrencySlot(habitatId: string): boolean {
  const max = Number(process.env.ORCY_DETECTOR_MAX_CONCURRENT ?? "8");
  const current = activeRuns.get(habitatId) ?? 0;
  if (current >= max) return false;
  activeRuns.set(habitatId, current + 1);
  return true;
}

function releaseConcurrencySlot(habitatId: string): void {
  const current = activeRuns.get(habitatId) ?? 0;
  const next = Math.max(0, current - 1);
  if (next === 0) {
    activeRuns.delete(habitatId);
  } else {
    activeRuns.set(habitatId, next);
  }
}

function cryptoRandom(): string {
  return globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2);
}

export function resetPlugins(): void {
  loadedPlugins.clear();
  pluginErrors.clear();
  pluginDirectory = null;
  channelRegistry.clear();
  formatterRegistry.clear();
  conditionRegistry.clear();
  actionRegistry.clear();
  providerRegistry.clear();
  detectorRegistry.clear();
  interceptorRegistry.pre.clear();
  interceptorRegistry.post.clear();
  enrollmentCache.clear();
  quarantineSet.clear();
  errorCounters.clear();
  activeRuns.clear();
}

/**
 * Loads persistent quarantine state from the database at boot (ADR-0016, v0.22.3).
 * Populates the in-memory `quarantineSet` so previously-quarantined plugins stay
 * quarantined across API restarts. Called once at boot after DB initialization.
 */
export function loadQuarantinesFromDb(): void {
  try {
    const rows = quarantineRepo.listAll();
    for (const row of rows) {
      quarantineSet.add(row.pluginKey);
    }
    if (rows.length > 0) {
      logger.info({ count: rows.length }, "Loaded persistent plugin quarantines from DB");
    }
  } catch (err) {
    logger.warn({ err }, "Failed to load persistent plugin quarantines — starting with empty set");
  }
}

/**
 * Clears a plugin quarantine both in-memory and in the DB (admin operation, v0.22.3).
 * Returns `true` if the plugin was quarantined and is now cleared, `false` if it was
 * not quarantined.
 */
export function clearQuarantine(pluginKey: string): boolean {
  const wasQuarantined = quarantineSet.has(pluginKey);
  quarantineSet.delete(pluginKey);
  errorCounters.delete(pluginKey);
  try {
    quarantineRepo.remove(pluginKey);
  } catch (err) {
    logger.warn({ err, pluginKey }, "Failed to remove persistent quarantine");
  }
  return wasQuarantined;
}
