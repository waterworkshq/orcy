import { afterEach, beforeEach, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { habitats, organizations, teams, users } from "../db/schema/index.js";
import { createHttpApplication } from "../httpApp.js";
import * as habitatRepo from "../repositories/habitat.js";
import { addMember } from "../repositories/teamMember.js";
import { createAgent } from "../repositories/agent.js";
import type { PublicHabitat } from "@orcy/shared";

const prefixes = ["/api", "/api/v1"];

function ids(response: { json(): { habitats: PublicHabitat[] } }): string[] {
  return response.json().habitats.map((habitat) => habitat.id).toSorted();
}

describe("Habitat list access through authenticated HTTP", () => {
  let app: Awaited<ReturnType<typeof createHttpApplication>>;
  let personalId: string;
  let privateId: string;
  let otherTeamId: string;
  let ownedPersonalId: string;
  let unrelatedId: string;

  beforeEach(async () => {
    await initTestDb();
    const db = getDb();
    db.insert(users).values({
      id: "outsider", username: "outsider", role: "editor",
      passwordHash: await bcrypt.hash("password", 4),
    }).run();
    db.insert(users).values({
      id: "owner", username: "owner", role: "editor", passwordHash: "unused",
    }).run();
    db.insert(organizations).values({ id: "org", name: "Org", slug: "org" }).run();
    db.insert(teams).values({ id: "team-a", organizationId: "org", name: "A", slug: "a" }).run();
    db.insert(teams).values({ id: "team-b", organizationId: "org", name: "B", slug: "b" }).run();
    db.insert(teams).values({ id: "team-c", organizationId: "org", name: "C", slug: "c" }).run();
    unrelatedId = habitatRepo.createHabitat({ name: "Private gamma", teamId: "team-c" }).id;
    ownedPersonalId = habitatRepo.createHabitat({ name: "Owned personal" }).id;
    db.update(habitats).set({ ownerUserId: "owner" }).where(eq(habitats.id, ownedPersonalId)).run();
    otherTeamId = habitatRepo.createHabitat({ name: "Private beta", teamId: "team-b" }).id;
    personalId = habitatRepo.createHabitat({ name: "Personal control" }).id;
    privateId = habitatRepo.createHabitat({ name: "Private alpha", teamId: "team-a" }).id;
    habitatRepo.updateHabitat(privateId, {
      ciCdSettings: { githubSecret: "ci-webhook-secret", gitlabSecret: "ci-gitlab-secret", taskPattern: "ci-pattern" },
      codeReviewSettings: {
        githubSecret: "private-webhook-secret", gitlabSecret: null,
        taskPattern: "private-pattern", autoApproveOnMerge: false,
        githubRepositories: [{ id: "123", fullName: "private-org/secret-repo" }], gitlabProjects: [],
      },
    });
    app = await createHttpApplication({ logger: false });
    await app.installPluginRoutes([]);
    await app.finalize();
  });

  afterEach(async () => {
    if (app) await app.close();
    closeDb();
  });

  async function login() {
    const response = await app.inject({
      method: "POST", url: "/api/auth/login",
      payload: { username: "outsider", password: "password" },
    });
    expect(response.statusCode).toBe(200);
    return { authorization: `Bearer ${response.json().token}` };
  }

  it.each(prefixes)("%s lists only personal Habitats for a human with no Teams", async (prefix) => {
    const headers = await login();
    const direct = await app.inject({ method: "GET", url: `${prefix}/habitats/${privateId}`, headers });
    expect(direct.statusCode).toBe(403);
    const response = await app.inject({ method: "GET", url: `${prefix}/habitats`, headers });
    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual([personalId, ownedPersonalId].toSorted());
    expect(response.body).not.toContain("private-org/secret-repo");
    expect(response.body).not.toContain("private-pattern");
    for (const name of ["PRIVATE ALPHA", "private beta"]) {
      const named = await app.inject({ method: "GET", url: `${prefix}/habitats?name=${encodeURIComponent(name)}`, headers });
      expect(named.statusCode).toBe(200);
      expect(named.json().habitats).toEqual([]);
    }
    const personal = await app.inject({ method: "GET", url: `${prefix}/habitats?name=PERSONAL`, headers });
    expect(personal.statusCode).toBe(200);
    expect(ids(personal)).toEqual([personalId, ownedPersonalId].toSorted());
  });

  for (const teamIds of [["team-a"], ["team-a", "team-b"]]) {
    it.each(prefixes)(`%s lists only personal and member Team Habitats for ${teamIds.length} Teams`, async (prefix) => {
      for (const teamId of teamIds) addMember({ teamId, userId: "outsider" });
      const headers = await login();
      const expected = [personalId, ownedPersonalId, privateId, ...(teamIds.length === 2 ? [otherTeamId] : [])];
      const response = await app.inject({ method: "GET", url: `${prefix}/habitats`, headers });
      expect(response.statusCode).toBe(200);
      expect(ids(response)).toEqual(expected.toSorted());
      const direct = await app.inject({ method: "GET", url: `${prefix}/habitats/${privateId}`, headers });
      expect(direct.statusCode).toBe(200);
      for (const [name, expectedIds] of [
        ["PRIVATE ALPHA", [privateId]],
        ["PRIVATE BETA", teamIds.length === 2 ? [otherTeamId] : []],
        ["PERSONAL", [personalId, ownedPersonalId]],
      ] as const) {
        const named = await app.inject({ method: "GET", url: `${prefix}/habitats?name=${encodeURIComponent(name)}`, headers });
        expect(named.statusCode).toBe(200);
        expect(ids(named)).toEqual([...expectedIds].toSorted());
      }
    });
  }

  it.each(prefixes)("%s keeps local agents unscoped and masks webhook secrets", async (prefix) => {
    const { plainApiKey } = createAgent({ name: "Local agent", type: "claude-code", domain: "fullstack" });
    const headers = { "x-agent-api-key": plainApiKey };
    const response = await app.inject({ method: "GET", url: `${prefix}/habitats`, headers });
    expect(response.statusCode).toBe(200);
    expect(ids(response)).toEqual([personalId, ownedPersonalId, privateId, otherTeamId, unrelatedId].toSorted());
    const named = await app.inject({ method: "GET", url: `${prefix}/habitats?name=PRIVATE%20ALPHA`, headers });
    expect(named.statusCode).toBe(200);
    expect(ids(named)).toEqual([privateId]);
    const habitat = named.json().habitats[0] as PublicHabitat;
    expect(habitat.codeReviewSettings).toEqual({
      hasGithubSecret: true, hasGitlabSecret: false, taskPattern: "private-pattern",
      autoApproveOnMerge: false, githubRepositories: [{ id: "123", fullName: "private-org/secret-repo" }], gitlabProjects: [],
    });
    expect(habitat.ciCdSettings).toEqual({ hasGithubSecret: true, hasGitlabSecret: true, taskPattern: "ci-pattern" });
    for (const settings of [habitat.codeReviewSettings!, habitat.ciCdSettings!]) {
      expect(Object.hasOwn(settings, "githubSecret")).toBe(false);
      expect(Object.hasOwn(settings, "gitlabSecret")).toBe(false);
    }
    for (const secret of ["private-webhook-secret", "ci-webhook-secret", "ci-gitlab-secret"]) {
      expect(response.body).not.toContain(secret);
      expect(named.body).not.toContain(secret);
    }
  });
});
