/**
 * Production router characterization (pre-extraction baseline).
 *
 * Captures the exact post-containment HTTP surface through the SAME
 * production registration seam the executable boots from — `createHttpApp` +
 * `registerHttpSurface` in `src/httpApp.ts`. There is no copied module list
 * here: a route added through the normal production seam changes the observed
 * inventory and fails the fixture comparison automatically (the sentinel
 * discriminator — proven by mutate/revert, see the ticket report).
 *
 * Hook parity is OBSERVED, not described: `registerHttpSurface` emits one
 * `HookInstallationRecord` at the exact statement that installs each root or
 * scoped hook (per-registration `onHookInstalled` option), and the fixtures
 * pin that production-emitted stream. Behavioral discriminators additionally
 * prove the hooks work: rate-limit headers on all three rate-limited scopes,
 * an audit provenance probe route reading what the root audit hooks
 * established, and Remote Participant key rejection.
 *
 * Every verified-ingress family in `RAW_BODY_ROUTES` is exercised under BOTH
 * prefixes with its real credential model: HMAC families (code-review
 * GitHub, CI GitHub, GitHub issues, Slack v0) prove exact-byte acceptance
 * and altered-byte rejection; GitLab token families (code review + CI) prove
 * valid-token acceptance and invalid-token rejection — their raw body is
 * captured but not credential-bearing, and is recorded as such rather than
 * inventing a signature claim. The Discord Ed25519 family is pinned as
 * deployed: the compiled ESM verifier calls an unbound CommonJS
 * require('tweetnacl') AND tweetnacl is absent from the dependency graph,
 * so it rejects every signature (including correct ones) when a public key
 * is configured — a recorded finding, not something this ticket changes.
 *
 * Three modes are pinned against committed fixtures under
 * `src/test/fixtures/routeBaseline/`:
 *   - api-only       no UI directory, no plugins
 *   - ui-installed   ORCY_UI_PATH points at a directory holding index.html
 *   - fixture-plugin one fixture System Plugin registered through the real
 *                    `pluginManager.loadPlugins` + `initializePlugins` seams
 *
 * The fixtures are the pre-extraction parity artifact for the assembly
 * extraction: regenerate with `UPDATE_ROUTE_BASELINE=1
 * corepack pnpm --filter @orcy/api test -- routeSurfaceCharacterization`
 * ONLY when the surface intentionally changes. Otherwise every diff —
 * added, removed, or reshaped route — must fail here.
 *
 * The compiled-executable counterpart lives in `compiledStartup.test.ts`
 * (the canonical build/launch harness): its characterized-surface test boots
 * `dist/index.js` with controlled temporary UI/plugin inputs and probes
 * representative surfaces so a health-only rewiring of `index.ts` cannot
 * pass while the in-process seam stays intact. Keeping it there avoids a
 * second migration/build/spawn harness racing builds into `dist/`.
 *
 * Fastify-synthesized HEAD twins are normalized by pairing each HEAD entry
 * with its GET twin; a HEAD route without a GET twin is NOT exempted — it
 * lands in the inventory as a first-class route and shows up in any diff.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import {
  createHttpApp,
  registerHttpSurface,
  RAW_BODY_ROUTES,
  type HttpApp,
  type HookInstallationRecord,
} from "../httpApp.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { getAuditProvenanceMetadata } from "../services/auditProvenanceContext.js";
import { closeDb, initTestDb } from "../db/index.js";
import { rebuildCache as rebuildHabitatSecretCache } from "../services/habitatSecretCache.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as connectionRepo from "../repositories/integrationConnection.js";
import * as externalIssueLinkRepo from "../repositories/externalIssueLink.js";

const JWT_SECRET = "dev-secret-change-in-production";
const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "routeBaseline");
const UPDATE_BASELINE = process.env.UPDATE_ROUTE_BASELINE === "1";

/**
 * Authentication guards observable at the route level today. This is a
 * descriptive snapshot of current behavior (middleware function names), NOT
 * the future policy catalog — Ticket 03 replaces name inference with typed
 * policy declarations.
 */
const AUTH_GUARD_KIND: Record<string, string> = {
  humanAuth: "human",
  agentAuth: "agent",
  agentOrHumanAuth: "local_actor",
  registrationAuth: "registration",
  authenticateRealtime: "realtime",
  daemonAuth: "daemon",
};

/** Scope-level authentication installed inside a route plugin, not the seam. */
const SURFACE_SCOPE_AUTH: Record<string, string> = {
  "api-shared": "remote_participant",
};

type RouteSource = "core" | "plugin" | "static" | "framework";

interface RouteRecord {
  method: string;
  path: string;
  surface: string;
  guards: string[];
  authKind: string;
  rawBodyEligible: boolean;
  source: RouteSource;
  generatedTwin: boolean;
}

interface BaselineFixture {
  uiMode: boolean;
  plugins: string[];
  /** Production-emitted hook installation stream (ordered). */
  hookInstallations: HookInstallationRecord[];
  behaviorNotes: string[];
  routes: RouteRecord[];
}

/**
 * Surface classification by absolute path, mirroring the seam's mount layout.
 * The one non-obvious rule: the manual-invite routes are registered by the
 * deprecated-prefix group as `/api/shared/invites/*`, path-adjacent to (but
 * distinct from) the Remote Participant API mounted at `/api/shared` —
 * `/api/v1/shared/invites/*` is the current-prefix twin of those, not part of
 * the v1-local API group's relative path space.
 */
function classifySurface(url: string): string {
  if (url === "/health") return "health";
  if (url === "/") return "root-redirect";
  if (url.startsWith("/api/v1/")) return "api-v1";
  if (url.startsWith("/api/shared/invites/")) return "api-deprecated";
  if (url.startsWith("/api/shared")) return "api-shared";
  if (url.startsWith("/api/")) return "api-deprecated";
  if (url.startsWith("/sse")) return "sse";
  if (url.startsWith("/app")) return "ui-static";
  return "other";
}

function classifyAuth(surface: string, guardNames: string[]): string {
  for (const name of guardNames) {
    const kind = AUTH_GUARD_KIND[name];
    if (kind) return kind;
  }
  const scopeAuth = SURFACE_SCOPE_AUTH[surface];
  if (scopeAuth) return `${scopeAuth} (scope-level)`;
  return "none-observed";
}

function handlerNames(preHandler: unknown): string[] {
  if (!preHandler) return [];
  const fns = Array.isArray(preHandler) ? preHandler : [preHandler];
  return fns.map((fn) => (typeof fn === "function" && fn.name ? fn.name : "<anonymous>"));
}

interface ObservedApp {
  app: HttpApp;
  records: RouteRecord[];
  hookInstallations: HookInstallationRecord[];
  waypoint?: { fired: boolean; afterHookCount: number };
}

/**
 * Builds the production application and observes every registered route and
 * hook installation. `withPlugins` flips the capture boundary so routes
 * registered by the production plugin seam are attributed `source: "plugin"`;
 * `waypoint` receives the seam's operational interposition callback slot so
 * the boot ordering can be pinned; `auditProbeRoute` registers a test-only
 * route AFTER route capture closes so it reads (without polluting) the
 * inventory.
 */
async function buildObservedApp(options: {
  logger?: boolean;
  withPlugins?: boolean;
  waypoint?: () => void;
  auditProbeRoute?: boolean;
}): Promise<ObservedApp> {
  const app = createHttpApp(options.logger ?? false);
  const records: RouteRecord[] = [];
  const hookInstallations: HookInstallationRecord[] = [];
  const waypoint: ObservedApp["waypoint"] = { fired: false, afterHookCount: -1 };
  let pluginBoundaryReached = false;
  let routeCaptureClosed = false;

  app.addHook("onRoute", (routeOptions) => {
    if (routeCaptureClosed) return;
    const methods = Array.isArray(routeOptions.method)
      ? routeOptions.method
      : [routeOptions.method as string];
    for (const m of methods) {
      records.push({
        method: m.toUpperCase(),
        path: routeOptions.url,
        surface: classifySurface(routeOptions.url),
        guards: handlerNames(routeOptions.preHandler),
        authKind: "pending",
        rawBodyEligible: (RAW_BODY_ROUTES as readonly string[]).includes(routeOptions.url),
        source: pluginBoundaryReached ? "plugin" : "core",
        generatedTwin: false,
      });
    }
  });

  await registerHttpSurface(app, {
    onHookInstalled: (record) => {
      hookInstallations.push(structuredClone(record));
    },
    onLocalPrefixesRegistered: options.waypoint
      ? () => {
          waypoint.fired = true;
          waypoint.afterHookCount = hookInstallations.length;
          options.waypoint!();
        }
      : undefined,
  });

  if (options.withPlugins) {
    pluginBoundaryReached = true;
    await pluginManager.loadPlugins();
    await pluginManager.initializePlugins(app);
  }

  routeCaptureClosed = true;

  if (options.auditProbeRoute) {
    // Test-only observation route on the production-configured app: returns
    // exactly what the root audit hooks established for this request.
    app.get("/__audit-probe__", async () => getAuditProvenanceMetadata() ?? null);
  }

  await app.ready();

  // HEAD twins: a HEAD entry whose GET twin exists is Fastify-synthesized.
  // A HEAD entry without a GET twin stays a first-class record.
  for (const rec of records) {
    if (rec.method === "HEAD") {
      const twin = records.some((r) => r.method === "GET" && r.path === rec.path);
      rec.generatedTwin = twin;
      if (twin) rec.source = "framework";
    }
    // Narrow framework normalization: the CORS preflight catch-all is the one
    // wildcard OPTIONS route (@fastify/cors). Any OTHER OPTIONS route — or any
    // unknown application route — stays first-class and lands in the diff.
    if (rec.method === "OPTIONS" && rec.path === "*") {
      rec.generatedTwin = true;
      rec.source = "framework";
    }
    // The optional UI's GET routes come from @fastify/static / the SPA
    // fallback — static surface, not core application routes.
    if (rec.surface === "ui-static" && !rec.generatedTwin) {
      rec.source = "static";
    }
    rec.authKind = classifyAuth(rec.surface, rec.guards);
  }

  records.sort((a, b) => (a.method + " " + a.path).localeCompare(b.method + " " + b.path));
  return { app, records, hookInstallations, waypoint: options.waypoint ? waypoint : undefined };
}

function recordKey(r: RouteRecord): string {
  return `${r.method} ${r.path}`;
}

function summarizeDiff(observed: RouteRecord[], expected: RouteRecord[]): string {
  const obs = new Set(observed.map(recordKey));
  const exp = new Set(expected.map(recordKey));
  const added = [...obs].filter((k) => !exp.has(k));
  const removed = [...exp].filter((k) => !obs.has(k));
  return (
    `added: ${added.length ? added.join(", ") : "(none)"}; ` +
    `removed: ${removed.length ? removed.join(", ") : "(none)"}; ` +
    `shape drift accounts for any remaining difference`
  );
}

async function loadFixture(name: string): Promise<BaselineFixture> {
  const { readFile } = await import("node:fs/promises");
  try {
    return JSON.parse(await readFile(path.join(FIXTURE_DIR, `${name}.json`), "utf8"));
  } catch (err) {
    if (UPDATE_BASELINE) {
      // First capture: there is nothing to compare against yet.
      return { uiMode: false, plugins: [], hookInstallations: [], behaviorNotes: [], routes: [] };
    }
    throw err;
  }
}

async function writeFixture(name: string, fixture: BaselineFixture): Promise<void> {
  await mkdir(FIXTURE_DIR, { recursive: true });
  await writeFile(
    path.join(FIXTURE_DIR, `${name}.json`),
    JSON.stringify(fixture, null, 2) + "\n",
    "utf8",
  );
}

function assertMatchesFixture(name: string, fixture: BaselineFixture, observed: RouteRecord[]) {
  const message =
    `route baseline "${name}" drifted from the committed fixture ` +
    `(${summarizeDiff(observed, fixture.routes)}). If intentional, regenerate with ` +
    `UPDATE_ROUTE_BASELINE=1 and review the diff; otherwise fix the regression.`;
  expect(observed, message).toEqual(fixture.routes);
}

/**
 * Behavioral truths discovered during characterization and recorded for the
 * owning tickets — NOT fixed here (out of scope per the ticket).
 */
const BEHAVIOR_NOTES: string[] = [
  "X-API-Version and Deprecation headers are set inside onResponse hooks; " +
    "Fastify has already sent the response by then, so neither header reaches " +
    "clients on any prefix (pre-existing at the characterization commit; the " +
    "deprecation-header parity promise must be re-grounded on onSend when the " +
    "assembly extraction revisits it).",
  "GET /plugins is agentOrHumanAuth-guarded today; the stale public-regex " +
    "exception lives only in the legacy routeInventory inference, not in " +
    "served behavior.",
  "The Discord Ed25519 verifier is structurally inert for two stacked " +
    "reasons: the compiled ESM module calls an unbound CommonJS " +
    "require('tweetnacl') (ReferenceError in ESM, swallowed by the catch), " +
    "and tweetnacl is additionally absent from the dependency graph. With " +
    "DISCORD_PUBLIC_KEY configured every interaction (including correctly " +
    "signed ones) is rejected 401; without a key, non-remote posture passes " +
    "requests unverified. Adding the dependency alone does NOT repair " +
    "verification — the import mechanism must be corrected too. Both are " +
    "behavior changes owned by a later ticket.",
  "Slack slash-command traffic is form-encoded on the real wire, but a " +
    "validly signed application/x-www-form-urlencoded request returns 500 " +
    "(only application/json bodies complete); the app registers no formbody " +
    "parser. Recorded for the owning ticket.",
];

// ---------------------------------------------------------------------------
// Fixture System Plugin — registered through the real plugin discovery seams
// (setPluginDirectory → loadPlugins → initializePlugins), never a test-local
// route registration. Mirrors what a production System Plugin can do today:
// an unrestricted FastifyPluginCallback mounted at root (ADR-0050 replaces
// this contract in a later ticket; the baseline records the current truth).
// ---------------------------------------------------------------------------
const FIXTURE_PLUGIN_ID = "char-fixture";
const FIXTURE_PLUGIN_ROUTE = "/__char-fixture";

async function writeFixturePluginDir(targetDir?: string): Promise<string> {
  const dir = targetDir ?? (await mkdtemp(path.join("/tmp", "route-char-plugins-")));
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, "char-fixture.mjs"),
    `export default {
  manifest: {
    id: '${FIXTURE_PLUGIN_ID}',
    version: '0.0.1',
    description: 'route characterization fixture plugin',
    contributions: [
      { kind: 'customHttpRoute', scope: 'system', method: 'GET', path: '${FIXTURE_PLUGIN_ROUTE}', requires: [] },
    ],
  },
  routeHandlers: async (fastify) => {
    fastify.get('${FIXTURE_PLUGIN_ROUTE}', async () => ({ fixture: true }));
  },
};\n`,
    "utf8",
  );
  return dir;
}

describe("production route surface characterization", () => {
  let apiOnly: ObservedApp;
  let uiInstalled: ObservedApp;
  let fixturePlugin: ObservedApp;
  let auditProbe: ObservedApp;
  let fixturePluginDir: string;
  let uiDir: string;
  let noUiDir: string;
  let priorUiPath: string | undefined;
  let adminToken: string;

  beforeAll(async () => {
    await initTestDb();
    setJwtSecret(JWT_SECRET);
    adminToken = jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
      issuer: "orcy",
    });

    // API-only mode: production conditional observes a missing UI directory.
    priorUiPath = process.env.ORCY_UI_PATH;
    noUiDir = await mkdtemp(path.join("/tmp", "route-char-noui-"));
    await rm(noUiDir, { recursive: true, force: true }); // existsSync must be false
    process.env.ORCY_UI_PATH = noUiDir;

    pluginManager.resetPlugins();
    apiOnly = await buildObservedApp({});

    // UI-installed mode: same seam, UI directory present.
    uiDir = await mkdtemp(path.join("/tmp", "route-char-ui-"));
    await writeFile(path.join(uiDir, "index.html"), "<html>char-ui</html>", "utf8");
    await writeFile(path.join(uiDir, "asset.txt"), "asset", "utf8");
    process.env.ORCY_UI_PATH = uiDir;
    pluginManager.resetPlugins();
    uiInstalled = await buildObservedApp({});

    // Fixture-plugin mode: real plugin seams on top of the UI-installed app.
    fixturePluginDir = await writeFixturePluginDir();
    pluginManager.resetPlugins();
    pluginManager.setPluginDirectory(fixturePluginDir);
    fixturePlugin = await buildObservedApp({ withPlugins: true });

    // Audit-probe app: production configuration plus the observation route.
    pluginManager.resetPlugins();
    auditProbe = await buildObservedApp({ auditProbeRoute: true });

    if (priorUiPath === undefined) delete process.env.ORCY_UI_PATH;
    else process.env.ORCY_UI_PATH = priorUiPath;
  });

  afterAll(async () => {
    await apiOnly.app.close();
    await uiInstalled.app.close();
    await fixturePlugin.app.close();
    await auditProbe.app.close();
    pluginManager.resetPlugins();
    await rm(fixturePluginDir, { recursive: true, force: true });
    await rm(uiDir, { recursive: true, force: true });
    closeDb();
  });

  // -------------------------------------------------------------------------
  // Baseline fixtures — the parity artifact for the assembly extraction.
  // -------------------------------------------------------------------------
  describe("baseline fixtures (pre-extraction parity artifact)", () => {
    it("api-only inventory matches the committed fixture", async () => {
      await pinBaseline(
        "apiOnly",
        { uiMode: false, plugins: [] },
        apiOnly,
      );
    });

    it("ui-installed inventory matches the committed fixture", async () => {
      await pinBaseline(
        "uiInstalled",
        { uiMode: true, plugins: [] },
        uiInstalled,
      );
    });

    it("fixture-plugin inventory matches the committed fixture", async () => {
      await pinBaseline(
        "fixturePlugin",
        { uiMode: true, plugins: [FIXTURE_PLUGIN_ID] },
        fixturePlugin,
      );
    });
  });

  // -------------------------------------------------------------------------
  // Hook installation — production-emitted, ordered, and behaviorally real.
  // -------------------------------------------------------------------------
  describe("hook installation (observed at the installing statement)", () => {
    it("emits the seven seam-installed hooks in registration order", () => {
      // Ordered production observations, identical across all three modes.
      expect(apiOnly.hookInstallations).toEqual([
        { surface: "root", hookKind: "onResponse", name: "api-version" },
        { surface: "root", hookKind: "onRequest", name: "audit-context" },
        { surface: "root", hookKind: "preHandler", name: "audit-enrichment" },
        { surface: "api-v1", hookKind: "preHandler", name: "per-agent-rate-limit" },
        { surface: "api-deprecated", hookKind: "preHandler", name: "per-agent-rate-limit" },
        { surface: "api-deprecated", hookKind: "onResponse", name: "deprecation-header" },
        { surface: "sse", hookKind: "preHandler", name: "per-agent-rate-limit" },
      ]);
      expect(uiInstalled.hookInstallations).toEqual(apiOnly.hookInstallations);
      expect(fixturePlugin.hookInstallations).toEqual(apiOnly.hookInstallations);
    });

    it("rate-limited scopes stamp X-RateLimit headers on every response", async () => {
      const v1 = await apiOnly.app.inject({ method: "GET", url: "/api/v1/habitats" });
      expect(v1.statusCode).toBe(401);
      expect(v1.headers["x-ratelimit-limit"], "/api/v1 rate-limit hook").toBeDefined();

      const deprecated = await apiOnly.app.inject({ method: "GET", url: "/api/habitats" });
      expect(deprecated.statusCode).toBe(401);
      expect(deprecated.headers["x-ratelimit-limit"], "/api rate-limit hook").toBeDefined();

      const realtime = await apiOnly.app.inject({ method: "GET", url: "/sse/habitats/h-1/stream" });
      expect(realtime.statusCode).toBe(401);
      expect(realtime.headers["x-ratelimit-limit"], "/sse rate-limit hook").toBeDefined();

      // Control: the root surface has no rate-limit hook.
      const health = await apiOnly.app.inject({ method: "GET", url: "/health" });
      expect(health.statusCode).toBe(200);
      expect(health.headers["x-ratelimit-limit"]).toBeUndefined();
    });

    it("root audit hooks establish and enrich request provenance", async () => {
      const plain = await auditProbe.app.inject({ method: "GET", url: "/__audit-probe__" });
      expect(plain.statusCode).toBe(200);
      expect(plain.json()).toMatchObject({
        source: "rest_api",
        method: "GET",
        route: "/__audit-probe__",
        requestId: expect.any(String),
      });

      const mcp = await auditProbe.app.inject({
        method: "GET",
        url: "/__audit-probe__",
        headers: {
          "x-orcy-audit-source": "mcp_tool",
          "x-agent-api-key": "any-nonempty-key",
          "x-orcy-mcp-tool": "charTool",
          "x-orcy-mcp-action": "charAction",
        },
      });
      expect(mcp.statusCode).toBe(200);
      expect(mcp.json()).toMatchObject({
        source: "mcp_tool",
        method: "GET",
        route: "/__audit-probe__",
        toolName: "charTool",
        mcpAction: "charAction",
      });
    });

    it("operational waypoint fires after local prefixes and before realtime", async () => {
      const observed = await buildObservedApp({
        waypoint: () => {
          /* ordering recorded by the harness itself */
        },
      });
      try {
        expect(observed.waypoint?.fired).toBe(true);
        const cut = observed.waypoint!.afterHookCount;
        const before = observed.hookInstallations.slice(0, cut);
        const after = observed.hookInstallations.slice(cut);
        // Every local-prefix hook precedes the waypoint (root hooks too).
        expect(before.some((h) => h.surface === "api-v1")).toBe(true);
        expect(before.some((h) => h.surface === "api-deprecated")).toBe(true);
        expect(before.every((h) => h.surface !== "sse")).toBe(true);
        // The realtime rate-limit hook (and nothing else) follows it.
        expect(after).toEqual([
          { surface: "sse", hookKind: "preHandler", name: "per-agent-rate-limit" },
        ]);
      } finally {
        await observed.app.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // Conditional-route honesty: fixture and UI routes exist only where the
  // production conditionals actually load them.
  // -------------------------------------------------------------------------
  describe("conditional routes", () => {
    it("UI static routes appear only in UI-installed mode and are labeled static", () => {
      const apiOnlyUi = apiOnly.records.filter((r) => r.surface === "ui-static");
      const uiUi = uiInstalled.records.filter((r) => r.surface === "ui-static");
      expect(apiOnlyUi).toEqual([]);
      expect(uiUi.length).toBeGreaterThan(0);
      for (const r of uiUi) {
        expect(r.source).toBe(r.generatedTwin ? "framework" : "static");
      }
    });

    it("fixture plugin route appears only in fixture-plugin mode", () => {
      expect(
        apiOnly.records.filter((r) => r.source === "plugin"),
      ).toEqual([]);
      const pluginRoutes = fixturePlugin.records.filter((r) => r.source === "plugin");
      expect(pluginRoutes.map(recordKey)).toEqual([`GET ${FIXTURE_PLUGIN_ROUTE}`]);
    });
  });

  // -------------------------------------------------------------------------
  // Deprecated-prefix parity, derived from the live records (not the fixture).
  // -------------------------------------------------------------------------
  describe("current/deprecated prefix parity", () => {
    function relativeKey(r: RouteRecord, surface: string): string {
      const prefix =
        surface === "api-v1" ? "/api/v1" : surface === "api-deprecated" ? "/api" : "";
      return `${r.method} ${r.path.slice(prefix.length)}`;
    }

    it("mirrors every (method, relativePath) across /api/v1 and /api", () => {
      const v1 = new Set(
        apiOnly.records.filter((r) => r.surface === "api-v1").map((r) => relativeKey(r, "api-v1")),
      );
      const deprecated = new Set(
        apiOnly.records
          .filter((r) => r.surface === "api-deprecated")
          .map((r) => relativeKey(r, "api-deprecated")),
      );
      expect(v1.size).toBeGreaterThan(0);
      expect([...v1].sort()).toEqual([...deprecated].sort());
    });

    it("keeps guard parity across the prefixes", () => {
      const v1ByRel = new Map(
        apiOnly.records
          .filter((r) => r.surface === "api-v1")
          .map((r) => [relativeKey(r, "api-v1"), r]),
      );
      for (const r of apiOnly.records.filter((r) => r.surface === "api-deprecated")) {
        const twin = v1ByRel.get(relativeKey(r, "api-deprecated"));
        expect(twin, `missing /api/v1 twin for ${r.path}`).toBeDefined();
        expect(r.guards, `guards for ${r.path}`).toEqual(twin!.guards);
        expect(r.authKind, `authKind for ${r.path}`).toEqual(twin!.authKind);
        expect(r.rawBodyEligible, `rawBodyEligible for ${r.path}`).toBe(twin!.rawBodyEligible);
      }
    });
  });

  // -------------------------------------------------------------------------
  // Verified ingress — every RAW_BODY_ROUTES family under both prefixes,
  // using each family's real credential model.
  //
  // Exact-byte dependence is made observable by signing payloads whose
  // whitespace JSON re-serialization would normalize: if raw-body capture is
  // removed, the route falls back to JSON.stringify(request.body), the bytes
  // change, and the valid signature stops matching.
  // -------------------------------------------------------------------------
  describe("verified ingress families (both prefixes, real credentials)", () => {
    const CR_GITHUB_SECRET = "char-cr-github-secret";
    const CR_GITLAB_TOKEN = "char-cr-gitlab-token";
    const CI_GITHUB_SECRET = "char-ci-github-secret";
    const CI_GITLAB_TOKEN = "char-ci-gitlab-token";
    const ISSUES_SECRET = "char-issues-secret";
    const SLACK_SECRET = "char-slack-signing-secret";

    let habitatId: string;
    let issuesConnectionId: string;
    let priorSlackSecret: string | undefined;
    let priorDiscordKey: string | undefined;
    // Ed25519 keypair matching the raw 32-byte public-key hex the production
    // verifier expects (SPKI DER's last 32 bytes = the raw key).
    const discordKeypair = crypto.generateKeyPairSync("ed25519");
    const discordPublicHex = discordKeypair.publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("hex");
    const discordSign = (bytes: string): { ts: string; sig: string } => {
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = crypto.sign(null, Buffer.from(ts + bytes), discordKeypair.privateKey);
      return { ts, sig: sig.toString("hex") };
    };

    // Spaced payloads: bytes differ from JSON.stringify(parsed).
    const CR_GITHUB_BYTES = '{"zen": "route characterization", "hook_id": 424242}';
    const CI_GITHUB_BYTES = '{"workflow_run": null, "char": "ci"}';
    const SLACK_BYTES = '{"text": "", "team_id": "T0001"}';
    const DISCORD_BYTES = '{"type": 1}';

    function spacedIssueBytes(nodeId: string, number: number): string {
      // Hand-written spaced JSON — the exact bytes the signature covers.
      return (
        `{"action": "opened", ` +
        `"issue": {"id": ${number}, "node_id": "${nodeId}", "number": ${number}, ` +
        `"title": "Char issue ${number}", "body": "characterization", "state": "open", ` +
        `"html_url": "https://github.com/char-owner/char-repo/issues/${number}", ` +
        `"labels": [], "user": {"login": "char-user"}, "updated_at": "2026-08-27T00:00:00Z"}, ` +
        `"repository": {"full_name": "char-owner/char-repo", "owner": {"login": "char-owner"}, "name": "char-repo"}}`
      );
    }

    function hmacSig(secret: string, bytes: string): string {
      return "sha256=" + crypto.createHmac("sha256", secret).update(bytes).digest("hex");
    }

    function slackSig(bytes: string): { ts: string; sig: string } {
      const ts = String(Math.floor(Date.now() / 1000));
      const base = `v0:${ts}:${bytes}`;
      return {
        ts,
        sig: "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(base).digest("hex"),
      };
    }

    beforeAll(async () => {
      // Habitat + all four provider-configurable secrets through the real
      // configuration seam (PUT /habitats/:id/webhook-secrets).
      const created = await apiOnly.app.inject({
        method: "POST",
        url: "/api/v1/habitats",
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: "Ingress Char Habitat", defaultColumns: true },
      });
      expect(created.statusCode).toBe(201);
      habitatId = (created.json() as { habitat: { id: string } }).habitat.id;

      for (const [provider, githubSecret, gitlabSecret] of [
        ["code_review", CR_GITHUB_SECRET, CR_GITLAB_TOKEN],
        ["ci_cd", CI_GITHUB_SECRET, CI_GITLAB_TOKEN],
      ] as const) {
        const put = await apiOnly.app.inject({
          method: "PUT",
          url: `/api/v1/habitats/${habitatId}/webhook-secrets`,
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { provider, githubSecret, gitlabSecret },
        });
        expect(put.statusCode).toBe(200);
      }
      rebuildHabitatSecretCache(); // the cache seam the code-review verifier reads

      // GitHub-issues connection: the per-connection secret store that
      // family's verifier iterates.
      const connection = connectionRepo.create({
        habitatId,
        provider: "github",
        name: "char-issues-connection",
        authMethod: "pat",
        repositoryOwner: "char-owner",
        repositoryName: "char-repo",
        autoImport: true,
        enabled: true,
        webhookSecret: ISSUES_SECRET,
        createdBy: "characterization",
      });
      issuesConnectionId = connection.id;

      // Slack + Discord credentials are environment-configured.
      priorSlackSecret = process.env.SLACK_SIGNING_SECRET;
      priorDiscordKey = process.env.DISCORD_PUBLIC_KEY;
      process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
      process.env.DISCORD_PUBLIC_KEY = discordPublicHex;
    });

    afterAll(() => {
      if (priorSlackSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
      else process.env.SLACK_SIGNING_SECRET = priorSlackSecret;
      if (priorDiscordKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
      else process.env.DISCORD_PUBLIC_KEY = priorDiscordKey;
    });

    for (const prefix of ["/api/v1", "/api"]) {
      // ---- HMAC families: exact-byte acceptance + altered-byte rejection ----

      it(`code-review GitHub: valid exact bytes accepted under ${prefix}`, async () => {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/github`,
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-hub-signature-256": hmacSig(CR_GITHUB_SECRET, CR_GITHUB_BYTES),
          },
          payload: CR_GITHUB_BYTES,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: "ignored", event: "ping" });
      });

      it(`code-review GitHub: altered bytes rejected under ${prefix}`, async () => {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/github`,
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-hub-signature-256": hmacSig(CR_GITHUB_SECRET, CR_GITHUB_BYTES + " "),
          },
          payload: CR_GITHUB_BYTES,
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid or missing signature" });
      });

      it(`CI GitHub: valid exact bytes accepted under ${prefix}`, async () => {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/github-ci`,
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-hub-signature-256": hmacSig(CI_GITHUB_SECRET, CI_GITHUB_BYTES),
          },
          payload: CI_GITHUB_BYTES,
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: "ignored", event: "ping" });
      });

      it(`CI GitHub: altered bytes rejected under ${prefix}`, async () => {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/github-ci`,
          headers: {
            "content-type": "application/json",
            "x-github-event": "ping",
            "x-hub-signature-256": hmacSig(CI_GITHUB_SECRET, CI_GITHUB_BYTES + " "),
          },
          payload: CI_GITHUB_BYTES,
        });
        expect(res.statusCode).toBe(401);
      });

      it(`Slack command: valid v0 exact-byte signature accepted under ${prefix}`, async () => {
        // application/json keeps the probe on the same parser path the other
        // families use; the credential input under test is rawBody either way.
        const { ts, sig } = slackSig(SLACK_BYTES);
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/chat/slack/command`,
          headers: {
            "content-type": "application/json",
            "x-slack-signature": sig,
            "x-slack-request-timestamp": ts,
          },
          payload: SLACK_BYTES,
        });
        expect(res.statusCode, res.body).toBe(200);
      });

      it(`Slack command: altered bytes rejected under ${prefix}`, async () => {
        const { ts, sig } = slackSig(SLACK_BYTES + " ");
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/chat/slack/command`,
          headers: {
            "content-type": "application/json",
            "x-slack-signature": sig,
            "x-slack-request-timestamp": ts,
          },
          payload: SLACK_BYTES,
        });
        expect(res.statusCode).toBe(401);
      });

      it(`Slack command: validly signed form-encoded traffic 500s under ${prefix} (recorded)`, async () => {
        // Slack's actual wire format. The signature verifies (exact bytes),
        // but no formbody parser is registered, so the route cannot complete.
        // Pinned as-deployed for the owning ticket.
        const body = "text=hi&team_id=T0001";
        const ts = String(Math.floor(Date.now() / 1000));
        const sig =
          "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${body}`).digest("hex");
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/chat/slack/command`,
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-slack-signature": sig,
            "x-slack-request-timestamp": ts,
          },
          payload: body,
        });
        expect(res.statusCode).toBe(500);
      });

      it(`Discord interaction: correctly signed request is STILL rejected under ${prefix} (inert verifier)`, async () => {
        // tweetnacl is absent from the dependency graph, so
        // verifyDiscordSignature cannot accept anything: a mathematically
        // correct Ed25519 signature over the exact bytes is rejected with
        // 401 when a public key is configured. Pinned as-deployed; if the
        // verifier is ever repaired, this probe flips and forces a conscious
        // fixture/behavior update.
        const { ts, sig } = discordSign(DISCORD_BYTES);
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/chat/discord/interaction`,
          headers: {
            "content-type": "application/json",
            "x-signature-ed25519": sig,
            "x-signature-timestamp": ts,
          },
          payload: DISCORD_BYTES,
        });
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
      });

      it(`Discord interaction: without a configured key the request passes unverified under ${prefix}`, async () => {
        const restore = process.env.DISCORD_PUBLIC_KEY;
        delete process.env.DISCORD_PUBLIC_KEY;
        try {
          const res = await apiOnly.app.inject({
            method: "POST",
            url: `${prefix}/chat/discord/interaction`,
            headers: { "content-type": "application/json" },
            payload: DISCORD_BYTES,
          });
          expect(res.statusCode).toBe(200);
          expect(res.json()).toEqual({ type: 1 });
        } finally {
          process.env.DISCORD_PUBLIC_KEY = restore;
        }
      });

      it(`GitHub issues: valid exact bytes create the mission link under ${prefix}`, async () => {
        const nodeId = `char-node-${prefix === "/api/v1" ? "v1" : "dep"}`;
        const bytes = spacedIssueBytes(nodeId, prefix === "/api/v1" ? 101 : 102);
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/github/issues`,
          headers: {
            "content-type": "application/json",
            "x-github-event": "issues",
            "x-hub-signature-256": hmacSig(ISSUES_SECRET, bytes),
          },
          payload: bytes,
        });
        expect(res.statusCode).toBe(200);
        expect(res.body).toBe("OK");
        const link = externalIssueLinkRepo.findByConnectionAndExternalId(
          issuesConnectionId,
          nodeId,
        );
        expect(link, "valid signature must sync the issue").toBeDefined();
      });

      it(`GitHub issues: altered bytes skip the connection (no link) under ${prefix}`, async () => {
        const nodeId = `char-node-bad-${prefix === "/api/v1" ? "v1" : "dep"}`;
        const bytes = spacedIssueBytes(nodeId, prefix === "/api/v1" ? 201 : 202);
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/github/issues`,
          headers: {
            "content-type": "application/json",
            "x-github-event": "issues",
            "x-hub-signature-256": hmacSig(ISSUES_SECRET, bytes + " "),
          },
          payload: bytes,
        });
        expect(res.statusCode).toBe(200); // fail-soft: skipped, still acknowledged
        const link = externalIssueLinkRepo.findByConnectionAndExternalId(
          issuesConnectionId,
          nodeId,
        );
        expect(link, "invalid signature must not sync").toBeUndefined();
      });

      // ---- Token families: raw body captured but NOT credential-bearing ----

      it(`code-review GitLab: valid token accepted under ${prefix}`, async () => {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/gitlab`,
          headers: { "content-type": "application/json", "x-gitlab-token": CR_GITLAB_TOKEN },
          payload: { object_kind: "char" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: "ignored", objectKind: "char" });
      });

      it(`code-review GitLab: invalid token rejected under ${prefix}`, async () => {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/gitlab`,
          headers: { "content-type": "application/json", "x-gitlab-token": "wrong-token" },
          payload: { object_kind: "char" },
        });
        expect(res.statusCode).toBe(401);
        expect(res.json()).toEqual({ error: "Invalid or missing token" });
      });

      it(`CI GitLab: valid token accepted under ${prefix}`, async () => {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/gitlab-ci`,
          headers: { "content-type": "application/json", "x-gitlab-token": CI_GITLAB_TOKEN },
          payload: { object_kind: "char" },
        });
        expect(res.statusCode).toBe(200);
        expect(res.json()).toEqual({ status: "ignored", objectKind: "char" });
      });

      it(`CI GitLab: invalid token rejected under ${prefix}`, async () => {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/webhooks/gitlab-ci`,
          headers: { "content-type": "application/json", "x-gitlab-token": "wrong-token" },
          payload: { object_kind: "char" },
        });
        expect(res.statusCode).toBe(401);
      });
    }
  });

  // -------------------------------------------------------------------------
  // Representative injected requests across every surface (current behavior).
  // -------------------------------------------------------------------------
  describe("representative request probes", () => {
    it("health responds unauthenticated", async () => {
      const res = await apiOnly.app.inject({ method: "GET", url: "/health" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ status: "ok" });
    });

    it("root redirects to the SPA", async () => {
      const res = await apiOnly.app.inject({ method: "GET", url: "/" });
      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe("/app/");
    });

    it("API-only mode serves no UI route", async () => {
      const res = await apiOnly.app.inject({ method: "GET", url: "/app/" });
      expect(res.statusCode).toBe(404);
    });

    it("UI-installed mode serves the SPA index", async () => {
      const res = await uiInstalled.app.inject({ method: "GET", url: "/app/" });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain("char-ui");
    });

    it("local API requires authentication and serves with a valid human token", async () => {
      const anon = await apiOnly.app.inject({ method: "GET", url: "/api/v1/habitats" });
      expect(anon.statusCode).toBe(401);
      const authed = await apiOnly.app.inject({
        method: "GET",
        url: "/api/v1/habitats",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(authed.statusCode).toBe(200);
    });

    it("deprecated /api prefix parity: the Deprecation header never reaches the wire (pre-existing)", async () => {
      // The deprecated group installs an onResponse hook stamping
      // `Deprecation: true`, but Fastify sends the response before onResponse
      // runs, so the header is absent on BOTH prefixes today. Recorded as a
      // behavior note for the owning ticket — not fixed here.
      const deprecated = await apiOnly.app.inject({ method: "GET", url: "/api/habitats" });
      expect(deprecated.statusCode).toBe(401);
      expect(deprecated.headers.deprecation).toBeUndefined();
      const current = await apiOnly.app.inject({ method: "GET", url: "/api/v1/habitats" });
      expect(current.statusCode).toBe(401);
      expect(current.headers.deprecation).toBeUndefined();
    });

    it("X-API-Version never reaches the wire either (same pre-existing onResponse defect)", async () => {
      for (const prefix of ["/api/v1", "/api"]) {
        const res = await apiOnly.app.inject({ method: "GET", url: `${prefix}/habitats` });
        expect(res.statusCode).toBe(401);
        expect(res.headers["x-api-version"]).toBeUndefined();
      }
    });

    it("realtime SSE stream rejects unauthenticated connections", async () => {
      const res = await apiOnly.app.inject({
        method: "GET",
        url: "/sse/habitats/h-1/stream",
      });
      expect(res.statusCode).toBe(401);
    });

    it("presence join rejects unauthenticated requests (containment baseline)", async () => {
      const res = await apiOnly.app.inject({
        method: "POST",
        url: "/sse/presence/join",
        payload: { sessionId: "s-1", habitatId: "h-1" },
      });
      expect(res.statusCode).toBe(401);
    });

    it("remote participant API rejects requests without a remote key", async () => {
      const res = await apiOnly.app.inject({ method: "GET", url: "/api/shared/me" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "MISSING_REMOTE_KEY" });
    });

    it("manual invite preview rejects a missing invite token", async () => {
      const res = await apiOnly.app.inject({
        method: "POST",
        url: "/api/v1/shared/invites/preview",
      });
      expect(res.statusCode).toBe(400);
      // The error envelope maps 400s to VALIDATION_ERROR with the route's
      // specific code carried in `details` — the observed wire truth.
      expect(res.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        details: "INVALID_INVITE_TOKEN",
      });
    });

    it("plugin listing requires local-actor auth (the public-regex exception was inference-only)", async () => {
      const anon = await apiOnly.app.inject({ method: "GET", url: "/api/v1/plugins" });
      expect(anon.statusCode).toBe(401);
      const authed = await apiOnly.app.inject({
        method: "GET",
        url: "/api/v1/plugins",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(authed.statusCode).toBe(200);
    });

    it("fixture plugin route serves unauthenticated today (pre-ADR-0050 truth)", async () => {
      const res = await fixturePlugin.app.inject({ method: "GET", url: FIXTURE_PLUGIN_ROUTE });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ fixture: true });
    });
  });

  // -------------------------------------------------------------------------
  // HEAD/OPTIONS normalization honesty.
  // -------------------------------------------------------------------------
  describe("framework-generated twins", () => {
    it("marks HEAD twins as generated only when a GET twin exists", () => {
      const heads = apiOnly.records.filter((r) => r.method === "HEAD");
      expect(heads.length).toBeGreaterThan(0);
      for (const h of heads) {
        if (h.generatedTwin) {
          expect(apiOnly.records.some((r) => r.method === "GET" && r.path === h.path)).toBe(true);
        }
      }
    });

    it("exposes any first-class HEAD or OPTIONS route for review", () => {
      const firstClass = apiOnly.records.filter(
        (r) => (r.method === "HEAD" || r.method === "OPTIONS") && !r.generatedTwin,
      );
      // Not an exception list — an observation. Today there are none; any that
      // appear will show up in the fixture diff and must be reviewed.
      expect(firstClass.map(recordKey)).toEqual([]);
    });
  });
});

/** Pins one mode's baseline: regenerate on UPDATE, byte-compare otherwise. */
async function pinBaseline(
  name: string,
  meta: { uiMode: boolean; plugins: string[] },
  observed: ObservedApp,
): Promise<void> {
  const full: BaselineFixture = {
    ...meta,
    hookInstallations: observed.hookInstallations,
    behaviorNotes: BEHAVIOR_NOTES,
    routes: observed.records,
  };
  const fixture = await loadFixture(name);
  if (UPDATE_BASELINE) {
    await writeFixture(name, full);
    return;
  }
  expect(full.uiMode, `${name}: uiMode`).toBe(fixture.uiMode);
  expect(full.plugins, `${name}: plugins`).toEqual(fixture.plugins);
  expect(
    full.hookInstallations,
    `${name}: hookInstallations (observed) vs fixture`,
  ).toEqual(fixture.hookInstallations);
  expect(full.behaviorNotes, `${name}: behaviorNotes`).toEqual(fixture.behaviorNotes);
  assertMatchesFixture(name, fixture, observed.records);
}
