/**
 * Production HTTP application surface — the single registration seam.
 *
 * Owns Fastify construction, root plugins and hooks, health, both local API
 * prefix groups (`/api/v1` and deprecated `/api`), realtime (`/sse`), the
 * Remote Participant API (`/api/shared`), the root redirect, and the optional
 * static UI. The executable (`src/index.ts`) boots through `buildHttpApp()`
 * and keeps operational startup — DB, caches, schedulers, workers, plugin
 * boot, listen — outside this module.
 *
 * This is deliberately an observation-preserving extraction, not the staged
 * authoritative assembly of ADR-0049: authentication policy installation,
 * plugin-route ownership, and the narrow runtime handle land in later
 * tickets. Until then `createHttpApp` + `registerHttpSurface` exist as two
 * steps for ONE purpose — the route characterization suite attaches its
 * `onRoute` observer between them so the observed inventory is the production
 * one. There is no second module list to drift.
 */
import Fastify from "fastify";
import type { FastifyLoggerOptions } from "fastify";
import { type ZodTypeProvider } from "fastify-type-provider-zod";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import fastifyRawBody from "fastify-raw-body";
import fs from "node:fs";
import { ORCY_PATHS } from "@orcy/shared";
import { installAuthPolicy, inheritAuthPolicy, verifiedIngressRoutePaths } from "./authPolicy.js";
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
import { humanAuth } from "./middleware/auth.js";
import {
  runWithAuditProvenance,
  updateAuditProvenance,
} from "./services/auditProvenanceContext.js";

const API_VERSION = 1;

/**
 * One record per hook installation performed by `registerHttpSurface`,
 * emitted at the exact statement that installs the hook. Consumed by the
 * route characterization suite so hook parity is observed from production
 * code rather than asserted from a hand-written description.
 */
export interface HookInstallationRecord {
  surface: "root" | "api-v1" | "api-deprecated" | "sse";
  hookKind: "onRequest" | "preHandler" | "onResponse";
  name: string;
}

type HookInstallObserver = (record: HookInstallationRecord) => void;

/**
 * Installs one hook and emits its installation record through the
 * per-registration observer — same call, same truth. Without an observer
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

/** Application instance the executable and the characterization suite share. */
export type HttpApp = ReturnType<typeof createHttpApp>;

/** Constructs the production Fastify instance (no routes registered yet). */
export function createHttpApp(logger: FastifyLoggerOptions | boolean = productionLogger()) {
  const fastify = Fastify({
    logger: logger as never,
    disableRequestLogging: true,
    bodyLimit: 1048576,
  }).withTypeProvider<ZodTypeProvider>();

  fastify.setValidatorCompiler(validatorCompiler);
  fastify.setSerializerCompiler(serializerCompiler);
  // Authentication authority (ADR-0049): validates verifier readiness, then
  // installs policy guards for every declaration made on this instance.
  installAuthPolicy(fastify);
  return fastify;
}

async function registerApiRoutes(fastify: HttpApp): Promise<void> {
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

export interface RegisterHttpSurfaceOptions {
  /**
   * Per-registration hook-installation observer: invoked at the exact
   * statement that installs each root or scoped hook. Scoped to this one
   * `registerHttpSurface` call, so concurrent app constructions cannot
   * cross-contaminate observation streams. Side-effect-free when omitted.
   */
  onHookInstalled?: HookInstallObserver;

  /**
   * Production-only interposition invoked after both local API prefix groups
   * are registered and before realtime / Remote Participant / root redirect /
   * optional static registration. This is the historical boot waypoint: the
   * executable starts its creation-dispatch adapters and workers here
   * (after the /api groups, before /sse — exactly the dd75a98 ordering)
   * while keeping their ownership out of this module. Tests use it to pin
   * the ordering; ordinary HTTP registration never depends on it.
   */
  onLocalPrefixesRegistered?: () => void | Promise<void>;
}

/**
 * Registers the entire current HTTP surface on an instance from
 * `createHttpApp`. Order is boot-relevant and preserved from the
 * pre-extraction `index.ts`.
 */
export async function registerHttpSurface(
  fastify: HttpApp,
  options: RegisterHttpSurfaceOptions = {},
): Promise<void> {
  const onHookInstalled = options.onHookInstalled;
  const corsOrigin = process.env.CORS_ORIGIN ?? false;
  await fastify.register(cors, { origin: corsOrigin });
  await fastify.register(helmet, { contentSecurityPolicy: false });
  await registerErrorHandler(fastify);

  await fastify.register(fastifyRawBody, {
    field: "rawBody",
    global: false,
    runFirst: true,
    routes: [...RAW_BODY_ROUTES],
  });

  installHook(
    onHookInstalled,
    { surface: "root", hookKind: "onResponse", name: "api-version" },
    () =>
      fastify.addHook("onResponse", (request, reply, done) => {
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
        { preHandler: humanAuth },
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
      installHook(
        onHookInstalled,
        { surface: "api-deprecated", hookKind: "onResponse", name: "deprecation-header" },
        () =>
          f.addHook("onResponse", (request, reply, done) => {
            reply.header("Deprecation", "true");
            done();
          }),
      );
      await registerApiRoutes(f);

      f.post<{ Params: { id: string } }>(
        "/habitats/:id/archive-events",
        { preHandler: humanAuth },
        async (request, _reply) => {
          const result = archiveOldEvents(request.params.id);
          return result;
        },
      );
    },
    { prefix: "/api" },
  );

  // Historical boot waypoint (dd75a98 ordering): operational startup that
  // must run after both local API prefix groups and before realtime, Remote
  // Participant, root redirect, and optional static registration. The
  // executable supplies the callback; HTTP registration never depends on it.
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
  }
}

/** Production entry point: construct and register in one step. */
export async function buildHttpApp(
  options: RegisterHttpSurfaceOptions = {},
): Promise<HttpApp> {
  const fastify = createHttpApp();
  await registerHttpSurface(fastify, options);
  return fastify;
}
