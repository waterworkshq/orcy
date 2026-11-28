import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks } from "../db/schema/index.js";
import { habitatRoutes } from "../routes/habitats.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import { getAnomalySettings, getDefaultAnomalySettings, scanHabitat } from "../services/anomalyService.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

// Synthetic scans must never send external notifications, including the null-default control.
vi.mock("../services/chatService.js", () => ({ sendAnomalyAlert: vi.fn().mockResolvedValue(undefined), processEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../services/emailService.js", () => ({ isConfigured: () => false }));

let app: FastifyInstance;
const token = jwt.sign({ sub: "anomaly-tester", username: "anomaly-tester", role: "admin" }, "dev-secret-change-in-production", { issuer: "orcy" });
const headers = { authorization: `Bearer ${token}` };

beforeEach(async () => {
  await initTestDb();
  vi.spyOn(sseBroadcaster, "publish").mockImplementation(() => {});
  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(async (f) => { f.addHook("preHandler", perAgentRateLimit); await f.register(habitatRoutes); }, { prefix: "/api" });
  await app.ready();
});
afterEach(async () => { await app.close(); vi.restoreAllMocks(); closeDb(); });

describe("persisted anomaly scanner admission", () => {
  it("honors explicit off, explicit on and inherited defaults after authenticated PATCH", async () => {
    const habitat = habitatRepo.createHabitat({ name: "Scanner fixture" });
    const column = columnRepo.createColumn({ habitatId: habitat.id, name: "Backlog", order: 0, requiresClaim: false });
    const mission = missionRepo.createMission({ habitatId: habitat.id, columnId: column.id, title: "Fixture", createdBy: "human" });
    const task = taskRepo.createTask({ missionId: mission.id, title: "Stale fixture", createdBy: "human" });
    getDb().update(tasks).set({ status: "in_progress", startedAt: new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString() }).where(eq(tasks.id, task.id)).run();
    const settings = { ...getDefaultAnomalySettings(), notifications: { email: false, sse: false, chat: false } };
    const patch = async (anomalySettings: typeof settings | { enabled: false } | null) => app.inject({ method: "PATCH", url: `/api/habitats/${habitat.id}`, headers, payload: { anomalySettings } });

    let res = await patch(settings);
    expect(res.statusCode).toBe(200);
    res = await patch({ enabled: false });
    expect(res.statusCode).toBe(200);
    expect(habitatRepo.getHabitatById(habitat.id)!.anomalySettings).toEqual({ ...settings, enabled: false });
    const readback = await app.inject({ method: "GET", url: `/api/habitats/${habitat.id}`, headers });
    expect(readback.statusCode).toBe(200);
    expect(readback.json().habitat.anomalySettings).toEqual({ ...settings, enabled: false });
    expect(getAnomalySettings(habitat.id).enabled).toBe(false);
    expect(scanHabitat(habitat.id)).toEqual([]);

    res = await patch({ ...settings, enabled: true });
    expect(res.statusCode).toBe(200);
    expect(getAnomalySettings(habitat.id).enabled).toBe(true);
    expect(scanHabitat(habitat.id).some((a) => a.type === "stale_in_progress")).toBe(true);

    res = await patch(null);
    expect(res.statusCode).toBe(200);
    expect(habitatRepo.getHabitatById(habitat.id)!.anomalySettings).toBeNull();
    expect(getAnomalySettings(habitat.id).enabled).toBe(true);
    expect(scanHabitat(habitat.id).some((a) => a.type === "stale_in_progress")).toBe(true);

    res = await patch({ enabled: false });
    expect(res.statusCode).toBe(200);
    expect(habitatRepo.getHabitatById(habitat.id)!.anomalySettings).toEqual({ ...getDefaultAnomalySettings(), enabled: false });
    expect(scanHabitat(habitat.id)).toEqual([]);
  });
});
