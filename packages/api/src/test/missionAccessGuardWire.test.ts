/**
 * Mission comments + template application authorization wire matrix (issue:
 * human nonmember access to mission-scoped comment and apply-template
 * endpoints) — REAL HTTP on BOTH served prefixes (`/api/v1`, deprecated
 * `/api`).
 *
 * Scope of claims:
 *  - GET/POST/PATCH/DELETE `/missions/:missionId/comments` and POST
 *    `/missions/:missionId/apply-template/:templateId` authorize the TARGET
 *    mission's actual Habitat via `requireMissionAccess` — the same
 *    membership predicate as the Mission detail routes. Intended delta:
 *    team nonmember humans 403 (was 200 read of private comments and 201
 *    template publications into the private habitat).
 *  - Preserved: anonymous 401; member (any role) admission; personal-Habitat
 *    (teamless) human admission; local agent admission on comment reads and
 *    writes (broad pod-wide agent access is intentional, per the dependency
 *    wire matrix); member template application still publishes (201 with
 *    persisted Mission + Task rows).
 *  - Denied writes leave state unchanged (zero comment rows added or
 *    mutated, zero template missions/tasks persisted, no title disclosure).
 *
 * No middleware mocks: every request crosses a real TCP socket into the real
 * application. The template is deliberately GLOBAL (`habitatId: null`) so the
 * route's own template-side habitat check cannot mask the missing
 * target-mission authorization.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import jwt from "jsonwebtoken";
import { eq } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as templateRepo from "../repositories/template.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as missionCommentService from "../services/missionCommentService.js";
import { missions, tasks } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";

const PREFIXES = ["/api/v1", "/api"] as const;
const RUN = Date.now().toString(36);

let app: HttpRuntimeHandle;
let baseUrl: string;

let teamHabitatId: string;
let personalHabitatId: string;
let agentKey: string;
let globalTemplateId: string;

let memberJwt: string;
let nonmemberAdminJwt: string;
let personalHumanJwt: string;

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function mint(userId: string, role: string): string {
  return jwt.sign({ sub: userId, username: `mag-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

async function wire(
  prefix: string,
  method: string,
  path: string,
  opts: { token?: string; agentKey?: string; body?: unknown } = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["x-agent-api-key"] = opts.agentKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, text };
}

let columnOrder = 0;
function makeMission(habitatId: string, title: string): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `mag-col-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  return missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title,
    createdBy: "mag-seed",
  }).id;
}

function rowsByTitle(table: typeof missions | typeof tasks, title: string): number {
  return getDb()
    .select({ id: (table as typeof missions).id })
    .from(table as typeof missions)
    .where(eq((table as typeof missions).title, title))
    .all().length;
}

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const org = organizationRepo.createOrganization({
    name: "mag-org",
    slug: `mag-org-${RUN}`,
  });
  const team = teamRepo.createTeam({
    organizationId: org.id,
    name: "mag-team",
    slug: `mag-team-${RUN}`,
  });
  teamHabitatId = habitatRepo.createHabitat({ name: "mag-team-habitat", teamId: team.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "mag-personal-habitat" }).id;

  teamMemberRepo.addMember({ teamId: team.id, userId: "mag-member", role: "member" });

  memberJwt = mint("mag-member", "viewer");
  nonmemberAdminJwt = mint("mag-nonmember-admin", "admin");
  personalHumanJwt = mint("mag-personal-human", "admin");

  agentKey = agentRepo.createAgent({
    name: "mag-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).plainApiKey;

  globalTemplateId = templateRepo.createTemplate({
    habitatId: null,
    name: `mag-global-template-${RUN}`,
    titlePattern: `mag-tpl-${RUN}`,
    tasksTemplate: [{ title: "mag-template-task", order: 0 }],
    createdBy: "system",
  }).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  closeDb();
});

describe("mission comments — authentication and target-mission authorization", () => {
  it("anonymous is 401 on GET and POST on both prefixes", async () => {
    const missionId = makeMission(teamHabitatId, `mag-anon-mission-${RUN}`);
    for (const prefix of PREFIXES) {
      const got = await wire(prefix, "GET", `/missions/${missionId}/comments`);
      expect(got.status, `${prefix} GET`).toBe(401);
      const posted = await wire(prefix, "POST", `/missions/${missionId}/comments`, {
        body: { content: "mag-anon-comment" },
      });
      expect(posted.status, `${prefix} POST`).toBe(401);
    }
    expect(missionCommentService.getComments(missionId).comments).toHaveLength(0);
  }, 30_000);

  it("team nonmember human is 403 on all four comment handlers with no disclosure and unchanged rows", async () => {
    const missionId = makeMission(teamHabitatId, `mag-priv-mission-${RUN}`);
    const marker = `mag-private-marker-${RUN}`;
    missionCommentService.addComment(missionId, "human", "mag-member", marker);
    const before = missionCommentService.getComments(missionId).comments;

    for (const prefix of PREFIXES) {
      const got = await wire(prefix, "GET", `/missions/${missionId}/comments`, {
        token: nonmemberAdminJwt,
      });
      expect(got.status, `${prefix} GET`).toBe(403);
      expect(got.text).not.toContain(marker);
      expect(got.body.comments).toBeUndefined();

      const posted = await wire(prefix, "POST", `/missions/${missionId}/comments`, {
        token: nonmemberAdminJwt,
        body: { content: `mag-injected-${RUN}` },
      });
      expect(posted.status, `${prefix} POST`).toBe(403);

      const patched = await wire(
        prefix,
        "PATCH",
        `/missions/${missionId}/comments/${before[0]!.id}`,
        { token: nonmemberAdminJwt, body: { content: "mag-tampered" } },
      );
      expect(patched.status, `${prefix} PATCH`).toBe(403);

      const deleted = await wire(
        prefix,
        "DELETE",
        `/missions/${missionId}/comments/${before[0]!.id}`,
        { token: nonmemberAdminJwt },
      );
      expect(deleted.status, `${prefix} DELETE`).toBe(403);
    }

    const after = missionCommentService.getComments(missionId).comments;
    expect(after).toHaveLength(before.length);
    expect(JSON.stringify(after)).toContain(marker);
    expect(JSON.stringify(after)).not.toContain("mag-tampered");
    expect(JSON.stringify(after)).not.toContain(`mag-injected-${RUN}`);
  }, 30_000);

  it("member human and local agent read private comments; teamless personal habitat stays open", async () => {
    const teamMissionId = makeMission(teamHabitatId, `mag-member-mission-${RUN}`);
    const marker = `mag-member-marker-${RUN}`;
    missionCommentService.addComment(teamMissionId, "human", "mag-member", marker);

    const personalMissionId = makeMission(personalHabitatId, `mag-open-mission-${RUN}`);
    missionCommentService.addComment(personalMissionId, "human", "mag-member", `mag-open-marker-${RUN}`);

    for (const prefix of PREFIXES) {
      const member = await wire(prefix, "GET", `/missions/${teamMissionId}/comments`, {
        token: memberJwt,
      });
      expect(member.status, `${prefix} member`).toBe(200);
      expect(member.text).toContain(marker);

      const agent = await wire(prefix, "GET", `/missions/${teamMissionId}/comments`, {
        agentKey,
      });
      expect(agent.status, `${prefix} agent`).toBe(200);
      expect(agent.text).toContain(marker);

      const open = await wire(prefix, "GET", `/missions/${personalMissionId}/comments`, {
        token: personalHumanJwt,
      });
      expect(open.status, `${prefix} personal`).toBe(200);
      expect(open.text).toContain(`mag-open-marker-${RUN}`);
    }
  }, 30_000);

  it("local agent write admission on all three comment write handlers (agent is the author)", async () => {
    const missionId = makeMission(teamHabitatId, `mag-agent-write-${RUN}`);

    for (const prefix of PREFIXES) {
      const posted = await wire(prefix, "POST", `/missions/${missionId}/comments`, {
        agentKey,
        body: { content: `mag-agent-comment-${prefix}-${RUN}` },
      });
      expect(posted.status, `${prefix} agent POST`).toBe(201);
      const commentId = posted.body?.comment?.id;
      expect(commentId, `${prefix} agent POST returns comment id`).toBeTruthy();

      const patched = await wire(
        prefix,
        "PATCH",
        `/missions/${missionId}/comments/${commentId}`,
        { agentKey, body: { content: `mag-agent-edited-${prefix}-${RUN}` } },
      );
      expect(patched.status, `${prefix} agent PATCH`).toBe(200);
      expect(JSON.stringify(patched.body)).toContain(`mag-agent-edited-${prefix}-${RUN}`);

      const deleted = await wire(
        prefix,
        "DELETE",
        `/missions/${missionId}/comments/${commentId}`,
        { agentKey },
      );
      expect(deleted.status, `${prefix} agent DELETE`).toBe(204);
      expect(
        JSON.stringify(missionCommentService.getComments(missionId).comments),
      ).not.toContain(`mag-agent-edited-${prefix}-${RUN}`);
    }
  }, 30_000);

  it("missing mission stays 404 for an authenticated human (no cross-habitat oracle)", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", "/missions/mag-does-not-exist/comments", {
        token: memberJwt,
      });
      expect(res.status, `${prefix}`).toBe(404);
    }
  }, 30_000);
});

describe("apply-template — target-mission authorization", () => {
  it("anonymous is 401 on both prefixes", async () => {
    const missionId = makeMission(teamHabitatId, `mag-anon-apply-${RUN}`);
    for (const prefix of PREFIXES) {
      const res = await wire(
        prefix,
        "POST",
        `/missions/${missionId}/apply-template/${globalTemplateId}`,
        { body: { title: `mag-anon-published-${RUN}` } },
      );
      expect(res.status, `${prefix}`).toBe(401);
    }
    expect(rowsByTitle(missions, `mag-anon-published-${RUN}`)).toBe(0);
  }, 30_000);

  it("team nonmember human is 403 with zero persisted publications and no disclosure", async () => {
    const missionId = makeMission(teamHabitatId, `mag-priv-apply-${RUN}`);
    const title = `mag-priv-published-${RUN}`;
    for (const prefix of PREFIXES) {
      const res = await wire(
        prefix,
        "POST",
        `/missions/${missionId}/apply-template/${globalTemplateId}`,
        { token: nonmemberAdminJwt, body: { title, attemptKey: `mag-nonmember-${prefix}-${RUN}` } },
      );
      expect(res.status, `${prefix}`).toBe(403);
      expect(res.text).not.toContain(title);
    }
    expect(rowsByTitle(missions, title)).toBe(0);
    expect(rowsByTitle(tasks, "mag-template-task")).toBe(0);
  }, 30_000);

  it("member publishes into the private habitat; teamless habitat stays open to its human", async () => {
    const teamMissionId = makeMission(teamHabitatId, `mag-member-apply-${RUN}`);
    const teamTitle = `mag-member-published-${RUN}`;
    const applied = await wire(
      "/api/v1",
      "POST",
      `/missions/${teamMissionId}/apply-template/${globalTemplateId}`,
      { token: memberJwt, body: { title: teamTitle, attemptKey: `mag-member-${RUN}` } },
    );
    expect(applied.status).toBe(201);
    expect(rowsByTitle(missions, teamTitle)).toBeGreaterThanOrEqual(1);
    expect(rowsByTitle(tasks, "mag-template-task")).toBeGreaterThanOrEqual(1);

    const personalMissionId = makeMission(personalHabitatId, `mag-open-apply-${RUN}`);
    const personalTitle = `mag-open-published-${RUN}`;
    const open = await wire(
      "/api/v1",
      "POST",
      `/missions/${personalMissionId}/apply-template/${globalTemplateId}`,
      { token: personalHumanJwt, body: { title: personalTitle, attemptKey: `mag-open-${RUN}` } },
    );
    expect(open.status).toBe(201);
    expect(rowsByTitle(missions, personalTitle)).toBeGreaterThanOrEqual(1);
  }, 30_000);
});
