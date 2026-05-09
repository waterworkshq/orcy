import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface RouteAuthInfo {
  method: string;
  url: string;
  hasAuth: boolean;
  preHandlerNames: string[];
  isPublic: boolean;
}

const AUTH_FUNCTION_NAMES = new Set([
  'agentAuth',
  'humanAuth',
  'agentOrHumanAuth',
  'sseAuth',
  'registrationAuth',
  'authenticateRealtime',
]);

const PUBLIC_ROUTE_PATTERNS: Array<{ method: string; pathPattern: RegExp }> = [
  { method: 'POST', pathPattern: /\/auth\/login$/ },
  { method: 'GET', pathPattern: /\/health$/ },
  { method: 'GET', pathPattern: /\/plugins$/ },
  { method: 'POST', pathPattern: /\/webhooks\/github$/ },
  { method: 'POST', pathPattern: /\/webhooks\/gitlab$/ },
  { method: 'POST', pathPattern: /\/webhooks\/github-ci$/ },
  { method: 'POST', pathPattern: /\/webhooks\/gitlab-ci$/ },
  { method: 'POST', pathPattern: /\/chat\/slack\/command$/ },
  { method: 'POST', pathPattern: /\/chat\/discord\/interaction$/ },
  { method: 'POST', pathPattern: /\/agents$/ },
];

function extractHandlerName(fn: unknown): string {
  if (typeof fn === 'function' && fn.name) return fn.name;
  return '<anonymous>';
}

export function isPublicRoute(method: string, url: string): boolean {
  return PUBLIC_ROUTE_PATTERNS.some(
    (p) => p.method === method.toUpperCase() && p.pathPattern.test(url),
  );
}

export function checkPreHandlerAuth(preHandler: unknown): { hasAuth: boolean; names: string[] } {
  if (!preHandler) return { hasAuth: false, names: [] };
  const fns = Array.isArray(preHandler) ? preHandler : [preHandler];
  const names = fns.map(extractHandlerName);
  const hasAuth = names.some((n) => AUTH_FUNCTION_NAMES.has(n));
  return { hasAuth, names };
}

export function captureRouteInventory(app: FastifyInstance): RouteAuthInfo[] {
  const routes: RouteAuthInfo[] = [];

  app.addHook('onRoute', (routeOptions) => {
    const method = routeOptions.method as string;
    const url = routeOptions.url;
    const { hasAuth, names } = checkPreHandlerAuth(routeOptions.preHandler);
    const isPublic = isPublicRoute(method, url);

    routes.push({ method, url, hasAuth, preHandlerNames: names, isPublic });
  });

  return routes;
}

export function findUnauthenticatedNonPublicRoutes(routes: RouteAuthInfo[]): RouteAuthInfo[] {
  return routes.filter((r) => !r.hasAuth && !r.isPublic);
}

export function filterRoutesByPrefix(routes: RouteAuthInfo[], prefix: string): RouteAuthInfo[] {
  return routes.filter((r) => r.url.startsWith(prefix));
}

export { AUTH_FUNCTION_NAMES, PUBLIC_ROUTE_PATTERNS };
