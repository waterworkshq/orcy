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
import { detectedMetadataSchema } from "@orcy/shared";
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
} from "./types.js";
import type { NotificationDelivery, NotificationEvent } from "@orcy/shared";
import { buildPluginContext } from "./context.js";
import {
  CAPABILITY_MATRIX,
  CONTRIBUTION_KIND_KEYS,
  buildContributionCatalog,
  canonicalContributionKey,
  type CapabilityPolicy,
  type ActionRegistryEntry,
  type ChannelRegistryEntry,
  type ContributionKind,
  type DetectorRegistryEntry,
  type InterceptorRegistryEntry,
  type PluginRegistries,
} from "./contributionAdapters.js";
import {
  createInvocationRuntime,
  type DetectorTarget,
  type ActionTarget,
  type ChannelTarget,
  type PostInterceptorTarget,
  type PreInterceptorTarget,
  type PreVetoRequest,
  type PreVetoDecision,
  type RuntimeDeps,
  type InvocationRuntime,
  type DetectorInvocationRequest,
  type ActionInvocationRequest,
  type ChannelInvocationRequest,
  type PostInterceptorInvocationRequest,
  type ActionOutcome,
  type ChannelOutcome,
  type PostInterceptorOutcome,
  type ManagedInvocationOutcome,
} from "./invocationRuntime.js";
import { readdir, stat, realpath } from "node:fs/promises";
import { join, resolve, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { logger } from "../lib/logger.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as quarantineRepo from "../repositories/pluginQuarantine.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as pulseService from "../services/pulseService.js";
import * as pulseRepo from "../repositories/pulse.js";
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

const channelRegistry: Map<string, ChannelRegistryEntry> = new Map();
const formatterRegistry: Map<string, { pluginId: string; handler: FormatterHandler }> = new Map();
const conditionRegistry: Map<string, { pluginId: string; handler: ConditionHandler }> = new Map();
const actionRegistry: Map<string, ActionRegistryEntry> = new Map();
const providerRegistry: Map<string, { pluginId: string; handler: ProviderHandler }> = new Map();
const detectorRegistry: Map<string, DetectorRegistryEntry> = new Map();
const interceptorRegistry: {
  pre: Map<InterceptorEvent, InterceptorRegistryEntry[]>;
  post: Map<InterceptorEvent, InterceptorRegistryEntry[]>;
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
export function getActionEntry(actionId: string): ActionRegistryEntry | null {
  return actionRegistry.get(actionId) ?? null;
}

/**
 * Dispatches a plugin action handler through the Plugin Invocation Runtime
 * (ADR-0023, ADR-0039 T5). Called by the automation executor for
 * `type: "plugin"` actions.
 *
 * T5 (ADR-0039 Q3): migrated to `invokeManaged`. The runtime owns startRun,
 * quarantine gate, context construction, timeout watchdog, result validation,
 * fault classification, and finishRun. The dispatcher is now a thin adapter
 * that maps the runtime outcome to the existing Action result shape.
 *
 * Q3 REVERSAL: a quarantined Action no longer executes — the runtime writes a
 * `skipped` Plugin Run and returns an explicit `{ status: "failed" }` to the
 * caller. This eliminates the v0.28 "known asymmetry" where quarantined
 * Actions still ran.
 *
 * T2: `requires` and the canonical contribution key are read from the enriched
 * registry entry — the dispatcher no longer rescans `loadedPlugins` manifests.
 */
export async function dispatchActionHandler(
  entry: ActionRegistryEntry,
  actionId: string,
  habitatId: string,
  evaluationCtx: import("@orcy/shared").PluginEvaluationContext,
  params: Record<string, unknown>,
): Promise<{ status: "succeeded" | "failed"; result?: Record<string, unknown>; error?: string }> {
  const target = makeActionTarget(entry);
  const outcome = await invokeActionThroughRuntime(target, habitatId, evaluationCtx, params);
  return outcome.result;
}

/**
 * Returns the detector registry entry for a `${pluginId}:${detectorId}` key, or `null`.
 * Used by the catch-up scan service to look up a detector's `detects` kind without
 * holding a reference to the private registry.
 */
export function getDetectorEntry(key: string): DetectorRegistryEntry | null {
  return detectorRegistry.get(key) ?? null;
}

/**
 * Dispatches a notification delivery to a registered channel plugin handler
 * through the Plugin Invocation Runtime (ADR-0039 T5).
 *
 * Returns `null` when no plugin has registered a handler for `channel`
 * (caller — `notificationDeliveryService.dispatchChannel` — must fall through
 * to the in-tree switch). On a registry hit, the runtime owns startRun,
 * quarantine gate (defensive only — Channel faults never increment the
 * counter), context construction, timeout watchdog, result validation, fault
 * classification, and finishRun. The dispatcher is a thin adapter that maps
 * the runtime outcome to `ChannelHandlerResult`.
 *
 * T5: migrated to `invokeManaged`. Channel faults remain non-quarantine-
 * accounted (Q2); the common quarantine check is defensive only — it fires
 * for restored or future manual-quarantine state but Channels cannot reach
 * the auto-threshold in this release.
 *
 * T2: `requires` and the canonical contribution key are read from the enriched
 * registry entry — the dispatcher no longer rescans `loadedPlugins` manifests.
 */
export async function dispatchToChannelPlugin(
  channel: string,
  delivery: NotificationDelivery,
  event: NotificationEvent,
): Promise<ChannelHandlerResult | null> {
  const entry = channelRegistry.get(channel);
  if (!entry) return null;

  const target = makeChannelTarget(entry);
  const outcome = await invokeChannelThroughRuntime(target, delivery, event);
  return outcome.result;
}

// ─────────────────────────────────────────────────────────────────────────────
// T7 — pre Lifecycle Interceptor runtime migration (ADR-0039 Q1, Q10, Q13)
//
// `runPreInterceptors` dispatches each enrolled pre target through the Plugin
// Invocation Runtime's synchronous `checkPreVeto` entry point. The runtime
// owns: startRun (the invocation gate), bounded fail-closed fault handling,
// result validation, quarantine accounting + enforcement, and finishRun.
//
// BOUNDED FAIL-CLOSED (Q1): a handler throw, invalid result, or Promise return
// is a failure veto — it produces Plugin Run telemetry, increments the
// contribution's quarantine counter, and returns 403 to the caller. An explicit
// `{ allow: false }` is an ordinary domain veto that does NOT count. Once a
// pre-interceptor contribution reaches its quarantine threshold via accumulated
// faults, the runtime skips it (returns allow) so Task work continues.
//
// SYNCHRONOUS PLUGIN RUN (Q13): each pre-interceptor invocation gets a
// synchronous Plugin Run row. startRun failure = infrastructure veto (no
// handler, no counter increment). finishRun failure preserves the handler's
// decision (allow/explicit-veto/failure-veto) and reports infrastructure
// trouble. This adds one synchronous INSERT to the Task transition hot path —
// accepted per ADR-0039 Consequences.
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a normalized {@link PreInterceptorTarget} from a registry entry. */
function makePreInterceptorTarget(entry: InterceptorRegistryEntry): PreInterceptorTarget {
  return {
    kind: "preInterceptor",
    pluginId: entry.pluginId,
    contributionId: entry.contribution.interceptorId,
    handler: entry.handler,
    contribution: entry.contribution,
    requires: entry.requires,
    timeoutMs: entry.timeoutMs,
    canonicalKey: entry.canonicalKey,
  };
}

/**
 * Invokes one pre Lifecycle Interceptor target through the Plugin Invocation
 * Runtime's synchronous `checkPreVeto`. Returns the full {@link PreVetoDecision}
 * so the caller (`runPreInterceptors`) can map it to the legacy veto shape and
 * short-circuit on the first veto.
 *
 * The runtime handles: startRun, quarantine gate (skipped → allow), context
 * construction, synchronous handler invocation, result validation, fault
 * classification, counter increment, and finishRun — all synchronously.
 */
function invokePreInterceptorThroughRuntime(
  target: PreInterceptorTarget,
  taskId: string,
  event: InterceptorEvent,
  habitatId: string,
  context: import("../services/tasks/transition-emitter.js").TransitionContext,
): PreVetoDecision {
  const ctxRef: { ctx: ReturnType<typeof buildPluginContext> | null } = { ctx: null };
  const runtime: InvocationRuntime = createInvocationRuntime(buildRuntimeDeps(ctxRef));
  const request: PreVetoRequest = {
    target,
    taskId,
    event,
    habitatId,
    context,
  };
  return runtime.checkPreVeto(request);
}

/**
 * Runs pre-phase interceptors for an event synchronously. Returns the first veto
 * (caller must throw/abort the DB write) or `null` if all allow. Pre-interceptors
 * are the only ones that can block a transition.
 *
 * T7 (ADR-0039 Q1): migrated to the Plugin Invocation Runtime's `checkPreVeto`.
 * Each enrolled pre target is individually admitted and invoked through the
 * runtime. The runtime owns bounded fail-closed semantics: throw, invalid
 * result, or Promise return vetoes and counts toward quarantine; explicit
 * `{ allow: false }` is an ordinary veto; a quarantined target is skipped so
 * Task work continues. Pre priority ordering and first-veto short-circuit are
 * preserved (the registry list is priority-sorted at registration time).
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
    const target = makePreInterceptorTarget(entry);
    const decision = invokePreInterceptorThroughRuntime(target, taskId, event, habitatId, context);
    if (decision.decision === "allow") continue;
    // First veto short-circuits (pre priority preserved by registry ordering).
    const veto: { allow: false; reason: string; details?: string } = {
      allow: false,
      reason: decision.message,
    };
    if (decision.vetoReason === "explicit" && decision.details !== undefined) {
      veto.details = decision.details;
    }
    return veto;
  }
  return null;
}

/**
 * Runs post-phase interceptors fire-and-forget. Post-interceptors cannot veto;
 * they may emit detected signals which the server persists atomically through
 * the Plugin Invocation Runtime (ADR-0039 T6 / Q11).
 *
 * Each enrolled post target is dispatched via
 * `invokePostInterceptorThroughRuntime`, which routes through `invokeManaged`.
 * The runtime owns startRun (sole run-id authority), defensive quarantine
 * gate, context construction, timeout watchdog, result validation, fault
 * classification, and finishRun. The `onResult` hook persists the validated
 * signal array as ONE atomic database batch — validation or mid-batch write
 * failure rolls back the entire batch (zero committed signals) and finishes
 * the run `failed`. SSE and hooks publish only after commit.
 *
 * T6 removed the dead `runId` parameter that was previously generated by
 * `cryptoRandom()` here and ignored by the receiver. T8 deleted the now-dead
 * `cryptoRandom` and `startPluginRun` helpers. `withTimeout` is retained:
 * it is the watchdog race implementation injected into the runtime via
 * `buildRuntimeDeps` (the runtime consumes it as `deps.withTimeout`).
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
    const target = makePostInterceptorTarget(entry);
    void invokePostInterceptorThroughRuntime(target, taskId, event, habitatId, context).catch(
      (err) => {
        logger.error({ err, pluginId: entry.pluginId }, "Post-interceptor run failed");
      },
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// T4 — Detector runtime migration (ADR-0039)
//
// Live detector dispatch (`dispatchDetectionEvent`) and scanner dispatch
// (`dispatchDetectorTarget`) both route through the Plugin Invocation Runtime
// (`invokeManaged`). The runtime owns: startRun, quarantine gate, concurrency
// capacity, context construction, handler invocation, validation, onResult
// signal persistence, and finishRun.
//
// Concurrency slots are held until the UNDERLYING handler Promise settles — not
// the watchdog timeout (Q12). The runtime attaches `handlerPromise.then(release,
// release)` so a never-settling handler holds capacity until process restart.
//
// `isRateLimited` is removed (Q14): `rate_limited` status is written solely
// when a Detector cannot acquire habitat concurrency capacity.
// ─────────────────────────────────────────────────────────────────────────────

/** Scanner-facing acknowledgement for one concrete Detector target dispatch. */
export type DetectorDispatchAcknowledgement =
  | { state: "already_accounted" }
  | { state: "durably_started"; runId: string }
  | { state: "recovery_deferred"; reason: "quarantined" | "capacity" | "start_failed" };

/** Builds a normalized {@link DetectorTarget} from a registry entry. */
function makeDetectorTarget(entry: DetectorRegistryEntry): DetectorTarget {
  return {
    kind: "signalDetector",
    pluginId: entry.pluginId,
    contributionId: entry.contribution.detectorId,
    handler: entry.handler,
    contribution: entry.contribution,
    requires: entry.requires,
    timeoutMs: entry.timeoutMs,
    canonicalKey: entry.canonicalKey,
  };
}

/**
 * Builds per-invocation runtime deps. The `buildContext` dep captures a mutable
 * `ctxRef` so the `onResult` closure can persist signals through the context's
 * `pulseWriter` (which has `pluginId`/`runId`/`habitatId` baked in). This is
 * safe because JavaScript is single-threaded and each invocation creates its
 * own `ctxRef` in its own closure scope.
 */
function buildRuntimeDeps(ctxRef: {
  ctx: ReturnType<typeof buildPluginContext> | null;
}): RuntimeDeps {
  return {
    startRun: (input) => runRepo.startRun(input),
    finishRun: (id, status, signalsEmitted, error) =>
      runRepo.finishRun(id, status, signalsEmitted, error),
    buildContext: (opts) => {
      ctxRef.ctx = buildPluginContext(opts);
      return ctxRef.ctx;
    },
    isQuarantined: (key) => quarantineSet.has(key),
    incrementError,
    withTimeout,
    acquireDetectorSlot: acquireConcurrencySlot,
    releaseDetectorSlot: releaseConcurrencySlot,
    logger: {
      error: (msg, meta) => logger.error(meta ?? {}, msg),
      warn: (msg, meta) => logger.warn(meta ?? {}, msg),
      info: (msg, meta) => logger.info(meta ?? {}, msg),
    },
  };
}

/**
 * Invokes one Detector target through the Plugin Invocation Runtime. Returns
 * the full outcome so the caller can map it to its own result shape.
 *
 * Signal persistence runs via the `onResult` hook BEFORE `finishRun` — this
 * preserves the BLOCKER 1 ordering invariant (signals committed before the run
 * is marked succeeded).
 */
function invokeDetectorThroughRuntime(
  target: DetectorTarget,
  ref: EventSourceRef,
): Promise<ManagedInvocationOutcome> {
  const ctxRef: { ctx: ReturnType<typeof buildPluginContext> | null } = { ctx: null };
  const runtime: InvocationRuntime = createInvocationRuntime(buildRuntimeDeps(ctxRef));
  const request: DetectorInvocationRequest = {
    target,
    habitatId: ref.habitatId,
    triggerEventId: ref.sourceId,
    triggerType: ref.kind,
    source: ref,
    onResult: async (signals) => {
      for (const signal of signals) {
        await ctxRef.ctx?.pulseWriter?.createDetectedSignal(signal);
      }
      return signals.length;
    },
  };
  return runtime.invokeManaged(request);
}

/**
 * Fire-and-forget live detector dispatch (ADR-0039 T4). Fans out across all
 * matching, enrolled detectors. Each target is individually admitted and
 * invoked through the runtime. The live caller does NOT await handler
 * completion — the invocation is detached.
 *
 * Returns `true` if at least one target was admitted for invocation.
 * Recursion guards (detected-signal exclusion in `registerDetectorHooks`)
 * remain intact.
 */
export function dispatchDetectionEvent(kind: EventSourceRef["kind"], ref: EventSourceRef): boolean {
  let dispatched = false;
  for (const [registryKey, entry] of detectorRegistry) {
    if (entry.contribution.detects !== kind) continue;
    if (!isEnrolled(ref.habitatId, registryKey)) continue;
    const target = makeDetectorTarget(entry);
    dispatched = true;
    void invokeDetectorThroughRuntime(target, ref).catch((err) => {
      logger.error({ err, pluginId: entry.pluginId }, "Detector runtime invocation failed");
    });
  }
  return dispatched;
}

/**
 * Scanner-facing per-target Detector dispatch (ADR-0039 T4). Dispatches to ONE
 * concrete normalized Detector target and returns a durable acknowledgement.
 *
 * The scanner awaits this and advances its watermark only when the result is
 * `already_accounted` or `durably_started`. `recovery_deferred` keeps the
 * watermark behind so the target can retry on the next scan pass.
 */
export async function dispatchDetectorTarget(
  target: DetectorTarget,
  ref: EventSourceRef,
): Promise<DetectorDispatchAcknowledgement> {
  // 1. Dedup — already durably accounted?
  if (runRepo.existsForTriggerEvent(target.pluginId, target.contributionId, ref.sourceId)) {
    return { state: "already_accounted" };
  }

  // 2. Invoke through the runtime (awaits handler completion).
  const outcome = await invokeDetectorThroughRuntime(target, ref);

  // 3. Map outcome to acknowledgement.
  if (outcome.startFailed) {
    return { state: "recovery_deferred", reason: "start_failed" };
  }
  if (outcome.status === "skipped") {
    return { state: "recovery_deferred", reason: "quarantined" };
  }
  if (outcome.status === "rate_limited") {
    return { state: "recovery_deferred", reason: "capacity" };
  }
  // running / succeeded / failed = handler was durably launched.
  return { state: "durably_started", runId: outcome.runId ?? "" };
}

// ─────────────────────────────────────────────────────────────────────────────
// T5 — Action + Channel runtime migration (ADR-0039)
//
// `dispatchActionHandler` and `dispatchToChannelPlugin` both route through
// the Plugin Invocation Runtime (`invokeManaged`). The runtime owns:
// startRun, quarantine gate, context construction, handler invocation,
// validation, fault classification, and finishRun.
//
// Q3 REVERSAL: a quarantined Action no longer executes. The runtime writes
// a `skipped` Plugin Run and returns an explicit `{ status: "failed" }` to
// the caller, eliminating the v0.28 "known asymmetry".
//
// Channel faults remain non-quarantine-accounted (Q2): the common quarantine
// gate is defensive only — Channels never call `incrementError` and cannot
// reach the auto-threshold in this release.
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a normalized {@link ActionTarget} from a registry entry. */
function makeActionTarget(entry: ActionRegistryEntry): ActionTarget {
  return {
    kind: "automationAction",
    pluginId: entry.pluginId,
    contributionId: entry.contribution.actionId,
    handler: entry.handler,
    contribution: entry.contribution,
    requires: entry.requires,
    timeoutMs: entry.timeoutMs,
    canonicalKey: entry.canonicalKey,
  };
}

/** Builds a normalized {@link ChannelTarget} from a registry entry. */
function makeChannelTarget(entry: ChannelRegistryEntry): ChannelTarget {
  return {
    kind: "notificationChannel",
    pluginId: entry.pluginId,
    contributionId: entry.contribution.channelId,
    handler: entry.handler,
    contribution: entry.contribution,
    requires: entry.requires,
    timeoutMs: entry.timeoutMs,
    canonicalKey: entry.canonicalKey,
  };
}

/**
 * Invokes one Action target through the Plugin Invocation Runtime. Returns the
 * full outcome so `dispatchActionHandler` can map `outcome.result` to the
 * existing Action result shape.
 *
 * Actions are awaited (caller waits for result), unlike Detectors which are
 * fire-and-forget. The runtime outcome's `result` field directly matches the
 * Action result shape `{ status, result?, error? }`.
 */
function invokeActionThroughRuntime(
  target: ActionTarget,
  habitatId: string,
  evalCtx: import("@orcy/shared").PluginEvaluationContext,
  params: Record<string, unknown>,
): Promise<ActionOutcome> {
  const ctxRef: { ctx: ReturnType<typeof buildPluginContext> | null } = { ctx: null };
  const runtime: InvocationRuntime = createInvocationRuntime(buildRuntimeDeps(ctxRef));
  const request: ActionInvocationRequest = {
    target,
    habitatId,
    triggerType: "automation:plugin-action",
    evalCtx,
    params,
  };
  // The runtime guarantees kind-correspondence: an ActionInvocationRequest
  // always produces an ActionOutcome. The cast encodes that structural invariant.
  return runtime.invokeManaged(request) as Promise<ActionOutcome>;
}

/**
 * Invokes one Channel target through the Plugin Invocation Runtime. Returns
 * the full outcome so `dispatchToChannelPlugin` can map `outcome.result` to
 * `ChannelHandlerResult`.
 *
 * The runtime's `populateKindPayload` sets `ctx.notificationPayload` from the
 * request's `delivery` and `event` fields before invoking the handler.
 */
function invokeChannelThroughRuntime(
  target: ChannelTarget,
  delivery: NotificationDelivery,
  event: NotificationEvent,
): Promise<ChannelOutcome> {
  const ctxRef: { ctx: ReturnType<typeof buildPluginContext> | null } = { ctx: null };
  const runtime: InvocationRuntime = createInvocationRuntime(buildRuntimeDeps(ctxRef));
  const request: ChannelInvocationRequest = {
    target,
    habitatId: delivery.habitatId,
    triggerEventId: delivery.eventId,
    triggerType: `channel:${target.contributionId}`,
    delivery,
    event,
  };
  // The runtime guarantees kind-correspondence: a ChannelInvocationRequest
  // always produces a ChannelOutcome. The cast encodes that structural invariant.
  return runtime.invokeManaged(request) as Promise<ChannelOutcome>;
}

// ─────────────────────────────────────────────────────────────────────────────
// T6 — post Lifecycle Interceptor runtime migration (ADR-0039 Q11)
//
// `runPostInterceptors` dispatches each enrolled post target via
// `invokePostInterceptorThroughRuntime`, which routes through the Plugin
// Invocation Runtime (`invokeManaged`). The runtime owns: startRun, defensive
// quarantine gate, context construction, handler invocation, validation, fault
// classification, and finishRun.
//
// ATOMIC SIGNAL BATCH (Q11): the previous sequential
//   `for (signal) { await ctx.pulseWriter?.createDetectedSignal(signal) }`
// loop is replaced by an atomic batch. The `onResult` hook persists the whole
// validated signal array in ONE database transaction via
// `pulseService.createPulseBatchAtomic`. Validation or mid-batch write failure
// rolls back the entire batch (zero committed signals) and finishes the run
// `failed`. SSE and hooks publish only after commit.
//
// Post faults remain non-quarantine-accounted (Q2): the common quarantine
// check is defensive only — post-interceptors never call `incrementError` and
// cannot reach the auto-threshold in this release.
// ─────────────────────────────────────────────────────────────────────────────

/** Builds a normalized {@link PostInterceptorTarget} from a registry entry. */
function makePostInterceptorTarget(entry: {
  pluginId: string;
  contribution: LifecycleInterceptorContribution;
  handler: InterceptorHandler;
  requires: PluginCapabilityName[];
  timeoutMs?: number;
  canonicalKey: string;
}): PostInterceptorTarget {
  return {
    kind: "postInterceptor",
    pluginId: entry.pluginId,
    contributionId: entry.contribution.interceptorId,
    handler: entry.handler,
    contribution: entry.contribution,
    requires: entry.requires,
    timeoutMs: entry.timeoutMs,
    canonicalKey: entry.canonicalKey,
  };
}

/**
 * Invokes one post Lifecycle Interceptor target through the Plugin Invocation
 * Runtime. Returns the full `PostInterceptorOutcome` so the caller
 * (`runPostInterceptors`) can detach fire-and-forget.
 *
 * Signal persistence runs via the `onResult` hook BEFORE `finishRun`. The hook
 * builds per-signal `CreatePulseInput` records stamped with
 * `{ detected: true, detector: pluginId, detectorRunId: ctxRef.ctx.runId }`
 * (mirroring `buildPulseWriter.createDetectedSignal`), then calls the atomic
 * batch writer. The returned count becomes the Plugin Run's `signalsEmitted`.
 *
 * Defense-in-depth: even though `validatePostResult` already validated each
 * signal shape at runtime level, we re-validate the merged metadata against
 * `detectedMetadataSchema` before the batch — same belt-and-suspenders check
 * `buildPulseWriter` performs on the singular path. A failure here aborts the
 * entire batch (zero signals committed) and propagates to the runtime, which
 * finishes the run `failed`.
 */
function invokePostInterceptorThroughRuntime(
  target: PostInterceptorTarget,
  taskId: string,
  event: InterceptorEvent,
  habitatId: string,
  context: import("../services/tasks/transition-emitter.js").TransitionContext,
): Promise<PostInterceptorOutcome> {
  const ctxRef: { ctx: ReturnType<typeof buildPluginContext> | null } = { ctx: null };
  const runtime: InvocationRuntime = createInvocationRuntime(buildRuntimeDeps(ctxRef));
  const request: PostInterceptorInvocationRequest = {
    target,
    habitatId,
    triggerEventId: taskId,
    triggerType: `${event}:post`,
    taskId,
    event,
    context,
    onResult: async (signals) => {
      if (signals.length === 0) return 0;
      const runId = ctxRef.ctx?.runId;
      const inputs: pulseRepo.CreatePulseInput[] = signals.map((s) => {
        const merged: Record<string, unknown> = {
          ...s.metadata,
          detected: true,
          detector: target.pluginId,
          detectorRunId: runId,
        };
        // Same defense-in-depth check as buildPulseWriter.createDetectedSignal:
        // if a future refactor lets caller-supplied metadata override the
        // stamped fields, this catches it BEFORE we open the batch transaction.
        const metaParse = detectedMetadataSchema.safeParse(merged);
        if (!metaParse.success) {
          throw new Error(`Detected signal metadata failed validation: ${metaParse.error.message}`);
        }
        const input: pulseRepo.CreatePulseInput = {
          habitatId,
          scope: "habitat",
          fromType: "system",
          fromId: target.pluginId,
          signalType: "detected",
          subject: s.subject,
          ...(s.body !== undefined ? { body: s.body } : {}),
          ...(s.taskId !== undefined ? { taskId: s.taskId } : {}),
          ...(s.missionId !== undefined ? { missionId: s.missionId } : {}),
          ...(s.replyToId !== undefined ? { replyToId: s.replyToId } : {}),
          metadata: merged,
          isAuto: true,
        };
        return input;
      });
      const pulses = pulseService.createPulseBatchAtomic(inputs);
      return pulses.length;
    },
  };
  // The runtime guarantees kind-correspondence: a PostInterceptorInvocationRequest
  // always produces a PostInterceptorOutcome. The cast encodes that structural invariant.
  return runtime.invokeManaged(request) as Promise<PostInterceptorOutcome>;
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

/**
 * Increments the per-contribution error counter; on threshold crossing, adds
 * the canonical contribution key to `quarantineSet`, persists it, and emits
 * `plugin.quarantined` SSE.
 *
 * T2: `pluginKey` is the JSON-encoded canonical contribution key produced by
 * `canonicalContributionKey`. The `pluginId` is passed separately (rather than
 * parsed out of the key) because the JSON format makes positional extraction
 * brittle and the caller already has the entry with `pluginId` on it. The
 * SSE payload carries both `pluginId` (real plugin id, for the UI's existing
 * enrollment/runs cache invalidation) and `contributionKey` (canonical
 * contribution key, for admin clear-quarantine calls).
 */
function incrementError(pluginKey: string, pluginId: string): void {
  const now = Date.now();
  const threshold = Number(process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD ?? "10");
  const entry = errorCounters.get(pluginKey);
  let count: number;
  if (!entry || now - entry.windowStart > 60_000) {
    count = 1;
    errorCounters.set(pluginKey, { count, windowStart: now });
  } else {
    entry.count += 1;
    count = entry.count;
  }
  if (count >= threshold) {
    quarantineSet.add(pluginKey);
    logger.warn({ pluginKey }, "Plugin quarantined after error threshold");
    // Persist to DB so quarantine survives API restart (ADR-0016, v0.22.3).
    try {
      quarantineRepo.upsert(
        pluginKey,
        pluginId,
        `Error threshold reached (${count} errors in 60s)`,
      );
    } catch (err) {
      logger.warn({ err, pluginKey }, "Failed to persist plugin quarantine");
    }
    // Emit plugin.quarantined SSE to every habitat with this plugin enrolled so
    // the loader cache invalidates and the UI can surface quarantine state.
    // T2: the SSE payload now carries the real plugin id (for UI cache
    // invalidation by plugin) AND the canonical contribution key (for admin
    // clear-quarantine calls — the key the user/admin passes back through the
    // DELETE /habitats/:id/plugins/:pluginKey/quarantine route).
    try {
      const enrollments = enrollmentRepo.listByPlugin(pluginId);
      const habitats = new Set(enrollments.map((e) => e.habitatId));
      for (const habitatId of habitats) {
        sseBroadcaster.publish(habitatId, {
          type: "plugin.quarantined",
          data: { habitatId, pluginId, contributionKey: pluginKey },
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
