/**
 * Four agent-only Subtask operations (nested-resource-contract, Sol ACCEPT
 * with amendments; code-review fixup) — REAL HTTP wire matrix on BOTH
 * served prefixes (`/api/v1`, deprecated `/api`) plus served MCP
 * compatibility.
 *
 * Scope of claims (author evidence, not universal Task isolation):
 *  - GET/POST `/tasks/:taskId/subtasks`, PATCH/DELETE
 *    `/tasks/:taskId/subtasks/:subtaskId` resolve the URL Task's actual
 *    Mission → Habitat and enforce the shared habitat-access predicate
 *    before any row is read or written. PATCH/DELETE additionally require
 *    the exact child/URL-parent pair at the final SQL statement.
 *    Intended deltas: GET unknown Task 200-empty → 404; POST under a Task
 *    with missing Mission/Habitat ancestry (only reachable via corrupted FK
 *    state) creation → 404; cross-parent PATCH 200 → 404; cross-parent
 *    DELETE 204 → 404; absent/null body / missing / non-string title → 400
 *    rather than a dereference fault.
 *  - Preserved: agent-only transport (401 for every human JWT — team member
 *    of any role, other-team member, nonmember global admin, personal-
 *    Habitat human — plus anonymous, invalid local key and VALID remote-only
 *    credentials); local-agent admission on team and personal Habitats for
 *    genuinely ASSIGNED Tasks and unassigned alike; response shapes;
 *    POST title-400 precedence before Task admission.
 *
 * Review-fixup discriminations pinned here:
 *  - EVERY local-agent actor performs ALL FOUR operations on team AND
 *    personal Tasks through BOTH prefixes, including a Task whose
 *    assignedAgentId IS the calling agent (local agents carry no Habitat
 *    binding; none is invented).
 *  - The known-child cross-parent negative matrix runs BOTH methods through
 *    BOTH prefixes in the SAME and a DIFFERENT Habitat, snapshotting the
 *    complete child row, both parents' child lists and publication counts.
 *  - False/0/null PATCH transitions start from true/nonzero/assigned state
 *    and assert BOTH the response and the persisted row — an
 *    ignore-falsy mapper mutant fails these.
 *  - Publication checks inspect the FULL spy-wrapped call tuple — actual
 *    Habitat ID, event type, actual Task ID and child payload / deleted
 *    child ID — so a wrong-Habitat publication mutant fails these. The spy
 *    wraps (does not suppress) the real broadcaster: publication is proven,
 *    subscriber delivery is not; no outbox guarantee is claimed.
 *  - Corrupted-ancestry fixtures restore FK enforcement in `finally` and
 *    prove the surviving ancestry plus re-enabled enforcement functionally.
 *
 * Disclosed limits: race-window behaviors (post-lookup reparent or child
 * disappearance between the service pre-read and the final SQL statement,
 * and mutation-statement DB faults) are pinned in
 * `taskSubtaskContainment.test.ts` — single-threaded synchronous request
 * handling cannot interleave them on the wire.
 *
 * No authorization/repository mocks: every request crosses a real TCP
 * socket into the real application; MCP checks drive the spawned server
 * over stdio with a real agent key. The real preHandler per-agent rate
 * limiter (60 req/min/key, keyed before auth resolves request.agent) is
 * live; heavier describes drive their own seeded agents rather than
 * dodging middleware.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
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
import * as subtaskRepo from "../repositories/subtask.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import { missions, habitats, tasks, taskSubtasks } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");
const PREFIXES = ["/api/v1", "/api"] as const;

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let childExit: Promise<void>;

let teamAHabitatId: string;
let teamBHabitatId: string;
let personalHabitatId: string;
let assignedAgentKey: string;
let assignedAgentId: string;
let unboundAgentKey: string;
let ancestryKey: string;
let semanticsKey: string;
let positiveKey: string;
let validRemoteKey: string;

let memberAdminJwt: string;
let memberViewerJwt: string;
let memberBJwt: string;
let nonmemberAdminJwt: string;

// ---- wire helpers ----------------------------------------------------------
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
  return jwt.sign({ sub: userId, username: `tsw-${userId}`, role }, getJwtSecret(), {
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
  if (opts.body !== undefined || opts.rawBody !== undefined)
    headers["Content-Type"] = "application/json";
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
function makeTask(habitatId: string, title: string, createdBy: string): string {
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
    createdBy,
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy }).id;
}

function makeChild(taskId: string, title: string): subtaskRepo.Subtask {
  return subtaskRepo.createSubtask({ taskId, title });
}

function snapshotChild(subtaskId: string) {
  return JSON.parse(
    JSON.stringify(getDb().select().from(taskSubtasks).where(eq(taskSubtasks.id, subtaskId)).all()),
  );
}

function childRowsFor(taskId: string) {
  return getDb().select().from(taskSubtasks).where(eq(taskSubtasks.taskId, taskId)).all();
}

// SSE publication: the spy wraps (does not suppress) the real broadcaster.
// Counters and TUPLE accessors both run on the full recorded call tuples —
// habitat ID, event type, task ID, child payload — so a wrong-Habitat or
// payload-dropping publication mutant fails, not just a missing one.
const publishSpy = vi.spyOn(sseBroadcaster, "publish");
type PubTuple = [string, { type?: string; data?: any }];
function pubsSince(n: number): PubTuple[] {
  return publishSpy.mock.calls.slice(n) as unknown as PubTuple[];
}
function sseCount(type: string, taskId: string): number {
  return publishSpy.mock.calls.filter(
    ([, event]: any) => event?.type === type && event?.data?.taskId === taskId,
  ).length;
}
function sseTotal(): number {
  return publishSpy.mock.calls.length;
}

// ---- MCP client over stdio (newline-delimited JSON-RPC) --------------------
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
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const org = organizationRepo.createOrganization({
    name: "tsw-org",
    slug: `tsw-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "tsw-team-a",
    slug: `tsw-team-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "tsw-team-b",
    slug: `tsw-team-b-${Date.now()}`,
  });
  teamAHabitatId = habitatRepo.createHabitat({ name: "tsw-habitat-a", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "tsw-habitat-b", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "tsw-personal-habitat" }).id;

  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tsw-member-admin", role: "member" });
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tsw-member-viewer", role: "member" });
  teamMemberRepo.addMember({ teamId: teamB.id, userId: "tsw-member-b", role: "member" });

  memberAdminJwt = mint("tsw-member-admin", "admin");
  memberViewerJwt = mint("tsw-member-viewer", "viewer");
  memberBJwt = mint("tsw-member-b", "viewer");
  nonmemberAdminJwt = mint("tsw-nonmember-admin", "admin");

  const assigned = agentRepo.createAgent({
    name: "tsw-agent-assigned",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  assignedAgentId = assigned.agent.id;
  assignedAgentKey = assigned.plainApiKey;

  const unbound = agentRepo.createAgent({
    name: "tsw-agent-unbound",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  unboundAgentKey = unbound.plainApiKey;

  // The heavier describes each drive their own seeded agent (real 60/min
  // pre-auth rate limiter); the MCP child shares the assigned key's budget.
  const spawnKey = (name: string): string =>
    agentRepo.createAgent({ name, type: "claude-code", domain: "fullstack", capabilities: [] })
      .plainApiKey;
  ancestryKey = spawnKey("tsw-agent-ancestry");
  semanticsKey = spawnKey("tsw-agent-semantics");
  positiveKey = spawnKey("tsw-agent-positive");

  const pod = remotePodRepo.createRemotePod({
    habitatId: teamAHabitatId,
    name: "tsw-remote-pod",
  });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamAHabitatId,
    participantType: "remote_orcy",
    displayName: "tsw-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamAHabitatId,
    credentialType: "api",
    label: "tsw-remote-cred",
  }).plaintextSecret;

  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: assignedAgentId,
      ORCY_API_KEY: assignedAgentKey,
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
    clientInfo: { name: "tsw-subtask-access-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  child.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
}, 120_000);

afterAll(async () => {
  publishSpy.mockRestore();
  child.kill("SIGTERM");
  await childExit;
  await app.close();
  closeDb();
});

describe("subtask operations — agent-only transport (both prefixes)", () => {
  it("EVERY local agent (genuinely assigned to the tested Task, and unassigned) performs ALL FOUR operations on team and personal Tasks through both prefixes", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      for (const [label, habitatId] of [
        ["team", teamAHabitatId],
        ["personal", personalHabitatId],
      ] as const) {
        const owner = makeTask(habitatId, `tsw-four-${suffix}-${label}`, "tsw-seed");
        // GENUINE assignment: the tested Task's assignedAgentId IS the
        // assigned agent (no unrelated anchor).
        getDb()
          .update(tasks)
          .set({ assignedAgentId: assignedAgentId })
          .where(eq(tasks.id, owner))
          .run();
        const seeded = makeChild(owner, `tsw-four-seed-${suffix}-${label}`);
        const seededOther = makeChild(owner, `tsw-four-keep-${suffix}-${label}`);

        for (const [agentLabel, key] of [
          ["assigned", assignedAgentKey],
          ["unassigned", unboundAgentKey],
        ] as const) {
          const tag = `${prefix} ${label} ${agentLabel}`;

          const list = await wire(prefix, "GET", `/tasks/${owner}/subtasks`, { agentKey: key });
          expect(list.status, `${tag} GET`).toBe(200);
          expect(list.body.subtasks.map((s: any) => s.id).toSorted()).toEqual(
            [seeded.id, seededOther.id].toSorted(),
          );
          expect(list.body.total).toBe(2);

          const created = await wire(prefix, "POST", `/tasks/${owner}/subtasks`, {
            agentKey: key,
            body: { title: `  tsw-four-${agentLabel}  ` },
          });
          expect(created.status, `${tag} POST`).toBe(201);
          expect(created.body.subtask.title).toBe(`tsw-four-${agentLabel}`);
          expect(created.body.subtask.taskId).toBe(owner);

          const patched = await wire(
            prefix,
            "PATCH",
            `/tasks/${owner}/subtasks/${created.body.subtask.id}`,
            {
              agentKey: key,
              body: { completed: true },
            },
          );
          expect(patched.status, `${tag} PATCH`).toBe(200);
          expect(patched.body.subtask.completed).toBe(true);

          const deleted = await wire(
            prefix,
            "DELETE",
            `/tasks/${owner}/subtasks/${created.body.subtask.id}`,
            {
              agentKey: key,
            },
          );
          expect(deleted.status, `${tag} DELETE`).toBe(204);
          expect(
            childRowsFor(owner)
              .map((r) => r.id)
              .toSorted(),
          ).toEqual([seeded.id, seededOther.id].toSorted());
        }
      }
    }
  }, 60_000);

  it("every human JWT stays 401 on all four operations; denied writes leave child rows and SSE unchanged", async () => {
    const owner = makeTask(teamAHabitatId, "tsw-human-401", "tsw-seed");
    getDb()
      .update(tasks)
      .set({ assignedAgentId: assignedAgentId })
      .where(eq(tasks.id, owner))
      .run();
    const kid = makeChild(owner, "tsw-human-401-child");
    const personalOwner = makeTask(personalHabitatId, "tsw-human-401-personal", "tsw-seed");
    const personalKid = makeChild(personalOwner, "tsw-personal-child");
    const beforeTeam = snapshotChild(kid.id);
    const beforePersonal = snapshotChild(personalKid.id);
    const sseBefore = sseTotal();

    const humanCases: Array<[string, string, string, string]> = [
      ["member-admin", memberAdminJwt, owner, kid.id],
      ["member-viewer", memberViewerJwt, owner, kid.id],
      ["member-b", memberBJwt, owner, kid.id],
      ["nonmember-admin", nonmemberAdminJwt, owner, kid.id],
      ["personal-human", nonmemberAdminJwt, personalOwner, personalKid.id],
    ];

    for (const prefix of PREFIXES) {
      for (const [label, token, taskId, childId] of humanCases) {
        expect(
          (await wire(prefix, "GET", `/tasks/${taskId}/subtasks`, { token })).status,
          `${prefix} ${label} GET`,
        ).toBe(401);
        expect(
          (
            await wire(prefix, "POST", `/tasks/${taskId}/subtasks`, {
              token,
              body: { title: "no" },
            })
          ).status,
          `${prefix} ${label} POST`,
        ).toBe(401);
        expect(
          (
            await wire(prefix, "PATCH", `/tasks/${taskId}/subtasks/${childId}`, {
              token,
              body: { completed: true },
            })
          ).status,
          `${prefix} ${label} PATCH`,
        ).toBe(401);
        expect(
          (await wire(prefix, "DELETE", `/tasks/${taskId}/subtasks/${childId}`, { token })).status,
          `${prefix} ${label} DELETE`,
        ).toBe(401);
      }
    }

    expect(snapshotChild(kid.id)).toEqual(beforeTeam);
    expect(snapshotChild(personalKid.id)).toEqual(beforePersonal);
    expect(sseTotal()).toBe(sseBefore);
  }, 60_000);

  it("anonymous, invalid agent key and VALID remote credential get 401 on all four operations with fields and publications unchanged", async () => {
    const owner = makeTask(teamAHabitatId, "tsw-authn", "tsw-seed");
    const kid = makeChild(owner, "tsw-authn-child");
    const before = snapshotChild(kid.id);
    const sseBefore = sseTotal();

    for (const prefix of PREFIXES) {
      for (const [method, path, opts] of [
        ["GET", `/tasks/${owner}/subtasks`, {}],
        ["POST", `/tasks/${owner}/subtasks`, { body: { title: "no" } }],
        ["PATCH", `/tasks/${owner}/subtasks/${kid.id}`, { body: { completed: true } }],
        ["DELETE", `/tasks/${owner}/subtasks/${kid.id}`, {}],
      ] as const) {
        expect((await wire(prefix, method, path, opts)).status, `${prefix} anon ${method}`).toBe(
          401,
        );
        expect(
          (await wire(prefix, method, path, { ...opts, agentKey: "not-a-key" })).status,
          `${prefix} badkey ${method}`,
        ).toBe(401);
        expect(
          (await wire(prefix, method, path, { ...opts, remoteKey: validRemoteKey })).status,
          `${prefix} remote ${method}`,
        ).toBe(401);
      }
    }

    expect(snapshotChild(kid.id)).toEqual(before);
    expect(sseTotal()).toBe(sseBefore);
  }, 60_000);
});

describe("subtask operations — Task ancestry 404s and credential precedence", () => {
  it("absent Task is 404 for all four operations on both prefixes; parent absence wins over child absence", async () => {
    const missing = "00000000-0000-4000-8000-0000000000b1";
    for (const prefix of PREFIXES) {
      expect(
        (await wire(prefix, "GET", `/tasks/${missing}/subtasks`, { agentKey: ancestryKey })).status,
        `${prefix} GET`,
      ).toBe(404);
      expect(
        (
          await wire(prefix, "POST", `/tasks/${missing}/subtasks`, {
            agentKey: ancestryKey,
            body: { title: "orphan" },
          })
        ).status,
        `${prefix} POST`,
      ).toBe(404);
      expect(
        (
          await wire(
            prefix,
            "PATCH",
            `/tasks/${missing}/subtasks/00000000-0000-4000-8000-0000000000b2`,
            {
              agentKey: ancestryKey,
              body: { completed: true },
            },
          )
        ).status,
        `${prefix} PATCH`,
      ).toBe(404);
      expect(
        (
          await wire(
            prefix,
            "DELETE",
            `/tasks/${missing}/subtasks/00000000-0000-4000-8000-0000000000b3`,
            {
              agentKey: ancestryKey,
            },
          )
        ).status,
        `${prefix} DELETE`,
      ).toBe(404);
    }

    // Missing-TASK credential precedence: the same four-operation matrix as
    // the corrupted-ancestry cases — human JWT and anonymous stay 401 BEFORE
    // Task admission (never a 404 disclosure), valid POST/PATCH bodies, and
    // zero row/publication effects (the snapshot helpers see no child and no
    // events for a nonexistent Task). The agent-404 loop above is preserved.
    await assertAncestryMatrix(missing, "00000000-0000-4000-8000-0000000000b2");
  }, 60_000);

  it("missing Mission and missing Habitat (corrupted-FK fixtures, finally-restored) are 404 for the agent and 401 for human/no-key on ALL FOUR operations, with no row/event effects", async () => {
    // FK cascades normally remove the Task with its Mission, so the missing
    // intermediate levels are only reachable by disabling connection-level FK
    // enforcement, deleting the ancestor row directly, and re-enabling it in
    // a finally on EVERY exit path.
    const db = getDb();

    const noMissionOwner = makeTask(teamAHabitatId, "tsw-no-mission", "tsw-seed");
    const noMissionKid = makeChild(noMissionOwner, "tsw-no-mission-child");
    const missionId = taskRepo.getMissionIdForTask(noMissionOwner)!;
    let noMissionCorrupted = false;
    try {
      db.run(sql`PRAGMA foreign_keys = OFF`);
      db.delete(missions).where(eq(missions.id, missionId)).run();
      noMissionCorrupted = true;

      // The intended ancestry state, asserted before behavior: Task
      // survives, its Mission is genuinely absent (no fake cascade proof).
      expect(taskRepo.getTaskById(noMissionOwner)).not.toBeNull();
      expect(missionRepo.getMissionById(missionId)).toBeNull();
      expect(childRowsFor(noMissionOwner)).toHaveLength(1);

      await assertAncestryMatrix(noMissionOwner, noMissionKid.id);
    } finally {
      db.run(sql`PRAGMA foreign_keys = ON`);
    }
    expect(noMissionCorrupted).toBe(true);
    assertFkEnforcementFunctional();

    const noHabitatFixtureHabitat = habitatRepo.createHabitat({
      name: "tsw-no-habitat-fixture",
    }).id;
    const noHabitatOwner = makeTask(noHabitatFixtureHabitat, "tsw-no-habitat", "tsw-seed");
    const noHabitatKid = makeChild(noHabitatOwner, "tsw-no-habitat-child");
    const noHabitatMissionId = taskRepo.getMissionIdForTask(noHabitatOwner)!;
    const noHabitatMission = missionRepo.getMissionById(noHabitatMissionId)!;
    let noHabitatCorrupted = false;
    try {
      db.run(sql`PRAGMA foreign_keys = OFF`);
      db.delete(habitats).where(eq(habitats.id, noHabitatMission.habitatId)).run();
      noHabitatCorrupted = true;

      expect(taskRepo.getTaskById(noHabitatOwner)).not.toBeNull();
      expect(missionRepo.getMissionById(noHabitatMissionId)).not.toBeNull();
      expect(habitatRepo.getHabitatById(noHabitatMission.habitatId)).toBeNull();
      expect(childRowsFor(noHabitatOwner)).toHaveLength(1);

      await assertAncestryMatrix(noHabitatOwner, noHabitatKid.id);
    } finally {
      db.run(sql`PRAGMA foreign_keys = ON`);
    }
    expect(noHabitatCorrupted).toBe(true);
    assertFkEnforcementFunctional();
  }, 60_000);

  /**
   * Four-operation precedence matrix on a corrupted-ancestry Task:
   * authenticated agent 404 (ancestry admission), human JWT and anonymous
   * 401 (installed auth precedes handler authorization) — well-formed
   * bodies, no row or publication effects.
   */
  async function assertAncestryMatrix(owner: string, childId: string): Promise<void> {
    const before = snapshotChild(childId);
    const sseBefore = sseTotal();
    const ops: Array<[string, string, (o: WireOpts) => WireOpts]> = [
      ["GET", `/tasks/${owner}/subtasks`, (o) => ({ ...o })],
      ["POST", `/tasks/${owner}/subtasks`, (o) => ({ ...o, body: { title: "orphan" } })],
      [
        "PATCH",
        `/tasks/${owner}/subtasks/${childId}`,
        (o) => ({ ...o, body: { completed: true } }),
      ],
      ["DELETE", `/tasks/${owner}/subtasks/${childId}`, (o) => ({ ...o })],
    ];
    for (const prefix of PREFIXES) {
      for (const [method, path, merge] of ops) {
        const agent = await wire(prefix, method, path, merge({ agentKey: ancestryKey }));
        expect(agent.status, `${prefix} agent ${method}`).toBe(404);
        const human = await wire(prefix, method, path, merge({ token: memberAdminJwt }));
        expect(human.status, `${prefix} human ${method}`).toBe(401);
        const anon = await wire(prefix, method, path, merge({}));
        expect(anon.status, `${prefix} anon ${method}`).toBe(401);
      }
    }
    expect(snapshotChild(childId)).toEqual(before);
    expect(sseTotal()).toBe(sseBefore);
  }

  /** FK enforcement restored proof: an FK-violating insert must now throw. */
  function assertFkEnforcementFunctional(): void {
    expect(() =>
      getDb()
        .insert(taskSubtasks)
        .values({
          id: "fk-check-should-fail",
          taskId: "00000000-0000-4000-8000-0000000000ff",
          title: "fk enforcement check",
          completed: false,
          order: 0,
          assigneeId: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  }
});

describe("GET /tasks/:taskId/subtasks — list semantics", () => {
  it("existing Task with no children keeps the full empty counts shape", async () => {
    const owner = makeTask(teamAHabitatId, "tsw-empty", "tsw-seed");
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/tasks/${owner}/subtasks`, { agentKey: semanticsKey });
      expect(res.status, prefix).toBe(200);
      expect(res.body).toEqual({ subtasks: [], total: 0, completedCount: 0 });
    }
  }, 30_000);

  it("nonempty list keeps order ordering, total and completedCount", async () => {
    const owner = makeTask(teamAHabitatId, "tsw-list", "tsw-seed");
    const second = makeChild(owner, "second");
    const first = makeChild(owner, "first");
    getDb().update(taskSubtasks).set({ order: 1 }).where(eq(taskSubtasks.id, second.id)).run();
    getDb()
      .update(taskSubtasks)
      .set({ order: 0, completed: true })
      .where(eq(taskSubtasks.id, first.id))
      .run();

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "GET", `/tasks/${owner}/subtasks`, { agentKey: semanticsKey });
      expect(res.status, prefix).toBe(200);
      expect(res.body.subtasks.map((s: any) => s.id)).toEqual([first.id, second.id]);
      expect(res.body.total).toBe(2);
      expect(res.body.completedCount).toBe(1);
    }
  }, 30_000);
});

describe("POST /tasks/:taskId/subtasks — creation semantics", () => {
  it("on EACH prefix: trims the title, defaults completed=false and order=0, persists taskId and the assignee, and publishes exactly one tuple-addressed event", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tsw-post-${suffix}`, "tsw-seed");
      const sseBefore = sseTotal();

      const res = await wire(prefix, "POST", `/tasks/${owner}/subtasks`, {
        agentKey: semanticsKey,
        body: { title: "  padded title  ", assigneeId: assignedAgentId },
      });

      expect(res.status, prefix).toBe(201);
      expect(res.body.subtask.title).toBe("padded title");
      expect(res.body.subtask.completed).toBe(false);
      expect(res.body.subtask.order).toBe(0);
      expect(res.body.subtask.assigneeId).toBe(assignedAgentId);

      const rows = childRowsFor(owner);
      expect(rows).toHaveLength(1);
      expect(rows[0].taskId).toBe(owner);
      expect(rows[0].title).toBe("padded title");
      expect(rows[0].completed).toBe(false);
      expect(rows[0].order).toBe(0);
      expect(rows[0].assigneeId).toBe(assignedAgentId);

      const pubs = pubsSince(sseBefore);
      expect(pubs).toHaveLength(1);
      expect(pubs[0][0]).toBe(teamAHabitatId);
      expect(pubs[0][1].type).toBe("subtask.created");
      expect(pubs[0][1].data.taskId).toBe(owner);
      expect(pubs[0][1].data.subtask).toMatchObject({
        id: rows[0].id,
        taskId: owner,
        title: "padded title",
        completed: false,
        order: 0,
        assigneeId: assignedAgentId,
      });
    }
  }, 60_000);

  it("absent body, empty object, JSON null body, blank title and non-string title are explicit 400s on both prefixes; title validation precedes Task admission", async () => {
    const missingTask = "00000000-0000-4000-8000-0000000000b6";
    const sseBefore = sseTotal();
    for (const prefix of PREFIXES) {
      // No body at all (no Content-Type): handler sees undefined body.
      const noBody = await wire(prefix, "POST", `/tasks/${missingTask}/subtasks`, {
        agentKey: semanticsKey,
      });
      expect(noBody.status, `${prefix} no-body`).toBe(400);
      expect(noBody.body.error).toBe("Title is required");

      // Present JSON body with no title field.
      const emptyObject = await wire(prefix, "POST", `/tasks/${missingTask}/subtasks`, {
        agentKey: semanticsKey,
        body: {},
      });
      expect(emptyObject.status, `${prefix} empty-object`).toBe(400);
      expect(emptyObject.body.error).toBe("Title is required");

      // Literal JSON null body parses to null.
      const nullBody = await wire(prefix, "POST", `/tasks/${missingTask}/subtasks`, {
        agentKey: semanticsKey,
        rawBody: "null",
      });
      expect(nullBody.status, `${prefix} null-body`).toBe(400);
      expect(nullBody.body.error).toBe("Title is required");

      const blank = await wire(prefix, "POST", `/tasks/${missingTask}/subtasks`, {
        agentKey: semanticsKey,
        body: { title: "   " },
      });
      expect(blank.status, `${prefix} blank`).toBe(400);
      expect(blank.body.error).toBe("Title is required");

      const nonString = await wire(prefix, "POST", `/tasks/${missingTask}/subtasks`, {
        agentKey: semanticsKey,
        body: { title: 42 },
      });
      expect(nonString.status, `${prefix} non-string`).toBe(400);
      expect(nonString.body.error).toBe("Title is required");

      // Precedence discriminator: a MISSING Task with a valid title is 404,
      // proving the 400s above are title validation, not ancestry.
      const validTitleMissingTask = await wire(prefix, "POST", `/tasks/${missingTask}/subtasks`, {
        agentKey: semanticsKey,
        body: { title: "valid" },
      });
      expect(validTitleMissingTask.status, `${prefix} missing-task`).toBe(404);
    }
    expect(childRowsFor(missingTask)).toHaveLength(0);
    expect(sseTotal()).toBe(sseBefore);
  }, 60_000);
});

describe("PATCH/DELETE — exact child/URL-parent pair containment", () => {
  it("known child under another Task: BOTH methods, BOTH prefixes, SAME and DIFFERENT Habitat — 404 with complete child/both-lists/publication snapshots", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      for (const [label, otherHabitatId] of [
        ["same-habitat", teamAHabitatId],
        ["different-habitat", teamBHabitatId],
      ] as const) {
        const a = makeTask(teamAHabitatId, `tsw-cross-a-${suffix}-${label}`, "tsw-seed");
        const b = makeTask(otherHabitatId, `tsw-cross-b-${suffix}-${label}`, "tsw-seed");
        const bChild = makeChild(b, `tsw-cross-child-${suffix}-${label}`);
        const beforeChild = snapshotChild(bChild.id);
        const beforeA = JSON.parse(JSON.stringify(childRowsFor(a)));
        const beforeB = JSON.parse(JSON.stringify(childRowsFor(b)));
        const sseBefore = sseTotal();

        const patched = await wire(prefix, "PATCH", `/tasks/${a}/subtasks/${bChild.id}`, {
          agentKey: positiveKey,
          body: { completed: true, title: "hijacked" },
        });
        expect(patched.status, `${prefix} ${label} PATCH`).toBe(404);
        expect(patched.body.error).toBe("Subtask not found");

        const deleted = await wire(prefix, "DELETE", `/tasks/${a}/subtasks/${bChild.id}`, {
          agentKey: positiveKey,
        });
        expect(deleted.status, `${prefix} ${label} DELETE`).toBe(404);
        expect(deleted.body.error).toBe("Subtask not found");

        expect(snapshotChild(bChild.id)).toEqual(beforeChild);
        expect(JSON.parse(JSON.stringify(childRowsFor(a)))).toEqual(beforeA);
        expect(JSON.parse(JSON.stringify(childRowsFor(b)))).toEqual(beforeB);
        expect(sseCount("subtask.updated", a)).toBe(0);
        expect(sseCount("subtask.updated", b)).toBe(0);
        expect(sseCount("subtask.deleted", a)).toBe(0);
        expect(sseCount("subtask.deleted", b)).toBe(0);
        expect(sseTotal()).toBe(sseBefore);
      }
    }
  }, 60_000);

  it("cross-habitat target remains directly accessible to this agent — the defect is false URL containment, not access denial", async () => {
    const a = makeTask(teamAHabitatId, "tsw-xhab-direct-a", "tsw-seed");
    const b = makeTask(teamBHabitatId, "tsw-xhab-direct-b", "tsw-seed");
    const bChild = makeChild(b, "tsw-xhab-direct-child");
    const sseBefore = sseTotal();

    const direct = await wire("/api/v1", "GET", `/tasks/${b}/subtasks`, { agentKey: positiveKey });
    expect(direct.status).toBe(200);
    expect(direct.body.total).toBe(1);
    expect(direct.body.subtasks[0].id).toBe(bChild.id);

    const hijack = await wire("/api/v1", "PATCH", `/tasks/${a}/subtasks/${bChild.id}`, {
      agentKey: positiveKey,
      body: { completed: true },
    });
    expect(hijack.status).toBe(404);
    expect(sseTotal()).toBe(sseBefore);
  }, 30_000);

  it("unknown child under an existing Task is 404 on both prefixes", async () => {
    const a = makeTask(teamAHabitatId, "tsw-unknown-child", "tsw-seed");
    makeChild(a, "tsw-unknown-child-real");
    for (const prefix of PREFIXES) {
      const patched = await wire(
        prefix,
        "PATCH",
        `/tasks/${a}/subtasks/00000000-0000-4000-8000-0000000000b7`,
        {
          agentKey: positiveKey,
          body: { completed: true },
        },
      );
      expect(patched.status, `${prefix} PATCH`).toBe(404);
      expect(patched.body.error).toBe("Subtask not found");

      const deleted = await wire(
        prefix,
        "DELETE",
        `/tasks/${a}/subtasks/00000000-0000-4000-8000-0000000000b8`,
        {
          agentKey: positiveKey,
        },
      );
      expect(deleted.status, `${prefix} DELETE`).toBe(404);
    }
    expect(childRowsFor(a)).toHaveLength(1);
  }, 30_000);
});

describe("positive controls — exact pair on each prefix", () => {
  it("false/0/null PATCH transition from true/nonzero/assigned state flips BOTH response and persisted fields on each prefix, with one tuple-addressed event", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tsw-falsy-${suffix}`, "tsw-seed");
      const kid = makeChild(owner, `tsw-falsy-child-${suffix}`);
      // Start from true / nonzero / assigned — an ignore-falsy mapper mutant
      // would silently preserve exactly these values.
      getDb()
        .update(taskSubtasks)
        .set({ completed: true, order: 5, assigneeId: assignedAgentId })
        .where(eq(taskSubtasks.id, kid.id))
        .run();
      const sseBefore = sseTotal();

      const res = await wire(prefix, "PATCH", `/tasks/${owner}/subtasks/${kid.id}`, {
        agentKey: positiveKey,
        body: { completed: false, order: 0, assigneeId: null },
      });

      expect(res.status, `${prefix} falsy patch`).toBe(200);
      expect(res.body.subtask.completed, `${prefix} response completed`).toBe(false);
      expect(res.body.subtask.order, `${prefix} response order`).toBe(0);
      expect(res.body.subtask.assigneeId, `${prefix} response assignee`).toBeNull();

      const row = getDb().select().from(taskSubtasks).where(eq(taskSubtasks.id, kid.id)).get()!;
      expect(row.completed, `${prefix} persisted completed`).toBe(false);
      expect(row.order, `${prefix} persisted order`).toBe(0);
      expect(row.assigneeId, `${prefix} persisted assignee`).toBeNull();

      const pubs = pubsSince(sseBefore);
      expect(pubs, `${prefix} exactly one publication`).toHaveLength(1);
      expect(pubs[0][0], `${prefix} actual habitat`).toBe(teamAHabitatId);
      expect(pubs[0][1].type).toBe("subtask.updated");
      expect(pubs[0][1].data.taskId).toBe(owner);
      expect(pubs[0][1].data.subtask).toMatchObject({
        id: kid.id,
        taskId: owner,
        completed: false,
        order: 0,
        assigneeId: null,
      });
    }
  }, 60_000);

  it("PATCH keeps response shape and never moves the child via body taskId; same-values update remains success with one event per write", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tsw-pos-patch-${suffix}`, "tsw-seed");
      const other = makeTask(teamAHabitatId, `tsw-pos-other-${suffix}`, "tsw-seed");
      const kid = makeChild(owner, `tsw-pos-child-${suffix}`);
      const sseBefore = sseTotal();

      const res = await wire(prefix, "PATCH", `/tasks/${owner}/subtasks/${kid.id}`, {
        agentKey: positiveKey,
        body: {
          title: "renamed",
          completed: true,
          order: 3,
          assigneeId: assignedAgentId,
          taskId: other,
        },
      });

      expect(res.status, `${prefix} patch`).toBe(200);
      expect(res.body.subtask.title).toBe("renamed");
      expect(res.body.subtask.completed).toBe(true);
      expect(res.body.subtask.order).toBe(3);
      expect(res.body.subtask.assigneeId).toBe(assignedAgentId);
      expect(res.body.subtask.taskId).toBe(owner);

      const row = childRowsFor(owner)[0];
      expect(row.taskId).toBe(owner);
      expect(row.completed).toBe(true);
      expect(childRowsFor(other)).toHaveLength(0);

      expect(sseCount("subtask.updated", owner), `${prefix} sse`).toBe(1);
      expect(sseTotal(), `${prefix} total sse`).toBe(sseBefore + 1);

      const again = await wire(prefix, "PATCH", `/tasks/${owner}/subtasks/${kid.id}`, {
        agentKey: positiveKey,
        body: { title: "renamed", completed: true, order: 3, assigneeId: assignedAgentId },
      });
      expect(again.status, `${prefix} same-values patch`).toBe(200);
      expect(sseCount("subtask.updated", owner), `${prefix} second sse`).toBe(2);
    }
  }, 60_000);

  it("DELETE returns an empty 204, removes the row, and publishes exactly one tuple-addressed event carrying the deleted child ID; repeated deletion is 404", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tsw-pos-del-${suffix}`, "tsw-seed");
      const kid = makeChild(owner, `tsw-pos-del-child-${suffix}`);
      const sseBefore = sseTotal();

      const res = await wire(prefix, "DELETE", `/tasks/${owner}/subtasks/${kid.id}`, {
        agentKey: positiveKey,
      });
      expect(res.status, `${prefix} delete`).toBe(204);
      expect(res.text, `${prefix} empty body`).toBe("");
      expect(childRowsFor(owner)).toHaveLength(0);

      const pubs = pubsSince(sseBefore);
      expect(pubs, `${prefix} exactly one publication`).toHaveLength(1);
      expect(pubs[0][0], `${prefix} actual habitat`).toBe(teamAHabitatId);
      expect(pubs[0][1].type).toBe("subtask.deleted");
      expect(pubs[0][1].data.taskId).toBe(owner);
      expect(pubs[0][1].data.subtaskId).toBe(kid.id);

      const repeat = await wire(prefix, "DELETE", `/tasks/${owner}/subtasks/${kid.id}`, {
        agentKey: positiveKey,
      });
      expect(repeat.status, `${prefix} repeat`).toBe(404);
      expect(sseCount("subtask.deleted", owner), `${prefix} sse stays 1`).toBe(1);
    }
  }, 60_000);
});

describe("subtask operations — served MCP compatibility (real agent key over stdio)", () => {
  it("list/create/update/delete round-trip with tuple-addressed publication checks and missing-parent errors", async () => {
    const owner = makeTask(teamAHabitatId, "tsw-mcp", "tsw-seed");
    const seeded = makeChild(owner, "tsw-mcp-seeded");

    const list = await callTool("orcy_habitat_task", { action: "list-subtasks", taskId: owner });
    expect(list.isError).toBeFalsy();
    const listBody = JSON.parse(toolText(list));
    expect(listBody.subtasks.map((s: any) => s.id)).toContain(seeded.id);
    expect(listBody.total).toBeGreaterThanOrEqual(1);

    let sseBefore = sseTotal();
    const create = await callTool("orcy_habitat_task", {
      action: "create-subtask",
      taskId: owner,
      title: "tsw-mcp-created",
    });
    expect(create.isError).toBeFalsy();
    const createdSub = JSON.parse(toolText(create)).subtask;
    const createdRow = getDb()
      .select()
      .from(taskSubtasks)
      .where(eq(taskSubtasks.id, createdSub.id))
      .get()!;
    expect(createdRow.taskId).toBe(owner);
    let pubs = pubsSince(sseBefore);
    expect(pubs).toHaveLength(1);
    expect(pubs[0][0]).toBe(teamAHabitatId);
    expect(pubs[0][1].type).toBe("subtask.created");
    expect(pubs[0][1].data.taskId).toBe(owner);
    expect(pubs[0][1].data.subtask.id).toBe(createdSub.id);

    // Subtask-only update: no status and no Task-level fields — the action's
    // precedence must stay untouched.
    sseBefore = sseTotal();
    const update = await callTool("orcy_habitat_task", {
      action: "update",
      taskId: owner,
      subtaskId: createdSub.id,
      subtaskCompleted: true,
    });
    expect(update.isError).toBeFalsy();
    expect(JSON.parse(toolText(update))).toMatchObject({ success: true });
    const updatedRow = getDb()
      .select()
      .from(taskSubtasks)
      .where(eq(taskSubtasks.id, createdSub.id))
      .get()!;
    expect(updatedRow.completed).toBe(true);
    pubs = pubsSince(sseBefore);
    expect(pubs).toHaveLength(1);
    expect(pubs[0][0]).toBe(teamAHabitatId);
    expect(pubs[0][1].type).toBe("subtask.updated");
    expect(pubs[0][1].data.taskId).toBe(owner);
    expect(pubs[0][1].data.subtask).toMatchObject({ id: createdSub.id, completed: true });

    sseBefore = sseTotal();
    const remove = await callTool("orcy_habitat_task", {
      action: "delete-subtask",
      taskId: owner,
      subtaskId: createdSub.id,
    });
    expect(remove.isError).toBeFalsy();
    expect(
      getDb().select().from(taskSubtasks).where(eq(taskSubtasks.id, createdSub.id)).all(),
    ).toHaveLength(0);
    pubs = pubsSince(sseBefore);
    expect(pubs).toHaveLength(1);
    expect(pubs[0][0]).toBe(teamAHabitatId);
    expect(pubs[0][1].type).toBe("subtask.deleted");
    expect(pubs[0][1].data.taskId).toBe(owner);
    expect(pubs[0][1].data.subtaskId).toBe(createdSub.id);
  }, 60_000);

  it("wrong-parent update and delete via MCP are isError with no DB/SSE mutation; missing-parent list/create error too", async () => {
    const a = makeTask(teamAHabitatId, "tsw-mcp-cross-a", "tsw-seed");
    const b = makeTask(teamAHabitatId, "tsw-mcp-cross-b", "tsw-seed");
    const bChild = makeChild(b, "tsw-mcp-b-child");
    const before = snapshotChild(bChild.id);
    const sseBefore = sseTotal();

    const patched = await callTool("orcy_habitat_task", {
      action: "update",
      taskId: a,
      subtaskId: bChild.id,
      subtaskCompleted: true,
    });
    expect(patched.isError).toBeTruthy();

    const removed = await callTool("orcy_habitat_task", {
      action: "delete-subtask",
      taskId: a,
      subtaskId: bChild.id,
    });
    expect(removed.isError).toBeTruthy();

    const missingList = await callTool("orcy_habitat_task", {
      action: "list-subtasks",
      taskId: "00000000-0000-4000-8000-0000000000b9",
    });
    expect(missingList.isError).toBeTruthy();

    const missingCreate = await callTool("orcy_habitat_task", {
      action: "create-subtask",
      taskId: "00000000-0000-4000-8000-0000000000ba",
      title: "nope",
    });
    expect(missingCreate.isError).toBeTruthy();

    expect(snapshotChild(bChild.id)).toEqual(before);
    expect(sseTotal()).toBe(sseBefore);
  }, 60_000);

  it("secondary wire path update + deleteSubtask=true deletes through the same containment and publishes the same event", async () => {
    const owner = makeTask(teamAHabitatId, "tsw-mcp-secondary", "tsw-seed");
    const kid = makeChild(owner, "tsw-mcp-secondary-child");
    const sseBefore = sseTotal();

    const res = await callTool("orcy_habitat_task", {
      action: "update",
      taskId: owner,
      subtaskId: kid.id,
      deleteSubtask: true,
    });
    expect(res.isError).toBeFalsy();
    expect(JSON.parse(toolText(res))).toMatchObject({ success: true });
    expect(childRowsFor(owner)).toHaveLength(0);
    const pubs = pubsSince(sseBefore);
    expect(pubs).toHaveLength(1);
    expect(pubs[0][0]).toBe(teamAHabitatId);
    expect(pubs[0][1].type).toBe("subtask.deleted");
    expect(pubs[0][1].data.taskId).toBe(owner);
    expect(pubs[0][1].data.subtaskId).toBe(kid.id);

    // The same secondary path cannot delete another Task's child.
    const b = makeTask(teamAHabitatId, "tsw-mcp-secondary-b", "tsw-seed");
    const bChild = makeChild(b, "tsw-mcp-secondary-b-child");
    const crossBefore = sseTotal();
    const cross = await callTool("orcy_habitat_task", {
      action: "update",
      taskId: owner,
      subtaskId: bChild.id,
      deleteSubtask: true,
    });
    expect(cross.isError).toBeTruthy();
    expect(childRowsFor(b)).toHaveLength(1);
    expect(sseTotal()).toBe(crossBefore);
  }, 60_000);
});
