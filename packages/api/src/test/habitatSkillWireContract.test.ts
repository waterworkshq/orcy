/**
 * Wire-contract guard for the published Skill surface
 * (docs/API.md "Habitat Skills", docs/SKILL.md "Habitat Skills").
 *
 * The published guide drifted from the served contract: it taught the
 * unsupported singular `anti_pattern`, the wrong default category, a larger
 * contribution response than the route returns, an async refresh, and a
 * signal listing described as agent-readable when the served route requires
 * human authentication. This test pins both halves of the contract:
 *
 *   - the docs' accepted-category list and default equal the shared registry;
 *   - the served route accepts exactly the registry values, persists the
 *     documented default, returns the documented compact/synchronous
 *     responses, and keeps the signal listing human-only.
 *
 * Docs-only change: this asserts existing behavior, it does not alter it.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SKILL_CATEGORIES } from "@orcy/shared";
import { initTestDb, closeDb } from "../db/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { normalize } from "../services/habitatSkillService.js";
import { habitatSkillRoutes } from "../routes/habitatSkill.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as agentRepo from "../repositories/agent.js";
import * as skillRepo from "../repositories/habitatSkill.js";

/** Test-only signing key — never the runtime's development fallback, and never the ambient `JWT_SECRET`. */
const TEST_JWT_SECRET = randomBytes(32).toString("hex");
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(habitatSkillRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

function humanToken(): string {
  return jwt.sign({ sub: "human-1", username: "human", role: "admin" }, TEST_JWT_SECRET, {
    issuer: "orcy",
  });
}

/**
 * The backticked values a `skillCategory` table row publishes. Every
 * backticked token is extracted — not just lowercase-underscore ones — so an
 * unsupported spelling such as `anti-pattern` is detected instead of silently
 * ignored. The field name and type cells are excluded.
 */
function extractCategoryValues(line: string): string[] {
  return [
    ...new Set(
      [...line.matchAll(/`([^`]+)`/g)]
        .map((m) => m[1]!)
        .filter((v) => v !== "skillCategory" && v !== "string"),
    ),
  ];
}

/**
 * The category values a doc file publishes for `skillCategory`.
 * Returns one entry per documented `skillCategory` table row.
 */
function documentedCategories(file: string): string[][] {
  const markdown = readFileSync(path.join(REPO_ROOT, file), "utf8");
  const rows: string[][] = [];
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("| `skillCategory` |")) continue;
    rows.push(extractCategoryValues(line));
  }
  return rows;
}

describe("published Skill categories match the shared registry", () => {
  it.each(["docs/API.md", "docs/SKILL.md"])("%s lists exactly SKILL_CATEGORIES", (file) => {
    const rows = documentedCategories(file);
    expect(rows.length, `${file} must document the skillCategory field`).toBeGreaterThan(0);
    for (const values of rows) {
      expect([...values].sort()).toEqual([...SKILL_CATEGORIES].sort());
    }
  });

  it.each(["docs/API.md", "docs/SKILL.md"])("%s documents agent_insight as the default", (file) => {
    const markdown = readFileSync(path.join(REPO_ROOT, file), "utf8");
    const defaultRows = markdown
      .split("\n")
      .filter((line) => line.startsWith("| `skillCategory` |") && line.includes("default"));
    expect(defaultRows.length, `${file} must state the default category`).toBeGreaterThan(0);
    for (const row of defaultRows) {
      expect(row).toMatch(/default:?\s*`agent_insight`/);
    }
  });

  it("detects an unsupported spelling alongside the registry values", () => {
    const values = extractCategoryValues(
      "| `skillCategory` | string | no | `convention`, `pattern`, `anti-pattern` |",
    );
    expect(values).toContain("anti-pattern");
    expect([...values].sort()).not.toEqual([...SKILL_CATEGORIES].sort());
  });

  it.each(Object.entries(PUBLISHED_CLUSTER_EXAMPLES))(
    "%s publishes exactly the cluster keys the server generates for the documented subjects",
    (file, subjects) => {
      const published = publishedClusterKeys(file);
      expect(published, `${file} must publish one cluster key per documented subject`).toEqual(
        subjects.map((subject) => normalize(subject)),
      );
      const markdown = readFileSync(path.join(REPO_ROOT, file), "utf8");
      for (const subject of subjects) {
        expect(markdown, `${file} must publish the subject "${subject}"`).toContain(subject);
      }
    },
  );
});

/**
 * The cluster-key examples each guide publishes, with the subject that
 * produces them. The expectation is explicit — no proximity matching — so a
 * published key can never be validated against an unrelated example.
 */
const PUBLISHED_CLUSTER_EXAMPLES: Record<string, string[]> = {
  "docs/API.md": [
    "Always use Drizzle ORM for database queries, never raw SQL",
    "JWT tokens use RS256 signing with jsonwebtoken v9",
  ],
  "docs/SKILL.md": ["Always use Drizzle ORM for database queries, never raw SQL"],
};

/** Every `"clusterKey"` a doc file publishes, in publication order. */
function publishedClusterKeys(file: string): string[] {
  const markdown = readFileSync(path.join(REPO_ROOT, file), "utf8");
  return [...markdown.matchAll(/"clusterKey": "([^"]+)"/g)].map((match) => match[1]!);
}

describe("served Skill wire contract", () => {
  let app: FastifyInstance | null = null;
  let habitatId: string;
  let agentApiKey: string;

  beforeEach(async () => {
    await initTestDb();
    setJwtSecret(TEST_JWT_SECRET);
    app = await buildApp();
    habitatId = habitatRepo.createHabitat({ name: "Skill Habitat" }).id;
    agentApiKey = agentRepo.createAgent({
      name: "Skill Agent",
      type: "claude-code",
      domain: "backend",
    }).plainApiKey;
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  it("rejects the singular anti_pattern category and accepts the plural", async () => {
    const rejected = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/skill/contribute`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: { insight: "Never use raw SQL", skillCategory: "anti_pattern" },
    });
    expect(rejected.statusCode).toBe(400);

    const accepted = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/skill/contribute`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: { insight: "Never use raw SQL", skillCategory: "anti_patterns" },
    });
    expect(accepted.statusCode).toBe(201);
    expect(accepted.json().success).toBe(true);

    const signals = skillRepo.getSignalsByHabitat(habitatId);
    expect(signals.signals.map((s) => s.skillCategory)).toEqual(["anti_patterns"]);
  });

  it("accepts every registry category", async () => {
    for (const category of SKILL_CATEGORIES) {
      const res = await app!.inject({
        method: "POST",
        url: `/api/habitats/${habitatId}/skill/contribute`,
        headers: { "x-agent-api-key": agentApiKey },
        payload: { insight: `Insight for ${category}`, skillCategory: category },
      });
      expect(res.statusCode, `category ${category} must be accepted`).toBe(201);
    }
  });

  it("persists agent_insight when the category is omitted", async () => {
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/skill/contribute`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: { insight: "Prefer the shared helper" },
    });
    expect(res.statusCode).toBe(201);

    const signals = skillRepo.getSignalsByHabitat(habitatId);
    expect(signals.signals).toHaveLength(1);
    expect(signals.signals[0]!.skillCategory).toBe("agent_insight");
  });

  it("reinforces an existing cluster instead of creating a second signal", async () => {
    const payload = { insight: "Prefer the shared helper" };
    const first = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/skill/contribute`,
      headers: { "x-agent-api-key": agentApiKey },
      payload,
    });
    expect(first.statusCode).toBe(201);

    const second = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/skill/contribute`,
      headers: { "x-agent-api-key": agentApiKey },
      payload,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().signal.id).toBe(first.json().signal.id);
    expect(second.json().signal.strength).toBe(first.json().signal.strength);

    const signals = skillRepo.getSignalsByHabitat(habitatId);
    expect(signals.signals).toHaveLength(1);
    expect(signals.signals[0]!.frequency).toBe(2);
  });

  it.each(Object.entries(PUBLISHED_CLUSTER_EXAMPLES))(
    "%s: the route returns the published cluster key for each documented subject",
    async (file, subjects) => {
      const published = publishedClusterKeys(file);
      for (const [index, subject] of subjects.entries()) {
        const res = await app!.inject({
          method: "POST",
          url: `/api/habitats/${habitatId}/skill/contribute`,
          headers: { "x-agent-api-key": agentApiKey },
          payload: { insight: subject },
        });
        expect(res.statusCode).toBe(201);
        expect(res.json().signal.clusterKey).toBe(published[index]);
        expect(res.json().signal.clusterKey).toBe(normalize(subject));
      }
    },
  );

  it("returns the compact contribution response", async () => {
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/skill/contribute`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: { insight: "Always use Drizzle ORM", skillCategory: "convention" },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(["signal", "success"]);
    expect(Object.keys(body.signal).sort()).toEqual(["clusterKey", "id", "strength"]);
    expect(body.signal.strength).toBe(0.3);
  });

  it("refreshes synchronously and returns the skill signal count", async () => {
    const res = await app!.inject({
      method: "POST",
      url: `/api/habitats/${habitatId}/skill/refresh`,
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, message: "Skill regenerated", signalCount: 0 });
  });

  it("refuses agent keys on the human-only signal listing", async () => {
    const agentRes = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/skill/signals`,
      headers: { "x-agent-api-key": agentApiKey },
    });
    expect(agentRes.statusCode).toBe(401);

    const humanRes = await app!.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/skill/signals`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(humanRes.statusCode).toBe(200);
    expect(humanRes.json().signals).toEqual([]);
  });
});
