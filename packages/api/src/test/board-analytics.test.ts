import { describe, it, expect, vi } from 'vitest';
import { boardAnalyticsRoutes } from '../routes/board-analytics.js';
import { boardRoutes } from '../routes/boards.js';

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
}

function captureAnalyticsRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    get: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'GET', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [] });
    }),
  };
  boardAnalyticsRoutes(fakeFastify);
  return routes;
}

function captureBoardRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
    get: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'GET', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [] });
    }),
  };
  boardRoutes(fakeFastify);
  return routes;
}

describe('boardAnalyticsRoutes', () => {
  it('exports a function named boardAnalyticsRoutes', () => {
    expect(boardAnalyticsRoutes).toBeInstanceOf(Function);
    expect(boardAnalyticsRoutes.name).toBe('boardAnalyticsRoutes');
  });

  it('registers 6 analytics endpoints', () => {
    const routes = captureAnalyticsRoutes();
    expect(routes).toHaveLength(6);
  });

  it('registers GET /boards/:id/stats', () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find(r => r.path === '/boards/:id/stats')).toBeDefined();
  });

  it('registers GET /boards/:id/summary', () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find(r => r.path === '/boards/:id/summary')).toBeDefined();
  });

  it('registers GET /boards/:id/events', () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find(r => r.path === '/boards/:id/events')).toBeDefined();
  });

  it('registers GET /boards/:id/capacity', () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find(r => r.path === '/boards/:id/capacity')).toBeDefined();
  });

  it('registers GET /boards/:id/predictions', () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find(r => r.path === '/boards/:id/predictions')).toBeDefined();
  });

  it('registers GET /boards/:id/burndown', () => {
    const routes = captureAnalyticsRoutes();
    expect(routes.find(r => r.path === '/boards/:id/burndown')).toBeDefined();
  });

  it('all analytics endpoints have auth + board access preHandlers', () => {
    const routes = captureAnalyticsRoutes();
    for (const route of routes) {
      expect(route.preHandler.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('boards.ts no longer contains analytics handlers', () => {
  it('does not register /boards/:id/stats', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/stats')).toBeUndefined();
  });

  it('does not register /boards/:id/summary', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/summary')).toBeUndefined();
  });

  it('does not register /boards/:id/events', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/events')).toBeUndefined();
  });

  it('does not register /boards/:id/capacity', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/capacity')).toBeUndefined();
  });

  it('does not register /boards/:id/predictions', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/predictions')).toBeUndefined();
  });

  it('does not register /boards/:id/burndown', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/burndown')).toBeUndefined();
  });
});
