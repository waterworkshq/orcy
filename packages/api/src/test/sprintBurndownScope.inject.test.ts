import { afterEach, describe, expect, it } from "vitest";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { closeDb, initTestDb } from "../db/index.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as sprintService from "../services/sprintService.js";
import { sprintRoutes } from "../routes/sprints.js";
import { updateTaskFixtureForTests } from "./helpers/taskFixtures.js";

const secret = "dev-secret-change-in-production";
afterEach(() => closeDb());

describe("served Sprint burndown scope", () => {
  it("ignores unrelated work and tracks committed work", async () => {
    await initTestDb();
    setJwtSecret(secret);
    const app = Fastify({ logger: false });
    await app.register(sprintRoutes, { prefix: "/api" });
    try {
      const habitat = habitatRepo.createHabitat({ name: "Synthetic habitat" });
      const column = columnRepo.createColumn({
        habitatId: habitat.id,
        name: "Backlog",
        order: 0,
        requiresClaim: false,
      });
      const createMission = (title: string) =>
        missionRepo.createMission({
          habitatId: habitat.id,
          columnId: column.id,
          title,
          createdBy: "user-1",
        });
      const committed = createMission("Committed");
      const outside = createMission("Outside");
      const sprint = sprintService.createSprint(
        habitat.id,
        {
          name: "Sprint Alpha",
          startDate: "2026-06-01",
          endDate: "2026-06-14",
        },
        "user-1",
      );
      sprintService.addMissionToSprint(sprint.id, committed.id);
      const inTask = taskRepo.createTask({
        missionId: committed.id,
        title: "Committed task",
        createdBy: "user-1",
      });
      const outTask = taskRepo.createTask({
        missionId: outside.id,
        title: "Outside task",
        createdBy: "user-1",
      });
      const token = jwt.sign(
        { sub: "user-1", username: "user-1", role: "admin" },
        secret,
        { issuer: "orcy" },
      );
      const read = async () => {
        const response = await app.inject({
          method: "GET",
          url: `/api/sprints/${sprint.id}/burndown`,
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode).toBe(200);
        return response.json();
      };
      const initial = await read();
      expect(initial.data[1]).toEqual({
        date: "2026-06-02",
        completed: 0,
        remaining: 1,
        idealRemaining: 0.9,
        totalTasks: 1,
      });
      updateTaskFixtureForTests(outTask.id, {
        status: "done",
        completedAt: "2026-06-02T12:00:00.000Z",
      });
      expect((await read()).data).toEqual(initial.data);
      updateTaskFixtureForTests(inTask.id, {
        status: "done",
        completedAt: "2026-06-02T12:00:00.000Z",
      });
      expect((await read()).data[1]).toEqual({
        date: "2026-06-02",
        completed: 1,
        remaining: 0,
        idealRemaining: 0.9,
        totalTasks: 1,
      });
    } finally {
      await app.close();
    }
  });
});
