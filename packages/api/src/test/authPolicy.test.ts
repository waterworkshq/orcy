/**
 * Focused auth-policy suites (ADR-0049): registry, root installer, scope
 * inheritance, verified-ingress verifiers, readiness self-probes, and the
 * observed inventory.
 *
 * The seam-constructed app (createHttpApp + registerHttpSurface) exercises
 * the production path: the root installer validates declarations, runs the
 * verifier readiness probes, and installs guards. A separate bare instance
 * proves the plugin-level applier keeps enforcement for plugins registered
 * outside the seam (no double installation on seam instances).
 *
 * Route-level response parity for every verified-ingress family under both
 * prefixes is pinned by the route-surface characterization suite; this file
 * pins the policy MECHANISM and the posture-matrix branches that
 * characterization (local posture) cannot reach.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { createHttpApp, registerHttpSurface, type HttpApp } from "../httpApp.js";
import {
  type AuthPolicy,
  AUTH_POLICY_IDS,
  CORE_VERIFIER_IDS,
  authPolicyClassifications,
  formatEffectivePolicy,
  inheritAuthPolicy,
  installAuthPolicy,
  policyGuardFor,
  probeVerifierPair,
  resolveEffectiveAuthPolicy,
  verifiedIngressRoutePaths,
} from "../authPolicy.js";
import { authRoutes } from "../routes/auth.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { createManualInvite } from "../services/remoteInviteService.js";
import { initTestDb, closeDb } from "../db/index.js";

const JWT_SECRET = "auth-policy-test-secret";
const SLACK_SECRET = "auth-policy-slack-secret";

let app: HttpApp;
let adminToken: string;
let priorSlackSecret: string | undefined;
let priorDiscordKey: string | undefined;
let priorRegistrationToken: string | undefined;
let priorHost: string | undefined;

// Ed25519 keypair for Discord probes; the verifier wants the raw 32-byte key.
const discordKeypair = crypto.generateKeyPairSync("ed25519");
const discordPublicHex = discordKeypair.publicKey
  .export({ type: "spki", format: "der" })
  .subarray(-32)
  .toString("hex");
function discordSign(bytes: string): { ts: string; sig: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.sign(null, Buffer.from(ts + bytes), discordKeypair.privateKey);
  return { ts, sig: sig.toString("hex") };
}

function slackSign(bytes: string): { ts: string; sig: string } {
  const ts = String(Math.floor(Date.now() / 1000));
  return {
    ts,
    sig: "v0=" + crypto.createHmac("sha256", SLACK_SECRET).update(`v0:${ts}:${bytes}`).digest("hex"),
  };
}

describe("auth policy registry and installer", () => {
  beforeAll(async () => {
    await initTestDb();
    setJwtSecret(JWT_SECRET);
    adminToken = jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
      issuer: "orcy",
    });

    priorSlackSecret = process.env.SLACK_SIGNING_SECRET;
    priorDiscordKey = process.env.DISCORD_PUBLIC_KEY;
    priorRegistrationToken = process.env.ORCY_REGISTRATION_TOKEN;
    priorHost = process.env.HOST;
    process.env.SLACK_SIGNING_SECRET = SLACK_SECRET;
    process.env.DISCORD_PUBLIC_KEY = discordPublicHex;
    process.env.ORCY_REGISTRATION_TOKEN = "reg-token-1";
    delete process.env.HOST; // 127.0.0.1 default → local-dev posture

    app = createHttpApp(false);
    await registerHttpSurface(app);
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    closeDb();
    if (priorSlackSecret === undefined) delete process.env.SLACK_SIGNING_SECRET;
    else process.env.SLACK_SIGNING_SECRET = priorSlackSecret;
    if (priorDiscordKey === undefined) delete process.env.DISCORD_PUBLIC_KEY;
    else process.env.DISCORD_PUBLIC_KEY = priorDiscordKey;
    if (priorRegistrationToken === undefined) delete process.env.ORCY_REGISTRATION_TOKEN;
    else process.env.ORCY_REGISTRATION_TOKEN = priorRegistrationToken;
    if (priorHost === undefined) delete process.env.HOST;
    else process.env.HOST = priorHost;
  });

  describe("closed catalog", () => {
    it("contains exactly the settled policy set", () => {
      expect([...AUTH_POLICY_IDS]).toEqual([
        "anonymous",
        "human",
        "agent",
        "local_actor",
        "registration",
        "daemon",
        "realtime",
        "remote_participant",
        "manual_invite",
        "verified_ingress",
      ]);
    });

    it("contains exactly the settled core verifier set", () => {
      expect([...CORE_VERIFIER_IDS]).toEqual([
        "github_code_review_hmac",
        "github_ci_hmac",
        "github_issues_hmac",
        "gitlab_code_review_token",
        "gitlab_ci_token",
        "slack_signing",
        "discord_ed25519",
      ]);
    });

    it("simple policies install the core middleware verbatim (registry indirection)", () => {
      // Mutating a registry entry's guard is mutating enforcement; the tests
      // that fail when an entry is no-op'd prove the wiring.
      expect(policyGuardFor("human").name).toBe("humanAuth");
      expect(policyGuardFor("agent").name).toBe("agentAuth");
      expect(policyGuardFor("local_actor").name).toBe("agentOrHumanAuth");
      expect(policyGuardFor("registration").name).toBe("registrationAuth");
      expect(policyGuardFor("daemon").name).toBe("daemonAuth");
      expect(policyGuardFor("realtime").name).toBe("authenticateRealtime");
      expect(policyGuardFor("remote_participant").name).toBe("remoteParticipantAuth");
    });
  });

  describe("declaration installs enforcement (seam instance)", () => {
    it("human policy: anonymous rejected, valid human accepted", async () => {
      const anon = await app.inject({ method: "GET", url: "/api/v1/auth/me" });
      expect(anon.statusCode).toBe(401);
      const authed = await app.inject({
        method: "GET",
        url: "/api/v1/auth/me",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(authed.statusCode).toBe(200);
    });

    it("daemon policy rejects a missing daemon token", async () => {
      const res = await app.inject({ method: "GET", url: "/api/v1/daemon/sessions" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "DAEMON_UNAUTHORIZED" });
    });

    it("registration policy enforces the configured registration token", async () => {
      const missing = await app.inject({ method: "POST", url: "/api/v1/agents" });
      expect(missing.statusCode).toBe(403);
      expect(missing.json()).toMatchObject({ code: "REGISTRATION_TOKEN_INVALID" });
      const wrong = await app.inject({
        method: "POST",
        url: "/api/v1/agents",
        headers: { "x-registration-token": "nope" },
      });
      expect(wrong.statusCode).toBe(403);
    });

    it("local_actor policy: GET /plugins is anonymous-rejected, human-accepted", async () => {
      const anon = await app.inject({ method: "GET", url: "/api/v1/plugins" });
      expect(anon.statusCode).toBe(401);
      const authed = await app.inject({
        method: "GET",
        url: "/api/v1/plugins",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(authed.statusCode).toBe(200);
    });

    it("realtime policy (inherited scope) rejects unauthenticated streams", async () => {
      const res = await app.inject({ method: "GET", url: "/sse/habitats/h-1/stream" });
      expect(res.statusCode).toBe(401);
    });

    it("realtime policy (inherited scope) authenticates a valid human principal", async () => {
      // Authorized direction, proven without opening the (never-ending) SSE
      // stream: a real habitat gated by team membership. With the realtime
      // guard the token is verified, request.user is set, and habitat
      // authorization answers 403 BOARD_ACCESS_DENIED (only reachable from an
      // authenticated human). Without the guard there is no principal and
      // habitat authorization answers 401 — this is the discriminating pair.
      const { createHabitat } = await import("../repositories/habitat.js");
      const habitat = createHabitat({ name: "Auth Policy SSE Habitat" });
      const { getDb } = await import("../db/index.js");
      const { habitats } = await import("../db/schema/index.js");
      const { eq } = await import("drizzle-orm");
      getDb().update(habitats).set({ teamId: "team-auth-policy" }).where(eq(habitats.id, habitat.id)).run();

      const res = await app.inject({
        method: "GET",
        url: `/sse/habitats/${habitat.id}/stream`,
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json()).toMatchObject({ code: "BOARD_ACCESS_DENIED" });
    });

    it("remote_participant policy (inherited scope) rejects missing remote keys", async () => {
      const res = await app.inject({ method: "GET", url: "/api/shared/me" });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ code: "MISSING_REMOTE_KEY" });
    });

    it("authorization runs after authentication, not instead of it", async () => {
      // Presence viewers: human guard 401s before requireHabitatAccess can
      // answer; with a valid token the authorization middleware speaks next.
      const anon = await app.inject({ method: "GET", url: "/sse/presence/viewers/h-1" });
      expect(anon.statusCode).toBe(401);
      const authed = await app.inject({
        method: "GET",
        url: "/sse/presence/viewers/does-not-exist",
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(authed.statusCode).toBe(404); // requireHabitatAccess (authorization)
    });
  });

  describe("manual_invite policy", () => {
    it("rejects a missing invite token with the historical 400", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shared/invites/preview",
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        code: "VALIDATION_ERROR",
        details: "INVALID_INVITE_TOKEN",
        error: "Invalid invite token format",
      });
    });

    it("rejects a malformed invite token", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shared/invites/preview",
        headers: { "x-orcy-invite-token": "not-an-orcy-token" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({
        details: "INVALID_INVITE_TOKEN",
        error: "Invalid invite token format",
      });
    });

    it("keeps the accept route's historically distinct missing-token message", async () => {
      // Same 400/code/details as preview, but the accept route always
      // answered a missing or malformed token with its own message. This
      // assertion fails if the two messages are ever unified.
      for (const token of [undefined, "not-an-orcy-token"]) {
        const res = await app.inject({
          method: "POST",
          url: "/api/v1/shared/invites/accept",
          headers: token ? { "x-orcy-invite-token": token } : {},
          payload: { podName: "p", participantDisplayName: "d" },
        });
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({
          code: "VALIDATION_ERROR",
          details: "INVALID_INVITE_TOKEN",
          error: "Invite token required in X-Orcy-Invite-Token header",
        });
      }
      // And under the deprecated prefix too.
      const deprecated = await app.inject({
        method: "POST",
        url: "/api/shared/invites/accept",
        payload: { podName: "p", participantDisplayName: "d" },
      });
      expect(deprecated.statusCode).toBe(400);
      expect(deprecated.json()).toMatchObject({
        error: "Invite token required in X-Orcy-Invite-Token header",
      });
    });

    it("rejects an unknown invite token with INVITE_NOT_FOUND", async () => {
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/shared/invites/preview",
        headers: { "x-orcy-invite-token": "orcy_invite_definitely-unknown" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toMatchObject({ details: "INVITE_NOT_FOUND" });
    });

    it("previews a valid token under both prefixes", async () => {
      const { habitat } = await import("../repositories/habitat.js").then((m) => ({
        habitat: m.createHabitat({ name: "Auth Policy Invite Habitat" }),
      }));
      const { oneTimeToken: token } = createManualInvite({
        habitatId: habitat.id,
        baselineStanding: "remote_observer",
        invitedBy: "admin-1",
      });
      for (const prefix of ["/api/v1", "/api"]) {
        const res = await app.inject({
          method: "POST",
          url: `${prefix}/shared/invites/preview`,
          headers: { "x-orcy-invite-token": token },
        });
        expect(res.statusCode, prefix).toBe(200);
        expect(res.json()).toMatchObject({ inviteType: "manual", status: "pending" });
      }
    });
  });

  describe("verified ingress posture matrix (guard-level)", () => {
    const DISCORD_BYTES = '{"type": 1}';

    it("Slack: valid signature passes, altered bytes rejected, under both prefixes", async () => {
      const bytes = '{"text": "", "team_id": "T1"}';
      for (const prefix of ["/api/v1", "/api"]) {
        const { ts, sig } = slackSign(bytes);
        const good = await app.inject({
          method: "POST",
          url: `${prefix}/chat/slack/command`,
          headers: {
            "content-type": "application/json",
            "x-slack-signature": sig,
            "x-slack-request-timestamp": ts,
          },
          payload: bytes,
        });
        expect(good.statusCode, `${prefix} valid`).toBe(200);
        const bad = await app.inject({
          method: "POST",
          url: `${prefix}/chat/slack/command`,
          headers: {
            "content-type": "application/json",
            "x-slack-signature": slackSign(bytes + " ").sig,
            "x-slack-request-timestamp": ts,
          },
          payload: bytes,
        });
        expect(bad.statusCode, `${prefix} altered`).toBe(401);
      }
    });

    it("Discord: correctly signed requests pass and bad signatures fail, both prefixes", async () => {
      for (const prefix of ["/api/v1", "/api"]) {
        const { ts, sig } = discordSign(DISCORD_BYTES);
        const good = await app.inject({
          method: "POST",
          url: `${prefix}/chat/discord/interaction`,
          headers: {
            "content-type": "application/json",
            "x-signature-ed25519": sig,
            "x-signature-timestamp": ts,
          },
          payload: DISCORD_BYTES,
        });
        expect(good.statusCode, `${prefix} valid`).toBe(200);
        expect(good.json()).toEqual({ type: 1 });

        const badTs = String(Math.floor(Date.now() / 1000));
        const otherKey = crypto.generateKeyPairSync("ed25519");
        const badSig = crypto
          .sign(null, Buffer.from(badTs + DISCORD_BYTES), otherKey.privateKey)
          .toString("hex");
        const bad = await app.inject({
          method: "POST",
          url: `${prefix}/chat/discord/interaction`,
          headers: {
            "content-type": "application/json",
            "x-signature-ed25519": badSig,
            "x-signature-timestamp": badTs,
          },
          payload: DISCORD_BYTES,
        });
        expect(bad.statusCode, `${prefix} bad signature`).toBe(401);
        expect(bad.json()).toMatchObject({ code: "UNAUTHORIZED" });
      }
    });

    it("missing credentials fail closed under remote posture", async () => {
      process.env.HOST = "0.0.0.0"; // classifyPosture → remote
      try {
        const slackKey = process.env.SLACK_SIGNING_SECRET;
        const discordKey = process.env.DISCORD_PUBLIC_KEY;
        delete process.env.SLACK_SIGNING_SECRET;
        delete process.env.DISCORD_PUBLIC_KEY;

        const slack = await app.inject({
          method: "POST",
          url: "/api/v1/chat/slack/command",
          headers: { "content-type": "application/json" },
          payload: { text: "" },
        });
        expect(slack.statusCode).toBe(401);

        const discord = await app.inject({
          method: "POST",
          url: "/api/v1/chat/discord/interaction",
          headers: { "content-type": "application/json" },
          payload: DISCORD_BYTES,
        });
        expect(discord.statusCode).toBe(401);

        process.env.SLACK_SIGNING_SECRET = slackKey;
        process.env.DISCORD_PUBLIC_KEY = discordKey;
      } finally {
        delete process.env.HOST;
      }
    });

    describe("historical CI vs code-review posture cells (remote posture, zero secrets)", () => {
      // No GitHub/GitLab secret is configured for any habitat in this file's
      // database, and posture is forced remote. Historically the CI routes
      // passed no failClosed option, so an unmatched credential dispatched;
      // the code-review routes passed failClosed: true and rejected.
      beforeAll(() => {
        process.env.HOST = "0.0.0.0";
      });
      afterAll(() => {
        delete process.env.HOST;
      });

      it("CI GitHub and CI GitLab fail OPEN: unmatched credentials dispatch, both prefixes", async () => {
        for (const prefix of ["/api/v1", "/api"]) {
          const github = await app.inject({
            method: "POST",
            url: `${prefix}/webhooks/github-ci`,
            headers: { "content-type": "application/json", "x-github-event": "ping" },
            payload: { zen: "ci fail-open cell" },
          });
          expect(github.statusCode, `${prefix} github-ci`).toBe(200);
          expect(github.json()).toEqual({ status: "ignored", event: "ping" });

          const gitlab = await app.inject({
            method: "POST",
            url: `${prefix}/webhooks/gitlab-ci`,
            headers: { "content-type": "application/json" },
            payload: { object_kind: "char" },
          });
          expect(gitlab.statusCode, `${prefix} gitlab-ci`).toBe(200);
          expect(gitlab.json()).toEqual({ status: "ignored", objectKind: "char" });
        }
      });

      it("code-review GitHub and GitLab stay fail-CLOSED under remote posture with zero secrets", async () => {
        for (const prefix of ["/api/v1", "/api"]) {
          const github = await app.inject({
            method: "POST",
            url: `${prefix}/webhooks/github`,
            headers: { "content-type": "application/json", "x-github-event": "ping" },
            payload: { zen: "cr fail-closed cell" },
          });
          expect(github.statusCode, `${prefix} github`).toBe(401);
          expect(github.json()).toEqual({ error: "Invalid or missing signature" });

          const gitlab = await app.inject({
            method: "POST",
            url: `${prefix}/webhooks/gitlab`,
            headers: { "content-type": "application/json" },
            payload: { object_kind: "char" },
          });
          expect(gitlab.statusCode, `${prefix} gitlab`).toBe(401);
          expect(gitlab.json()).toEqual({ error: "Invalid or missing token" });
        }
      });
    });

    it("github guards preserve the missing-event 400 precedence over signature rejection", async () => {
      // No secrets configured for this payload's habitat scope + local
      // posture fail-opens the signature, so the handler's 400 for the
      // missing event header is what answers.
      const res = await app.inject({
        method: "POST",
        url: "/api/v1/webhooks/github",
        headers: { "content-type": "application/json" },
        payload: { zen: "x" },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: "Missing X-GitHub-Event header" });
    });
  });

  describe("github_issues no-op ordering (historical)", () => {
    it("skips connection lookup and signature warnings for non-actionable events", async () => {
      const connectionRepo = await import("../repositories/integrationConnection.js");
      const { logger } = await import("../lib/logger.js");
      const listSpy = vi.spyOn(connectionRepo, "listEnabledByProviderAndRepo");
      const warnSpy = vi.spyOn(logger, "warn");
      try {
        // Repository-bearing payload with NO issue → historical no-op before
        // any connection or signature work.
        const noIssue = await app.inject({
          method: "POST",
          url: "/api/v1/webhooks/github/issues",
          headers: { "content-type": "application/json" },
          payload: {
            action: "opened",
            repository: { full_name: "no-op-owner/no-op-repo", owner: { login: "no-op-owner" }, name: "no-op-repo" },
          },
        });
        expect(noIssue.statusCode).toBe(200);
        expect(noIssue.body).toBe("No issue in payload");

        // Issue-bearing payload with an UNSUPPORTED action → same.
        const unsupported = await app.inject({
          method: "POST",
          url: "/api/v1/webhooks/github/issues",
          headers: { "content-type": "application/json" },
          payload: {
            action: "deleted",
            issue: { id: 1, node_id: "N", number: 1, title: "t", body: "", state: "open", html_url: "u", labels: [], user: { login: "l" }, updated_at: "2026-01-01T00:00:00Z" },
            repository: { full_name: "no-op-owner/no-op-repo", owner: { login: "no-op-owner" }, name: "no-op-repo" },
          },
        });
        expect(unsupported.statusCode).toBe(200);
        expect(unsupported.body).toBe("Action 'deleted' not handled");

        expect(listSpy, "no connection lookup for non-actionable events").not.toHaveBeenCalled();
        const signatureWarns = warnSpy.mock.calls.filter((c) =>
          String(c.at(-1)).includes("signature missing or invalid"),
        );
        expect(signatureWarns, "no signature warning for non-actionable events").toHaveLength(0);
      } finally {
        listSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it("still credential-checks actionable events (connection lookup + signature warning)", async () => {
      const { logger } = await import("../lib/logger.js");
      const connectionRepo = await import("../repositories/integrationConnection.js");
      const warnSpy = vi.spyOn(logger, "warn");
      try {
        const { createHabitat } = await import("../repositories/habitat.js");
        const habitat = createHabitat({ name: "Issues Ordering Habitat" });
        connectionRepo.create({
          habitatId: habitat.id,
          provider: "github",
          name: "ordering-connection",
          authMethod: "pat",
          repositoryOwner: "ordering-owner",
          repositoryName: "ordering-repo",
          webhookSecret: "ordering-secret",
          createdBy: "auth-policy-test",
        });

        const actionable = await app.inject({
          method: "POST",
          url: "/api/v1/webhooks/github/issues",
          headers: {
            "content-type": "application/json",
            "x-hub-signature-256": "sha256=definitely-wrong",
          },
          payload: {
            action: "opened",
            issue: { id: 9, node_id: "ORDER_NODE", number: 9, title: "t", body: "", state: "open", html_url: "u", labels: [], user: { login: "l" }, updated_at: "2026-01-01T00:00:00Z" },
            repository: { full_name: "ordering-owner/ordering-repo", owner: { login: "ordering-owner" }, name: "ordering-repo" },
          },
        });
        expect(actionable.statusCode).toBe(200); // fail-soft family
        expect(actionable.body).toBe("OK");
        const signatureWarns = warnSpy.mock.calls.filter((c) =>
          String(c.at(-1)).includes("signature missing or invalid"),
        );
        expect(signatureWarns.length).toBeGreaterThan(0);
      } finally {
        warnSpy.mockRestore();
      }
    });
  });

  describe("observed inventory", () => {
    it("classifies every route from the same declaration the guard used", () => {
      const byKey = new Map(
        authPolicyClassifications(app).map((c) => [`${c.method} ${c.url}`, c.effectivePolicy]),
      );
      expect(byKey.get("GET /health")).toBe("anonymous");
      expect(byKey.get("GET /api/v1/auth/me")).toBe("human");
      expect(byKey.get("POST /api/v1/agents")).toBe("registration");
      expect(byKey.get("GET /api/v1/daemon/sessions")).toBe("daemon");
      expect(byKey.get("GET /api/v1/plugins")).toBe("local_actor");
      expect(byKey.get("GET /sse/habitats/:habitatId/stream")).toBe("realtime");
      expect(byKey.get("GET /api/shared/me")).toBe("remote_participant");
      expect(byKey.get("POST /api/v1/shared/invites/preview")).toBe("manual_invite");
      expect(byKey.get("GET /api/v1/habitats")).toBe("local_actor"); // migrated local API
      expect(byKey.get("POST /api/v1/tasks/:id/claim")).toBe("agent");
      expect(byKey.get("GET /api/v1/habitats/:id/remote-access/readiness")).toBe("human");
      expect(byKey.get("GET /api/v1/habitats/:habitatId/wiki/pages")).toBe("local_actor");
      expect(byKey.get("POST /api/v1/chat/slack/command")).toEqual({
        policy: "verified_ingress",
        verifier: "slack_signing",
      });
      expect(byKey.get("POST /api/chat/discord/interaction")).toEqual({
        policy: "verified_ingress",
        verifier: "discord_ed25519",
      });
    });

    it("reaches readiness with every route policy-classified — no unclassified remainder", () => {
      // app.ready() already resolved in beforeAll with the readiness hook
      // active: the full production surface has an effective policy on every
      // route. The one exception mirrors readiness exactly: @fastify/cors's
      // wildcard preflight catch-all, which answers preflight before
      // authentication by design and is registered by the framework.
      const missing = authPolicyClassifications(app).filter(
        (c) => c.effectivePolicy === undefined && !(c.method === "OPTIONS" && c.url === "*"),
      );
      expect(missing).toEqual([]);
      // The exemption exists — and covers exactly the framework route shape.
      const catchAll = authPolicyClassifications(app).filter(
        (c) => c.effectivePolicy === undefined,
      );
      expect(catchAll.map((c) => `${c.method} ${c.url}`)).toEqual(["OPTIONS *"]);
    });

    it("keeps prefix parity for effective policy", () => {
      const classified = authPolicyClassifications(app);
      const render = (p: AuthPolicy | undefined): string =>
        p === undefined ? "MISSING_POLICY" : formatEffectivePolicy(p);
      const v1 = new Map(
        classified
          .filter((c) => c.url.startsWith("/api/v1/"))
          .map((c) => [
            `${c.method} ${c.url.slice("/api/v1".length)}`,
            render(c.effectivePolicy),
          ]),
      );
      const deprecated = classified.filter(
        (x) => x.url.startsWith("/api/") && !x.url.startsWith("/api/v1/") && !x.url.startsWith("/api/shared"),
      );
      expect(deprecated.length).toBeGreaterThan(0);
      for (const c of deprecated) {
        const key = `${c.method} ${c.url.slice("/api".length)}`;
        const twin = v1.get(key);
        expect(twin, `missing /api/v1 twin for ${key}`).toBeDefined();
        expect(render(c.effectivePolicy)).toBe(twin);
      }
    });

    it("derives raw-body eligibility from the declared verifiers (round trip)", () => {
      const classified = new Set(
        authPolicyClassifications(app)
          .filter(
            (c) =>
              typeof c.effectivePolicy === "object" &&
              c.effectivePolicy.policy === "verified_ingress",
          )
          .map((c) => c.url),
      );
      expect(classified).toEqual(new Set(verifiedIngressRoutePaths()));
    });
  });

  describe("readiness self-probes", () => {
    it("probeVerifierPair rejects an always-false verifier", () => {
      expect(probeVerifierPair(() => false, () => false)).toBe(false);
    });

    it("probeVerifierPair rejects an always-true verifier", () => {
      expect(probeVerifierPair(() => true, () => true)).toBe(false);
    });

    it("resolves undefined config to no policy at all (never a fallback)", () => {
      expect(resolveEffectiveAuthPolicy(undefined)).toBeUndefined();
    });
  });

  describe("closed readiness — missing policy fails the application", () => {
    async function withBareApp(
      register: (f: FastifyInstance) => Promise<void> | void,
    ): Promise<FastifyInstance> {
      const f: FastifyInstance = Fastify({ logger: false });
      await register(f);
      await f.ready();
      return f;
    }

    it("a normal core route without effective policy prevents readiness", async () => {
      await expect(
        withBareApp(async (f) => {
          installAuthPolicy(f);
          f.get("/normal-core-route", async () => ({})); // no config.authPolicy
        }),
      ).rejects.toThrow(/no effective authentication policy.*GET \/normal-core-route/);
    });

    it("an inherited scope satisfies readiness for its routes", async () => {
      const f = await withBareApp(async (inst) => {
        installAuthPolicy(inst);
        await inst.register(async (scope) => {
          inheritAuthPolicy(scope, "human");
          scope.get("/scoped", async () => ({}));
        });
      });
      try {
        const res = await f.inject({ method: "GET", url: "/scoped" });
        expect(res.statusCode).toBe(401);
      } finally {
        await f.close();
      }
    });

    it("the @fastify/cors preflight catch-all (OPTIONS *) is the one framework exemption", async () => {
      // The wildcard OPTIONS route is registered by @fastify/cors itself and
      // answers preflight before authentication by design; readiness must not
      // fail on it — but that normalization covers exactly this shape.
      const f = await withBareApp(async (inst) => {
        installAuthPolicy(inst);
        inst.options("*", async () => ({}));
      });
      await f.close();
    });

    it("a non-wildcard OPTIONS route without policy still prevents readiness", async () => {
      await expect(
        withBareApp(async (f) => {
          installAuthPolicy(f);
          f.options("/concrete", async () => ({})); // not the CORS catch-all
        }),
      ).rejects.toThrow(/no effective authentication policy/);
    });

    it("a route with policy and the CORS catch-all together reach readiness", async () => {
      const f = await withBareApp(async (inst) => {
        installAuthPolicy(inst);
        inst.options("*", async () => ({}));
        inst.get("/health2", { config: { authPolicy: "anonymous" } }, async () => ({}));
      });
      await f.close();
    });
  });

  describe("registration-time validation and inheritance", () => {
    async function withBareApp(
      register: (f: FastifyInstance) => Promise<void> | void,
    ): Promise<FastifyInstance> {
      const f: FastifyInstance = Fastify({ logger: false });
      await register(f);
      await f.ready();
      return f;
    }

    it("rejects an unknown policy at registration (boot error)", async () => {
      await expect(
        withBareApp(async (f) => {
          installAuthPolicy(f);
          f.get("/x", { config: { authPolicy: "godmode" as never } }, async () => ({}));
        }),
      ).rejects.toThrow(/unknown auth policy "godmode"/);
    });

    it("rejects verified_ingress with an unknown verifier at registration", async () => {
      await expect(
        withBareApp(async (f) => {
          installAuthPolicy(f);
          f.get(
            "/x",
            {
              config: {
                authPolicy: { policy: "verified_ingress", verifier: "carrier_pigeon" as never },
              },
            },
            async () => ({}),
          );
        }),
      ).rejects.toThrow(/unknown core verifier "carrier_pigeon"/);
    });

    it('rejects the bare "verified_ingress" string at registration', async () => {
      await expect(
        withBareApp(async (f) => {
          installAuthPolicy(f);
          f.get("/x", { config: { authPolicy: "verified_ingress" as never } }, async () => ({}));
        }),
      ).rejects.toThrow(/without a core verifier ID/);
    });

    it("rejects a route declaration that conflicts with its scope's inherited policy", async () => {
      await expect(
        withBareApp(async (f) => {
          await f.register(async (scope) => {
            inheritAuthPolicy(scope, "remote_participant");
            scope.get("/x", { config: { authPolicy: "anonymous" } }, async () => ({}));
          });
        }),
      ).rejects.toThrow(/conflicting with its homogeneous scope/);
    });

    it("root-installed identical declaration in an inherited scope: enforced exactly once", async () => {
      const captured: Array<{ preHandler?: unknown }> = [];
      const f = await withBareApp(async (inst) => {
        // The root installer must predate the scope's encapsulation context —
        // a hook added to the parent DURING a child plugin's execution never
        // reaches the child's routes. This mirrors production, where
        // createHttpApp installs before registerHttpSurface registers scopes.
        installAuthPolicy(inst);
        inst.addHook("onRoute", (o) => {
          captured.push(o);
        });
        await inst.register(async (scope) => {
          inheritAuthPolicy(scope, "human");
          scope.get("/x", { config: { authPolicy: "human" } }, async () => ({}));
        });
      });
      try {
        // The routeOptions object is shared across onRoute hooks, so the
        // captured reference reflects the final installed chain: the root
        // installer installed the guard once; the scope's inheritance saw an
        // identical declaration and did not install a second copy.
        // Fastify re-invokes onRoute with finalized route options, so more
        // than one capture is normal — the property under test is that NO
        // capture ever shows a doubled guard chain.
        expect(captured.length).toBeGreaterThanOrEqual(1);
        for (const entry of captured) {
          const guards = entry.preHandler == null
            ? []
            : Array.isArray(entry.preHandler)
              ? entry.preHandler
              : [entry.preHandler];
          expect(guards.length).toBeLessThanOrEqual(1);
          for (const g of guards as Array<{ name?: string }>) {
            expect(g.name).toBe("humanAuth");
          }
        }
        const anon = await f.inject({ method: "GET", url: "/x" });
        expect(anon.statusCode).toBe(401);
      } finally {
        await f.close();
      }
    });

    it("bare inherited scope + identical declaration: enforced without any root installer", async () => {
      // No installAuthPolicy anywhere: the scope's inheritance hook is the
      // only authority. The identical explicit declaration must install the
      // guard through the same deduplicated installer — historically this
      // branch silently depended on the root hook and left the route
      // unauthenticated on bare instances.
      const captured: Array<{ preHandler?: unknown }> = [];
      const f = await withBareApp(async (inst) => {
        inst.addHook("onRoute", (o) => {
          captured.push(o);
        });
        await inst.register(async (scope) => {
          inheritAuthPolicy(scope, "human");
          scope.get(
            "/x",
            { config: { authPolicy: "human" } },
            async (request: FastifyRequest) => ({ hasUser: request.user !== undefined }),
          );
        });
      });
      try {
        const anon = await f.inject({ method: "GET", url: "/x" });
        expect(anon.statusCode).toBe(401);

        const authed = await f.inject({
          method: "GET",
          url: "/x",
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(authed.statusCode).toBe(200);
        expect(authed.json()).toEqual({ hasUser: true });

        // Exactly one humanAuth in the final chain.
        const finalEntry = captured.at(-1)!;
        const guards = finalEntry.preHandler == null
          ? []
          : Array.isArray(finalEntry.preHandler)
            ? finalEntry.preHandler
            : [finalEntry.preHandler];
        expect(guards).toHaveLength(1);
        expect((guards[0] as { name?: string }).name).toBe("humanAuth");
      } finally {
        await f.close();
      }
    });

    it("plugin-level applier enforces declarations on bare instances (outside the seam)", async () => {
      const f = await withBareApp(async (inst) => {
        await inst.register(authRoutes);
      });
      try {
        const anon = await f.inject({ method: "GET", url: "/auth/me" });
        expect(anon.statusCode).toBe(401);
        const authed = await f.inject({
          method: "GET",
          url: "/auth/me",
          headers: { authorization: `Bearer ${adminToken}` },
        });
        expect(authed.statusCode).toBe(200);
      } finally {
        await f.close();
      }
    });
  });
});
