/**
 * Production router characterization (pre-extraction baseline).
 *
 * Captures the exact post-containment HTTP surface through the SAME
 * staged assembly the executable boots from — `createHttpApplication` in
 * `src/httpApp.ts`. There is no copied module list
 * here: a route added through the normal production seam changes the observed
 * inventory and fails the fixture comparison automatically (the sentinel
 * discriminator — proven by mutate/revert, see the ticket report).
 *
 * Hook parity is OBSERVED, not described: the assembly emits one
 * `HookInstallationRecord` at the exact statement that installs each root or
 * scoped hook (per-registration `onHookInstalled` option), and the fixtures
 * pin that production-emitted stream. Behavioral discriminators additionally
 * prove the hooks work: rate-limit headers on all three rate-limited scopes,
 * an audit provenance probe route reading what the root audit hooks
 * established, and Remote Participant key rejection.
 *
 * Every verified-ingress family is exercised under BOTH prefixes with its
 * real credential model: HMAC families (code-review GitHub, CI GitHub,
 * GitHub issues, Slack v0, Discord Ed25519) prove exact-byte acceptance and
 * altered-byte rejection; GitLab token families (code review + CI) prove
 * valid-token acceptance and invalid-token rejection — their raw body is
 * captured but not credential-bearing, and is recorded as such rather than
 * inventing a signature claim. Raw-body eligibility and the verifier guards
 * both derive from the policy declarations in `authPolicy.ts` (one
 * declaration, no copied path list). The Discord Ed25519 verifier was
 * repaired by the auth-policy ticket (then an ESM-safe tweetnacl import +
 * runtime dependency; Node's native Ed25519 crypto now): correctly signed
 * requests verify, and the policy readiness self-probe fails assembly if
 * the verifier ever regresses.
 *
 * Three modes are pinned against committed fixtures under
 * `src/test/fixtures/routeBaseline/`:
 *   - api-only       no UI directory, no plugins
 *   - ui-installed   ORCY_UI_PATH points at a directory holding index.html
 *   - fixture-plugin one fixture System Plugin registered through the real
 *                    `runPluginBoot` (loadPlugins → staged install → hooks)
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
  createHttpApplication,
  RAW_BODY_ROUTES,
  type HttpRuntimeHandle,
  type HookInstallationRecord,
} from "../httpApp.js";
import { formatEffectivePolicy } from "../authPolicy.js";
import { runPluginBoot } from "../plugins/pluginBoot.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { closeDb, initTestDb } from "../db/index.js";
import { rebuildCache as rebuildHabitatSecretCache } from "../services/habitatSecretCache.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as connectionRepo from "../repositories/integrationConnection.js";
import * as externalIssueLinkRepo from "../repositories/externalIssueLink.js";

const JWT_SECRET = "dev-secret-change-in-production";
const FIXTURE_DIR = path.join(import.meta.dirname, "fixtures", "routeBaseline");
const UPDATE_BASELINE = process.env.UPDATE_ROUTE_BASELINE === "1";

/**
 * Effective authentication policy is derived from the SAME declaration that
 * installs the runtime guard (typed `config.authPolicy`, resolved through the
 * policy module's resolver): one declaration, one classification, surfaced by
 * the assembly-derived inventory. There is no fallback classification — a
 * route that reaches the inventory with no effective policy renders as
 * `MISSING_POLICY`, and the installer's readiness hook has already rejected
 * the application before it could serve.
 */
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

interface ObservedApp {
  app: HttpRuntimeHandle;
  records: RouteRecord[];
  hookInstallations: HookInstallationRecord[];
  waypoint?: { fired: boolean; afterHookCount: number };
}

/**
 * Builds the production application through the SAME staged assembly the
 * executable boots from (`createHttpApplication`) and renders its derived
 * route inventory. `withPlugins` runs the REAL production plugin boot
 * (`runPluginBoot`) so plugin-stage routes are attributed
 * `source: "plugin"`; `waypoint` wraps the assembly's operational
 * interposition slot so the boot ordering can be pinned; `auditProbeRoute`
 * asks the assembly for its finalize-time observation route (outside the
 * inventory by construction).
 */
async function buildObservedApp(options: {
  logger?: boolean;
  withPlugins?: boolean;
  waypoint?: () => void;
  auditProbeRoute?: boolean;
}): Promise<ObservedApp> {
  const hookInstallations: HookInstallationRecord[] = [];
  const waypoint: ObservedApp["waypoint"] = { fired: false, afterHookCount: -1 };

  const app = await createHttpApplication({
    logger: options.logger ?? false,
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
    auditProbeRoute: options.auditProbeRoute,
  });

  if (options.withPlugins) {
    // Real production plugin boot: discovery, staged installation, detector
    // hooks — nothing test-local.
    await runPluginBoot(app);
  } else {
    // No discovery cycle ran: install the (empty) validated catalog
    // explicitly — installation is required and exactly once.
    await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  }

  await app.finalize();

  const records: RouteRecord[] = app.routeInventory().map((entry) => ({
    method: entry.method,
    path: entry.url,
    surface: classifySurface(entry.url),
    guards: entry.guards,
    authKind:
      entry.effectivePolicy === null
        ? "MISSING_POLICY"
        : formatEffectivePolicy(entry.effectivePolicy),
    rawBodyEligible: entry.rawBodyEligible,
    source: entry.source,
    generatedTwin: entry.generatedTwin,
  }));

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
  "X-API-Version and Deprecation headers were historically set inside " +
    "onResponse hooks — after Fastify had already sent the response, so " +
    "neither header reached clients on any prefix. The assembly extraction " +
    "corrected this at the owning seam: both headers are now installed at " +
    "onSend and wire-visible; Deprecation is scoped to the deprecated /api " +
    "group (and the deprecated plugin mirror) only.",
  "GET /plugins is declared local_actor auth policy (guard installed by " +
    "the policy registry). The pre-policy public-regex exception and the " +
    "name-inference classifier that carried it are deleted; there is no " +
    "public/unauthenticated classification besides an explicit anonymous " +
    "declaration.",
  "The Discord Ed25519 verifier was structurally inert for two stacked " +
    "reasons (unbound CommonJS require('tweetnacl') in compiled ESM, plus " +
    "tweetnacl absent from the dependency graph), rejecting every signature " +
    "when a key was configured. The auth-policy ticket repaired BOTH causes " +
    "as an explicit characterized-defect correction (tweetnacl then; Node's " +
    "native Ed25519 crypto now): correctly signed interactions verify under " +
    "both prefixes, the configured-key / missing-key posture matrix and " +
    "invalid-request response shape are unchanged, and the policy readiness " +
    "self-probe fails assembly if the verifier ever regresses to inert.",
  "Slack slash-command traffic is form-encoded on the real wire, but the " +
    "app historically registered no urlencoded parser, so a validly signed " +
    "application/x-www-form-urlencoded request returned 500 (only JSON " +
    "bodies completed). The ingress ticket resolved deferred item RA-1: a " +
    "route-scoped parser (nested Fastify scope around /chat/slack/command " +
    "only — WHATWG plus/percent decoding, last-wins duplicate keys, " +
    "null-prototype string fields) now completes correctly signed form " +
    "commands under both prefixes, altered form bytes still verify-reject, " +
    "and no other route's content-type handling changed. Exact-byte " +
    "verification still runs on the fastify-raw-body capture, unchanged.",
];

// ---------------------------------------------------------------------------
// Fixture System Plugin — registered through the real plugin discovery seams
// (setPluginDirectory → loadPlugins → staged install), never a test-local
// route registration. Mirrors the ADR-0050 contract: a manifest-declared
// route (stable routeId, method, plugin-relative path) with a keyed request
// handler; core mounts it under both plugin namespaces with fixed
// local_actor policy. The plugin author never sees Fastify.
// ---------------------------------------------------------------------------
const FIXTURE_PLUGIN_ID = "char-fixture";
const FIXTURE_PLUGIN_ROUTE_ID = "status";

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
      { kind: 'customHttpRoute', scope: 'system', routeId: '${FIXTURE_PLUGIN_ROUTE_ID}', method: 'GET', path: '/status', requires: [] },
    ],
  },
  httpHandlers: {
    '${FIXTURE_PLUGIN_ROUTE_ID}': async (request) => ({ status: 200, body: { fixture: true, actorType: request.actor?.type ?? null } }),
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
      // The two header hooks install at onSend — the assembly's correction of
      // the characterized onResponse defect (headers now reach the wire).
      expect(apiOnly.hookInstallations).toEqual([
        { surface: "root", hookKind: "onSend", name: "api-version" },
        { surface: "root", hookKind: "onRequest", name: "audit-context" },
        { surface: "root", hookKind: "preHandler", name: "audit-enrichment" },
        { surface: "api-v1", hookKind: "preHandler", name: "per-agent-rate-limit" },
        { surface: "api-deprecated", hookKind: "preHandler", name: "per-agent-rate-limit" },
        { surface: "api-deprecated", hookKind: "onSend", name: "deprecation-header" },
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

    it("fixture plugin routes appear only in fixture-plugin mode, under both namespaces", () => {
      expect(
        apiOnly.records.filter((r) => r.source === "plugin"),
      ).toEqual([]);
      const pluginRoutes = fixturePlugin.records.filter((r) => r.source === "plugin");
      // Core mounts the validated catalog under both the current and the
      // deprecated plugin namespace (ADR-0050) — two records, one declaration.
      expect(pluginRoutes.map(recordKey)).toEqual([
        `GET /api/plugins/${FIXTURE_PLUGIN_ID}/status`,
        `GET /api/v1/plugins/${FIXTURE_PLUGIN_ID}/status`,
      ]);
      for (const r of pluginRoutes) {
        expect(r.authKind, `${r.path} policy`).toBe("local_actor");
      }
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

      // ---- Slack form-encoded wire format (RA-1 resolved) ----
      // Slack's actual wire format. Each probe is signed over its exact
      // bytes; the response body proves the DECODED text reached the
      // command handler (help and unknown-command responses embed the
      // parsed action, so an undecoded or unparsed body cannot produce
      // them).

      it(`Slack command: correctly signed form-encoded command completes under ${prefix}`, async () => {
        const body = "text=help&team_id=T0001&user_id=U0001";
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
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json(), "decoded text=help must reach the command handler").toMatchObject({
          text: "Available commands",
        });
      });

      it(`Slack command: charset-parameter form content-type completes under ${prefix}`, async () => {
        // `application/x-www-form-urlencoded; charset=utf-8` is the same
        // media type to the parser (Fastify matches the bare media type once
        // parameters are stripped) — Slack SDKs commonly send the parameter.
        // The signature still covers the exact payload bytes; the decoded
        // text must reach the command handler under the parametered header.
        const body = "text=help&team_id=T0001&user_id=U0001";
        const ts = String(Math.floor(Date.now() / 1000));
        const sig =
          "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${body}`).digest("hex");
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/chat/slack/command`,
          headers: {
            "content-type": "application/x-www-form-urlencoded; charset=utf-8",
            "x-slack-signature": sig,
            "x-slack-request-timestamp": ts,
          },
          payload: body,
        });
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json(), "decoded text=help must reach the command handler").toMatchObject({
          text: "Available commands",
        });
      });

      it(`Slack command: form percent-decoding reaches the command handler under ${prefix}`, async () => {
        // %75 decodes to "u": the action must arrive as "unknowncmd", not
        // the raw "%75nknowncmd" — the unknown-command response echoes the
        // parsed action, so the body discriminates decoded from undecoded.
        const body = "text=%75nknowncmd&team_id=T0001";
        const ts = String(Math.floor(Date.now() / 1000));
        const sig =
          "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${body}`).digest("hex");
        const restore = process.env.ORCY_DEFAULT_HABITAT_ID;
        process.env.ORCY_DEFAULT_HABITAT_ID = habitatId;
        try {
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
          expect(res.statusCode, res.body).toBe(200);
          expect(res.json().text).toBe(
            "Unknown command: unknowncmd. Type /orcy help for available commands.",
          );
        } finally {
          if (restore === undefined) delete process.env.ORCY_DEFAULT_HABITAT_ID;
          else process.env.ORCY_DEFAULT_HABITAT_ID = restore;
        }
      });

      it(`Slack command: form plus-decoding reaches the command handler under ${prefix}`, async () => {
        // "+" decodes to a space: "help me" parses to the help action. With
        // plus decoding broken the action is "help+me" and the response
        // becomes the unknown-command echo instead.
        const body = "text=help+me&team_id=T0001";
        const ts = String(Math.floor(Date.now() / 1000));
        const sig =
          "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${body}`).digest("hex");
        const restore = process.env.ORCY_DEFAULT_HABITAT_ID;
        process.env.ORCY_DEFAULT_HABITAT_ID = habitatId;
        try {
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
          expect(res.statusCode, res.body).toBe(200);
          expect(res.json(), "decoded 'help me' must parse to the help action").toMatchObject({
            text: "Available commands",
          });
        } finally {
          if (restore === undefined) delete process.env.ORCY_DEFAULT_HABITAT_ID;
          else process.env.ORCY_DEFAULT_HABITAT_ID = restore;
        }
      });

      it(`Slack command: duplicate form fields resolve last-wins under ${prefix}`, async () => {
        // The deliberate duplicate-key rule: LAST value wins, as a plain
        // string. An array value would crash the handler (no .trim) and
        // first-wins would answer the unknown-command echo instead.
        const body = "text=unknowncmd&text=help&team_id=T0001";
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
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json(), "the LAST text field (help) must win").toMatchObject({
          text: "Available commands",
        });
      });

      it(`Slack command: signature over different form bytes rejected under ${prefix}`, async () => {
        const body = "text=help&team_id=T0001&user_id=U0001";
        const ts = String(Math.floor(Date.now() / 1000));
        const sig =
          "v0=" +
          crypto
            .createHmac("sha256", SLACK_SECRET)
            .update(`v0:${ts}:${body} `)
            .digest("hex");
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
        expect(res.statusCode, res.body).toBe(401);
        expect(res.json()).toMatchObject({ code: "UNAUTHORIZED" });
      });

      it(`Discord interaction: correctly signed request is accepted under ${prefix} (repaired verifier)`, async () => {
        // The defect correction: the verifier (tweetnacl then, Node's native
        // Ed25519 crypto now) verifies a mathematically correct signature
        // over the exact bytes. The pre-repair baseline pinned this same
        // probe at 401 (structurally inert verifier); the policy readiness
        // self-probe makes any regression a boot failure instead of a
        // silent 401-everything.
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
        expect(res.statusCode, res.body).toBe(200);
        expect(res.json()).toEqual({ type: 1 });
      });

      it(`Discord interaction: bad signature rejected under ${prefix}`, async () => {
        const ts = String(Math.floor(Date.now() / 1000));
        const wrongKey = crypto.generateKeyPairSync("ed25519");
        const sig = crypto
          .sign(null, Buffer.from(ts + DISCORD_BYTES), wrongKey.privateKey)
          .toString("hex");
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

    it("the form parser is route-scoped: form-encoded traffic to other routes still fails content parsing under both prefixes", async () => {
      // Fastify encapsulation confines the urlencoded parser to the nested
      // scope holding /chat/slack/command. A form-encoded request anywhere
      // else — under EITHER prefix — must keep hitting the
      // unsupported-media-type fallthrough (the same generic 500 the Slack
      // route answered before RA-1), proving no global content-type behavior
      // changed and neither prefix mirror smuggled the parser out of scope.
      for (const prefix of ["/api/v1", "/api"]) {
        const res = await apiOnly.app.inject({
          method: "POST",
          url: `${prefix}/habitats`,
          headers: { "content-type": "application/x-www-form-urlencoded" },
          payload: "name=not-a-json-habitat",
        });
        expect(res.statusCode, `${prefix} form post: status`).toBe(500);
        expect(res.json(), `${prefix} form post: body`).toMatchObject({
          code: "INTERNAL_ERROR",
        });
      }
    });
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

    it("deprecated /api prefix: the Deprecation header is wire-visible, scoped only to /api", async () => {
      // The assembly corrected the characterized onResponse defect at the
      // owning seam: the deprecated group stamps `Deprecation: true` at
      // onSend, so it reaches clients — and ONLY the deprecated group does.
      const deprecated = await apiOnly.app.inject({ method: "GET", url: "/api/habitats" });
      expect(deprecated.statusCode).toBe(401);
      expect(deprecated.headers.deprecation).toBe("true");
      const current = await apiOnly.app.inject({ method: "GET", url: "/api/v1/habitats" });
      expect(current.statusCode).toBe(401);
      expect(current.headers.deprecation).toBeUndefined();
      // The Remote Participant scope (/api/shared) must not leak the
      // deprecated-prefix header.
      const shared = await apiOnly.app.inject({ method: "GET", url: "/api/shared/me" });
      expect(shared.statusCode).toBe(401);
      expect(shared.headers.deprecation).toBeUndefined();
    });

    it("X-API-Version is wire-visible on its API surface (onSend correction)", async () => {
      for (const prefix of ["/api/v1", "/api"]) {
        const res = await apiOnly.app.inject({ method: "GET", url: `${prefix}/habitats` });
        expect(res.statusCode).toBe(401);
        expect(res.headers["x-api-version"]).toBe("1");
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

    it("fixture plugin route requires local-actor auth under both namespaces (ADR-0050 truth)", async () => {
      // The superseded seam mounted an anonymous root route; the declared
      // seam installs fixed local_actor policy under both plugin namespaces.
      for (const prefix of ["/api/v1", "/api"]) {
        const anon = await fixturePlugin.app.inject({
          method: "GET",
          url: `${prefix}/plugins/${FIXTURE_PLUGIN_ID}/status`,
        });
        expect(anon.statusCode, `${prefix} anonymous`).toBe(401);

        const authed = await fixturePlugin.app.inject({
          method: "GET",
          url: `${prefix}/plugins/${FIXTURE_PLUGIN_ID}/status`,
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(authed.statusCode, `${prefix} authenticated`).toBe(200);
        expect(authed.json()).toEqual({ fixture: true, actorType: "human" });
        expect(authed.headers.deprecation, `${prefix} deprecation header`).toBe(
          prefix === "/api" ? "true" : undefined,
        );
      }
    });
  });

  // -------------------------------------------------------------------------
  // HEAD/OPTIONS normalization honesty.
  // -------------------------------------------------------------------------
  describe("raw-body eligibility follows the declared verifier", () => {
    it("the capture list equals the verified-ingress-classified route set", () => {
      const classified = new Set(
        apiOnly.records.filter((r) => r.rawBodyEligible).map((r) => r.path),
      );
      expect(classified).toEqual(new Set(RAW_BODY_ROUTES as readonly string[]));
    });
  });

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
