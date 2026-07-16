import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { createHmac } from "crypto";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import {
  releases as releasesTable,
  findingTriage as findingTriageTable,
  habitats,
} from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as releaseRepo from "../repositories/release.js";
import * as releaseTriggerService from "../services/releaseTriggerService.js";
import { rebuildCache } from "../services/habitatSecretCache.js";
import { codeReviewWebhookRoutes } from "../routes/codeReviewWebhooks.js";
import { ciCdWebhookRoutes } from "../routes/ciCdWebhooks.js";
import { triageRoutes } from "../routes/triage.js";

/**
 * REL-11 — End-to-end validation of release detection through the real
 * Fastify route handlers with real HMAC signature verification.
 *
 * Unlike the unit tests (which mock boardSecretCache and call service
 * functions directly), this test exercises the full stack:
 *   HTTP request → Fastify route → HMAC verification → habitat resolution
 *   → handler dispatch → detectAndActivate → DB write → response
 *
 * This is the closest to real-infra validation without a running instance.
 */

const WEBHOOK_SECRET = "test-webhook-secret-for-e2e";

function signPayload(payload: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function makeJwt(): string {
  return jwt.sign(
    { sub: "user-1", username: "test", role: "admin" },
    "dev-secret-change-in-production",
    { issuer: "orcy" },
  );
}

function buildReleasePayload(opts: {
  action?: string;
  tagName?: string;
  draft?: boolean;
  prerelease?: boolean;
}) {
  return {
    action: opts.action ?? "published",
    release: {
      tag_name: opts.tagName ?? "v0.1.0",
      name: `Release ${opts.tagName ?? "v0.1.0"}`,
      body: "release notes",
      html_url: "https://github.com/example/repo/releases/tag/v0.1.0",
      draft: opts.draft ?? false,
      prerelease: opts.prerelease ?? false,
    },
    repository: { full_name: "example/repo" },
  };
}

describe("REL-11: end-to-end release detection via real Fastify routes", () => {
  let app: FastifyInstance | null = null;
  let habitatId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.delete(releasesTable).run();
    db.delete(findingTriageTable).run();

    const habitat = habitatRepo.createHabitat({ name: "E2E Habitat" });
    habitatId = habitat.id;

    // Configure the habitat with a real webhook secret via code_review_settings.
    db.update(habitats)
      .set({
        codeReviewSettings: {
          autoApproveOnMerge: false,
          githubSecret: WEBHOOK_SECRET,
          gitlabSecret: null,
          taskPattern: "",
        },
      })
      .where(eq(habitats.id, habitatId))
      .run();

    // Rebuild the in-memory secret cache so HMAC verification works.
    rebuildCache();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  async function buildApp(): Promise<FastifyInstance> {
    const server = Fastify({ logger: false });
    await server.register(
      async (f) => {
        await f.register(codeReviewWebhookRoutes);
        await f.register(ciCdWebhookRoutes);
        await f.register(triageRoutes);
      },
      { prefix: "/api" },
    );
    await server.ready();
    return server;
  }

  it("GitHub release webhook → HMAC verify → habitat resolve → release recorded", async () => {
    // Seed a prior release so self-classification works.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    app = await buildApp();
    const payload = buildReleasePayload({ tagName: "v0.1.1" });
    const body = JSON.stringify(payload);
    const signature = signPayload(body, WEBHOOK_SECRET);

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      payload,
      headers: {
        "x-github-event": "release",
        "x-hub-signature-256": signature,
        "content-type": "application/json",
      },
    });

    // The webhook should return 200 with status "recorded".
    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    expect(result.status).toBe("recorded");
    expect(result.release).toBeDefined();

    // Verify the release row was created with correct provenance.
    const row = releaseRepo.findByHabitatAndVersion(habitatId, "0.1.1");
    expect(row).not.toBeNull();
    expect(row!.detectedBy).toBe("github_release_webhook");
    expect(row!.releaseType).toBe("patch"); // 0.1.0 → 0.1.1 = patch
  });

  it("pre-release tag is silently ignored via real webhook path", async () => {
    app = await buildApp();
    const payload = buildReleasePayload({ tagName: "v1.0.0-rc.1" });
    const body = JSON.stringify(payload);
    const signature = signPayload(body, WEBHOOK_SECRET);

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      payload,
      headers: {
        "x-github-event": "release",
        "x-hub-signature-256": signature,
      },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    expect(result.status).toBe("ignored");
    expect(releaseRepo.findByHabitatAndVersion(habitatId, "1.0.0")).toBeNull();
  });

  it("first release via webhook returns 400 for GitHub redelivery", async () => {
    app = await buildApp();
    const payload = buildReleasePayload({ tagName: "v1.0.0" });
    const body = JSON.stringify(payload);
    const signature = signPayload(body, WEBHOOK_SECRET);

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      payload,
      headers: {
        "x-github-event": "release",
        "x-hub-signature-256": signature,
      },
    });

    // Should return 400 so GitHub redelivers.
    expect(res.statusCode).toBe(400);
    const result = JSON.parse(res.payload);
    expect(result.error).toMatch(/explicit type/i);
  });

  it("invalid HMAC signature is rejected", async () => {
    app = await buildApp();
    const payload = buildReleasePayload({ tagName: "v0.1.1" });

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      payload,
      headers: {
        "x-github-event": "release",
        "x-hub-signature-256": "sha256=invalid-signature",
      },
    });

    expect(res.statusCode).toBe(401);
  });

  it('detectedBy is always "api" on REST trigger regardless of client body', async () => {
    // Seed a prior release.
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: "/api/triage/release-trigger",
      payload: {
        habitatId,
        version: "v0.1.1",
        detectedBy: "github_release_webhook", // should be ignored
      },
      headers: { authorization: `Bearer ${makeJwt()}` },
    });

    expect(res.statusCode).toBe(200);
    const row = releaseRepo.findByHabitatAndVersion(habitatId, "0.1.1");
    expect(row).not.toBeNull();
    expect(row!.detectedBy).toBe("api"); // forced by server
  });

  it("released action (gh-release CLI) works via real webhook path", async () => {
    await releaseTriggerService.detectAndActivate(habitatId, "v0.1.0", {
      releaseType: "minor",
      detectedBy: "api",
    });

    app = await buildApp();
    const payload = buildReleasePayload({ action: "released", tagName: "v0.2.0" });
    const body = JSON.stringify(payload);
    const signature = signPayload(body, WEBHOOK_SECRET);

    const res = await app.inject({
      method: "POST",
      url: "/api/webhooks/github",
      payload,
      headers: {
        "x-github-event": "release",
        "x-hub-signature-256": signature,
      },
    });

    expect(res.statusCode).toBe(200);
    const result = JSON.parse(res.payload);
    expect(result.status).toBe("recorded");
    const row = releaseRepo.findByHabitatAndVersion(habitatId, "0.2.0");
    expect(row).not.toBeNull();
    expect(row!.releaseType).toBe("minor"); // 0.1.0 → 0.2.0 = minor
  });
});
