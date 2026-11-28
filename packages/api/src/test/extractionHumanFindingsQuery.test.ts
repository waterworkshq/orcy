/**
 * Human Learning Loop accepted-finding reads — numeric URL query filters.
 *
 * Exercises the REAL production route path: human-authenticated HTTP →
 * Zod querystring validation → REST handler → service filtering → real DB.
 * The documented `limit` and `maxAgeSeconds` query params arrive as URL
 * strings; the schema must accept them, apply the documented integer bounds,
 * and leave every other filter and the authorization behavior untouched.
 *
 * Gates:
 * 1. `limit` as a query string bounds the result set (newest first).
 * 2. `maxAgeSeconds` as a query string filters on the finding's lastSeenAt.
 * 3. Omitted numeric filters keep the documented defaults; non-accepted and
 *    stale findings stay excluded.
 * 4. Invalid, fractional, out-of-range and duplicate numeric values get the
 *    existing typed validation response (400 / VALIDATION_ERROR).
 * 5. The other filter controls (`findingType`, `domain`) still narrow.
 * 6. Authorization is unchanged — an unauthenticated read is refused.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { v4 as uuid } from "uuid";
import type {
  ExtractionFindingType,
  ExtractionScopeType,
} from "@orcy/shared";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { extractionRoutes } from "../routes/extraction.js";
import { createHabitat } from "../repositories/habitat.js";
import {
  extractedFindings,
  extractedFindingScopeRefs,
} from "../db/schema/index.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FindingFixture {
  id: string;
  lastSeenAt: string;
}

function insertFinding(opts: {
  habitatId: string;
  status?: "proposed" | "accepted" | "rejected" | "superseded" | "withdrawn";
  completeness?: "complete" | "partial" | "stale";
  findingType?: ExtractionFindingType;
  subject?: string;
  lastSeenAt?: string;
  scopeRefs?: Array<{ scopeType: ExtractionScopeType; scopeId: string }>;
}): FindingFixture {
  const db = getDb();
  const findingId = uuid();
  const lastSeenAt = opts.lastSeenAt ?? new Date().toISOString();

  db.insert(extractedFindings)
    .values({
      id: findingId,
      habitatId: opts.habitatId,
      firstAttemptId: `att-${uuid()}`,
      lastSeenAttemptId: `att-${uuid()}`,
      lineageRootId: findingId,
      supersedesFindingId: null,
      revision: 1,
      extractorKey: "test_extractor",
      extractorVersion: 1,
      findingType: opts.findingType ?? "lesson",
      subject: opts.subject ?? "Test finding",
      body: "Test body",
      structuredPayload: null,
      confidence: 0.85,
      sampleSize: 10,
      completeness: opts.completeness ?? "complete",
      visibilityCeiling: "habitat_member",
      fingerprint: `fp-${uuid()}`,
      evidenceDigest: `ed-${uuid()}`,
      status: opts.status ?? "accepted",
      decisionVersion: 1,
      firstSeenAt: lastSeenAt,
      lastSeenAt,
      occurrenceCount: 1,
      caveats: [],
    })
    .run();

  for (const ref of opts.scopeRefs ?? []) {
    db.insert(extractedFindingScopeRefs)
      .values({
        id: uuid(),
        findingId,
        scopeType: ref.scopeType,
        scopeId: ref.scopeId,
        derivedFromSourceId: `src-${uuid()}`,
      })
      .run();
  }

  return { id: findingId, lastSeenAt };
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(extractionRoutes);
  await app.ready();
  return app;
}

let app: FastifyInstance;
let habitatId: string;
let token: string;

const NOW = Date.now();
const isoSecondsAgo = (seconds: number): string =>
  new Date(NOW - seconds * 1000).toISOString();

beforeEach(async () => {
  await initTestDb();
  app = await buildApp();
  habitatId = createHabitat({ name: "Human Findings Query Habitat" }).id;
  token = makeToken({ sub: "user-1", username: "admin", role: "admin" });
});

afterEach(async () => {
  await app.close();
  await closeDb();
});

function read(url: string, headers: Record<string, string> = { authorization: `Bearer ${token}` }) {
  return app.inject({ method: "GET", url, headers });
}

describe("Human accepted-finding reads — numeric URL query filters", () => {
  it("gate 1: limit as a query string bounds the result set, newest first", async () => {
    insertFinding({ habitatId, subject: "oldest", lastSeenAt: isoSecondsAgo(300) });
    insertFinding({ habitatId, subject: "middle", lastSeenAt: isoSecondsAgo(200) });
    insertFinding({ habitatId, subject: "newest", lastSeenAt: isoSecondsAgo(100) });

    const res = await read(
      `/habitats/${habitatId}/extraction/findings?limit=2`,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.findings).toHaveLength(2);
    expect(body.findings.map((f: { subject: string }) => f.subject)).toEqual([
      "newest",
      "middle",
    ]);
  });

  it("gate 2: maxAgeSeconds as a query string filters on lastSeenAt", async () => {
    insertFinding({ habitatId, subject: "stale-but-accepted", lastSeenAt: isoSecondsAgo(7200) });
    insertFinding({ habitatId, subject: "fresh", lastSeenAt: isoSecondsAgo(60) });

    const res = await read(
      `/habitats/${habitatId}/extraction/findings?maxAgeSeconds=3600`,
    );

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.findings.map((f: { subject: string }) => f.subject)).toEqual(["fresh"]);
  });

  it("gate 3: omitted numeric filters keep the documented defaults", async () => {
    insertFinding({ habitatId, subject: "accepted" });
    insertFinding({ habitatId, subject: "proposed", status: "proposed" });
    insertFinding({ habitatId, subject: "stale", completeness: "stale" });

    const res = await read(`/habitats/${habitatId}/extraction/findings`);

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.findings.map((f: { subject: string }) => f.subject)).toEqual(["accepted"]);
  });

  it("gate 4: invalid numeric values get the typed validation response", async () => {
    for (const query of ["limit=abc", "limit=1.5", "maxAgeSeconds=abc", "maxAgeSeconds=1.5"]) {
      const res = await read(`/habitats/${habitatId}/extraction/findings?${query}`);

      expect(res.statusCode, query).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code, query).toBe("VALIDATION_ERROR");
      expect(body.error, query).toBe("Validation failed");
    }
  });

  it("gate 4: out-of-range numeric values get the typed validation response", async () => {
    for (const query of ["limit=0", "limit=101", "maxAgeSeconds=0", "maxAgeSeconds=-5"]) {
      const res = await read(`/habitats/${habitatId}/extraction/findings?${query}`);

      expect(res.statusCode, query).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.code, query).toBe("VALIDATION_ERROR");
    }
  });

  it("gate 4: duplicate numeric values get the typed validation response", async () => {
    const res = await read(`/habitats/${habitatId}/extraction/findings?limit=2&limit=3`);

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("VALIDATION_ERROR");
  });

  it("gate 5: the other filter controls still narrow the result set", async () => {
    insertFinding({ habitatId, subject: "lesson-in-domain", findingType: "lesson" });
    insertFinding({ habitatId, subject: "convention-in-domain", findingType: "convention" });
    insertFinding({
      habitatId,
      subject: "scoped",
      findingType: "lesson",
      scopeRefs: [{ scopeType: "domain", scopeId: "core" }],
    });

    const byType = await read(
      `/habitats/${habitatId}/extraction/findings?findingType=convention`,
    );
    expect(byType.statusCode).toBe(200);
    expect(
      JSON.parse(byType.body).findings.map((f: { subject: string }) => f.subject),
    ).toEqual(["convention-in-domain"]);

    const byDomain = await read(`/habitats/${habitatId}/extraction/findings?domain=core`);
    expect(byDomain.statusCode).toBe(200);
    expect(
      JSON.parse(byDomain.body).findings.map((f: { subject: string }) => f.subject),
    ).toEqual(["scoped"]);
  });

  it("gate 6: an unauthenticated read is still refused", async () => {
    const res = await read(`/habitats/${habitatId}/extraction/findings?limit=2`, {});

    expect(res.statusCode).toBe(401);
  });
});
