/** Mission reads cross the production HTTP/auth chain on both served prefixes. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as missionService from "../services/missionService.js";
import net from "node:net";
import bcrypt from "bcryptjs";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as schema from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as eventRepo from "../repositories/events/event-feature.js";
import * as connectionRepo from "../repositories/integrationConnection.js";
import * as linkRepo from "../repositories/externalIssueLink.js";
import * as agentRepo from "../repositories/agent.js";

const PREFIXES = ["/api/v1", "/api"] as const;
const READ_SUFFIXES = ["", "/details", "/tasks", "/progress", "/external-links"] as const;
const PRIVATE_MARKERS = ["private-mission-marker", "private-task-marker", "private-event-marker", "private-link-marker"];
let app: HttpRuntimeHandle;
let baseUrl: string;
let missionId: string;
let personalMissionId: string;
let orphanMissionId: string;
let personalHabitatId: string;
let taskId: string;
let eventId: string;
let linkId: string;
const headers: Record<string, Record<string, string>> = { anonymous: {} };

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as net.AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

async function read(prefix: string, id: string, suffix: string, actor: string, query = "") {
  const response = await fetch(`${baseUrl}${prefix}/missions/${id}${suffix}${query}`, { headers: headers[actor] });
  const text = await response.text();
  return { status: response.status, body: JSON.parse(text), text };
}

function makeMission(habitatId: string, title: string) {
  const column = columnRepo.createColumn({ habitatId, name: "todo" });
  return missionRepo.createMission({ habitatId, columnId: column.id, title, createdBy: "system" });
}

beforeAll(async () => {
  await initTestDb();
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  expect(getDb().all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 1 }]);
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;
  const db = getDb();
  for (const actor of ["outsider", "member", "admin"]) {
    const id = `mission-read-${actor}`;
    db.insert(schema.users).values({ id, username: id, passwordHash: await bcrypt.hash("test-password", 4), role: actor === "admin" ? "admin" : "editor" }).run();
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: id, password: "test-password" }),
    });
    expect(response.status).toBe(200);
    const login = await response.json() as { token: string };
    headers[actor] = { authorization: `Bearer ${login.token}` };
  }
  db.insert(schema.organizations).values({ id: "mission-read-org", name: "private org", slug: "mission-read-org" }).run();
  db.insert(schema.teams).values({ id: "mission-read-team", organizationId: "mission-read-org", name: "private team", slug: "mission-read-team" }).run();
  db.insert(schema.teamMembers).values({ id: "mission-read-member", teamId: "mission-read-team", userId: "mission-read-member", role: "member" }).run();
  const agent = agentRepo.createAgent({ name: "mission-read-agent", type: "codex", domain: "general" });
  headers.agent = { "x-agent-api-key": agent.plainApiKey };
  const habitat = habitatRepo.createHabitat({ name: "private", teamId: "mission-read-team" });
  missionId = makeMission(habitat.id, PRIVATE_MARKERS[0]!).id;
  taskId = taskRepo.createTask({ missionId, title: PRIVATE_MARKERS[1]!, description: "private-task-description", createdBy: "system" }).id;
  eventId = eventRepo.createMissionEvent({ missionId, actorType: "human", actorId: "mission-read-member", action: "created", metadata: { secret: PRIVATE_MARKERS[2] } }).id;
  const connection = connectionRepo.create({ habitatId: habitat.id, provider: "github", name: "private github", authMethod: "pat", createdBy: "system" });
  linkId = linkRepo.create({ habitatId: habitat.id, missionId, connectionId: connection.id, provider: "github", externalId: "789", externalKey: "private-org/private-repo#789", externalUrl: "https://github.com/private-org/private-repo/issues/789", externalStatus: "open", providerLabels: [PRIVATE_MARKERS[3]!] }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "personal" }).id;
  personalMissionId = makeMission(personalHabitatId, "personal mission").id;
  orphanMissionId = makeMission(personalHabitatId, "orphan mission").id;
  // Deliberately corrupt only this fixture's ancestry; restore and assert FK enforcement.
  db.run(sql`PRAGMA foreign_keys = OFF`);
  try {
    expect(db.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 0 }]);
    db.update(schema.missions).set({ habitatId: "missing-parent-habitat" }).where(eq(schema.missions.id, orphanMissionId)).run();
  } finally {
    db.run(sql`PRAGMA foreign_keys = ON`);
    expect(db.all(sql`PRAGMA foreign_keys`)).toEqual([{ foreign_keys: 1 }]);
  }
});

afterAll(async () => {
  await app?.close();
  await closeDb();
});

describe.each(PREFIXES)("Mission read access at %s", (prefix) => {
  it("refuses a nonmember human before returning private Mission progress", async () => {
    const response = await read(prefix, missionId, "/progress", "outsider");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
    for (const marker of [...PRIVATE_MARKERS, missionId, taskId]) expect(response.text).not.toContain(marker);
  });
  it("refuses a nonmember human before returning the private Mission task list", async () => {
    const response = await read(prefix, missionId, "/tasks", "outsider");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
    for (const marker of [...PRIVATE_MARKERS, taskId, "private-task-description"]) expect(response.text).not.toContain(marker);
  });
  it("refuses a nonmember human before returning private external integration metadata", async () => {
    const response = await read(prefix, missionId, "/external-links", "outsider");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
    for (const marker of [...PRIVATE_MARKERS, linkId, "private-org/private-repo"]) expect(response.text).not.toContain(marker);
  });
  it("refuses a nonmember human before returning populated private details", async () => {
    const response = await read(prefix, missionId, "/details", "outsider");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
    for (const marker of [...PRIVATE_MARKERS, taskId, eventId]) expect(response.text).not.toContain(marker);
  });
  it("refuses a nonmember human before returning the private Mission", async () => {
    const response = await read(prefix, missionId, "", "outsider");
    expect(response.status).toBe(403);
    expect(response.body).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
    for (const marker of PRIVATE_MARKERS) expect(response.text).not.toContain(marker);
  });
  it("does not grant a nonmember global admin private Mission reads", async () => {
    for (const suffix of READ_SUFFIXES) {
      const response = await read(prefix, missionId, suffix, "admin");
      expect(response.status).toBe(403);
      expect(response.body).toEqual({ error: "You do not have access to this habitat", code: "BOARD_ACCESS_DENIED" });
      for (const marker of [...PRIVATE_MARKERS, missionId, taskId, eventId, linkId]) expect(response.text).not.toContain(marker);
    }
  });

  it("admits a member and local agent with populated private projections", async () => {
    for (const actor of ["member", "agent"]) {
      const mission = await read(prefix, missionId, "", actor);
      expect(mission.status).toBe(200);
      expect(mission.body.mission).toMatchObject({ id: missionId, title: PRIVATE_MARKERS[0] });
      const details = await read(prefix, missionId, "/details", actor);
      expect(details.status).toBe(200);
      expect(details.body.tasks).toEqual(expect.arrayContaining([expect.objectContaining({ id: taskId, title: PRIVATE_MARKERS[1], description: "private-task-description" })]));
      expect(details.body.events).toEqual(expect.arrayContaining([expect.objectContaining({ id: eventId, metadata: { secret: PRIVATE_MARKERS[2] } })]));
      expect(details.body.progress.total).toBe(1);
      const tasks = await read(prefix, missionId, "/tasks", actor);
      expect(tasks.status).toBe(200);
      expect(tasks.body.tasks).toEqual([expect.objectContaining({ id: taskId, title: PRIVATE_MARKERS[1] })]);
      expect(tasks.body.total).toBe(1);
      const progress = await read(prefix, missionId, "/progress", actor);
      expect(progress.status).toBe(200);
      expect(progress.body.total).toBe(1);
      const links = await read(prefix, missionId, "/external-links", actor);
      expect(links.status).toBe(200);
      expect(links.body.externalLinks).toEqual(expect.arrayContaining([expect.objectContaining({ id: linkId, providerLabels: [PRIVATE_MARKERS[3]], externalKey: "private-org/private-repo#789" })]));
    }
  });

  it("preserves authenticated personal-Habitat access and empty links", async () => {
    for (const actor of ["outsider", "member", "admin", "agent"]) {
      for (const suffix of READ_SUFFIXES) {
        const response = await read(prefix, personalMissionId, suffix, actor);
        expect(response.status).toBe(200);
        if (suffix === "/external-links") expect(response.body).toEqual({ externalLinks: [] });
        else if (suffix === "/tasks") expect(response.body).toEqual({ tasks: [], total: 0 });
        else if (suffix === "/progress") expect(response.body.total).toBe(0);
        else expect(response.body.mission.id).toBe(personalMissionId);
      }
    }
  });

  it("requires authentication before private or nonexistent Mission reads", async () => {
    for (const id of [missionId, "missing-mission"]) {
      for (const suffix of READ_SUFFIXES) {
        const response = await read(prefix, id, suffix, "anonymous");
        expect(response.status).toBe(401);
        expect(response.body.code).toBe("UNAUTHORIZED");
        for (const marker of PRIVATE_MARKERS) expect(response.text).not.toContain(marker);
      }
    }
  });

  it("returns missing Mission and parent errors before projection reads", async () => {
    for (const actor of ["outsider", "member", "admin", "agent"]) {
      for (const suffix of READ_SUFFIXES) {
        const missing = await read(prefix, "missing-mission", suffix, actor);
        expect(missing.status).toBe(404);
        expect(missing.body).toEqual({ error: "Mission not found", code: "NOT_FOUND" });
        const orphan = await read(prefix, orphanMissionId, suffix, actor);
        expect(orphan.status).toBe(404);
        expect(orphan.body).toEqual({ error: "Habitat not found", code: "NOT_FOUND" });
      }
    }
  });

  it("derives access from persisted ancestry before projection or integration queries", async () => {
    // Call-through observation only: production guards/repositories remain real.
    const reads = [
      vi.spyOn(missionService, "getMissionWithProgress"),
      vi.spyOn(missionService, "getMissionProgress"),
      vi.spyOn(taskRepo, "getTasksByMissionId"),
      vi.spyOn(eventRepo, "getMissionEventsByMissionId"),
      vi.spyOn(linkRepo, "listByMissionId"),
    ];
    try {
      for (const actor of ["outsider", "admin"]) {
        for (const suffix of READ_SUFFIXES) {
          const response = await read(prefix, missionId, suffix, actor, `?habitatId=${personalHabitatId}`);
          expect(response.status).toBe(403);
          expect(response.body.code).toBe("BOARD_ACCESS_DENIED");
        }
      }
      for (const spy of reads) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of reads) spy.mockRestore();
    }
  });

});
