#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"]);
const POLICIES = new Set([
  "anonymous",
  "human",
  "agent",
  "local_actor",
  "registration",
  "daemon",
  "realtime",
  "remote_participant",
  "manual_invite",
  "verified_ingress:github_code_review_hmac",
  "verified_ingress:github_ci_hmac",
  "verified_ingress:github_issues_hmac",
  "verified_ingress:gitlab_code_review_token",
  "verified_ingress:gitlab_ci_token",
  "verified_ingress:slack_signing",
  "verified_ingress:discord_ed25519",
]);
const normalize = (path) =>
  path.replace(/:[A-Za-z][A-Za-z0-9_]*/g, ":param").replace(/\/$/, "") || "/";
const cell = (value) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/\|/g, "&#124;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "&#96;")
    .replace(/\r|\n/g, " ");

function identity(route) {
  const { path, surface, source, method } = route;
  if (
    path !== "*" &&
    (!path.startsWith("/") ||
      path.includes("?") ||
      path.includes("#") ||
      /[\s|<>`]/.test(path) ||
      (path.length > 1 && path.endsWith("/")))
  )
    throw new Error(`Malformed route path: ${path}`);
  if (source === "framework" && path === "*" && surface === "other" && method === "OPTIONS")
    return { path: "*", surface: "framework" };
  if (source !== "core" && !(source === "framework" && method === "HEAD" && route.generatedTwin))
    throw new Error(`Unexpected route source: ${source}`);
  if (surface === "api-v1" && path.startsWith("/api/v1/"))
    return { path: normalize(path.slice("/api/v1".length)), surface: "current" };
  if (
    surface === "api-deprecated" &&
    path.startsWith("/api/") &&
    !path.startsWith("/api/v1/") &&
    (!path.startsWith("/api/shared/") || path.startsWith("/api/shared/invites/"))
  )
    return { path: normalize(path.slice("/api".length)), surface: "deprecated" };
  if (surface === "api-shared" && path.startsWith("/api/shared/"))
    return { path: normalize(path), surface: "shared" };
  if (
    (surface === "health" && path === "/health") ||
    (surface === "root-redirect" && path === "/") ||
    (surface === "sse" && path.startsWith("/sse/"))
  )
    return { path: normalize(path), surface: "standalone" };
  throw new Error(`Path/surface mismatch: ${method} ${path} (${surface})`);
}

export function buildRouteIndex(routes) {
  if (!Array.isArray(routes) || routes.length === 0)
    throw new Error("Expected nonempty routes array");
  const entries = new Map();
  const raw = new Set();
  for (const route of routes) {
    if (
      !route ||
      !METHODS.has(route.method) ||
      typeof route.path !== "string" ||
      !(
        POLICIES.has(route.authKind) ||
        (route.method === "OPTIONS" &&
          route.path === "*" &&
          route.source === "framework" &&
          route.authKind === "MISSING_POLICY")
      ) ||
      typeof route.generatedTwin !== "boolean"
    )
      throw new Error(`Malformed route: ${JSON.stringify(route)}`);
    const { path, surface } = identity(route);
    if (surface === "framework" && !route.generatedTwin)
      throw new Error("Framework preflight must be marked generated");
    if (
      route.generatedTwin &&
      route.method !== "HEAD" &&
      !(route.method === "OPTIONS" && route.path === "*" && route.source === "framework")
    )
      throw new Error(`Unexpected generated twin: ${route.method} ${route.path}`);
    const rawKey = `${route.method} ${route.path}`;
    if (raw.has(rawKey)) throw new Error(`Duplicate route: ${rawKey}`);
    raw.add(rawKey);
    const namespace = surface === "shared" ? "shared:" : "local:";
    const key = `${namespace}${route.method} ${path}`;
    const entry = entries.get(key) ?? {
      method: route.method,
      path,
      auth: route.authKind,
      surfaces: new Set(),
      ns: namespace,
    };
    if (entry.auth !== route.authKind) throw new Error(`Conflicting auth policy: ${key}`);
    if (entry.surfaces.has(surface))
      throw new Error(`Duplicate normalized route: ${key} (${surface})`);
    entry.surfaces.add(surface);
    entries.set(key, entry);
  }
  for (const route of routes) {
    if (
      !route.generatedTwin ||
      (route.method === "OPTIONS" && route.path === "*" && route.source === "framework")
    )
      continue;
    if (!raw.has(`GET ${route.path}`)) throw new Error(`Generated HEAD without GET: ${route.path}`);
    const { path, surface } = identity(route);
    const namespace = surface === "shared" ? "shared:" : "local:";
    if (entries.get(`${namespace}GET ${path}`).auth !== route.authKind)
      throw new Error(`Generated HEAD policy mismatch: ${route.path}`);
    entries.get(`${namespace}HEAD ${path}`).surfaces.delete(surface);
  }
  const family = (p) => {
    if (p.startsWith("/api/shared/")) return "remote-participant";
    const parts = p.split("/").filter(Boolean);
    if (p === "/" || p === "/health" || p === "*" || parts[0] === "sse") return "platform";
    return parts[0] === "shared" ? `shared/${parts[1] ?? ""}` : parts[0];
  };
  const groups = new Map();
  for (const entry of entries.values()) {
    if (!entry.surfaces.size || entry.surfaces.has("framework")) continue;
    const name = family(entry.path);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(entry);
  }
  const sorted = [...groups].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  let out =
    "# API Route Index\n\n> GENERATED FILE — do not edit by hand. Regenerate with `node scripts/generate-route-index.mjs`.\n> API-only production assembly baseline: `packages/api/src/test/fixtures/routeBaseline/apiOnly.json`; UI and plugin routes are not included.\n> Paths are presentation-normalized (`:param`); policy IDs describe installed authentication, not object-level authorization. Current `/api/v1` and deprecated `/api` twins share a row only when method, path, and policy match. `/api/shared` Remote Participant routes stay independent; manual-invite deprecated twins are paired with `/api/v1/shared/invites/*`. Generated HEAD twins and framework OPTIONS `*` CORS preflight are excluded from operation totals; explicit HEAD/OPTIONS remain. See `docs/API.md` for selected endpoint contracts.\n\n";
  let count = 0;
  for (const [name, rows] of sorted) {
    out += `## ${cell(name)}\n\n| Method | Path | Auth policy | Surfaces |\n|---|---|---|---|\n`;
    rows.sort((a, b) =>
      a.path < b.path
        ? -1
        : a.path > b.path
          ? 1
          : a.method < b.method
            ? -1
            : a.method > b.method
              ? 1
              : a.ns < b.ns
                ? -1
                : a.ns > b.ns
                  ? 1
                  : 0,
    );
    for (const row of rows) {
      const surfaces = row.surfaces;
      const coverage =
        surfaces.has("current") && surfaces.has("deprecated")
          ? "current + deprecated twin"
          : surfaces.has("current")
            ? "current only"
            : surfaces.has("deprecated")
              ? "deprecated only"
              : surfaces.has("shared")
                ? "Remote Participant API"
                : "standalone";
      out += `| ${cell(row.method)} | \`${cell(row.path)}\` | \`${cell(row.auth)}\` | ${coverage} |\n`;
      count++;
    }
    out += "\n";
  }
  return (
    out +
    `---\n\nTotal operations (generated HEAD and framework preflight excluded; twins deduplicated): ${count} across ${sorted.length} families.\n`
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const fixture = JSON.parse(
    readFileSync(
      resolve(ROOT, "packages/api/src/test/fixtures/routeBaseline/apiOnly.json"),
      "utf8",
    ),
  );
  const output = buildRouteIndex(fixture.routes);
  const destination = resolve(ROOT, "docs/API-ROUTES.md");
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, output);
    renameSync(temporary, destination);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {}
    throw error;
  }
}
