#!/usr/bin/env node
import "dotenv/config";
import Fastify, { type FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import cors from "@fastify/cors";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import fastifyRawBody from "fastify-raw-body";
import fs from "node:fs";
import { ORCY_PATHS } from "@orcy/shared";
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
import * as habitatRepo from "./repositories/habitat.js";
import * as habitatHealthService from "./services/boardHealthService.js";
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
import { registerCreationDispatchAdapters } from "./services/taskCreationDispatchAdapters.js";
import { startOccurrenceLeaseRecoveryWorker } from "./services/scheduledOccurrenceRecovery.js";
import { startCreationDispatchWorker } from "./services/creationDispatchWorker.js";
import {
  taskCodeEvidenceRoutes,
  missionCodeEvidenceRoutes,
  repositorySettingsRoutes,
} from "./routes/codeEvidence.js";
import { rebuildCache as rebuildHabitatSecretCache } from "./services/habitatSecretCache.js";
import { archiveOldEvents } from "./services/auditArchivalService.js";
import { seedDefaultTemplates as seedQualityTemplates } from "./services/qualityGateService.js";
import { startAllSchedulers } from "./services/scheduler.js";
import { initSkillHooks } from "./services/habitatSkillService.js";
import { initWorkflowService } from "./services/workflowService.js";
import { initWikiScheduler } from "./services/wikiSchedulerService.js";
import { initDb } from "./db/index.js";

import { registerErrorHandler } from "./errors/plugin.js";
import { perAgentRateLimit } from "./middleware/rateLimit.js";
import { humanAuth } from "./middleware/auth.js";
import { setJwtSecret } from "./middleware/jwt-verification.js";
import {
  runWithAuditProvenance,
  updateAuditProvenance,
} from "./services/auditProvenanceContext.js";
import * as pluginManager from "./plugins/pluginManager.js";
import { assertSecurityConfigOrExit } from "./config/security.js";

const securityConfig = assertSecurityConfigOrExit();
setJwtSecret(securityConfig.jwtSecret);

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "127.0.0.1";

const isDev = process.env.NODE_ENV !== "production";

let occurrenceRecoveryHandle: NodeJS.Timeout | undefined;
let creationDispatchHandle: { stop: () => void } | undefined;

const API_VERSION = 1;

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? (isDev ? "info" : "warn"),
    ...(isDev ? { transport: { target: "pino-pretty", options: { colorize: true } } } : {}),
  },
  disableRequestLogging: true,
  bodyLimit: 1048576,
}).withTypeProvider<ZodTypeProvider>();

fastify.setValidatorCompiler(validatorCompiler);
fastify.setSerializerCompiler(serializerCompiler);

const corsOrigin = process.env.CORS_ORIGIN ?? false;
await fastify.register(cors, { origin: corsOrigin });
await fastify.register(helmet, { contentSecurityPolicy: false });
await registerErrorHandler(fastify);

await fastify.register(fastifyRawBody, {
  field: "rawBody",
  global: false,
  runFirst: true,
  routes: [
    "/api/webhooks/github",
    "/api/webhooks/gitlab",
    "/api/webhooks/github-ci",
    "/api/webhooks/gitlab-ci",
    "/api/chat/slack/command",
    "/api/chat/discord/interaction",
    "/api/v1/webhooks/github",
    "/api/v1/webhooks/gitlab",
    "/api/v1/webhooks/github-ci",
    "/api/v1/webhooks/gitlab-ci",
    "/api/v1/chat/slack/command",
    "/api/v1/chat/discord/interaction",
    "/api/webhooks/github/issues",
    "/api/v1/webhooks/github/issues",
  ],
});

fastify.addHook("onResponse", (request, reply, done) => {
  reply.header("X-API-Version", API_VERSION);
  done();
});

fastify.addHook("onRequest", (request, _reply, done) => {
  runWithAuditProvenance(
    { source: "rest_api", requestId: request.id, method: request.method },
    done,
  );
});

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
});

fastify.get("/health", async () => ({ status: "ok", timestamp: new Date().toISOString() }));

async function registerApiRoutes(f: FastifyInstance) {
  await f.register(habitatRoutes);
  await f.register(habitatAnalyticsRoutes);
  await f.register(habitatExportRoutes);
  await f.register(columnRoutes);
  await f.register(taskRoutes);
  await f.register(missionRoutes);
  await f.register(roadmapRoutes);
  await f.register(agentRoutes);
  await f.register(authRoutes);
  await f.register(commentRoutes);
  await f.register(missionCommentRoutes);
  await f.register(auditExportRoutes);
  await f.register(auditBundleRoutes);
  await f.register(habitatHealthRoutes);
  await f.register(subtaskRoutes);
  await f.register(templateRoutes);
  await f.register(workflowRoutes);
  await f.register(metricsRoutes);
  await f.register(webhookRoutes);
  await f.register(dashboardRoutes);
  await f.register(savedFilterRoutes);
  await f.register(attachmentRoutes);
  await f.register(notificationPrefRoutes);
  await f.register(notificationRoutes);
  await f.register(automationRoutes);
  await f.register(chatIntegrationRoutes);
  await f.register(agentMessageRoutes);
  await f.register(pulseRoutes);
  await f.register(insightsRoutes);
  await f.register(codeReviewWebhookRoutes);
  await f.register(ciCdWebhookRoutes);
  await f.register(organizationRoutes);
  await f.register(timeTrackingRoutes);
  await f.register(effortRoutes);
  await f.register(dependencyRoutes);
  await f.register(qualityGateRoutes);
  await f.register(prioritizationRoutes);
  await f.register(scheduledTaskRoutes);
  await f.register(reviewRuleRoutes);
  await f.register(sprintRoutes);
  await f.register(integrationRoutes);
  await f.register(githubIssueWebhookRoutes);
  await f.register(taskCodeEvidenceRoutes);
  await f.register(missionCodeEvidenceRoutes);
  await f.register(repositorySettingsRoutes);
  await f.register(daemonRoutes);
  await f.register(daemonAdminRoutes);
  await f.register(habitatSkillRoutes);
  await f.register(wikiRoutes);
  await f.register(remoteAccessRoutes);
  await f.register(remoteWebhookRoutes);
  await f.register(sharedInviteRoutes);
  await f.register(pluginRoutes);
  await f.register(triageRoutes);
  await f.register(taskCreationAttemptRoutes);
  await f.register(taskClonePublicationRoutes);
  await f.register(taskPublicationRoutes);
  await f.register(scheduledOccurrenceRepairRoutes);
}

await fastify.register(
  async (f) => {
    f.addHook("preHandler", perAgentRateLimit);
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
    f.addHook("preHandler", perAgentRateLimit);
    f.addHook("onResponse", (request, reply, done) => {
      reply.header("Deprecation", "true");
      done();
    });
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

// T11 Phase 1A — boot-registration of the creation dispatch infrastructure.
// Moved OUTSIDE registerApiRoutes to prevent double-startup (registerApiRoutes
// is called for both /api/v1 and /api prefixes). Always started (not gated by
// the flag) so that a rollback (flag OFF after being ON) can still drain
// committed published_pending_observation / published_pending_assignment /
// publishing attempts. The workers are no-ops when there are no post-cutover
// attempts to process.
registerCreationDispatchAdapters();
occurrenceRecoveryHandle = startOccurrenceLeaseRecoveryWorker(60_000);
creationDispatchHandle = startCreationDispatchWorker(5_000);

await fastify.register(
  async (f) => {
    f.addHook("preHandler", perAgentRateLimit);
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
fastify.get("/", async (_request, reply) => reply.redirect("/app/"));

const uiPath = process.env.ORCY_UI_PATH || ORCY_PATHS.ui;
if (fs.existsSync(uiPath)) {
  await fastify.register(fastifyStatic, {
    root: uiPath,
    prefix: "/app/",
    wildcard: false,
  });
  // SPA fallback: serve index.html for all /app/* routes that don't match a file
  fastify.get("/app/*", async (request, reply) => {
    return reply.sendFile("index.html", uiPath);
  });
}

await initDb();
if (!process.env.DB_PATH && process.env.NODE_ENV !== "production") {
  const defaultPath = (await import("./db/index.js")).getDefaultDbPath();
  console.warn(`WARNING: No DB_PATH set. API is using production database at: ${defaultPath}`);
  console.warn("Set DB_PATH env var to a different path to keep dev/test data separate.");
}

try {
  rebuildHabitatSecretCache();
} catch (err) {
  fastify.log.error({ err }, "Failed to rebuild habitat secret cache");
}

try {
  seedQualityTemplates();
} catch (err) {
  fastify.log.error({ err }, "Failed to seed quality templates");
}

const schedulers = startAllSchedulers(fastify);

try {
  initSkillHooks();
} catch (err) {
  fastify.log.error({ err }, "Failed to initialize skill hooks");
}

try {
  initWorkflowService();
} catch (err) {
  fastify.log.error({ err }, "Failed to initialize workflow service");
}

try {
  initWikiScheduler();
} catch (err) {
  fastify.log.error({ err }, "Failed to initialize wiki scheduler");
}

const healthSnapshotInterval = setInterval(async () => {
  try {
    const habitats = habitatRepo.listHabitats();
    for (const habitat of habitats) {
      try {
        habitatHealthService.calculateHealth(habitat.id);
      } catch (err) {
        fastify.log.error({ err, habitatId: habitat.id }, "Health snapshot failed");
      }
    }
  } catch (err) {
    fastify.log.error({ err }, "Health snapshot scan failed");
  }
}, 60 * 60_000);

const shutdown = async () => {
  await fastify.close();
  process.exit(0);
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

fastify.addHook("onClose", async () => {
  schedulers.stop();
  clearInterval(healthSnapshotInterval);
  creationDispatchHandle?.stop();
  if (occurrenceRecoveryHandle) clearInterval(occurrenceRecoveryHandle);
  const { shutdownAll } = await import("./services/daemonEngine.js");
  shutdownAll();
});

pluginManager.loadQuarantinesFromDb();

try {
  await pluginManager.loadPlugins();
  await pluginManager.initializePlugins(fastify);
  const loaded = pluginManager.getLoadedPlugins();
  if (loaded.length > 0) {
    fastify.log.info({ plugins: loaded }, "Plugins loaded");
  }
} catch (err) {
  fastify.log.error({ err }, "Failed to load plugins - continuing without plugins");
}

const { initDaemonWiring } = await import("./daemon-wiring.js");
await initDaemonWiring();

const { initDetectorScan } = await import("./services/detectorScanService.js");
initDetectorScan();

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`Orcy API running at http://${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
