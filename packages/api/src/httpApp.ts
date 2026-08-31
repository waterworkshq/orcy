/**
 * Authoritative staged HTTP application assembly (ADR-0049).
 *
 * `createHttpApplication` is the ONE owner of the production HTTP surface:
 * Fastify construction, validator/serializer compilers, root CORS/Helmet/
 * error/audit hooks, the policy installer, raw-body eligibility, health,
 * root redirect, optional static UI, both local API prefix groups
 * (`/api/v1` and deprecated `/api`) with their inline archive routes,
 * realtime (`/sse`), the Remote Participant API (`/api/shared`), and staged
 * System Plugin route installation (ADR-0050). Route registration order is
 * boot-relevant and preserved from the pre-extraction `index.ts`.
 *
 * The lifecycle is one-way and closed:
 *
 *   core_registered → plugins_installed → ready → closed
 *
 * Plugin catalog installation (`installPluginRoutes`) is required exactly
 * once — an explicitly empty validated catalog installs too; repeated,
 * skipped, or late installation and repeated or late finalization are boot
 * errors. `finalize` runs Fastify readiness (every route must carry an
 * effective authentication policy) and derives the production route
 * inventory from the same registration stream the server serves.
 *
 * The executable (`src/index.ts`) receives only the narrow runtime handle:
 * staged plugin install, finalize, listen/inject, close, onClose, logging,
 * and the derived inventory — never the `FastifyInstance`, never route
 * registration. Operational startup (DB, caches, schedulers, workers,
 * plugin discovery, daemon wiring, signals, shutdown coordination) stays
 * outside this module; the historical worker waypoint is invoked here
 * exactly once so its ordering is assembly-owned.
 */
import Fastify from "fastify";
import type {
  FastifyBaseLogger,
  FastifyLoggerOptions,
  InjectOptions,
  LightMyRequestResponse,
  RouteOptions,
} from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import fastifyRawBody from "fastify-raw-body";
import fs from "node:fs";
import { ORCY_PATHS } from "@orcy/shared";
import {
  installAuthPolicy,
  inheritAuthPolicy,
  registerFrameworkCorsRoute,
  resolveEffectiveAuthPolicy,
  verifiedIngressRoutePaths,
  type AuthPolicy,
} from "./authPolicy.js";
import {
  installPluginRoutes as mountPluginRouteCatalog,
  type PluginRouteCatalog,
} from "./plugins/pluginHttpRoutes.js";
import { habitatRoutes } from "./routes/habitats.js";
import { habitatAnalyticsRoutes } from "./routes/board-analytics.js";
import { habitatExportRoutes } from "./routes/board-export.js";
import { columnRoutes } from "./routes/columns.js";
import { taskRoutes } from "./routes/tasks.js";
import { missionRoutes } from "./routes/missions.js";
import { roadmapRoutes } from "./routes/roadmap.js";
import { agentRoutes } from "./routes/agents.js";
import { sseRoutes } from "./routes/sse.js";
import { authRoutes } from "./routes/auth.js";

import { webhookRoutes } from "./routes/webhookOutgoing.js";
import { commentRoutes } from "./routes/comments.js";
import { missionCommentRoutes } from "./routes/missionComments.js";
import { auditExportRoutes } from "./routes/auditExport.js";
import { auditBundleRoutes } from "./routes/auditBundle.js";
import { habitatHealthRoutes } from "./routes/boardHealth.js";
import { archiveOldEvents } from "./services/auditArchivalService.js";
import { templateRoutes } from "./routes/templates.js";
import { workflowRoutes } from "./routes/workflow.js";
import { metricsRoutes } from "./routes/metrics.js";
import { subtaskRoutes } from "./routes/subtasks.js";
import { presenceRoutes } from "./routes/presence.js";
import { dashboardRoutes } from "./routes/dashboard.js";
import { savedFilterRoutes } from "./routes/savedFilters.js";
import { attachmentRoutes } from "./routes/attachments.js";
import { notificationPrefRoutes } from "./routes/notificationPreferences.js";
import { notificationRoutes } from "./routes/notifications.js";
import { automationRoutes } from "./routes/automationRules.js";
import { chatIntegrationRoutes } from "./routes/chatIntegration.js";
import { agentMessageRoutes } from "./routes/agentMessages.js";
import { habitatAgentMailRoutes } from "./routes/habitatAgentMail.js";
import { pulseRoutes } from "./routes/pulse.js";
import { insightsRoutes } from "./routes/insights.js";
import { codeReviewWebhookRoutes } from "./routes/codeReviewWebhooks.js";
import { ciCdWebhookRoutes } from "./routes/ciCdWebhooks.js";
import { organizationRoutes } from "./routes/organizations.js";
import { timeTrackingRoutes } from "./routes/timeTracking.js";
import { effortRoutes } from "./routes/effort.js";
import { dependencyRoutes } from "./routes/dependencies.js";
import { qualityGateRoutes } from "./routes/qualityGates.js";
import { prioritizationRoutes } from "./routes/prioritization.js";
import { scheduledTaskRoutes } from "./routes/scheduledTasks.js";
import { reviewRuleRoutes } from "./routes/reviewRules.js";
import { sprintRoutes } from "./routes/sprints.js";
import { integrationRoutes } from "./routes/integrations.js";
import { githubIssueWebhookRoutes } from "./routes/githubIssueWebhooks.js";
import { daemonRoutes, daemonAdminRoutes } from "./routes/daemon.js";
import { habitatSkillRoutes } from "./routes/habitatSkill.js";
import { wikiRoutes } from "./routes/wiki.js";
import { remoteAccessRoutes } from "./routes/remoteAccess.js";
import { sharedInviteRoutes } from "./routes/sharedInvite.js";
import { sharedApiRoutes } from "./routes/sharedApi.js";
import { remoteWebhookRoutes } from "./routes/remoteWebhooks.js";
import { pluginRoutes } from "./routes/plugins.js";
import { triageRoutes } from "./routes/triage.js";
import { taskCreationAttemptRoutes } from "./routes/taskCreationAttempts.js";
import { taskPublicationRoutes } from "./routes/taskPublication.js";
import { taskClonePublicationRoutes } from "./routes/taskClonePublication.js";
import { scheduledOccurrenceRepairRoutes } from "./routes/scheduledOccurrenceRepair.js";
import { extractionRoutes } from "./routes/extraction.js";
import {
  taskCodeEvidenceRoutes,
  missionCodeEvidenceRoutes,
  repositorySettingsRoutes,
} from "./routes/codeEvidence.js";

import { registerErrorHandler } from "./errors/plugin.js";
import { perAgentRateLimit } from "./middleware/rateLimit.js";
import {
  getAuditProvenanceMetadata,
  runWithAuditProvenance,
  updateAuditProvenance,
} from "./services/auditProvenanceContext.js";

const API_VERSION = 1;

/**
 * One record per hook installation performed by the assembly, emitted at the
 * exact statement that installs the hook. Consumed by the route
 * characterization suite so hook parity is observed from production code
 * rather than asserted from a hand-written description.
 */
export interface HookInstallationRecord {
  surface: "root" | "api-v1" | "api-deprecated" | "sse" | "plugin-current" | "plugin-deprecated";
  hookKind: "onRequest" | "preHandler" | "onSend" | "onResponse";
  name: string;
}

type HookInstallObserver = (record: HookInstallationRecord) => void;

/**
 * Installs one hook and emits its installation record through the
 * per-construction observer — same call, same truth. Without an observer
 * (ordinary production boot) this registers identically to a bare `addHook`.
 */
function installHook(
  observer: HookInstallObserver | undefined,
  record: HookInstallationRecord,
  install: () => void,
): void {
  install();
  observer?.(record);
}

/**
 * Routes eligible for exact raw-body capture (provider-signed ingress),
 * derived from the verified-ingress verifier declarations in `authPolicy.ts`
 * — the same declarations that install the verifier guards. There is no
 * separately maintained literal path list.
 */
export const RAW_BODY_ROUTES: readonly string[] = verifiedIngressRoutePaths();

function productionLogger(): FastifyLoggerOptions | boolean {
  const isDev = process.env.NODE_ENV !== "production";
  return {
    level: process.env.LOG_LEVEL ?? (isDev ? "info" : "warn"),
    ...(isDev ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  };
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** One-way assembly stages (ADR-0049). */
export type HttpAssemblyState = "core_registered" | "plugins_installed" | "ready" | "closed";

/** Boot error for any out-of-order lifecycle operation. */
export class HttpAssemblyLifecycleError extends Error {
  constructor(operation: string, state: HttpAssemblyState) {
    super(
      `HTTP assembly lifecycle violation: "${operation}" is not allowed in state "${state}". ` +
        "The assembly is one-way: core_registered → plugins_installed (installPluginRoutes, " +
        "exactly once and required, an empty validated catalog included) → ready (finalize, " +
        "exactly once) → closed.",
    );
    this.name = "HttpAssemblyLifecycleError";
  }
}

// ---------------------------------------------------------------------------
// Production-derived route inventory
// ---------------------------------------------------------------------------

/** Who registered a route, as the assembly observed it. */
export type AssemblyRouteSource = "core" | "plugin" | "static" | "framework";

/**
 * One inventory entry per (method, url) the assembled application can serve.
 * Derived at `finalize` from the same registration stream that produced the
 * live server — there is no copied route list.
 */
export interface AssemblyRouteInventoryEntry {
  method: string;
  url: string;
  /** Effective authentication policy from the same declaration that installed the guard; null when none. */
  effectivePolicy: AuthPolicy | null;
  /** Final installed preHandler chain (mechanism evidence, names only). */
  guards: string[];
  rawBodyEligible: boolean;
  source: AssemblyRouteSource;
  /** True for Fastify-synthesized HEAD twins (GET twin exists) and the framework CORS catch-all. */
  generatedTwin: boolean;
}

interface CapturedRoute {
  routeOptions: RouteOptions;
  source: Exclude<AssemblyRouteSource, "framework">;
}

function methodsOf(routeOptions: RouteOptions): string[] {
  const raw = routeOptions.method;
  return (Array.isArray(raw) ? raw : [raw]).map((m) => String(m).toUpperCase());
}

function handlerNames(preHandler: unknown): string[] {
  if (!preHandler) return [];
  const fns = Array.isArray(preHandler) ? preHandler : [preHandler];
  return fns.map((fn) => (typeof fn === "function" && fn.name ? fn.name : "<anonymous>"));
}

function isWildcardOptionsRoute(routeOptions: RouteOptions): boolean {
  return routeOptions.url === "*" && methodsOf(routeOptions).includes("OPTIONS");
}

/**
 * Normalizes the captured registration stream into the inventory. HEAD twins
 * with a GET twin are Fastify-synthesized (framework); a HEAD entry without
 * one stays first-class, as does any OPTIONS route other than the one
 * framework-owned CORS catch-all.
 */
function deriveInventory(captured: readonly CapturedRoute[]): AssemblyRouteInventoryEntry[] {
  const seen = new Set<RouteOptions>();
  const entries: AssemblyRouteInventoryEntry[] = [];
  for (const { routeOptions, source } of captured) {
    if (seen.has(routeOptions)) continue;
    seen.add(routeOptions);
    const policy = resolveEffectiveAuthPolicy(routeOptions.config);
    for (const method of methodsOf(routeOptions)) {
      entries.push({
        method,
        url: routeOptions.url,
        effectivePolicy: policy ?? null,
        // Guards resolve from the FINAL installed chain: scope-level
        // inheritance may install its guard after this route's first
        // onRoute pass, and the shared routeOptions reference reflects it.
        guards: handlerNames(routeOptions.preHandler),
        rawBodyEligible: typeof policy === "object" && policy.policy === "verified_ingress",
        source,
        generatedTwin: false,
      });
    }
  }
  const getUrls = new Set(entries.filter((e) => e.method === "GET").map((e) => e.url));
  for (const entry of entries) {
    if (entry.method === "HEAD" && getUrls.has(entry.url)) {
      entry.generatedTwin = true;
      entry.source = "framework";
    }
    if (entry.method === "OPTIONS" && entry.url === "*") {
      entry.generatedTwin = true;
      entry.source = "framework";
    }
  }
  entries.sort((a, b) => `${a.method} ${a.url}`.localeCompare(`${b.method} ${b.url}`));
  return entries;
}

// ---------------------------------------------------------------------------
// Options and handle
// ---------------------------------------------------------------------------

export interface CreateHttpApplicationOptions {
  /** Fastify logger options or `false` (tests). Defaults to the production logger. */
  logger?: FastifyLoggerOptions | boolean;

  /**
   * Per-construction hook-installation observer: invoked at the exact
   * statement that installs each root, scoped, or plugin-namespace hook
   * (plugin namespaces install through the staged plugin step). Scoped to
   * this one assembly, so concurrent app constructions cannot
   * cross-contaminate observation streams. Side-effect-free when omitted.
   */
  onHookInstalled?: HookInstallObserver;

  /**
   * Operational interposition invoked exactly once, after both local API
   * prefix groups are registered and before realtime / Remote Participant /
   * root redirect / optional static registration. This is the historical
   * boot waypoint: the executable starts its creation-dispatch adapters and
   * workers here (after the /api groups, before /sse — exactly the dd75a98
   * ordering) while keeping their ownership out of this module. Tests use it
   * to pin the ordering; ordinary HTTP registration never depends on it.
   */
  onLocalPrefixesRegistered?: () => void | Promise<void>;

  /**
   * Characterization-suite-only observation route: answers with exactly what
   * the root audit hooks established for the request. Registered by the
   * assembly at `finalize` — AFTER the inventory snapshot — so it observes
   * provenance without ever appearing in the production inventory.
   */
  auditProbeRoute?: boolean;
}

/**
 * The narrow runtime handle the executable receives. It exposes staged
 * lifecycle operations, request injection, close, logging, and the derived
 * inventory — deliberately NOT the `FastifyInstance` or any route
 * registration capability (ADR-0049).
 */
export interface HttpRuntimeHandle {
  readonly state: HttpAssemblyState;
  readonly log: FastifyBaseLogger;

  /**
   * Installs the operational plugin discovery's validated route catalog
   * (ADR-0050). Exactly once, required before `finalize`; an explicitly
   * empty validated catalog installs too. Repeated, late, or skipped
   * installation is a boot error.
   */
  installPluginRoutes(catalog: PluginRouteCatalog): Promise<void>;

  /**
   * Runs Fastify readiness — every route on the instance must carry an
   * effective authentication policy or boot fails here, before listen —
   * and derives the production route inventory. Exactly once.
   */
  finalize(): Promise<void>;

  /** Listens for requests. Only legal once the assembly is ready. */
  listen(options: { port: number; host: string }): Promise<void>;

  /** Injects a request into the ready application (tests and diagnostics). */
  inject(request: string | InjectOptions): Promise<LightMyRequestResponse>;

  /**
   * Registers an operational shutdown callback on application close.
   * Register before `finalize` — like Fastify's own `onClose`, hooks cannot
   * be added once the application has started.
   */
  onClose(hook: () => void | Promise<void>): void;

  /** The production-derived route inventory; available once ready. */
  routeInventory(): AssemblyRouteInventoryEntry[];

  /** Closes the HTTP application. Terminal. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Constructs the typed production Fastify instance (no routes registered yet). */
function constructFastify(logger: FastifyLoggerOptions | boolean) {
  return Fastify({
    logger: logger as never,
    disableRequestLogging: true,
    bodyLimit: 1048576,
  }).withTypeProvider<ZodTypeProvider>();
}

/** Application instance type the assembly constructs. */
export type HttpAppInstance = ReturnType<typeof constructFastify>;

/** Local API route group shared by the current (`/api/v1`) and deprecated (`/api`) prefixes. */
async function registerApiRoutes(fastify: HttpAppInstance): Promise<void> {
  await fastify.register(habitatRoutes);
  await fastify.register(habitatAnalyticsRoutes);
  await fastify.register(habitatExportRoutes);
  await fastify.register(columnRoutes);
  await fastify.register(taskRoutes);
  await fastify.register(missionRoutes);
  await fastify.register(roadmapRoutes);
  await fastify.register(agentRoutes);
  await fastify.register(authRoutes);
  await fastify.register(commentRoutes);
  await fastify.register(missionCommentRoutes);
  await fastify.register(auditExportRoutes);
  await fastify.register(auditBundleRoutes);
  await fastify.register(habitatHealthRoutes);
  await fastify.register(subtaskRoutes);
  await fastify.register(templateRoutes);
  await fastify.register(workflowRoutes);
  await fastify.register(metricsRoutes);
  await fastify.register(webhookRoutes);
  await fastify.register(dashboardRoutes);
  await fastify.register(savedFilterRoutes);
  await fastify.register(attachmentRoutes);
  await fastify.register(notificationPrefRoutes);
  await fastify.register(notificationRoutes);
  await fastify.register(automationRoutes);
  await fastify.register(chatIntegrationRoutes);
  await fastify.register(agentMessageRoutes);
  await fastify.register(habitatAgentMailRoutes);
  await fastify.register(pulseRoutes);
  await fastify.register(insightsRoutes);
  await fastify.register(codeReviewWebhookRoutes);
  await fastify.register(ciCdWebhookRoutes);
  await fastify.register(organizationRoutes);
  await fastify.register(timeTrackingRoutes);
  await fastify.register(effortRoutes);
  await fastify.register(dependencyRoutes);
  await fastify.register(qualityGateRoutes);
  await fastify.register(prioritizationRoutes);
  await fastify.register(scheduledTaskRoutes);
  await fastify.register(reviewRuleRoutes);
  await fastify.register(sprintRoutes);
  await fastify.register(integrationRoutes);
  await fastify.register(githubIssueWebhookRoutes);
  await fastify.register(taskCodeEvidenceRoutes);
  await fastify.register(missionCodeEvidenceRoutes);
  await fastify.register(repositorySettingsRoutes);
  await fastify.register(daemonRoutes);
  await fastify.register(daemonAdminRoutes);
  await fastify.register(habitatSkillRoutes);
  await fastify.register(wikiRoutes);
  await fastify.register(remoteAccessRoutes);
  await fastify.register(remoteWebhookRoutes);
  await fastify.register(sharedInviteRoutes);
  await fastify.register(pluginRoutes);
  await fastify.register(triageRoutes);
  await fastify.register(taskCreationAttemptRoutes);
  await fastify.register(taskClonePublicationRoutes);
  await fastify.register(taskPublicationRoutes);
  await fastify.register(scheduledOccurrenceRepairRoutes);
  await fastify.register(extractionRoutes);
}

/**
 * Constructs the production application and registers the entire core HTTP
 * surface, resolving in the `core_registered` state. Plugin routes install
 * through the returned handle's lifecycle; nothing else may register routes.
 */
export async function createHttpApplication(
  options: CreateHttpApplicationOptions = {},
): Promise<HttpRuntimeHandle> {
  const onHookInstalled = options.onHookInstalled;
  const fastify = constructFastify(options.logger ?? productionLogger());

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  // Authentication authority (ADR-0049): validates verifier readiness, then
  // installs policy guards for every declaration made on this instance.
  installAuthPolicy(fastify);

  // Registration stream capture — the same stream that serves requests
  // derives the inventory at finalize. Route-options references (not config
  // snapshots) are captured so scope-level inheritance, applied by scoped
  // onRoute hooks after this one, is final when the inventory resolves.
  const captured: CapturedRoute[] = [];
  let registrationSource: CapturedRoute["source"] = "core";
  fastify.addHook("onRoute", (routeOptions) => {
    captured.push({ routeOptions, source: registrationSource });
  });

  let state: HttpAssemblyState = "core_registered";
  let inventory: AssemblyRouteInventoryEntry[] | undefined;

  const requireState = (operation: string, expected: HttpAssemblyState): void => {
    if (state !== expected) {
      throw new HttpAssemblyLifecycleError(operation, state);
    }
  };

  const registerCore = async (): Promise<void> => {
    const corsOrigin = process.env.CORS_ORIGIN ?? false;
    const corsWindowStart = captured.length;
    await fastify.register(cors, { origin: corsOrigin });
    // Record the framework-owned CORS preflight catch-all explicitly
    // (ADR-0049 readiness): only routes registered by THIS core-owned
    // `@fastify/cors` registration are exempt from closed readiness — the
    // exemption is a recorded reference, never a shape an application or
    // plugin route could acquire unnoticed.
    for (const { routeOptions } of captured.slice(corsWindowStart)) {
      if (isWildcardOptionsRoute(routeOptions)) {
        registerFrameworkCorsRoute(fastify, routeOptions);
      }
    }

    await fastify.register(helmet, { contentSecurityPolicy: false });
    await registerErrorHandler(fastify);

    await fastify.register(fastifyRawBody, {
      field: "rawBody",
      global: false,
      runFirst: true,
      routes: [...RAW_BODY_ROUTES],
    });

    // `onSend`, not the historical `onResponse`: onResponse runs after
    // Fastify has already sent the response, so headers stamped there never
    // reached the wire. The assembly corrects this at the owning seam.
    installHook(
      onHookInstalled,
      { surface: "root", hookKind: "onSend", name: "api-version" },
      () =>
        fastify.addHook("onSend", (_request, reply, _payload, done) => {
          reply.header("X-API-Version", API_VERSION);
          done();
        }),
    );

    installHook(
      onHookInstalled,
      { surface: "root", hookKind: "onRequest", name: "audit-context" },
      () =>
        fastify.addHook("onRequest", (request, _reply, done) => {
          runWithAuditProvenance(
            { source: "rest_api", requestId: request.id, method: request.method },
            done,
          );
        }),
    );

    installHook(
      onHookInstalled,
      { surface: "root", hookKind: "preHandler", name: "audit-enrichment" },
      () =>
        fastify.addHook("preHandler", (request, _reply, done) => {
          const auditSource = request.headers["x-orcy-audit-source"];
          const toolName = request.headers["x-orcy-mcp-tool"];
          const mcpAction = request.headers["x-orcy-mcp-action"];
          const isMcpTool = auditSource === "mcp_tool" && Boolean(request.headers["x-agent-api-key"]);

          updateAuditProvenance({
            ...(isMcpTool ? { source: "mcp_tool" } : {}),
            route: request.routeOptions.url,
            method: request.method,
            ...(isMcpTool && typeof toolName === "string" ? { toolName } : {}),
            ...(isMcpTool && typeof mcpAction === "string" ? { mcpAction } : {}),
          });
          done();
        }),
    );

    fastify.get(
      "/health",
      { config: { authPolicy: "anonymous" } },
      async () => ({ status: "ok", timestamp: new Date().toISOString() }),
    );

    await fastify.register(
      async (f) => {
        installHook(
          onHookInstalled,
          { surface: "api-v1", hookKind: "preHandler", name: "per-agent-rate-limit" },
          () => f.addHook("preHandler", perAgentRateLimit),
        );
        await registerApiRoutes(f);

        f.post<{ Params: { id: string } }>(
          "/habitats/:id/archive-events",
          { config: { authPolicy: "human" } },
          async (request, _reply) => {
            const result = archiveOldEvents(request.params.id);
            return result;
          },
        );
      },
      { prefix: "/api/v1" },
    );

    await fastify.register(
      async (f) => {
        installHook(
          onHookInstalled,
          { surface: "api-deprecated", hookKind: "preHandler", name: "per-agent-rate-limit" },
          () => f.addHook("preHandler", perAgentRateLimit),
        );
        // `onSend` — same wire-effectiveness correction as the root version
        // header; the deprecated prefix actually delivers the header now.
        installHook(
          onHookInstalled,
          { surface: "api-deprecated", hookKind: "onSend", name: "deprecation-header" },
          () =>
            f.addHook("onSend", (_request, reply, _payload, done) => {
              reply.header("Deprecation", "true");
              done();
            }),
        );
        await registerApiRoutes(f);

        f.post<{ Params: { id: string } }>(
          "/habitats/:id/archive-events",
          { config: { authPolicy: "human" } },
          async (request, _reply) => {
            const result = archiveOldEvents(request.params.id);
            return result;
          },
        );
      },
      { prefix: "/api" },
    );

    // Historical boot waypoint (dd75a98 ordering): operational startup that
    // must run after both local API prefix groups and before realtime,
    // Remote Participant, root redirect, and optional static registration.
    // Invoked exactly ONCE — never once per prefix group. The executable
    // supplies the callback; HTTP registration never depends on it.
    await options.onLocalPrefixesRegistered?.();

    await fastify.register(
      async (f) => {
        installHook(
          onHookInstalled,
          { surface: "sse", hookKind: "preHandler", name: "per-agent-rate-limit" },
          () => f.addHook("preHandler", perAgentRateLimit),
        );
        await f.register(sseRoutes);
        await f.register(presenceRoutes);
      },
      { prefix: "/sse" },
    );

    // Phase D — Shared Habitat API for remote participants.
    // All routes here require X-Orcy-Remote-Key auth (set by sharedApiRoutes plugin).
    // Lives under its own prefix so it cannot accidentally pick up routes
    // mounted under /api/v1 or /api.
    await fastify.register(
      async (f) => {
        await f.register(sharedApiRoutes);
      },
      { prefix: "/api/shared" },
    );

    // Redirect root to /app/ so users hitting / (which returns a 404 JSON)
    // are sent to the SPA instead.
    fastify.get(
      "/",
      { config: { authPolicy: "anonymous" } },
      async (_request, reply) => reply.redirect("/app/"),
    );

    const uiPath = process.env.ORCY_UI_PATH || ORCY_PATHS.ui;
    if (fs.existsSync(uiPath)) {
      // Homogeneous anonymous scope: the static UI serves unauthenticated by
      // design, and every route it installs inherits that one declaration.
      // UI routes are inventory-attributed `static`, not core.
      registrationSource = "static";
      try {
        await fastify.register(
          async (f) => {
            inheritAuthPolicy(f, "anonymous");
            await f.register(fastifyStatic, {
              root: uiPath,
              prefix: "/app/",
              wildcard: false,
            });
            // SPA fallback: serve index.html for all /app/* routes that don't match a file
            f.get("/app/*", async (request, reply) => {
              return reply.sendFile("index.html", uiPath);
            });
          },
        );
      } finally {
        registrationSource = "core";
      }
    }
  };

  await registerCore();

  return {
    get state() {
      return state;
    },
    get log() {
      return fastify.log;
    },
    async installPluginRoutes(catalog: PluginRouteCatalog): Promise<void> {
      requireState("installPluginRoutes", "core_registered");
      const previousSource = registrationSource;
      registrationSource = "plugin";
      try {
        await mountPluginRouteCatalog(
          fastify,
          catalog,
          onHookInstalled ? { onHookInstalled } : undefined,
        );
      } finally {
        registrationSource = previousSource;
      }
      state = "plugins_installed";
    },
    async finalize(): Promise<void> {
      requireState("finalize", "plugins_installed");
      // Inventory snapshot BEFORE any test-only observation route registers,
      // so the derived inventory is exactly the production surface.
      inventory = deriveInventory(captured);
      if (options.auditProbeRoute) {
        fastify.get(
          "/__audit-probe__",
          { config: { authPolicy: "anonymous" } },
          async () => getAuditProvenanceMetadata() ?? null,
        );
      }
      // Closed readiness: boot fails here — before listen — if any route
      // lacks an effective authentication policy.
      await fastify.ready();
      state = "ready";
    },
    async listen({ port, host }): Promise<void> {
      requireState("listen", "ready");
      await fastify.listen({ port, host });
    },
    async inject(request) {
      requireState("inject", "ready");
      return fastify.inject(request);
    },
    onClose(hook: () => void | Promise<void>): void {
      fastify.addHook("onClose", hook);
    },
    routeInventory(): AssemblyRouteInventoryEntry[] {
      if (state !== "ready" || inventory === undefined) {
        throw new HttpAssemblyLifecycleError("routeInventory", state);
      }
      return inventory.map((entry) => ({ ...entry }));
    },
    async close(): Promise<void> {
      if (state === "closed") return;
      await fastify.close();
      state = "closed";
    },
  };
}
