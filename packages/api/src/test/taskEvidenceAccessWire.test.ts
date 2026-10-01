/**
 * Task evidence correction / gap resolution — REAL HTTP wire matrix on BOTH
 * served prefixes (`/api/v1`, deprecated `/api`), plus served MCP.
 *
 * Scope of claims (author evidence, not universal Task isolation):
 *  - POST /tasks/:taskId/code-evidence/:linkId/correct and
 *    POST /tasks/:taskId/code-evidence/gaps/:gapId/resolve resolve the TARGET
 *    Task's actual Mission → Habitat and enforce the shared membership
 *    predicate BEFORE any evidence row is read, and then require the source
 *    row to belong to that exact Task.
 *  - Intended deltas: team-nonmember human was 200 → now 403
 *    `BOARD_ACCESS_DENIED`; a link/gap owned by another Task (same Habitat or
 *    another), or a Mission row whose targetId text equals the URL Task id,
 *    was 200-with-mutation → now 404 with the source row untouched.
 *  - Preserved: `local_actor` policy and 401 for anonymous / invalid local /
 *    remote-only credentials; member (any role, incl. viewer) / personal-
 *    Habitat human / local agent admission; raw stored-row responses; repeat
 *    corrections and repeat resolutions; same-envelope mutation; the existing
 *    correction/gap publication asymmetry.
 *  - Mission POSTs are exercised for shared-signature regression only. This
 *    file asserts NO new Mission-member denial: Mission admission is unchanged
 *    and remains a disclosed residual.
 *
 * Disclosed limits: final-statement predicate faults are proven at the
 * repository/service boundary on a real DB (see
 * `taskEvidenceContainment.test.ts` and `.production.test.ts`) and at the
 * route boundary by this file's denial snapshots — not by manufacturing an
 * HTTP race. Missing-Mission admission uses an explicitly FK-OFF corrupt
 * ancestry fixture with `finally` restoration and an asserted pragma.
 *
 * No middleware mocks: every request crosses a real TCP socket into the real
 * application; MCP checks drive the spawned server over stdio with a real
 * agent key.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as linkRepo from "../repositories/codeEvidenceLinkRepository.js";
import * as gapRepo from "../repositories/codeEvidenceGapRepository.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as userRepo from "../repositories/user.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import { agents, codeEvidenceLinks, codeEvidenceGaps, missions, taskEvents } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");
const PREFIXES = ["/api/v1", "/api"] as const;

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let childExit: Promise<void>;

let teamAHabitatId: string;
let teamBHabitatId: string;
let personalHabitatId: string;
let agentKey: string;
let agentId: string;
let validRemoteKey: string;

let faultAgentId: string;
let faultAgentKey: string;
let memberAdminJwt: string;
let memberViewerJwt: string;
let memberBJwt: string;
let nonmemberAdminJwt: string;
let personalHumanJwt: string;

const CORRECT_BODY = { status: "incorrect", reason: "wrong commit" };
const RESOLVE_BODY = { resolutionReason: "Webhook now configured" };

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
  return jwt.sign({ sub: userId, username: `tew-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
  body?: unknown;
  rawBody?: string;
}
async function wire(
  prefix: string,
  method: string,
  path: string,
  opts: WireOpts = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["x-agent-api-key"] = opts.agentKey;
  if (opts.remoteKey) headers["x-orcy-remote-key"] = opts.remoteKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method,
    headers,
    body: opts.rawBody ?? (opts.body === undefined ? undefined : JSON.stringify(opts.body)),
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
function makeTask(habitatId: string, title: string): { taskId: string; missionId: string } {
  const column = columnRepo.createColumn({
    habitatId,
    name: `col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `mission-${title}`,
    createdBy: "tew-seed",
  });
  const task = taskRepo.createTask({ missionId: mission.id, title, createdBy: "tew-seed" });
  return { taskId: task.id, missionId: mission.id };
}

let evidenceOrder = 0;
function seedLink(targetType: "task" | "mission", targetId: string) {
  return linkRepo.create({
    targetType,
    targetId,
    evidenceType: "branch",
    evidenceId: `branch-${++evidenceOrder}`,
    linkSource: "agent_reported",
    linkedByType: "agent",
    linkedById: "agent-original-linker",
    title: `feature/tew-${evidenceOrder}`,
    externalUrl: `https://github.com/org/repo/tree/feature/tew-${evidenceOrder}`,
    confidence: 0.5,
    verificationState: "verified",
    allowExternalRepository: true,
    metadata: { seed: true },
  })!;
}

function seedGap(targetType: "task" | "mission", targetId: string) {
  return gapRepo.create({
    targetType,
    targetId,
    reasonCode: "provider_webhook_missing",
    reportedByType: "system",
    reportedById: "orcy",
    metadata: { seed: true },
  })!;
}

function linkRow(id: string) {
  const row = getDb().select().from(codeEvidenceLinks).where(eq(codeEvidenceLinks.id, id)).get();
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

function gapRow(id: string) {
  const row = getDb().select().from(codeEvidenceGaps).where(eq(codeEvidenceGaps.id, id)).get();
  return row ? JSON.parse(JSON.stringify(row)) : null;
}

function eventsFor(taskId: string) {
  return getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all().length;
}

function enableAndAssertFk(): void {
  getDb().run(sql`PRAGMA foreign_keys = ON`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys, "sql.js FK enforcement must be ON for this suite").toBe(1);
}

/** Collects this operation's SSE traffic from the real broadcaster. */
function collectSse(habitatIds: string[]) {
  const seen: Array<{ habitatId: string; type: string; data: any }> = [];
  const unsubs = habitatIds.map((h) =>
    sseBroadcaster.subscribe(h, (event: any) => {
      seen.push({ habitatId: h, type: event.type, data: event.data });
    }),
  );
  return {
    seen,
    evidence: () =>
      seen.filter((e) => e.type === "code_evidence.updated" || e.type === "task.updated"),
    stop: () => unsubs.forEach((u) => u()),
  };
}

let rpcId = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
let buffer = "";
function mcpRequest(method: string, params?: unknown): Promise<any> {
  const id = ++rpcId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
  });
}
function callTool(name: string, args: Record<string, unknown>) {
  return mcpRequest("tools/call", { name, arguments: args });
}
function toolText(result: any): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

beforeAll(async () => {
  await initTestDb();
  enableAndAssertFk();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const org = organizationRepo.createOrganization({
    name: "tew-org",
    slug: `tew-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "tew-team-a",
    slug: `tew-team-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "tew-team-b",
    slug: `tew-team-b-${Date.now()}`,
  });
  teamAHabitatId = habitatRepo.createHabitat({ name: "tew-habitat-a", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "tew-habitat-b", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "tew-personal-habitat" }).id;

  // FK enforcement is ON for this suite, so every actor below is a persisted
  // user rather than a JWT whose subject happens to name nobody.
  const now = new Date().toISOString();
  for (const userId of [
    "tew-member-admin",
    "tew-member-viewer",
    "tew-member-b",
    "tew-nonmember-admin",
    "tew-personal-human",
  ]) {
    userRepo.createUser({
      id: userId,
      username: userId,
      passwordHash: "not-a-real-hash",
      role: "admin",
      createdAt: now,
      updatedAt: now,
    });
  }

  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tew-member-admin", role: "member" });
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tew-member-viewer", role: "member" });
  teamMemberRepo.addMember({ teamId: teamB.id, userId: "tew-member-b", role: "member" });

  memberAdminJwt = mint("tew-member-admin", "admin");
  memberViewerJwt = mint("tew-member-viewer", "viewer");
  memberBJwt = mint("tew-member-b", "viewer");
  nonmemberAdminJwt = mint("tew-nonmember-admin", "admin");
  personalHumanJwt = mint("tew-personal-human", "admin");

  const created = agentRepo.createAgent({
    name: "tew-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;

  // The F1 fault fixtures add request volume on top of everything above, and
  // per-agent rate limiting is a per-key in-process budget with a 60/min
  // default. Give these fixtures their own key with a raised ceiling so the new
  // proofs are never rate-limited by earlier tests. Test fixture only.
  const faultAgent = agentRepo.createAgent({
    name: "tew-fault-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  faultAgentId = faultAgent.agent.id;
  faultAgentKey = faultAgent.plainApiKey;
  getDb()
    .update(agents)
    .set({ rateLimitPerMinute: 5000 })
    .where(eq(agents.id, faultAgentId))
    .run();

  const pod = remotePodRepo.createRemotePod({
    habitatId: teamAHabitatId,
    name: "tew-remote-pod",
  });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamAHabitatId,
    participantType: "remote_orcy",
    displayName: "tew-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamAHabitatId,
    credentialType: "api",
    label: "tew-remote-cred",
  }).plaintextSecret;

  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: agentId,
      ORCY_API_KEY: agentKey,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  childExit = new Promise((resolve) => child.on("exit", () => resolve()));
  child.stderr?.on("data", (c: Buffer) => {
    const text = c.toString();
    if (text.trim()) console.warn("[mcp stderr]:", text.trim());
  });
  child.stdout!.on("data", (chunk: Buffer) => {
    buffer += chunk.toString("utf-8");
    let idx: number;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      let msg: any;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg?.id !== undefined && pending.has(msg.id)) {
        const p = pending.get(msg.id)!;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
        else p.resolve(msg.result);
      }
    }
  });
  const init = await mcpRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "tew-task-evidence-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  child.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
}, 120_000);

afterAll(async () => {
  child.kill("SIGTERM");
  await childExit;
  await app.close();
  closeDb();
});

describe("actor matrix — Task correction/resolve admission on both prefixes", () => {
  it("allows a local agent, a team admin, a team viewer and a personal-Habitat human; both prefixes", async () => {
    const cases: Array<[string, WireOpts]> = [
      ["agent", { agentKey }],
      ["team admin", { token: memberAdminJwt }],
      ["team viewer", { token: memberViewerJwt }],
    ];
    for (const [label, creds] of cases) {
      for (const prefix of PREFIXES) {
        const { taskId } = makeTask(teamAHabitatId, `tew-allow-${label}-${prefix}`);
        const link = seedLink("task", taskId);
        const gap = seedGap("task", taskId);

        const corrected = await wire(
          prefix,
          "POST",
          `/tasks/${taskId}/code-evidence/${link.id}/correct`,
          {
            ...creds,
            body: CORRECT_BODY,
          },
        );
        expect(corrected.status, `${label} ${prefix} correct`).toBe(200);
        expect(corrected.body.link.id).toBe(link.id);
        expect(corrected.body.link.targetType).toBe("task");
        expect(corrected.body.link.targetId).toBe(taskId);
        expect(corrected.body.link.status).toBe("incorrect");

        const resolved = await wire(
          prefix,
          "POST",
          `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`,
          { ...creds, body: RESOLVE_BODY },
        );
        expect(resolved.status, `${label} ${prefix} resolve`).toBe(200);
        expect(resolved.body.gap.id).toBe(gap.id);
        expect(resolved.body.gap.status).toBe("resolved");
        expect(resolved.body.gap.targetType).toBe("task");
        expect(resolved.body.gap.targetId).toBe(taskId);
      }
    }

    // Personal-Habitat human: no team, so the membership branch does not apply.
    for (const prefix of PREFIXES) {
      const { taskId } = makeTask(personalHabitatId, `tew-personal-${prefix}`);
      const link = seedLink("task", taskId);
      const res = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
        token: personalHumanJwt,
        body: CORRECT_BODY,
      });
      expect(res.status, `personal human ${prefix}`).toBe(200);
      expect(res.body.link.correctedByType).toBe("human");
      expect(res.body.link.correctedById).toBe("tew-personal-human");
    }
  });

  it("denies a team nonmember (including a global admin) with 403 BOARD_ACCESS_DENIED, before any source lookup or write", async () => {
    for (const prefix of PREFIXES) {
      const { taskId } = makeTask(teamAHabitatId, `tew-nonmember-${prefix}`);
      const foreign = seedLink("task", taskId);
      const replacement = seedLink("task", taskId);
      const linkBefore = linkRow(foreign.id);
      const replacementBefore = linkRow(replacement.id);
      const eventsBefore = eventsFor(taskId);

      for (const [label, path] of [
        ["correct", `/tasks/${taskId}/code-evidence/${foreign.id}/correct`],
        ["resolve", `/tasks/${taskId}/code-evidence/gaps/${seedGap("task", taskId).id}/resolve`],
      ] as const) {
        const res = await wire(prefix, "POST", path, {
          token: nonmemberAdminJwt,
          body: label === "correct" ? CORRECT_BODY : RESOLVE_BODY,
        });
        expect(res.status, `nonmember ${label} ${prefix}`).toBe(403);
        expect(res.body.error?.code ?? res.body.code, `nonmember ${label}`).toBe(
          "BOARD_ACCESS_DENIED",
        );
      }

      // Source, replacement and both targets' audit rows are unchanged.
      expect(linkRow(foreign.id)).toEqual(linkBefore);
      expect(linkRow(replacement.id)).toEqual(replacementBefore);
      expect(eventsFor(taskId)).toBe(eventsBefore);
    }
  });

  it("denies a member of another team with 403, and never touches the other Habitat's source", async () => {
    const { taskId: teamBTask } = makeTask(teamBHabitatId, "tew-other-team-task");
    const victimLink = seedLink("task", teamBTask);
    const victimGap = seedGap("task", teamBTask);
    const linkBefore = linkRow(victimLink.id);
    const gapBefore = gapRow(victimGap.id);

    for (const prefix of PREFIXES) {
      const res = await wire(
        prefix,
        "POST",
        `/tasks/${teamBTask}/code-evidence/${victimLink.id}/correct`,
        { token: memberAdminJwt, body: CORRECT_BODY },
      );
      expect(res.status, `cross-team ${prefix}`).toBe(403);
    }
    const gapRes = await wire(
      "/api/v1",
      "POST",
      `/tasks/${teamBTask}/code-evidence/gaps/${victimGap.id}/resolve`,
      { token: memberAdminJwt, body: RESOLVE_BODY },
    );
    expect(gapRes.status).toBe(403);
    expect(linkRow(victimLink.id)).toEqual(linkBefore);
    expect(gapRow(victimGap.id)).toEqual(gapBefore);
  });

  it("401s anonymous, invalid local key, remote-only credential, and invalid local key + valid JWT — valid body, both prefixes", async () => {
    for (const prefix of PREFIXES) {
      const { taskId } = makeTask(teamAHabitatId, `tew-auth-${prefix}`);
      const link = seedLink("task", taskId);
      const gap = seedGap("task", taskId);
      const before = linkRow(link.id);

      const anon = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
        body: CORRECT_BODY,
      });
      expect(anon.status, `anonymous ${prefix}`).toBe(401);

      const badKey = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${link.id}/correct`,
        { agentKey: "not-a-real-key", body: CORRECT_BODY },
      );
      expect(badKey.status, `invalid local key ${prefix}`).toBe(401);

      const remote = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${link.id}/correct`,
        { remoteKey: validRemoteKey, body: CORRECT_BODY },
      );
      expect(remote.status, `remote-only ${prefix}`).toBe(401);

      // Invalid local key + valid JWT stays 401 (agent-key precedence).
      const mixed = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${link.id}/correct`,
        { agentKey: "not-a-real-key", token: memberAdminJwt, body: CORRECT_BODY },
      );
      expect(mixed.status, `mixed credentials ${prefix}`).toBe(401);

      const anonGap = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`,
        { body: RESOLVE_BODY },
      );
      expect(anonGap.status, `anonymous gap ${prefix}`).toBe(401);

      expect(linkRow(link.id)).toEqual(before);
    }
  });

  it("404s a missing Task before any source work, and 400s a schema-invalid body with no credential", async () => {
    for (const prefix of PREFIXES) {
      const missing = await wire(
        prefix,
        "POST",
        `/tasks/no-such-task/code-evidence/no-link/correct`,
        {
          agentKey,
          body: CORRECT_BODY,
        },
      );
      expect(missing.status, `missing task ${prefix}`).toBe(404);

      const { taskId } = makeTask(teamAHabitatId, `tew-schema-${prefix}`);
      const link = seedLink("task", taskId);
      const bad = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
        agentKey,
        body: { status: "not-a-status", reason: "x" },
      });
      expect(bad.status, `invalid status ${prefix}`).toBe(400);

      const missingReason = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${link.id}/correct`,
        { agentKey, body: { status: "removed" } },
      );
      expect(missingReason.status, `missing reason ${prefix}`).toBe(400);

      const nullBody = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${link.id}/correct`,
        { body: JSON.stringify({ status: null, reason: null }) },
      );
      expect(nullBody.status, `null fields ${prefix}`).toBe(400);
    }
  });

  it("404s a Task whose Mission row is missing (corrupt ancestry fixture, FK explicitly off then restored)", async () => {
    const { taskId, missionId } = makeTask(teamAHabitatId, "tew-corrupt-ancestry");
    const link = seedLink("task", taskId);
    const before = linkRow(link.id);

    // Normal cascades cannot model missing ancestry; only an FK-OFF delete can.
    getDb().run(sql`PRAGMA foreign_keys = OFF`);
    try {
      const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
      expect(pragma[0]!.foreign_keys, "corrupt fixture must run with FK OFF").toBe(0);
      getDb().delete(missions).where(eq(missions.id, missionId)).run();
    } finally {
      enableAndAssertFk();
    }
    expect(getDb().select().from(missions).where(eq(missions.id, missionId)).get()).toBeUndefined();

    const res = await wire("/api/v1", "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
      agentKey,
      body: CORRECT_BODY,
    });
    expect(res.status).toBe(404);
    expect(linkRow(link.id)).toEqual(before);
  });
});

describe("exact-pair source containment on the wire", () => {
  it("404s a same-Habitat other-Task source with no audit, no SSE and an unchanged row", async () => {
    for (const prefix of PREFIXES) {
      const { taskId: urlTask } = makeTask(teamAHabitatId, `tew-wrong-src-${prefix}`);
      const { taskId: otherTask } = makeTask(teamAHabitatId, `tew-other-src-${prefix}`);
      const foreign = seedLink("task", otherTask);
      const before = linkRow(foreign.id);
      const eventsBefore = eventsFor(otherTask) + eventsFor(urlTask);
      const sse = collectSse([teamAHabitatId]);

      const res = await wire(
        prefix,
        "POST",
        `/tasks/${urlTask}/code-evidence/${foreign.id}/correct`,
        {
          agentKey,
          body: CORRECT_BODY,
        },
      );
      expect(res.status, `same-habitat wrong source ${prefix}`).toBe(404);
      expect(res.body.error).toBe("Evidence link not found");

      const gapRes = await wire(
        prefix,
        "POST",
        `/tasks/${urlTask}/code-evidence/gaps/${seedGap("task", otherTask).id}/resolve`,
        { agentKey, body: RESOLVE_BODY },
      );
      expect(gapRes.status, `same-habitat wrong gap ${prefix}`).toBe(404);
      expect(gapRes.body.error).toBe("Evidence gap not found");

      expect(linkRow(foreign.id)).toEqual(before);
      expect(eventsFor(otherTask) + eventsFor(urlTask)).toBe(eventsBefore);
      expect(sse.evidence()).toHaveLength(0);
      sse.stop();
    }
  });

  it("404s a cross-Habitat source", async () => {
    const { taskId: urlTask } = makeTask(teamAHabitatId, "tew-cross-wrong-src");
    const { taskId: otherHabitatTask } = makeTask(teamBHabitatId, "tew-cross-other-habitat");
    const foreign = seedLink("task", otherHabitatTask);
    const before = linkRow(foreign.id);

    const res = await wire(
      "/api/v1",
      "POST",
      `/tasks/${urlTask}/code-evidence/${foreign.id}/correct`,
      { agentKey, body: CORRECT_BODY },
    );
    expect(res.status).toBe(404);
    expect(linkRow(foreign.id)).toEqual(before);
  });

  it("404s a Mission row whose targetId text equals the URL Task id (polymorphic discriminator)", async () => {
    for (const prefix of PREFIXES) {
      const { taskId } = makeTask(teamAHabitatId, `tew-mission-disc-${prefix}`);
      // A direct-row seed: the Mission owns a link whose targetId *text* is the
      // Task's id. String equality must not be mistaken for polymorphic identity.
      const impostor = seedLink("mission", taskId);
      const before = linkRow(impostor.id);
      const sse = collectSse([teamAHabitatId]);

      const res = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${impostor.id}/correct`,
        {
          agentKey,
          body: CORRECT_BODY,
        },
      );
      expect(res.status, `mission impostor ${prefix}`).toBe(404);
      expect(linkRow(impostor.id)).toEqual(before);
      expect(linkRow(impostor.id)!.targetType).toBe("mission");
      expect(sse.evidence()).toHaveLength(0);
      sse.stop();
    }
  });

  it("404s a known wrong source even with an invalid replacement — no reference probe precedes containment", async () => {
    const { taskId: urlTask } = makeTask(teamAHabitatId, "tew-wrong-plus-bad-ref");
    const { taskId: otherTask } = makeTask(teamAHabitatId, "tew-wrong-plus-bad-ref-other");
    const foreign = seedLink("task", otherTask);
    const before = linkRow(foreign.id);

    const res = await wire(
      "/api/v1",
      "POST",
      `/tasks/${urlTask}/code-evidence/${foreign.id}/correct`,
      {
        agentKey,
        body: { status: "superseded", reason: "r", replacementLinkId: "no-such-link" },
      },
    );
    expect(res.status, "wrong source outranks reference existence").toBe(404);
    expect(linkRow(foreign.id)).toEqual(before);
  });

  it("500s a matching source with a nonexistent replacement, leaving the source row unchanged", async () => {
    const { taskId } = makeTask(teamAHabitatId, "tew-bad-ref");
    const link = seedLink("task", taskId);
    const before = linkRow(link.id);
    const eventsBefore = eventsFor(taskId);

    const res = await wire("/api/v1", "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
      agentKey,
      body: { status: "superseded", reason: "r", replacementLinkId: "no-such-link" },
    });
    expect(res.status).toBe(500);
    expect(linkRow(link.id)).toEqual(before);
    // The mutation is rolled back and no route audit was written.
    expect(eventsFor(taskId)).toBe(eventsBefore);
  });
});

describe("success projections, repetition and publication asymmetry", () => {
  it("returns the raw stored row with exact actor and preserved provenance on both prefixes", async () => {
    for (const prefix of PREFIXES) {
      const { taskId } = makeTask(teamAHabitatId, `tew-proj-${prefix}`);
      const link = seedLink("task", taskId);
      const replacement = seedLink("task", taskId);

      const res = await wire(prefix, "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
        token: memberViewerJwt,
        body: { status: "superseded", reason: "dup", replacementLinkId: replacement.id },
      });
      expect(res.status).toBe(200);
      const body = res.body.link;
      // Raw stored row: identity columns, not the mapped GET projection.
      expect(body.id).toBe(link.id);
      expect(body.targetType).toBe("task");
      expect(body.targetId).toBe(taskId);
      expect(body.correctedByType).toBe("human");
      expect(body.correctedById).toBe("tew-member-viewer");
      expect(body.correctionReason).toBe("dup");
      expect(body.replacementLinkId).toBe(replacement.id);
      expect(typeof body.correctedAt).toBe("string");
      // Original evidence identity, provenance and metadata survive.
      expect(body.evidenceType).toBe(link.evidenceType);
      expect(body.evidenceId).toBe(link.evidenceId);
      expect(body.title).toBe(link.title);
      expect(body.externalUrl).toBe(link.externalUrl);
      expect(body.linkedByType).toBe(link.linkedByType);
      expect(body.linkedById).toBe(link.linkedById);
      expect(body.linkedAt).toBe(link.linkedAt);
      expect(body.linkSource).toBe(link.linkSource);
      expect(body.linkSources).toEqual(link.linkSources);
      expect(body.verificationState).toBe(link.verificationState);
      expect(body.confidence).toBe(link.confidence);
      expect(body.allowExternalRepository).toBe(true);
      expect(body.metadata).toEqual(link.metadata);
      // No replacement content expansion: the response is the source row only.
      expect(body.title).not.toBe(replacement.title);
      expect(Object.keys(body)).not.toContain("replacement");

      // Repeat correction stays 200, clears an omitted replacement, and
      // appends exactly one NEW audit row without rewriting the earlier ones.
      const auditRows = () =>
        getDb()
          .select()
          .from(taskEvents)
          .where(eq(taskEvents.taskId, taskId))
          .all()
          .map((e: any) => JSON.parse(JSON.stringify(e)));
      const beforeEvents = eventsFor(taskId);
      const priorEvents = auditRows();
      expect(beforeEvents, "repetition proof needs a nonempty audit denominator").toBeGreaterThan(
        0,
      );

      const again = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${link.id}/correct`,
        {
          token: memberViewerJwt,
          body: { status: "removed", reason: "second" },
        },
      );
      expect(again.status).toBe(200);
      expect(again.body.link.status).toBe("removed");
      expect(again.body.link.replacementLinkId).toBeNull();

      const afterEvents = auditRows();
      expect(afterEvents.length, "a repeat correction appends exactly one audit row").toBe(
        beforeEvents + 1,
      );
      const appended = afterEvents[afterEvents.length - 1]!;
      expect((appended as any).action).toBe("code_evidence_corrected");
      expect((appended as any).actorType).toBe("human");
      expect((appended as any).actorId).toBe("tew-member-viewer");
      expect(JSON.stringify((appended as any).metadata)).toContain(link.id);
      // No pre-existing audit row was rewritten by the repeat.
      expect(afterEvents.slice(0, beforeEvents)).toEqual(priorEvents);
    }
  });

  it("accepts empty/whitespace reasons, keeps customReason unused, and strips unknown fields", async () => {
    const { taskId } = makeTask(teamAHabitatId, "tew-reasons");
    const blank = seedLink("task", taskId);
    const res = await wire(
      "/api/v1",
      "POST",
      `/tasks/${taskId}/code-evidence/${blank.id}/correct`,
      {
        agentKey,
        body: {
          status: "removed",
          reason: "   ",
          customReason: "must not be stored",
          targetType: "mission",
          targetId: "somewhere-else",
          auditSource: "spoofed",
          version: 99,
        },
      },
    );
    expect(res.status).toBe(200);
    expect(res.body.link.correctionReason).toBe("   ");
    expect(res.body.link.targetType).toBe("task");
    expect(res.body.link.targetId).toBe(taskId);
    expect(Object.keys(res.body.link)).not.toContain("customReason");
    expect(Object.keys(res.body.link)).not.toContain("auditSource");
    expect(linkRow(blank.id)!.correctionReason).toBe("   ");
  });

  it("resolves a gap with raw reporter/resolver fields and no task.updated publication", async () => {
    for (const prefix of PREFIXES) {
      const { taskId } = makeTask(teamAHabitatId, `tew-gap-${prefix}`);
      const gap = seedGap("task", taskId);
      const sse = collectSse([teamAHabitatId]);

      const res = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`,
        { agentKey, body: { resolutionReason: "configured now" } },
      );
      expect(res.status, `gap resolve ${prefix}`).toBe(200);
      const body = res.body.gap;
      expect(body.id).toBe(gap.id);
      expect(body.status).toBe("resolved");
      expect(body.targetType).toBe("task");
      expect(body.targetId).toBe(taskId);
      // Raw reporter columns, not a mapped reportedBy object.
      expect(body.reportedByType).toBe("system");
      expect(body.reportedById).toBe("orcy");
      expect(body.reportedAt).toBe(gap.reportedAt);
      expect(body.reasonCode).toBe(gap.reasonCode);
      expect(body.metadata).toEqual(gap.metadata);
      expect(body.resolvedByType).toBe("agent");
      expect(body.resolvedById).toBe(agentId);
      expect(body.resolutionReason).toBe("configured now");

      const evidence = sse.evidence();
      const updates = evidence.filter((e) => e.type === "code_evidence.updated");
      expect(updates).toHaveLength(1);
      expect(updates[0]!.data).toMatchObject({
        targetType: "task",
        targetId: taskId,
        evidenceLinkId: "",
        changeKind: "verified",
      });
      // Gap resolution publishes no task.updated — the existing asymmetry.
      expect(evidence.filter((e) => e.type === "task.updated")).toHaveLength(0);
      sse.stop();

      // Repetition stays 200 and overwrites the latest envelope.
      const again = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`,
        { agentKey, body: { resolutionReason: "re-resolved" } },
      );
      expect(again.status).toBe(200);
      expect(again.body.gap.resolutionReason).toBe("re-resolved");
      expect(again.body.gap.reportedById).toBe("orcy");
    }
  });

  it("correction publishes code_evidence.updated with the actual source and then task.updated", async () => {
    const { taskId } = makeTask(teamAHabitatId, "tew-correct-sse");
    const link = seedLink("task", taskId);
    const sse = collectSse([teamAHabitatId]);

    const res = await wire("/api/v1", "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
      agentKey,
      body: CORRECT_BODY,
    });
    expect(res.status).toBe(200);

    const evidence = sse.evidence();
    const updates = evidence.filter((e) => e.type === "code_evidence.updated");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data).toMatchObject({
      targetType: "task",
      targetId: taskId,
      evidenceLinkId: link.id,
      changeKind: "corrected",
    });
    expect(evidence.filter((e) => e.type === "task.updated").length).toBeGreaterThanOrEqual(1);
    sse.stop();
  });

  it("any admitted actor may correct another actor's link or resolve another actor's gap", async () => {
    const { taskId } = makeTask(teamAHabitatId, "tew-cross-actor");
    const link = seedLink("task", taskId);
    const gap = seedGap("task", taskId);

    const corrected = await wire(
      "/api/v1",
      "POST",
      `/tasks/${taskId}/code-evidence/${link.id}/correct`,
      {
        agentKey,
        body: CORRECT_BODY,
      },
    );
    expect(corrected.status).toBe(200);
    expect(corrected.body.link.correctedByType).toBe("agent");

    const resolved = await wire(
      "/api/v1",
      "POST",
      `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`,
      { token: memberAdminJwt, body: RESOLVE_BODY },
    );
    expect(resolved.status).toBe(200);
    expect(resolved.body.gap.resolvedByType).toBe("human");
    expect(resolved.body.gap.resolvedById).toBe("tew-member-admin");
  });
});

describe("Mission callers — shared-signature regression only (no new admission)", () => {
  it("200s the exact pair and 404s the wrong type/id on both prefixes", async () => {
    for (const prefix of PREFIXES) {
      const { taskId, missionId } = makeTask(teamAHabitatId, `tew-mission-${prefix}`);
      const missionLink = seedLink("mission", missionId);
      const missionGap = seedGap("mission", missionId);
      // A Task row whose targetId text equals the Mission id: the reverse
      // discriminator.
      const taskImpostor = seedLink("task", missionId);
      const impostorBefore = linkRow(taskImpostor.id);

      const corrected = await wire(
        prefix,
        "POST",
        `/missions/${missionId}/code-evidence/${missionLink.id}/correct`,
        { agentKey, body: CORRECT_BODY },
      );
      expect(corrected.status, `mission correct ${prefix}`).toBe(200);
      expect(corrected.body.link.id).toBe(missionLink.id);
      expect(corrected.body.link.targetType).toBe("mission");
      expect(corrected.body.link.targetId).toBe(missionId);

      const resolved = await wire(
        prefix,
        "POST",
        `/missions/${missionId}/code-evidence/gaps/${missionGap.id}/resolve`,
        { agentKey, body: RESOLVE_BODY },
      );
      expect(resolved.status, `mission resolve ${prefix}`).toBe(200);
      expect(resolved.body.gap.id).toBe(missionGap.id);
      expect(resolved.body.gap.targetType).toBe("mission");

      const wrongType = await wire(
        prefix,
        "POST",
        `/missions/${missionId}/code-evidence/${taskImpostor.id}/correct`,
        { agentKey, body: CORRECT_BODY },
      );
      expect(wrongType.status, `mission wrong type ${prefix}`).toBe(404);
      expect(linkRow(taskImpostor.id)).toEqual(impostorBefore);

      const wrongId = await wire(
        prefix,
        "POST",
        `/missions/${missionId}/code-evidence/${seedLink("mission", taskId).id}/correct`,
        { agentKey, body: CORRECT_BODY },
      );
      expect(wrongId.status, `mission wrong id ${prefix}`).toBe(404);

      const wrongGap = await wire(
        prefix,
        "POST",
        `/missions/${missionId}/code-evidence/gaps/${seedGap("task", missionId).id}/resolve`,
        { agentKey, body: RESOLVE_BODY },
      );
      expect(wrongGap.status, `mission wrong gap ${prefix}`).toBe(404);

      const missingMission = await wire(
        prefix,
        "POST",
        `/missions/no-such-mission/code-evidence/${missionLink.id}/correct`,
        { agentKey, body: CORRECT_BODY },
      );
      expect(missingMission.status).toBe(404);
    }
  });
});

describe("served MCP over stdio — agent identity, wire names and error mapping", () => {
  it("corrects and resolves through the served tools with prefixed wire fields", async () => {
    const { taskId } = makeTask(teamAHabitatId, "tew-mcp-ok");
    const link = seedLink("task", taskId);
    const gap = seedGap("task", taskId);

    const corrected = await callTool("orcy_habitat_task", {
      action: "correct-code-evidence-link",
      taskId,
      linkId: link.id,
      linkStatus: "incorrect",
      correctionReason: "mcp wire reason",
      customReason: "still unused",
    });
    expect(corrected.isError).toBeFalsy();
    const correctedPayload = JSON.parse(toolText(corrected));
    // The served tool decodes the raw `{link: rawRow}` wrapper.
    const correctedLink = correctedPayload.link ?? correctedPayload;
    expect(correctedLink.id).toBe(link.id);
    expect(correctedLink.status).toBe("incorrect");
    expect(correctedLink.correctionReason).toBe("mcp wire reason");
    expect(correctedLink.targetType).toBe("task");
    expect(correctedLink.targetId).toBe(taskId);
    // MCP authenticates with the real agent key, so attribution is the agent.
    expect(correctedLink.correctedByType).toBe("agent");
    expect(correctedLink.correctedById).toBe(agentId);

    const resolved = await callTool("orcy_habitat_task", {
      action: "resolve-gap",
      taskId,
      gapId: gap.id,
      resolutionReason: "mcp resolved",
    });
    expect(resolved.isError).toBeFalsy();
    const resolvedPayload = JSON.parse(toolText(resolved));
    const resolvedGap = resolvedPayload.gap ?? resolvedPayload;
    expect(resolvedGap.id).toBe(gap.id);
    expect(resolvedGap.status).toBe("resolved");
    expect(resolvedGap.resolutionReason).toBe("mcp resolved");
    expect(resolvedGap.targetType).toBe("task");
    expect(resolvedGap.targetId).toBe(taskId);
  });

  it("isError on a missing source and on a wrong-target source, with the DB unchanged", async () => {
    const { taskId: urlTask } = makeTask(teamAHabitatId, "tew-mcp-wrong");
    const { taskId: otherTask } = makeTask(teamAHabitatId, "tew-mcp-other");
    const foreign = seedLink("task", otherTask);
    const before = linkRow(foreign.id);

    const wrongSource = await callTool("orcy_habitat_task", {
      action: "correct-code-evidence-link",
      taskId: urlTask,
      linkId: foreign.id,
      linkStatus: "removed",
      correctionReason: "wrong target",
    });
    expect(wrongSource.isError).toBe(true);
    expect(linkRow(foreign.id)).toEqual(before);

    const missingSource = await callTool("orcy_habitat_task", {
      action: "correct-code-evidence-link",
      taskId: urlTask,
      linkId: "no-such-link",
      linkStatus: "removed",
      correctionReason: "missing",
    });
    expect(missingSource.isError).toBe(true);

    const missingTask = await callTool("orcy_habitat_task", {
      action: "resolve-gap",
      taskId: "no-such-task",
      gapId: seedGap("task", urlTask).id,
      resolutionReason: "nope",
    });
    expect(missingTask.isError).toBe(true);
  });

  it("records the MCP tool call provenance on the Task event", async () => {
    const { taskId } = makeTask(teamAHabitatId, "tew-mcp-provenance");
    const link = seedLink("task", taskId);

    const res = await callTool("orcy_habitat_task", {
      action: "correct-code-evidence-link",
      taskId,
      linkId: link.id,
      linkStatus: "superseded",
      correctionReason: "provenance",
    });
    expect(res.isError).toBeFalsy();

    const events = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .all()
      .filter((e: any) => e.action === "code_evidence_corrected");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const latest = events[events.length - 1]!;
    expect((latest as any).actorType).toBe("agent");
    expect((latest as any).actorId).toBe(agentId);
    expect(JSON.stringify(latest)).toContain("corrected");
  });
});

/**
 * F1 — the two commissioned failure stages that were previously carried by
 * source reading alone.
 *
 * Stage order inside each handler is load-bearing and is what these tests
 * observe rather than assume: admission (`authorizeTaskAccess`) → source
 * pre-read → source UPDATE (autocommit, so already durable) → throwing
 * `createEvent` → `code_evidence.updated` → `task.updated` (correction only).
 *
 * The audit triggers are scoped to BOTH the selected action AND the actual
 * target Task id, so an unrelated setup or fan-out insert can never supply the
 * failure. Nothing here closes the database or mocks an audit fault: the 500
 * comes from a real SQLite abort raised inside the real statement.
 */
describe("F1a — real audit-INSERT abort after a committed source UPDATE", () => {
  /** Aborts only the one audit insert this operation performs. */
  function armAuditAbort(trigger: string, action: string, taskId: string): void {
    getDb().run(
      sql.raw(`
      CREATE TRIGGER ${trigger} BEFORE INSERT ON task_events
      WHEN NEW.action = '${action}' AND NEW.task_id = '${taskId}'
      BEGIN
        SELECT RAISE(ABORT, 'tew simulated audit abort');
      END;
    `),
    );
  }

  for (const prefix of PREFIXES) {
    it(`correction: 500 with the source envelope committed, no audit row, then a replay that appends one (${prefix})`, async () => {
      const { taskId } = makeTask(teamAHabitatId, `tew-audit-correct-${prefix}`);
      const link = seedLink("task", taskId);
      const sse = collectSse([teamAHabitatId]);

      // Establish a nonempty audit denominator with one real successful write
      // first, so the abort below is proven to affect only the second insert.
      const seeded = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${link.id}/correct`,
        { agentKey: faultAgentKey, body: { status: "incorrect", reason: "seed audit row" } },
      );
      expect(seeded.status).toBe(200);
      const beforeEvents = eventsFor(taskId);
      expect(beforeEvents, "audit-delta proof needs a nonempty starting denominator").toBe(1);
      const beforeRows = sse.evidence().length;

      armAuditAbort("tew_abort_correct", "code_evidence_corrected", taskId);
      try {
        const res = await wire(
          prefix,
          "POST",
          `/tasks/${taskId}/code-evidence/${link.id}/correct`,
          { agentKey: faultAgentKey, body: { status: "removed", reason: "triggered audit abort" } },
        );
        expect(res.status, "the throwing audit insert surfaces 500").toBe(500);
        // Observable code/entity only — the handler does not expose the SQL cause.
        expect(res.body.code).toBe("REPOSITORY_ERROR");
        expect(res.body.error).toBeTruthy();

        // The source UPDATE committed BEFORE the failing audit insert.
        const committed = linkRow(link.id)!;
        expect(committed.status).toBe("removed");
        expect(committed.correctionReason).toBe("triggered audit abort");
        expect(committed.correctedByType).toBe("agent");
        expect(committed.correctedById).toBe(faultAgentId);
        expect(committed.correctedAt).toBeTruthy();
        // No audit row was appended and nothing was published.
        expect(eventsFor(taskId), "the aborted audit insert writes no row").toBe(beforeEvents);
        expect(
          sse.evidence().slice(beforeRows),
          "no operation SSE publishes once the audit insert throws",
        ).toHaveLength(0);
      } finally {
        getDb().run(sql.raw(`DROP TRIGGER tew_abort_correct`));
        sse.stop();
      }

      // Dropping the fault and replaying proves the 500 was the audit fault and
      // not a collapsed zero-match or an auth/entry failure.
      const afterEvents = eventsFor(taskId);
      const replay = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${link.id}/correct`,
        { agentKey: faultAgentKey, body: { status: "incorrect", reason: "replayed after audit fix" } },
      );
      expect(replay.status).toBe(200);
      const replayed = linkRow(link.id)!;
      // Same row, same envelope overwritten — not a second link record.
      expect(replayed.id).toBe(link.id);
      expect(replayed.status).toBe("incorrect");
      expect(replayed.correctionReason).toBe("replayed after audit fix");
      expect(eventsFor(taskId), "the replay appends exactly one audit row").toBe(afterEvents + 1);
    });

    it(`gap resolution: 500 with the source envelope committed, no audit row, then a replay that appends one (${prefix})`, async () => {
      const { taskId } = makeTask(teamAHabitatId, `tew-audit-gap-${prefix}`);
      const gap = seedGap("task", taskId);
      const sse = collectSse([teamAHabitatId]);

      // One real successful resolution first, so the abort below is proven to
      // affect only the second audit insert.
      const seeded = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`,
        { agentKey: faultAgentKey, body: { resolutionReason: "seed audit row" } },
      );
      expect(seeded.status).toBe(200);
      const beforeEvents = eventsFor(taskId);
      expect(beforeEvents).toBe(1);
      const beforeRows = sse.evidence().length;

      armAuditAbort("tew_abort_gap", "code_evidence_gap_resolved", taskId);
      try {
        const res = await wire(
          prefix,
          "POST",
          `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`,
          { agentKey: faultAgentKey, body: { resolutionReason: "triggered audit abort" } },
        );
        expect(res.status).toBe(500);
        expect(res.body.code).toBe("REPOSITORY_ERROR");

        const committed = gapRow(gap.id)!;
        expect(committed.status).toBe("resolved");
        expect(committed.resolutionReason).toBe("triggered audit abort");
        expect(committed.resolvedByType).toBe("agent");
        expect(committed.resolvedById).toBe(faultAgentId);
        expect(committed.resolvedAt).toBeTruthy();
        // Reporter provenance retained on the same row.
        expect(committed.reportedById).toBe("orcy");
        expect(eventsFor(taskId)).toBe(beforeEvents);
        expect(sse.evidence().slice(beforeRows)).toHaveLength(0);
        // Gap resolution publishes no task.updated even on the success path.
        expect(
          sse
            .evidence()
            .slice(beforeRows)
            .filter((e) => e.type === "task.updated"),
        ).toHaveLength(0);
      } finally {
        getDb().run(sql.raw(`DROP TRIGGER tew_abort_gap`));
        sse.stop();
      }

      const afterEvents = eventsFor(taskId);
      const replay = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`,
        { agentKey: faultAgentKey, body: { resolutionReason: "replayed after audit fix" } },
      );
      expect(replay.status).toBe(200);
      expect(gapRow(gap.id)!.resolutionReason).toBe("replayed after audit fix");
      expect(eventsFor(taskId)).toBe(afterEvents + 1);
    });
  }
});

/**
 * F1b — the subscriber boundary.
 *
 * `sseBroadcaster.publish` walks its handler `Set` synchronously with no
 * try/catch, so the first throwing handler aborts publication of that event.
 * These are CONFIGURED SYNCHRONOUS SUBSCRIBER-BOUNDARY characterizations of
 * this process's broadcaster: they are not network-delivery guarantees, not an
 * outbox, and not a claim that any subscriber's own work is transactional.
 *
 * Every fixture uses a fresh personal Habitat (agents admit on any existing
 * habitat) so no other test's subscription can be in the Set, registers
 * handlers in a known order, settles and baselines any publication caused by
 * setup before the operation under test, and unsubscribes every registration
 * in `finally`.
 */
describe("F1b — throwing SSE subscriber at each publication stage", () => {
  interface Subscriber {
    name: string;
    throwOn: (type: string) => boolean;
    seen: string[];
  }

  /** Registers in order, runs `fn`, and always unsubscribes every handler. */
  async function withOrderedSubscribers<T>(
    habitatId: string,
    specs: Array<{ name: string; throwOn: string | null }>,
    fn: () => Promise<T>,
  ): Promise<{ result: T; subscribers: Subscriber[] }> {
    const subscribers: Subscriber[] = specs.map((s) => ({
      name: s.name,
      throwOn: (type: string) => s.throwOn === type,
      seen: [],
    }));
    const unsubs: Array<() => void> = [];
    try {
      for (const sub of subscribers) {
        unsubs.push(
          sseBroadcaster.subscribe(habitatId, (event: any) => {
            sub.seen.push(event.type);
            if (sub.throwOn(event.type)) {
              throw new Error(`tew subscriber ${sub.name} failed on ${event.type}`);
            }
          }),
        );
      }
      // Settle and baseline: nothing published during fixture setup may count
      // toward the operation under test.
      for (const sub of subscribers) sub.seen.length = 0;
      const result = await fn();
      return { result, subscribers };
    } finally {
      for (const unsub of unsubs) unsub();
    }
  }

  function freshHabitat(label: string): string {
    return habitatRepo.createHabitat({ name: `tew-${label}-${Date.now()}-${Math.random()}` }).id;
  }

  for (const prefix of PREFIXES) {
    it(`correction: a first-evidence-publication throw yields 500 with source+audit durable and no task.updated (${prefix})`, async () => {
      const habitatId = freshHabitat(`sse-first-correction-${prefix}`);
      const { taskId } = makeTask(habitatId, `tew-sse-first-correction-${prefix}`);
      const link = seedLink("task", taskId);

      // Control: the identical request with no throwing subscriber is 200, so
      // the 500 below is attributable to the subscriber and not to the request.
      const control = seedLink("task", taskId);
      const controlRes = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${control.id}/correct`,
        { agentKey: faultAgentKey, body: CORRECT_BODY },
      );
      expect(
        controlRes.status,
        `no-subscriber control for the same request: ${controlRes.text}`,
      ).toBe(200);

      // Nonempty audit denominator established by the control, so the delta
      // below (+1 per successful operation) is what proves the append.
      const beforeEvents = eventsFor(taskId);
      expect(beforeEvents).toBe(1);

      const { result, subscribers } = await withOrderedSubscribers(
        habitatId,
        [
          { name: "early", throwOn: null },
          { name: "thrower", throwOn: "code_evidence.updated" },
          { name: "late", throwOn: null },
        ],
        () =>
          wire(prefix, "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
            agentKey: faultAgentKey,
            body: CORRECT_BODY,
          }),
      );

      expect(result.status, "a throwing evidence subscriber surfaces 500").toBe(500);
      // Source mutation and audit both stayed durable.
      expect(linkRow(link.id)!.status).toBe("incorrect");
      expect(eventsFor(taskId), "the audit insert already committed").toBe(beforeEvents + 1);
      const audit = getDb()
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId))
        .all()
        .filter((e: any) => e.action === "code_evidence_corrected");
      // One row from the no-subscriber control plus exactly one from the
      // throwing attempt: the audit insert committed before publication began.
      expect(audit).toHaveLength(2);
      const latest = audit[audit.length - 1]!;
      expect((latest as any).actorId).toBe(faultAgentId);
      expect(JSON.stringify((latest as any).metadata)).toContain(link.id);

      const [early, thrower, late] = subscribers;
      expect(early!.seen).toEqual(["code_evidence.updated"]);
      expect(thrower!.seen).toEqual(["code_evidence.updated"]);
      // Publication of that event aborted at the thrower, so the handler
      // registered after it never observed the event…
      expect(late!.seen, "publication stops at the first throwing handler").toEqual([]);
      // …and correction's later task.updated never happened.
      expect(early!.seen).not.toContain("task.updated");
      expect(late!.seen).not.toContain("task.updated");
    });

    it(`gap resolution: a first-evidence-publication throw yields 500 with source+audit durable (${prefix})`, async () => {
      const habitatId = freshHabitat(`sse-first-gap-${prefix}`);
      const { taskId } = makeTask(habitatId, `tew-sse-first-gap-${prefix}`);
      const gap = seedGap("task", taskId);

      // Control: the identical request with no throwing subscriber is 200.
      const controlGap = seedGap("task", taskId);
      const controlRes = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/gaps/${controlGap.id}/resolve`,
        { agentKey: faultAgentKey, body: RESOLVE_BODY },
      );
      expect(
        controlRes.status,
        `no-subscriber control for the same request: ${controlRes.text}`,
      ).toBe(200);

      // Nonempty audit denominator established by the control.
      const beforeEvents = eventsFor(taskId);
      expect(beforeEvents).toBe(1);

      const { result, subscribers } = await withOrderedSubscribers(
        habitatId,
        [
          { name: "early", throwOn: null },
          { name: "thrower", throwOn: "code_evidence.updated" },
          { name: "late", throwOn: null },
        ],
        () =>
          wire(prefix, "POST", `/tasks/${taskId}/code-evidence/gaps/${gap.id}/resolve`, {
            agentKey: faultAgentKey,
            body: RESOLVE_BODY,
          }),
      );

      expect(result.status).toBe(500);
      expect(gapRow(gap.id)!.status).toBe("resolved");
      expect(gapRow(gap.id)!.resolvedById).toBe(faultAgentId);
      expect(eventsFor(taskId)).toBe(beforeEvents + 1);
      const gapAudit = getDb()
        .select()
        .from(taskEvents)
        .where(eq(taskEvents.taskId, taskId))
        .all()
        .filter((e: any) => e.action === "code_evidence_gap_resolved");
      // Control row + the throwing attempt's row: the audit insert committed
      // before publication began.
      expect(gapAudit, "the audit row is durable at the subscriber stage").toHaveLength(2);
      const latestGap = gapAudit[gapAudit.length - 1]!;
      expect((latestGap as any).actorId).toBe(faultAgentId);
      expect(JSON.stringify((latestGap as any).metadata)).toContain(gap.id);
      const [early, thrower, late] = subscribers;
      expect(early!.seen).toEqual(["code_evidence.updated"]);
      expect(thrower!.seen).toEqual(["code_evidence.updated"]);
      expect(late!.seen).toEqual([]);
      // The gap path publishes no task.updated even before the throw, and the
      // throw adds nothing.
      expect(early!.seen).not.toContain("task.updated");
      expect(late!.seen).not.toContain("task.updated");
    });

    it(`correction only: a later task.updated throw yields 500 after the evidence event was already published (${prefix})`, async () => {
      const habitatId = freshHabitat(`sse-late-correction-${prefix}`);
      const { taskId } = makeTask(habitatId, `tew-sse-late-correction-${prefix}`);
      const link = seedLink("task", taskId);

      // Control: the identical request with no throwing subscriber is 200, so
      // the 500 below is attributable to the subscriber and not to the request.
      const control = seedLink("task", taskId);
      const controlRes = await wire(
        prefix,
        "POST",
        `/tasks/${taskId}/code-evidence/${control.id}/correct`,
        { agentKey: faultAgentKey, body: CORRECT_BODY },
      );
      expect(
        controlRes.status,
        `no-subscriber control for the same request: ${controlRes.text}`,
      ).toBe(200);

      // Nonempty audit denominator established by the control, so the delta
      // below (+1 per successful operation) is what proves the append.
      const beforeEvents = eventsFor(taskId);
      expect(beforeEvents).toBe(1);

      const { result, subscribers } = await withOrderedSubscribers(
        habitatId,
        [
          { name: "early", throwOn: null },
          { name: "thrower", throwOn: "task.updated" },
          { name: "late", throwOn: null },
        ],
        () =>
          wire(prefix, "POST", `/tasks/${taskId}/code-evidence/${link.id}/correct`, {
            agentKey: faultAgentKey,
            body: CORRECT_BODY,
          }),
      );

      expect(result.status, "a throwing task.updated subscriber surfaces 500").toBe(500);
      expect(linkRow(link.id)!.status).toBe("incorrect");
      expect(eventsFor(taskId), "source and audit are both durable at this stage").toBe(
        beforeEvents + 1,
      );

      const [early, thrower, late] = subscribers;
      // The evidence publication completed for everyone registered before the
      // thrower, so the late handler observed it too.
      expect(early!.seen).toEqual(["code_evidence.updated", "task.updated"]);
      expect(thrower!.seen).toEqual(["code_evidence.updated", "task.updated"]);
      expect(late!.seen, "the late handler saw the first event but not the throwing one").toEqual([
        "code_evidence.updated",
      ]);
    });
  }
});
