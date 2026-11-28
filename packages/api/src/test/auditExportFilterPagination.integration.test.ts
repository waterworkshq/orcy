import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { pipelineEvents, taskEvents, users } from "../db/schema/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { auditExportRoutes } from "../routes/auditExport.js";
import * as habitatService from "../services/habitatService.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import { automationRunCollector } from "../services/auditProjection/automationRunCollector.js";

const app = Fastify({ logger: false });
const token = jwt.sign({ sub: "filter-user", username: "filter-user", role: "admin" }, "dev-secret-change-in-production", { issuer: "orcy" });
const headers = { authorization: `Bearer ${token}` };
let base: string;
let otherBase: string;

beforeAll(async () => {
  await initTestDb();
  const now = new Date().toISOString();
  getDb().insert(users).values({ id: "filter-user", username: "filter-user", passwordHash: "hash", displayName: "Filter User", role: "admin", createdAt: now, updatedAt: now }).run();
  const { habitat, columns } = habitatService.createHabitat({ name: "Audit filters", defaultColumns: true });
  const other = habitatService.createHabitat({ name: "Other audit habitat", defaultColumns: true });
  const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: columns[0].id, title: "Mission", createdBy: "filter-user" });
  const task = taskRepo.createTask({ missionId: mission.id, title: "Task", createdBy: "filter-user" });
  for (let i = 0; i < 1001; i++) {
    getDb().insert(taskEvents).values({ id: `filter-${String(i).padStart(4, "0")}`, taskId: task.id, actorType: "human", actorId: "filter-user", action: i === 1000 ? "completed" : "updated", metadata: i === 1000 ? { provider: "late-provider" } : {}, timestamp: new Date(Date.UTC(2020, 0, 1, 0, 0, i < 2 ? 0 : i)).toISOString() }).run();
  }
  getDb().insert(pipelineEvents).values({ id: "late-pipeline", taskId: task.id, provider: "github", repo: "orcy/app", runId: "late-run", status: "failure", branch: "main", createdAt: "2021-01-01T00:00:00.000Z", metadata: { audit: { source: "webhook", provider: "github" } } }).run();
  registerErrorHandler(app);
  await app.register(auditExportRoutes);
  await app.ready();
  base = `/habitats/${habitat.id}/audit`;
  otherBase = `/habitats/${other.habitat.id}/audit`;
});
afterAll(async () => { await app.close(); closeDb(); });

describe("audit filters before pagination", () => {
  it.each(["actions=completed", "provider=late-provider"])("includes a late match for %s", async (filter) => {
    const response = await app.inject({ method: "GET", url: `${base}/export?format=json&actorId=filter-user&${filter}`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().map((event: { id: string }) => event.id)).toEqual(["task_event:filter-1000"]);
    expect(response.headers["x-audit-result-truncated"]).toBe("false");
  });

  it("applies preset and combined filters before slicing", async () => {
    const response = await app.inject({ method: "GET", url: `${base}/events?preset=failed_pipelines&limit=1&order=asc`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json().events.map((event: { id: string }) => event.id)).toEqual(["pipeline_event:late-pipeline"]);
    expect(response.json().completenessSummary.totalEvents).toBe(1);
    expect(response.json().warnings.some((w: { code: string }) => w.code === "result_truncated")).toBe(false);
    const download = await app.inject({ method: "GET", url: `${base}/export?format=json&preset=failed_pipelines`, headers });
    expect(download.json().map((event: { id: string }) => event.id)).toEqual(["pipeline_event:late-pipeline"]);
    const combined = await app.inject({ method: "GET", url: `${base}/events?preset=failed_pipelines&provider=github&source=webhook&actions=failure`, headers });
    expect(combined.json().events.map((event: { id: string }) => event.id)).toEqual(["pipeline_event:late-pipeline"]);
  });

  it("paginates the matching set and summarizes all matches", async () => {
    for (const order of ["asc", "desc"]) {
      const response = await app.inject({ method: "GET", url: `${base}/events?actorId=filter-user&actions=updated&limit=2&offset=998&order=${order}`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.json().events.map((event: { id: string }) => event.id)).toEqual(order === "asc" ? ["task_event:filter-0998", "task_event:filter-0999"] : ["task_event:filter-0000", "task_event:filter-0001"]);
      expect(response.json().completenessSummary.totalEvents).toBe(1000);
      expect(response.json().warnings.some((w: { code: string }) => w.code === "result_truncated")).toBe(true);
    }
    const none = await app.inject({ method: "GET", url: `${base}/events?actions=never`, headers });
    expect(none.json().events).toEqual([]);
    expect(none.json().completenessSummary.totalEvents).toBe(0);
    const narrow = await app.inject({ method: "GET", url: `${base}/events?actorId=filter-user&provider=late-provider&since=2020-01-01T00%3A16%3A40.000Z`, headers });
    expect(narrow.json().events.map((event: { id: string }) => event.id)).toEqual(["task_event:filter-1000"]);
    expect(narrow.json().events[0].metadata.provider).toBe("late-provider");
  });

  it.each(["json", "jsonl", "csv"])("signals truncated and complete %s downloads without altering the payload", async (format) => {
    const truncated = await app.inject({ method: "GET", url: `${base}/export?format=${format}&actorId=filter-user`, headers });
    expect(truncated.statusCode).toBe(200);
    expect(truncated.headers["x-audit-result-truncated"]).toBe("true");
    expect(truncated.headers["access-control-expose-headers"]).toContain("X-Audit-Result-Truncated");
    expect(truncated.headers["content-disposition"]).toContain(`.${format}`);
    const count = format === "json" ? truncated.json().length : truncated.body.trim().split("\n").length - (format === "csv" ? 1 : 0);
    expect(count).toBe(1000);
    const complete = await app.inject({ method: "GET", url: `${base}/export?format=${format}&actorId=filter-user&actions=completed`, headers });
    expect(complete.headers["x-audit-result-truncated"]).toBe("false");
    expect(complete.body).toContain("filter-1000");
    expect((await app.inject({ method: "GET", url: `${base}/export?format=${format}` })).statusCode).toBe(401);
  });

  it("does not expose matching events from another habitat", async () => {
    const response = await app.inject({ method: "GET", url: `${otherBase}/export?format=json&provider=late-provider`, headers });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([]);
    expect(response.headers["x-audit-result-truncated"]).toBe("false");
  });

  it("signals a failed collector separately from the row limit", async () => {
    const spy = vi.spyOn(automationRunCollector, "collect").mockImplementation(() => { throw new Error("unavailable"); });
    try {
      const response = await app.inject({ method: "GET", url: `${otherBase}/export?format=json`, headers });
      expect(response.statusCode).toBe(200);
      expect(response.headers["x-audit-result-truncated"]).toBe("false");
      expect(response.headers["x-audit-result-partial"]).toBe("true");
      expect(response.headers["access-control-expose-headers"]).toContain("X-Audit-Result-Partial");
    } finally { spy.mockRestore(); }
    const healthy = await app.inject({ method: "GET", url: `${otherBase}/export?format=json`, headers });
    expect(healthy.headers["x-audit-result-partial"]).toBe("false");
  });

  it.each(["code_evidence_projection_partial", "notification_delivery_orphan", "webhook_delivery_orphan"])("signals omitted rows for %s", async (code) => {
    const spy = vi.spyOn(automationRunCollector, "collect").mockReturnValue({ events: [], caveats: [], warnings: [{ code, message: "omitted" }] });
    try {
      const response = await app.inject({ method: "GET", url: `${otherBase}/export?format=json`, headers });
      expect(response.headers["x-audit-result-partial"]).toBe("true");
    } finally { spy.mockRestore(); }
  });
});
