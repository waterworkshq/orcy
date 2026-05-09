import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { validatorCompiler, serializerCompiler } from 'fastify-type-provider-zod';
import {
  captureRouteInventory,
  findUnauthenticatedNonPublicRoutes,
  filterRoutesByPrefix,
  isPublicRoute,
  checkPreHandlerAuth,
  type RouteAuthInfo,
} from '../config/routeInventory.js';
import { agentAuth, humanAuth, agentOrHumanAuth } from '../middleware/auth.js';
import { initTestDb, closeDb } from '../db/index.js';
import { perAgentRateLimit } from '../middleware/rateLimit.js';

import { boardRoutes } from '../routes/boards.js';
import { boardAnalyticsRoutes } from '../routes/board-analytics.js';
import { boardExportRoutes } from '../routes/board-export.js';
import { columnRoutes } from '../routes/columns.js';
import { taskRoutes } from '../routes/tasks.js';
import { featureRoutes } from '../routes/features.js';
import { agentRoutes } from '../routes/agents.js';
import { sseRoutes } from '../routes/sse.js';
import { authRoutes } from '../routes/auth.js';
import { webhookRoutes } from '../routes/webhookOutgoing.js';
import { commentRoutes } from '../routes/comments.js';
import { templateRoutes } from '../routes/templates.js';
import { subtaskRoutes } from '../routes/subtasks.js';
import { presenceRoutes } from '../routes/presence.js';
import { dashboardRoutes } from '../routes/dashboard.js';
import { savedFilterRoutes } from '../routes/savedFilters.js';
import { attachmentRoutes } from '../routes/attachments.js';
import { notificationPrefRoutes } from '../routes/notificationPreferences.js';
import { chatIntegrationRoutes } from '../routes/chatIntegration.js';
import { agentMessageRoutes } from '../routes/agentMessages.js';
import { codeReviewWebhookRoutes } from '../routes/codeReviewWebhooks.js';
import { ciCdWebhookRoutes } from '../routes/ciCdWebhooks.js';
import { organizationRoutes } from '../routes/organizations.js';
import { timeTrackingRoutes } from '../routes/timeTracking.js';
import { dependencyRoutes } from '../routes/dependencies.js';
import { qualityGateRoutes } from '../routes/qualityGates.js';

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
  await f.register(codeReviewWebhookRoutes);
  await f.register(ciCdWebhookRoutes);
  await f.register(organizationRoutes);
  await f.register(timeTrackingRoutes);
  await f.register(dependencyRoutes);
  await f.register(qualityGateRoutes);
}

const ROUTES_WITHOUT_AUTH_BY_DESIGN: string[] = [
  '/api/v1/webhooks/github (POST)',
  '/api/v1/webhooks/gitlab (POST)',
  '/api/v1/webhooks/github-ci (POST)',
  '/api/v1/webhooks/gitlab-ci (POST)',
  '/api/v1/chat/slack/command (POST)',
  '/api/v1/chat/discord/interaction (POST)',
  '/api/v1/auth/setup-status (GET)',
  '/api/v1/auth/register (POST)',
  '/api/webhooks/github (POST)',
  '/api/webhooks/gitlab (POST)',
  '/api/webhooks/github-ci (POST)',
  '/api/webhooks/gitlab-ci (POST)',
  '/api/chat/slack/command (POST)',
  '/api/chat/discord/interaction (POST)',
  '/api/auth/setup-status (GET)',
  '/api/auth/register (POST)',
];

function routeKey(r: RouteAuthInfo): string {
  return `${r.url} (${r.method})`;
}

describe('Route Inventory', () => {
  let v1Routes: RouteAuthInfo[];
  let apiRoutes: RouteAuthInfo[];
  let allRoutes: RouteAuthInfo[];

  beforeAll(async () => {
    await initTestDb();

    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const capturedRoutes: RouteAuthInfo[] = [];

    app.addHook('onRoute', (routeOptions) => {
      const method = routeOptions.method as string;
      const url = routeOptions.url;
      const { hasAuth, names } = checkPreHandlerAuth(routeOptions.preHandler);
      const isPublic = isPublicRoute(method, url);
      capturedRoutes.push({ method, url, hasAuth, preHandlerNames: names, isPublic });
    });

    await app.register(async (f) => {
      f.setValidatorCompiler(validatorCompiler);
      f.setSerializerCompiler(serializerCompiler);
      f.addHook('preHandler', perAgentRateLimit);
      await registerApiRoutes(f);

      f.post<{ Params: { id: string } }>(
        '/boards/:id/archive-events',
        { preHandler: humanAuth },
        async () => ({}),
      );
    }, { prefix: '/api/v1' });

    await app.register(async (f) => {
      f.setValidatorCompiler(validatorCompiler);
      f.setSerializerCompiler(serializerCompiler);
      f.addHook('preHandler', perAgentRateLimit);
      f.addHook('onResponse', (request, reply, done) => { done(); });
      await registerApiRoutes(f);

      f.post<{ Params: { id: string } }>(
        '/boards/:id/archive-events',
        { preHandler: humanAuth },
        async () => ({}),
      );
    }, { prefix: '/api' });

    await app.register(async (f) => {
      await f.register(sseRoutes);
      await f.register(presenceRoutes);
    }, { prefix: '/sse' });

    await app.ready();

    allRoutes = capturedRoutes.filter((r) => r.method !== 'HEAD');
    v1Routes = allRoutes.filter((r) => r.url.startsWith('/api/v1'));
    apiRoutes = allRoutes.filter((r) => r.url.startsWith('/api/') && !r.url.startsWith('/api/v1'));
  });

  afterAll(() => {
    closeDb();
  });

  describe('isPublicRoute', () => {
    it('identifies auth/login as public', () => {
      expect(isPublicRoute('POST', '/auth/login')).toBe(true);
    });

    it('identifies health as public', () => {
      expect(isPublicRoute('GET', '/health')).toBe(true);
    });

    it('identifies agent registration as public', () => {
      expect(isPublicRoute('POST', '/agents')).toBe(true);
    });

    it('identifies webhook endpoints as public', () => {
      expect(isPublicRoute('POST', '/webhooks/github')).toBe(true);
      expect(isPublicRoute('POST', '/webhooks/gitlab')).toBe(true);
      expect(isPublicRoute('POST', '/webhooks/github-ci')).toBe(true);
    });

    it('does not identify board routes as public', () => {
      expect(isPublicRoute('GET', '/boards')).toBe(false);
      expect(isPublicRoute('POST', '/boards')).toBe(false);
    });

    it('does not identify task routes as public', () => {
      expect(isPublicRoute('GET', '/tasks')).toBe(false);
    });
  });

  describe('checkPreHandlerAuth', () => {
    it('detects no auth when preHandler is undefined', () => {
      expect(checkPreHandlerAuth(undefined).hasAuth).toBe(false);
    });

    it('detects auth in named function', () => {
      expect(checkPreHandlerAuth([agentAuth]).hasAuth).toBe(true);
      expect(checkPreHandlerAuth([humanAuth]).hasAuth).toBe(true);
      expect(checkPreHandlerAuth([agentOrHumanAuth]).hasAuth).toBe(true);
    });

    it('detects auth in array of handlers', () => {
      expect(checkPreHandlerAuth([(_req: any, _rep: any) => {}, humanAuth]).hasAuth).toBe(true);
    });

    it('does not false-positive on non-auth handlers', () => {
      expect(checkPreHandlerAuth([(_req: any, _rep: any) => {}]).hasAuth).toBe(false);
    });
  });

  describe('/api/v1 routes', () => {
    it('registers routes under /api/v1', () => {
      expect(v1Routes.length).toBeGreaterThan(0);
    });

    it('reports unauthenticated non-public routes', () => {
      const unprotected = findUnauthenticatedNonPublicRoutes(v1Routes);
      const keys = unprotected.map(routeKey);
      const unexpected = keys.filter((k) => !ROUTES_WITHOUT_AUTH_BY_DESIGN.includes(k));

      if (unexpected.length > 0) {
        console.log('Unauthenticated /api/v1 routes:');
        for (const key of keys) {
          const tag = ROUTES_WITHOUT_AUTH_BY_DESIGN.includes(key) ? '[KNOWN]' : '[NEW]';
          console.log(`  ${tag} ${key}`);
        }
      }

      expect(unexpected, `Unauthenticated /api/v1 routes without auth: ${unexpected.join(', ')}`).toEqual([]);
    });

    it('auth/login has no auth preHandler (by design)', () => {
      const loginRoute = v1Routes.find((r) => r.url.includes('/auth/login') && r.method === 'POST');
      expect(loginRoute).toBeDefined();
      expect(loginRoute!.isPublic).toBe(true);
    });

    it('agent registration has registrationAuth preHandler', () => {
      const regRoute = v1Routes.find(
        (r) => r.url.includes('/agents') && !r.url.includes('/:id') && r.method === 'POST',
      );
      expect(regRoute).toBeDefined();
      expect(regRoute!.hasAuth).toBe(true);
    });
  });

  describe('/api routes (deprecated prefix)', () => {
    it('registers routes under /api', () => {
      expect(apiRoutes.length).toBeGreaterThan(0);
    });

    it('reports unauthenticated non-public routes', () => {
      const unprotected = findUnauthenticatedNonPublicRoutes(apiRoutes);
      const keys = unprotected.map(routeKey);
      const unexpected = keys.filter((k) => !ROUTES_WITHOUT_AUTH_BY_DESIGN.includes(k));

      if (unexpected.length > 0) {
        console.log('Unauthenticated /api routes:');
        for (const key of keys) {
          const tag = ROUTES_WITHOUT_AUTH_BY_DESIGN.includes(key) ? '[KNOWN]' : '[NEW]';
          console.log(`  ${tag} ${key}`);
        }
      }

      expect(unexpected, `Unauthenticated /api routes without auth: ${unexpected.join(', ')}`).toEqual([]);
    });

    it('mirrors the same route set as /api/v1', () => {
      const v1Urls = new Set(v1Routes.map((r) => r.url.replace('/api/v1', '')));
      const apiUrls = new Set(apiRoutes.map((r) => r.url.replace('/api', '')));

      for (const url of v1Urls) {
        expect(apiUrls.has(url)).toBe(true);
      }
    });
  });

  describe('route inventory completeness', () => {
    it('captures board routes', () => {
      const boardRoutes = allRoutes.filter((r) => r.url.includes('/boards'));
      expect(boardRoutes.length).toBeGreaterThan(0);
    });

    it('captures task routes', () => {
      const taskRoutesFound = allRoutes.filter((r) => r.url.includes('/tasks'));
      expect(taskRoutesFound.length).toBeGreaterThan(0);
    });

    it('captures feature routes', () => {
      const featureRoutesFound = allRoutes.filter((r) => r.url.includes('/features'));
      expect(featureRoutesFound.length).toBeGreaterThan(0);
    });

    it('captures agent routes', () => {
      const agentRoutesFound = allRoutes.filter((r) => r.url.includes('/agents'));
      expect(agentRoutesFound.length).toBeGreaterThan(0);
    });
  });

  describe('filterRoutesByPrefix', () => {
    it('filters routes by url prefix', () => {
      const filtered = filterRoutesByPrefix(allRoutes, '/api/v1/boards');
      expect(filtered.length).toBeGreaterThan(0);
      for (const r of filtered) {
        expect(r.url).toContain('/boards');
      }
    });

    it('returns empty for non-matching prefix', () => {
      const filtered = filterRoutesByPrefix(allRoutes, '/nonexistent');
      expect(filtered).toHaveLength(0);
    });
  });

  describe('findUnauthenticatedNonPublicRoutes', () => {
    it('returns only routes without auth that are not public', () => {
      const routes: RouteAuthInfo[] = [
        { method: 'GET', url: '/boards', hasAuth: true, preHandlerNames: ['humanAuth'], isPublic: false },
        { method: 'GET', url: '/agents', hasAuth: false, preHandlerNames: [], isPublic: true },
        { method: 'GET', url: '/tasks', hasAuth: false, preHandlerNames: [], isPublic: false },
      ];
      const result = findUnauthenticatedNonPublicRoutes(routes);
      expect(result).toHaveLength(1);
      expect(result[0].url).toBe('/tasks');
    });
  });
});
