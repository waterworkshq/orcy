#!/usr/bin/env node
import 'dotenv/config';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import fastifyRawBody from 'fastify-raw-body';
import path from 'node:path';
import fs from 'node:fs';
import { ORCY_PATHS } from '@orcy/shared';
import { boardRoutes } from './routes/boards.js';
import { boardAnalyticsRoutes } from './routes/board-analytics.js';
import { boardExportRoutes } from './routes/board-export.js';
import { columnRoutes } from './routes/columns.js';
import { taskRoutes } from './routes/tasks.js';
import { featureRoutes } from './routes/features.js';
import { agentRoutes } from './routes/agents.js';
import { sseRoutes } from './routes/sse.js';
import { authRoutes } from './routes/auth.js';

import { webhookRoutes } from './routes/webhookOutgoing.js';
import { commentRoutes } from './routes/comments.js';
import { templateRoutes } from './routes/templates.js';
import { subtaskRoutes } from './routes/subtasks.js';
import { presenceRoutes } from './routes/presence.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { savedFilterRoutes } from './routes/savedFilters.js';
import { attachmentRoutes } from './routes/attachments.js';
import { notificationPrefRoutes } from './routes/notificationPreferences.js';
import { chatIntegrationRoutes } from './routes/chatIntegration.js';
import { agentMessageRoutes } from './routes/agentMessages.js';
import { pulseRoutes } from './routes/pulse.js';
import { codeReviewWebhookRoutes } from './routes/codeReviewWebhooks.js';
import { ciCdWebhookRoutes } from './routes/ciCdWebhooks.js';
import { organizationRoutes } from './routes/organizations.js';
import { timeTrackingRoutes } from './routes/timeTracking.js';
import { dependencyRoutes } from './routes/dependencies.js';
import { qualityGateRoutes } from './routes/qualityGates.js';
import { sseBroadcaster } from './sse/broadcaster.js';
import { releaseStaleTasks } from './services/agentService.js';
import { startRetryProcessor as startTaskRetryProcessor } from './services/retryService.js';
import { rebuildCache as rebuildBoardSecretCache } from './services/boardSecretCache.js';
import { startPresenceCleanup } from './sse/presence.js';
import { scanAllBoards } from './services/anomalyService.js';
import { archiveAllBoards, archiveOldEvents } from './services/auditArchivalService.js';
import { seedDefaultTemplates as seedQualityTemplates } from './services/qualityGateService.js';
import { initDb, getDb } from './db/index.js';
import { tasks, features } from './db/schema.js';
import { and, or, sql, notInArray, eq } from 'drizzle-orm';
import { nowExpr } from './db/dialect-helpers.js';

import { registerErrorHandler } from './errors/plugin.js';
import { perAgentRateLimit } from './middleware/rateLimit.js';
import { humanAuth, setJwtSecret } from './middleware/auth.js';
import * as pluginManager from './plugins/pluginManager.js';
import { assertSecurityConfigOrExit } from './config/security.js';

const securityConfig = assertSecurityConfigOrExit();
setJwtSecret(securityConfig.jwtSecret);

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '127.0.0.1';

const isDev = process.env.NODE_ENV !== 'production';

const API_VERSION = 1;

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? (isDev ? 'info' : 'warn'),
    ...(isDev ? { transport: { target: 'pino-pretty', options: { colorize: true } } } : {}),
  },
  disableRequestLogging: true,
  bodyLimit: 1048576,
}).withTypeProvider<ZodTypeProvider>();

fastify.setValidatorCompiler(validatorCompiler);
fastify.setSerializerCompiler(serializerCompiler);

const corsOrigin = process.env.CORS_ORIGIN ?? false;
await fastify.register(cors, { origin: corsOrigin });
await fastify.register(helmet, { contentSecurityPolicy: false });
await fastify.register(rateLimit, {
  max: 100,
  timeWindow: '1 minute',
  keyGenerator: (request) => {
    const agentKey = request.headers['x-agent-api-key'] as string | undefined;
    if (agentKey) return `agent:${agentKey}`;
    return `ip:${request.ip}`;
  },
  addHeadersOnExceeding: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true,
  },
  addHeaders: {
    'x-ratelimit-limit': true,
    'x-ratelimit-remaining': true,
    'x-ratelimit-reset': true,
    'retry-after': true,
  },
});
await registerErrorHandler(fastify);

await fastify.register(fastifyRawBody, {
  field: 'rawBody',
  global: false,
  runFirst: true,
  routes: [
    '/api/webhooks/github',
    '/api/webhooks/gitlab',
    '/api/webhooks/github-ci',
    '/api/webhooks/gitlab-ci',
    '/api/chat/slack/command',
    '/api/chat/discord/interaction',
    '/api/v1/webhooks/github',
    '/api/v1/webhooks/gitlab',
    '/api/v1/webhooks/github-ci',
    '/api/v1/webhooks/gitlab-ci',
    '/api/v1/chat/slack/command',
    '/api/v1/chat/discord/interaction',
  ],
});

fastify.addHook('onResponse', (request, reply, done) => {
  reply.header('X-API-Version', API_VERSION);
  done();
});

fastify.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

async function registerApiRoutes(f: FastifyInstance) {
  await f.register(boardRoutes);
  await f.register(boardAnalyticsRoutes);
  await f.register(boardExportRoutes);
  await f.register(columnRoutes);
  await f.register(taskRoutes);
  await f.register(featureRoutes);
  await f.register(agentRoutes);
  await f.register(authRoutes);
  await f.register(commentRoutes);
  await f.register(subtaskRoutes);
  await f.register(templateRoutes);
  await f.register(webhookRoutes);
  await f.register(dashboardRoutes);
  await f.register(savedFilterRoutes);
  await f.register(attachmentRoutes);
  await f.register(notificationPrefRoutes);
  await f.register(chatIntegrationRoutes);
  await f.register(agentMessageRoutes);
  await f.register(pulseRoutes);
  await f.register(codeReviewWebhookRoutes);
  await f.register(ciCdWebhookRoutes);
  await f.register(organizationRoutes);
  await f.register(timeTrackingRoutes);
  await f.register(dependencyRoutes);
  await f.register(qualityGateRoutes);
}

await fastify.register(async (f) => {
  f.addHook('preHandler', perAgentRateLimit);
  await registerApiRoutes(f);

  f.post<{ Params: { id: string } }>(
    '/boards/:id/archive-events',
    { preHandler: humanAuth },
    async (request, reply) => {
      const result = archiveOldEvents(request.params.id);
      return result;
    }
  );
}, { prefix: '/api/v1' });

await fastify.register(async (f) => {
  f.addHook('preHandler', perAgentRateLimit);
  f.addHook('onResponse', (request, reply, done) => {
    reply.header('Deprecation', 'true');
    done();
  });
  await registerApiRoutes(f);

  f.post<{ Params: { id: string } }>(
    '/boards/:id/archive-events',
    { preHandler: humanAuth },
    async (request, reply) => {
      const result = archiveOldEvents(request.params.id);
      return result;
    }
  );
}, { prefix: '/api' });

await fastify.register(async (f) => {
  await f.register(sseRoutes);
  await f.register(presenceRoutes);
}, { prefix: '/sse' });

// Redirect root to /app/ so users hitting / (which returns a 404 JSON)
// are sent to the SPA instead.
fastify.get('/', async (_request, reply) => reply.redirect('/app/'));

const uiPath = process.env.ORCY_UI_PATH || ORCY_PATHS.ui;
if (fs.existsSync(uiPath)) {
  await fastify.register(fastifyStatic, {
    root: uiPath,
    prefix: '/app/',
    wildcard: false,
  });
  // SPA fallback: serve index.html for all /app/* routes that don't match a file
  fastify.get('/app/*', async (request, reply) => {
    return reply.sendFile('index.html', uiPath);
  });
}

// Release tasks that have been idle for more than 30 minutes back to the board pool
const staleTaskInterval = setInterval(() => {
  try {
    releaseStaleTasks(30);
  } catch (err) {
    fastify.log.error({ err }, 'Error releasing stale tasks');
  }
}, 60_000);

// Clean up presence entries that have not been seen for 60s
const presenceCleanupInterval = startPresenceCleanup(60_000);

// Detect tasks that have passed their due date or SLA deadline and emit overdue events
const overdueCheckInterval = setInterval(() => {
  try {
    const db = getDb();
    const nowSql = nowExpr();
    const overdueRows = db.select({ id: tasks.id, boardId: features.boardId })
      .from(tasks)
      .innerJoin(features, eq(tasks.featureId, features.id))
      .where(
        and(
          notInArray(tasks.status, ['done', 'approved', 'failed']),
          or(sql`${features.dueAt} < ${nowSql}`, sql`${features.slaDeadlineAt} < ${nowSql}`)
        )
      )
      .all();
    if (overdueRows.length > 0) {
      const now = new Date().toISOString();
      for (const row of overdueRows) {
        sseBroadcaster.publish(row.boardId, {
          type: 'task.overdue',
          data: { taskId: row.id, boardId: row.boardId, detectedAt: now },
        });
      }
    }
  } catch (err) {
    fastify.log.error({ err }, 'Error checking overdue tasks');
  }
}, 60_000);

// Process pending retry tasks (rejected tasks with next_retry_at <= now)
const taskRetryInterval = startTaskRetryProcessor(30_000);

// Periodically scan all boards for anomalies
const anomalyScanInterval = setInterval(() => {
  try {
    scanAllBoards();
  } catch (err) {
    fastify.log.error({ err }, 'Error scanning for anomalies');
  }
}, 5 * 60_000);

// Daily audit log archival — archive old events for all boards
const auditArchivalInterval = setInterval(() => {
  try {
    const results = archiveAllBoards();
    if (results.length > 0) {
      fastify.log.info({ results }, 'Audit archival completed');
    }
  } catch (err) {
    fastify.log.error({ err }, 'Error archiving old events');
  }
}, 24 * 60 * 60_000);

// Graceful shutdown — persist DB immediately on SIGTERM/SIGINT, then exit
const shutdown = async () => {
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

fastify.addHook('onClose', async () => {
  clearInterval(staleTaskInterval);
  clearInterval(presenceCleanupInterval);
  clearInterval(overdueCheckInterval);
  clearInterval(taskRetryInterval);
  clearInterval(anomalyScanInterval);
  clearInterval(auditArchivalInterval);
});

await initDb();
if (!process.env.DB_PATH && process.env.NODE_ENV !== 'production') {
  const defaultPath = (await import('./db/index.js')).getDefaultDbPath();
  console.warn(`WARNING: No DB_PATH set. API is using production database at: ${defaultPath}`);
  console.warn('Set DB_PATH env var to a different path to keep dev/test data separate.');
}

try {
  rebuildBoardSecretCache();
} catch (err) {
  fastify.log.error({ err }, 'Failed to rebuild board secret cache');
}

try {
  seedQualityTemplates();
} catch (err) {
  fastify.log.error({ err }, 'Failed to seed quality templates');
}

try {
  await pluginManager.loadPlugins();
  await pluginManager.initializePlugins(fastify);
  const loaded = pluginManager.getLoadedPlugins();
  if (loaded.length > 0) {
    fastify.log.info({ plugins: loaded }, 'Plugins loaded');
  }
} catch (err) {
  fastify.log.error({ err }, 'Failed to load plugins - continuing without plugins');
}

fastify.get('/plugins', async () => ({ plugins: pluginManager.getLoadedPlugins() }));

try {
  await fastify.listen({ port: PORT, host: HOST });
  fastify.log.info(`Orcy API running at http://${HOST}:${PORT}`);
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
