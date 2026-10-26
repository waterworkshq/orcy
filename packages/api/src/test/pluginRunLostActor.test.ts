import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb } from "../db/index.js";
import { pluginRoutes } from "../routes/plugins.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as agentRepo from "../repositories/agent.js";
import type { PluginRunRow } from "../db/schema/index.js";

// Route → storage/list integration for POST /plugins/runs/:id/lost actor
// attribution (issue #130): the authenticated principal is recorded in the
// run row's existing error text; finishedAt is the row's existing column.
// Genuine auth — the route's declared local_actor policy (agentOrHumanAuth)
// runs, so anonymous requests 401 without any service mock.

const JWT_SECRET = "dev-secret-change-in-production";

function makeHumanToken(): string {
  return jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, {
    issuer: "orcy",
  });
}

function minutesAgo(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

function startStaleRun(habitatId: string, contributionId: string): PluginRunRow {
  return runRepo.startRun({
    habitatId,
    pluginId: "lost-actor-plugin",
    contributionId,
    contributionKind: "signalDetector",
    triggerEventId: `evt-${contributionId}`,
    triggerType: "pulseCreated",
    startedAt: minutesAgo(60),
  });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(pluginRoutes, { prefix: "/api" });
  await app.ready();
  return app;
}

async function listRuns(
  app: FastifyInstance,
  habitatId: string,
  headers: Record<string, string>,
): Promise<PluginRunRow[]> {
  const response = await app.inject({
    method: "GET",
    url: `/api/habitats/${habitatId}/plugins/runs`,
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json() as PluginRunRow[];
}

beforeEach(async () => {
  await initTestDb();
});

afterEach(() => {
  closeDb();
});

describe("mark plugin run lost — actor attribution", () => {
  it("records the authenticated human in the error text, retrievable via POST and the runs list", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Lost Human Habitat" });
      const run = startStaleRun(habitat.id, "human-attr-detector");
      const headers = { authorization: `Bearer ${makeHumanToken()}` };

      const response = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { run: PluginRunRow };
      expect(body.run.status).toBe("lost");
      expect(body.run.error).toBe("Marked lost by operator (human:admin-1)");
      expect(body.run.finishedAt).toBeTruthy();

      const listed = await listRuns(app, habitat.id, headers);
      const listedRun = listed.find((r) => r.id === run.id);
      expect(listedRun?.error).toBe("Marked lost by operator (human:admin-1)");
      expect(listedRun?.finishedAt).toBe(body.run.finishedAt);
    } finally {
      await app.close();
    }
  });

  it("records the authenticated agent in the error text", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Lost Agent Habitat" });
      const created = agentRepo.createAgent({
        name: "lost-actor-agent",
        type: "claude-code",
        domain: "backend",
      });
      const run = startStaleRun(habitat.id, "agent-attr-detector");
      const headers = { "x-agent-api-key": created.plainApiKey };

      const response = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
        headers,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json() as { run: PluginRunRow };
      expect(body.run.error).toBe(`Marked lost by operator (agent:${created.agent.id})`);
      expect(body.run.finishedAt).toBeTruthy();

      const listed = await listRuns(app, habitat.id, headers);
      expect(listed.find((r) => r.id === run.id)?.error).toBe(
        `Marked lost by operator (agent:${created.agent.id})`,
      );
    } finally {
      await app.close();
    }
  });

  it("ignores a body-supplied actor — only the authenticated principal is recorded", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Lost Spoof Habitat" });
      const run = startStaleRun(habitat.id, "spoof-detector");

      const response = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
        headers: { authorization: `Bearer ${makeHumanToken()}` },
        payload: { actor: { type: "agent", id: "spoofed-agent" }, force: true },
      });
      expect(response.statusCode).toBe(200);
      const stored = runRepo.getById(run.id);
      expect(stored?.error).toBe("Marked lost by operator (human:admin-1)");
    } finally {
      await app.close();
    }
  });

  it("resolves the agent before the human when both credentials are presented", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Lost Precedence Habitat" });
      const created = agentRepo.createAgent({
        name: "precedence-agent",
        type: "codex",
        domain: "frontend",
      });
      const run = startStaleRun(habitat.id, "precedence-detector");

      const response = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
        headers: {
          "x-agent-api-key": created.plainApiKey,
          authorization: `Bearer ${makeHumanToken()}`,
        },
      });
      expect(response.statusCode).toBe(200);
      expect(runRepo.getById(run.id)?.error).toBe(
        `Marked lost by operator (agent:${created.agent.id})`,
      );
    } finally {
      await app.close();
    }
  });

  it("rejects an unauthenticated request with 401 and leaves the run untouched", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Lost Anon Habitat" });
      const run = startStaleRun(habitat.id, "anon-detector");

      const response = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
      });
      expect(response.statusCode).toBe(401);
      expect(runRepo.getById(run.id)?.status).toBe("running");
      expect(runRepo.getById(run.id)?.error).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("refuses a repeated mark on the now-lost run and leaves the row unchanged", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Lost Repeat Habitat" });
      const run = startStaleRun(habitat.id, "repeat-detector");
      const headers = { authorization: `Bearer ${makeHumanToken()}` };

      const first = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
        headers,
      });
      expect(first.statusCode).toBe(200);
      const lostAt = (first.json() as { run: PluginRunRow }).run.finishedAt;

      const second = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
        headers,
        payload: { force: true },
      });
      expect(second.statusCode).toBe(400);
      expect((second.json() as { message: string }).message).toContain(
        "current status is 'lost'",
      );

      const stored = runRepo.getById(run.id);
      expect(stored?.finishedAt).toBe(lostAt);
      expect(stored?.error).toBe("Marked lost by operator (human:admin-1)");
    } finally {
      await app.close();
    }
  });

  it("refuses a run belonging to a different habitat (ownership guard unchanged)", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Lost Own Habitat" });
      const otherHabitat = habitatRepo.createHabitat({ name: "Lost Other Habitat" });
      const run = startStaleRun(otherHabitat.id, "foreign-detector");

      const response = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
        headers: { authorization: `Bearer ${makeHumanToken()}` },
      });
      expect(response.statusCode).toBe(404);
      expect((response.json() as { message: string }).message).toContain(
        "Plugin run not found",
      );
      expect(runRepo.getById(run.id)?.status).toBe("running");
      expect(runRepo.getById(run.id)?.error).toBeNull();
    } finally {
      await app.close();
    }
  });

  it("keeps the staleness guard: a fresh run without force is refused", async () => {
    const app = await buildApp();
    try {
      const habitat = habitatRepo.createHabitat({ name: "Lost Fresh Habitat" });
      const run = runRepo.startRun({
        habitatId: habitat.id,
        pluginId: "lost-actor-plugin",
        contributionId: "fresh-detector",
        contributionKind: "signalDetector",
        triggerEventId: "evt-fresh",
        triggerType: "pulseCreated",
        startedAt: minutesAgo(2),
      });

      const response = await app.inject({
        method: "POST",
        url: `/api/habitats/${habitat.id}/plugins/runs/${run.id}/lost`,
        headers: { authorization: `Bearer ${makeHumanToken()}` },
      });
      expect(response.statusCode).toBe(400);
      expect((response.json() as { message: string }).message).toContain(
        "Use force=true to override",
      );
      expect(runRepo.getById(run.id)?.status).toBe("running");
    } finally {
      await app.close();
    }
  });
});
