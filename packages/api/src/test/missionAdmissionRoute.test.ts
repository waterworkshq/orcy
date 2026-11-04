import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import jwt from "jsonwebtoken";
import type { ExternalIssue } from "@orcy/shared";
import { closeDb, getDb, initDb } from "../db/index.js";
import { users } from "../db/schema/index.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as orgRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as connectionRepo from "../repositories/integrationConnection.js";
import * as candidateRepo from "../repositories/externalIntakeCandidate.js";
import * as missionRepo from "../repositories/mission.js";
import * as linkRepo from "../repositories/externalIssueLink.js";
import * as agentRepo from "../repositories/agent.js";
import { syncExternalIssue } from "../services/integrations/syncService.js";

let app: HttpRuntimeHandle;
let dir: string;
const priorEnv = Object.fromEntries(["SLACK_SIGNING_SECRET", "DISCORD_PUBLIC_KEY", "ORCY_REGISTRATION_TOKEN", "HOST"].map((key) => [key, process.env[key]]));
function user() {
  const id = randomUUID();
  getDb().insert(users).values({ id, username: id, passwordHash: "x", role: "editor" }).run();
  return id;
}
function token(id: string) {
  return jwt.sign({ sub: id, username: id, role: "editor" }, getJwtSecret(), { issuer: "orcy", expiresIn: "1h" });
}
function issue(id: string): ExternalIssue {
  return { provider: "github", externalId: id, externalKey: `acme/repo#${id}`,
    title: "Issue", body: "Body", status: "open", labels: ["bug"],
    url: `https://github.com/acme/repo/issues/${id}`, updatedAt: "2026-01-01T00:00:00.000Z" };
}
function fixture() {
  const member = user();
  const outsider = user();
  const org = orgRepo.createOrganization({ name: "Admission", slug: randomUUID() });
  const team = teamRepo.createTeam({ organizationId: org.id, name: "Team", slug: randomUUID() });
  memberRepo.addMember({ teamId: team.id, userId: member, role: "member" });
  const habitat = habitatRepo.createHabitat({ name: "Habitat", teamId: team.id });
  columnRepo.createColumn({ habitatId: habitat.id, name: "Todo", order: 0, requiresClaim: false });
  const connection = connectionRepo.create({ habitatId: habitat.id, provider: "github", name: "GitHub",
    authMethod: "pat", accessToken: "ghp_test", repositoryOwner: "acme", repositoryName: "repo",
    autoImport: false, pullEnabled: true, createdBy: member });
  return { member, outsider, habitat, connection };
}
async function promote(candidateId: string, bearer?: string) {
  return app.inject({ method: "POST", url: `/api/v1/intake-candidates/${candidateId}/promote`,
    ...(bearer ? { headers: { authorization: `Bearer ${bearer}` } } : {}) });
}
beforeEach(async () => {
  process.env.SLACK_SIGNING_SECRET = "admission-wire-slack-secret";
  process.env.DISCORD_PUBLIC_KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
  process.env.ORCY_REGISTRATION_TOKEN = "admission-wire-reg-token";
  delete process.env.HOST;
  dir = mkdtempSync(join(tmpdir(), "orcy-admission-http-"));
  await initDb(join(dir, "http.sqlite"));
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
}, 120_000);
afterEach(async () => {
  try { await app?.close(); }
  finally {
    closeDb();
    if (dir) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of Object.entries(priorEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

describe("human promotion route", () => {
  // GROUND: T3 Step 1 (GREEN characterization; no product code) — real HTTP, real JWT, real team membership.
  // Mutation target for the DESIGN mutation-list drill: bypassing input.verifyAccess must fail this test.
  it("denies a real non-member without writes, then admits a member", async () => {
    const f = fixture();
    const id = randomUUID();
    syncExternalIssue(f.connection, issue(id));
    const candidate = candidateRepo.findByConnectionAndExternalId(f.connection.id, id)!;
    expect((await promote(candidate.id)).statusCode).toBe(401);
    const { plainApiKey } = agentRepo.createAgent({ name: `admission-${randomUUID()}`, type: "claude-code", domain: "fullstack", capabilities: [] });
    const agentResponse = await app.inject({ method: "POST", url: `/api/v1/intake-candidates/${candidate.id}/promote`, headers: { "X-Agent-API-Key": plainApiKey } });
    expect(agentResponse.statusCode).toBe(401);
    const denied = await promote(candidate.id, token(f.outsider));
    expect(denied.statusCode).toBe(403);
    expect(candidateRepo.getById(candidate.id)).toMatchObject({ reviewStatus: "new", promotedMissionId: null });
    expect(missionRepo.getMissionsByHabitatId(f.habitat.id).missions).toHaveLength(0);
    expect(linkRepo.findByConnectionAndExternalId(f.connection.id, id)).toBeNull();
    const allowed = await promote(candidate.id, token(f.member));
    expect(allowed.statusCode).toBe(201);
    expect(candidateRepo.getById(candidate.id)).toMatchObject({ reviewStatus: "promoted", promotedMissionId: allowed.json().mission.id });
  });

  // GROUND: T3 Step 1 / PRD A9 — provider-owner conflict yields bounded 409, no owner Mission/Habitat/connection disclosure.
  it("returns a bounded conflict without revealing the owner", async () => {
    const owner = fixture();
    const target = fixture();
    const id = randomUUID();
    const existingMission = missionRepo.createMission({ habitatId: owner.habitat.id,
      title: "existing", createdBy: owner.member });
    const existingLink = linkRepo.create({ connectionId: owner.connection.id, habitatId: owner.habitat.id,
      missionId: existingMission.id, provider: "github", externalId: id,
      externalKey: `acme/repo#${id}`, externalUrl: "https://example.com/issue", externalStatus: "open" });
    syncExternalIssue(target.connection, issue(id));
    const candidate = candidateRepo.findByConnectionAndExternalId(target.connection.id, id)!;
    const response = await promote(candidate.id, token(target.member));
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ code: "CONFLICT", error: "External issue is already linked" });
    for (const secret of [owner.habitat.id, owner.connection.id, existingMission.id, existingLink.id, owner.member]) {
      expect(response.body).not.toContain(secret);
    }
    expect(candidateRepo.getById(candidate.id)).toMatchObject({ reviewStatus: "new", promotedMissionId: null });
    expect(missionRepo.getMissionsByHabitatId(target.habitat.id).missions).toHaveLength(0);
    expect(linkRepo.getById(existingLink.id)).toMatchObject({ missionId: existingMission.id, connectionId: owner.connection.id });
  });
});
