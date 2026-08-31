/**
 * Core-owned System Plugin HTTP routes (ADR-0050, supersedes ADR-0041).
 *
 * Plugins no longer receive Fastify registration capability. A plugin DECLARES
 * routes in its manifest (`customHttpRoute` contributions with a stable
 * `routeId`, one supported method, and a path relative to the plugin's
 * namespace) and exports keyed request handlers in `httpHandlers`. This module
 * is the single authority between the two:
 *
 *   1. {@link validatePluginHttpRouteDeclarations} runs during plugin discovery
 *      (pluginManager `loadPlugins`). A structural declaration fault rejects
 *      the whole plugin while the scan continues to later valid plugins — the
 *      existing load-failure containment.
 *   2. {@link installPluginRoutes} is the single core installer. It mounts the
 *      validated catalog under BOTH the current namespace
 *      (`/api/v1/plugins/:pluginId/*`) and the deprecated mirror
 *      (`/api/plugins/:pluginId/*`), always with the fixed `local_actor`
 *      policy, per-agent rate limiting matching the core API groups, and the
 *      `Deprecation` header only on the deprecated mirror.
 *
 * Handler faults are request-scoped: they are logged with plugin/route
 * identity and rethrown through the global error envelope. They never touch
 * the Plugin Invocation Runtime, quarantine counters, or process liveness —
 * there is no mount-time plugin execution at all, so ADR-0041's crash-loud
 * activation case no longer exists.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { CustomHttpRouteContribution } from "@orcy/shared";
import type { PluginHttpHandler, PluginHttpRequest, PluginHttpResponse, PluginModule } from "./types.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";

/** Methods a `customHttpRoute` declaration may use. Mirrors the shared union. */
const SUPPORTED_METHODS = new Set(["GET", "POST", "PATCH", "DELETE"]);

/**
 * Identifier grammar shared by `routeId` and the mounted `pluginId` segment:
 * starts alphanumeric, then alphanumerics plus `.` `_` `-` (≤100 chars). No
 * slashes, colons, spaces, or percent-encoding — a safe handler-map key and a
 * safe single URL path segment.
 */
const ID_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/**
 * Path grammar for declared routes: starts `/`, every segment non-empty and
 * built from URL-unreserved characters only. Static segments — no `:params`,
 * no `*` wildcards, no trailing slash, no `.`/`..` traversal, no percent
 * escapes, no query or fragment. Validation makes the declared form canonical,
 * so normalization is identity and duplicate detection cannot be evaded by
 * path-case/trailing-slash variants (the documented hole in the superseded
 * collision-only registry).
 */
const RELATIVE_PATH_PATTERN = /^\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*$/;

/** Normalized method of a declared route. */
export type PluginHttpMethod = "GET" | "POST" | "PATCH" | "DELETE";

/** Uppercases a declared method; `null` when it is not one of the four supported. */
export function normalizePluginRouteMethod(method: unknown): PluginHttpMethod | null {
  if (typeof method !== "string" || method.length === 0) return null;
  const upper = method.toUpperCase();
  return SUPPORTED_METHODS.has(upper) ? (upper as PluginHttpMethod) : null;
}

/** Validates a declared relative path; returns it unchanged (canonical by grammar) or `null`. */
export function validatePluginRoutePath(path: unknown): string | null {
  if (typeof path !== "string" || !RELATIVE_PATH_PATTERN.test(path)) return null;
  // The character grammar alone admits "." and ".." (both build from allowed
  // characters) — reject them explicitly: a declared path must never mount
  // outside the plugin namespace.
  for (const segment of path.split("/")) {
    if (segment === "." || segment === "..") return null;
  }
  return path;
}

/** Validates a `routeId` (or the mounted `pluginId` segment); `null` when malformed. */
export function validatePluginRouteId(id: unknown): string | null {
  return typeof id === "string" && ID_SEGMENT_PATTERN.test(id) ? id : null;
}

/** One validated, installable route from operational plugin discovery. */
export interface PluginRouteCatalogEntry {
  pluginId: string;
  routeId: string;
  method: PluginHttpMethod;
  /** Canonical relative path; mounted at `/${pluginId}${path}` under each prefix. */
  path: string;
  handler: PluginHttpHandler;
}

/** The validated plugin-route catalog consumed by {@link installPluginRoutes}. */
export type PluginRouteCatalog = readonly PluginRouteCatalogEntry[];

function declarationLabel(c: CustomHttpRouteContribution): string {
  return typeof c.routeId === "string" && c.routeId ? c.routeId : "<missing routeId>";
}

/**
 * Breaking plugin-SDK contract (ADR-0050): the unrestricted callback is gone
 * from the {@link PluginModule} type, so the legacy field is read
 * structurally. Reject loudly with the migration path rather than silently
 * mounting nothing. Shared by the adapter's `orphanCheck` (earliest rejection)
 * and {@link validatePluginHttpRouteDeclarations} (plugins without route
 * declarations still fail on the dead export).
 */
export function legacyRouteHandlersFault(mod: PluginModule): string | null {
  const legacy = (mod as { routeHandlers?: unknown }).routeHandlers;
  if (legacy === undefined) return null;
  return (
    "module.routeHandlers is no longer supported (core-owned plugin HTTP routes, ADR-0050); " +
    "declare customHttpRoute contributions with routeId and export httpHandlers keyed by routeId"
  );
}

/**
 * Whole-plugin validation of a module's HTTP route surface, run during
 * discovery AFTER `validatePlugin`/`detectIdCollisions` accept it. Returns the
 * first structural fault as an actionable error string, or `null` when the
 * declarations and handler map agree exactly.
 *
 * Checked here (cross-contribution view; per-contribution field shape also
 * runs in the adapter's `orphanCheck` for the earliest possible rejection):
 *   - legacy `routeHandlers` export → explicit breaking-contract rejection
 *   - `httpHandlers` map shape (null / arrays are not Records)
 *   - every declaration: `routeId` shape, method membership, path grammar,
 *     fixed `"system"` scope, and exactly one keyed own-property handler in
 *     `httpHandlers` (inherited Object.prototype functions do not count)
 *   - duplicate `routeId` within the manifest
 *   - duplicate normalized `METHOD path` within the manifest
 *   - handler-map keys with no matching declaration (undeclared extras)
 */
export function validatePluginHttpRouteDeclarations(mod: PluginModule): string | null {
  const legacyFault = legacyRouteHandlersFault(mod);
  if (legacyFault) return legacyFault;

  const declarations = mod.manifest.contributions.filter(
    (c): c is CustomHttpRouteContribution => c.kind === "customHttpRoute",
  );

  // Map-shape honesty for runtime JS values: `null` is typeof "object" and
  // arrays are objects too — both must be rejected as non-Record maps rather
  // than accepted/coalesced into an empty map.
  if (
    mod.httpHandlers !== undefined &&
    (typeof mod.httpHandlers !== "object" ||
      mod.httpHandlers === null ||
      Array.isArray(mod.httpHandlers))
  ) {
    return `module.httpHandlers must be a Record<routeId, handler> when present (plugin "${mod.manifest.id}")`;
  }
  const handlers = mod.httpHandlers ?? {};

  if (declarations.length === 0) {
    const extra = Object.keys(handlers);
    if (extra.length > 0) {
      return (
        `plugin "${mod.manifest.id}" exports httpHandlers [${extra.join(", ")}] but declares ` +
        "no customHttpRoute contributions — every handler mapping must match a declared routeId"
      );
    }
    return null;
  }

  // The mounted namespace embeds the plugin id as a URL segment; a plugin that
  // declares HTTP routes must have a segment-safe id.
  if (!validatePluginRouteId(mod.manifest.id)) {
    return (
      `plugin id "${mod.manifest.id}" is not URL-segment-safe and cannot mount HTTP routes ` +
      "(expected [A-Za-z0-9][A-Za-z0-9._-]{0,99})"
    );
  }

  const seenRouteIds = new Set<string>();
  const seenMethodPaths = new Set<string>();
  const declaredRouteIds = new Set<string>();

  for (const c of declarations) {
    const label = declarationLabel(c);
    if (!validatePluginRouteId(c.routeId)) {
      return (
        `customHttpRoute "${label}" has a malformed routeId (expected ` +
        `[A-Za-z0-9][A-Za-z0-9._-]{0,99})`
      );
    }
    if (c.scope !== "system") {
      return `customHttpRoute "${c.routeId}" must declare scope "system" (got ${JSON.stringify(c.scope)})`;
    }
    const method = normalizePluginRouteMethod(c.method);
    if (!method) {
      return `customHttpRoute "${c.routeId}" method must be one of: GET, POST, PATCH, DELETE`;
    }
    if (!validatePluginRoutePath(c.path)) {
      return (
        `customHttpRoute "${c.routeId}" has a malformed path ${JSON.stringify(c.path)} — ` +
        "expected a relative path of unreserved-character segments starting with \"/\" " +
        "(no params, wildcards, traversal, trailing slash, or percent-encoding)"
      );
    }
    if (seenRouteIds.has(c.routeId)) {
      return `duplicate routeId "${c.routeId}" within manifest`;
    }
    seenRouteIds.add(c.routeId);
    declaredRouteIds.add(c.routeId);

    const methodPath = `${method} ${c.path}`;
    if (seenMethodPaths.has(methodPath)) {
      return `duplicate route "${methodPath}" within manifest`;
    }
    seenMethodPaths.add(methodPath);

    // Own-property agreement: an inherited Object.prototype function
    // (`constructor`, `toString`, …) must NOT satisfy "exactly one keyed
    // handler" — a prototype-chain key with no exported handler is a missing
    // handler (review finding 1).
    if (!Object.hasOwn(handlers, c.routeId) || typeof handlers[c.routeId] !== "function") {
      return `customHttpRoute "${c.routeId}" declared but no matching handler in module.httpHandlers`;
    }
  }

  for (const key of Object.keys(handlers)) {
    if (!declaredRouteIds.has(key)) {
      return (
        `plugin "${mod.manifest.id}" exports httpHandlers["${key}"] with no matching ` +
        "customHttpRoute declaration — every handler mapping must match a declared routeId"
      );
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Installation
// ---------------------------------------------------------------------------

/** Current plugin route namespace. */
export const PLUGIN_ROUTE_PREFIX_CURRENT = "/api/v1/plugins";
/** Deprecated mirror namespace; its responses carry `Deprecation: true`. */
export const PLUGIN_ROUTE_PREFIX_DEPRECATED = "/api/plugins";

function toPluginHttpRequest(entry: PluginRouteCatalogEntry, request: FastifyRequest): PluginHttpRequest {
  const actor = request.user
    ? { type: "human" as const, id: request.user.id, name: request.user.username ?? null }
    : request.agent
      ? { type: "agent" as const, id: request.agent.id, name: request.agent.name ?? null }
      : null;
  return {
    method: entry.method,
    path: entry.path,
    params: (request.params ?? {}) as Record<string, string>,
    query: (request.query ?? {}) as Record<string, unknown>,
    body: request.body,
    headers: request.headers,
    actor,
  };
}

/**
 * Request-scoped handler wrapper. Invokes the plugin handler with bounded
 * inputs and maps its bounded response. A throw is logged with plugin/route
 * identity and rethrown so the global error envelope answers the request —
 * no quarantine accounting, no plugin deactivation, no process impact.
 */
async function handlePluginRouteRequest(
  entry: PluginRouteCatalogEntry,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  let result: PluginHttpResponse | void;
  try {
    result = await entry.handler(toPluginHttpRequest(entry, request));
  } catch (err) {
    request.log.error(
      { err, pluginId: entry.pluginId, routeId: entry.routeId, method: entry.method, path: entry.path },
      "Plugin HTTP route handler failed",
    );
    throw err;
  }
  if (result === undefined || result === null) {
    await reply.code(204).send();
    return;
  }
  await reply.code(result.status ?? 200).send(result.body);
}

function registerPluginRoute(
  fastify: FastifyInstance,
  entry: PluginRouteCatalogEntry,
): void {
  fastify.route({
    method: entry.method,
    url: `/${entry.pluginId}${entry.path}`,
    // Fixed policy: core installs local human-or-agent authentication for
    // every plugin route; the declaration cannot choose, remove, or widen it.
    config: { authPolicy: "local_actor" },
    handler: (request, reply) => handlePluginRouteRequest(entry, request, reply),
  });
}

/**
 * Narrow structural record of one plugin-namespace hook installation — the
 * plugin-seam mirror of the assembly's hook-installation observation. Declared
 * structurally here rather than imported from `httpApp.ts` so the installer
 * never depends on its consumer: the assembly threads its per-construction
 * observer through the runtime handle's `installPluginRoutes` lifecycle step.
 */
export interface PluginHookInstallationRecord {
  surface: "plugin-current" | "plugin-deprecated";
  hookKind: "preHandler" | "onSend";
  name: string;
}

/** Options for {@link installPluginRoutes}. */
export interface InstallPluginRoutesOptions {
  /**
   * Per-construction observer invoked at the exact statement that installs
   * each plugin-namespace hook. When omitted (ordinary boot without
   * observation) installation is identical to a bare `addHook` — no records,
   * no behavior difference.
   */
  onHookInstalled?: (record: PluginHookInstallationRecord) => void;
}

/**
 * The single core installer for validated plugin routes (ADR-0050). Mounts
 * every catalog entry under both the current and deprecated plugin namespaces.
 * Registration is declaration-only — no plugin code executes at mount time,
 * and one request dispatches exactly one handler invocation (each prefix
 * yields a distinct URL, so the twin mounts cannot double-match). Each
 * namespace hook installation emits its record through the optional
 * per-construction observer.
 */
export async function installPluginRoutes(
  fastify: FastifyInstance,
  catalog: PluginRouteCatalog,
  options?: InstallPluginRoutesOptions,
): Promise<void> {
  if (catalog.length === 0) return;
  const onHookInstalled = options?.onHookInstalled;

  await fastify.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      onHookInstalled?.({
        surface: "plugin-current",
        hookKind: "preHandler",
        name: "per-agent-rate-limit",
      });
      for (const entry of catalog) {
        registerPluginRoute(f, entry);
      }
    },
    { prefix: PLUGIN_ROUTE_PREFIX_CURRENT },
  );

  await fastify.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      onHookInstalled?.({
        surface: "plugin-deprecated",
        hookKind: "preHandler",
        name: "per-agent-rate-limit",
      });
      // Deprecated mirror only. The authoritative assembly uses the same
      // wire-effective `onSend` stage for the core `/api` group, preserving
      // current/deprecated prefix parity while keeping the header scoped to
      // deprecated routes.
      f.addHook("onSend", (_request, reply, _payload, done) => {
        reply.header("Deprecation", "true");
        done();
      });
      onHookInstalled?.({
        surface: "plugin-deprecated",
        hookKind: "onSend",
        name: "deprecation-header",
      });
      for (const entry of catalog) {
        registerPluginRoute(f, entry);
      }
    },
    { prefix: PLUGIN_ROUTE_PREFIX_DEPRECATED },
  );
}
