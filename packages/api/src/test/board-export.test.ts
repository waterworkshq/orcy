import { describe, it, expect, vi } from 'vitest';
import { boardExportRoutes } from '../routes/board-export.js';
import { habitatRoutes } from '../routes/habitats.js';

interface CapturedRoute {
  method: string;
  path: string;
  preHandler: any[];
}

function captureExportRoutes(): CapturedRoute[] {
  const routes: CapturedRoute[] = [];
  const fakeFastify: any = {
    withTypeProvider: vi.fn(() => fakeFastify),
    register: vi.fn(),
    post: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'POST', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [] });
    }),
    patch: vi.fn(),
    delete: vi.fn(),
    get: vi.fn((path: string, opts: any, _handler: any) => {
      const preHandler = opts?.preHandler;
      routes.push({ method: 'GET', path, preHandler: Array.isArray(preHandler) ? preHandler : preHandler ? [preHandler] : [] });
    }),
  };
  boardExportRoutes(fakeFastify);
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
  habitatRoutes(fakeFastify);
  return routes;
}

describe('boardExportRoutes', () => {
  it('exports a function named boardExportRoutes', () => {
    expect(boardExportRoutes).toBeInstanceOf(Function);
    expect(boardExportRoutes.name).toBe('boardExportRoutes');
  });

  it('registers 4 endpoints', () => {
    const routes = captureExportRoutes();
    expect(routes).toHaveLength(4);
  });

  it('registers GET /boards/:id/export', () => {
    const routes = captureExportRoutes();
    expect(routes.find(r => r.path === '/boards/:id/export')).toBeDefined();
  });

  it('registers POST /boards/import', () => {
    const routes = captureExportRoutes();
    expect(routes.find(r => r.path === '/boards/import')).toBeDefined();
  });

  it('registers POST /boards/:id/import', () => {
    const routes = captureExportRoutes();
    expect(routes.find(r => r.path === '/boards/:id/import')).toBeDefined();
  });

  it('registers GET /boards/:id/anomalies', () => {
    const routes = captureExportRoutes();
    expect(routes.find(r => r.path === '/boards/:id/anomalies')).toBeDefined();
  });

  it('export endpoint has humanAuth preHandler', () => {
    const routes = captureExportRoutes();
    const route = routes.find(r => r.path === '/boards/:id/export');
    expect(route).toBeDefined();
    expect(route!.preHandler).toHaveLength(1);
    const handlerName = typeof route!.preHandler[0] === 'function' ? route!.preHandler[0].name || String(route!.preHandler[0]) : String(route!.preHandler[0]);
    expect(handlerName).toBe('humanAuth');
  });

  it('import endpoints have humanAuth preHandler', () => {
    const routes = captureExportRoutes();
    for (const path of ['/boards/import', '/boards/:id/import']) {
      const route = routes.find(r => r.path === path);
      expect(route).toBeDefined();
      expect(route!.preHandler).toHaveLength(1);
      const handlerName = typeof route!.preHandler[0] === 'function' ? route!.preHandler[0].name || String(route!.preHandler[0]) : String(route!.preHandler[0]);
      expect(handlerName).toBe('humanAuth');
    }
  });

  it('anomalies endpoint has agentOrHumanAuth + requireBoardAccess preHandlers', () => {
    const routes = captureExportRoutes();
    const route = routes.find(r => r.path === '/boards/:id/anomalies');
    expect(route).toBeDefined();
    expect(route!.preHandler.length).toBeGreaterThanOrEqual(2);
  });
});

describe('boards.ts no longer contains export/import/anomalies handlers', () => {
  it('does not register GET /boards/:id/export', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/export')).toBeUndefined();
  });

  it('does not register POST /boards/import', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/import')).toBeUndefined();
  });

  it('does not register POST /boards/:id/import', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/import')).toBeUndefined();
  });

  it('does not register GET /boards/:id/anomalies', () => {
    const routes = captureBoardRoutes();
    expect(routes.find(r => r.path === '/boards/:id/anomalies')).toBeUndefined();
  });
});
