/**
 * Mission deadline preservation on PATCH /missions/:id (issue #236).
 *
 * The served contract the UI fix depends on:
 *  - an OMITTED `dueAt` leaves the stored deadline untouched, byte-for-byte
 *    (its own precision included) — an unrelated edit must not move the deadline;
 *  - a SUPPLIED `dueAt` replaces it (the served value is a UTC instant);
 *  - an explicit `null` clears it.
 *
 * Exercised through the REAL Mission route (Zod body parsing included) against
 * the real database, so the omission semantics are proven end to end rather than
 * assumed from the repository code alone.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { missions, missionEvents } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import { missionRoutes } from "../routes/missions.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";

const USER_ID = "user-1";
const AUTH = { authorization: `Bearer ${jwt.sign({ sub: USER_ID, username: "test", role: "admin" }, getJwtSecret(), { issuer: "orcy" })}` };

let habitatId: string;
let columnId: string;
let app: FastifyInstance;

/** The deadline exactly as stored, not re-serialized. */
function storedDueAt(missionId: string): string | null {
  const row = getDb()
    .select({ dueAt: missions.dueAt })
    .from(missions)
    .where(eq(missions.id, missionId))
    .get();
  return row?.dueAt ?? null;
}

/** The SLA deadline column exactly as stored. */
function storedSlaDeadlineAt(missionId: string): string | null {
  const row = getDb()
    .select({ slaDeadlineAt: missions.slaDeadlineAt })
    .from(missions)
    .where(eq(missions.id, missionId))
    .get();
  return row?.slaDeadlineAt ?? null;
}

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(missions).run();
  const habitat = habitatRepo.createHabitat({ name: "Deadline Habitat" });
  habitatId = habitat.id;
  columnId = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  }).id;

  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(async (f) => {
    await f.register(missionRoutes);
  }, { prefix: "/api" });
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb();
});

describe("PATCH /missions/:id — deadline preservation", () => {
  it("leaves the stored deadline untouched when dueAt is omitted", async () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Original",
      createdBy: USER_ID,
      dueAt: "2026-11-30T12:00:45.000Z",
      slaMinutes: 90,
    });
    // An SLA deadline already on the row must survive an unrelated edit too.
    getDb()
      .update(missions)
      .set({ slaDeadlineAt: "2026-11-29T09:15:30.000Z" })
      .where(eq(missions.id, mission.id))
      .run();

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${mission.id}`,
      headers: AUTH,
      payload: { title: "Renamed", version: mission.version },
    });
    expect(res.statusCode).toBe(200);
    expect(storedDueAt(mission.id)).toBe("2026-11-30T12:00:45.000Z");
    expect(storedSlaDeadlineAt(mission.id)).toBe("2026-11-29T09:15:30.000Z");
  });

  it("replaces the deadline when dueAt is supplied", async () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Original",
      createdBy: USER_ID,
      dueAt: "2026-11-30T12:00:45.000Z",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${mission.id}`,
      headers: AUTH,
      payload: { dueAt: "2026-12-01T09:00:00.000Z", version: mission.version },
    });
    expect(res.statusCode).toBe(200);
    expect(storedDueAt(mission.id)).toBe("2026-12-01T09:00:00.000Z");
  });

  it("clears the deadline when dueAt is an explicit null", async () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Original",
      createdBy: USER_ID,
      dueAt: "2026-11-30T12:00:45.000Z",
    });

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${mission.id}`,
      headers: AUTH,
      payload: { dueAt: null, version: mission.version },
    });
    expect(res.statusCode).toBe(200);
    expect(storedDueAt(mission.id)).toBeNull();
  });

  it("does not report an omitted deadline as a changed field", async () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Original",
      createdBy: USER_ID,
      dueAt: "2026-11-30T12:00:45.000Z",
    });

    await app.inject({
      method: "PATCH",
      url: `/api/missions/${mission.id}`,
      headers: AUTH,
      payload: { title: "Renamed", version: mission.version },
    });
    const event = getDb()
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, mission.id))
      .all()
      .find((row) => row.action === "updated");
    expect(event).toBeDefined();
    expect((event!.metadata as { changedFields: string[] }).changedFields).not.toContain("dueAt");
  });
});
