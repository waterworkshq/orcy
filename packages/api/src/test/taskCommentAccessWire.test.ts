/**
 * Three agent-only Task comment writes (comment-containment-contract, Sol
 * ACCEPT with amendments) — REAL HTTP wire matrix on BOTH served prefixes
 * (`/api/v1`, deprecated `/api`) plus served MCP compatibility.
 *
 * Scope of claims (author evidence, not universal Task isolation):
 *  - POST `/tasks/:id/comments`, PATCH/DELETE
 *    `/tasks/:id/comments/:commentId` resolve the URL Task's actual
 *    Mission → Habitat and enforce the shared habitat-access predicate
 *    before any comment row is read or written. PATCH/DELETE additionally
 *    require the exact comment/URL-Task pair AND the typed original author
 *    at the final SQL statement. Intended deltas: POST under a Task with
 *    missing Mission/Habitat ancestry (only reachable via corrupted FK
 *    state) creation → 404; cross-Task PATCH 200 → 404; cross-Task DELETE
 *    204 → 404 (previously the actual author of B's comment could mutate
 *    it through A's URL, even cross-Habitat).
 *  - Preserved: agent-only transport (401 for every human JWT — including
 *    a HUMAN-authored comment with a matching human ID — plus anonymous,
 *    invalid local key and VALID remote-only credentials); local-agent
 *    admission on team and personal Habitats; POST mention/SSE/hook fan on
 *    matched inserts; PATCH with no mention recompute and no edit SSE;
 *    DELETE with exactly one root deletion event and legitimate
 *    mixed-author same-Task cascade.
 *
 * MCP: the only served comment actions are `orcy_habitat_task`
 * `add-comment`/`get-comments`; there is no served comment edit/delete
 * action, and none is invented here.
 *
 * Disclosed limits: race-window behaviors (post-lookup reparent/re-author,
 * conditional reply INSERT misses, mutation-statement DB faults and the
 * deep-chain native FK recursion fault with statement rollback) are pinned
 * in `taskCommentContainment.test.ts` and
 * `taskCommentContainment.production.test.ts` — single-threaded
 * synchronous request handling cannot interleave them on the wire.
 *
 * No authorization/repository mocks: every request crosses a real TCP
 * socket into the real application; MCP checks drive the spawned server
 * over stdio with a real agent key. The real preHandler per-agent rate
 * limiter (60 req/min/key) is live; heavier describes drive their own
 * seeded agents rather than dodging middleware.
 */
import { describe, it, expect, beforeAll, afterAll, vi, type Mock } from "vitest";
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
import * as commentRepo from "../repositories/comment.js";
import * as commentMentionRepo from "../repositories/commentMention.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import {
  missions,
  habitats,
  tasks,
  taskComments,
  taskCommentMentions,
  notificationEvents,
  notificationDeliveries,
  users,
  agents as agentsTable,
  taskEvents as taskEventsTable,
  taskWatchers as taskWatchersTable,
} from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { sseBroadcaster } from "../sse/broadcaster.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import { onCommentCreated } from "../services/commentService.js";
import * as userRepo from "../repositories/user.js";
import * as notificationPrefRepo from "../repositories/notificationPreferences.js";
import * as watcherRepo from "../repositories/watcher.js";
import * as emailService from "../services/emailService.js";

// SMTP env must be set BEFORE first import of emailService (module-level
// constants) so the real human-mention recipient path (processEvent ->
// sendIfEnabled) runs its genuine resolution instead of the isConfigured()
// early return. The sendEmail boundary is spied so no network occurs.
vi.hoisted(() => {
  process.env.SMTP_HOST = process.env.SMTP_HOST ?? "smtp.test.invalid";
  process.env.SMTP_USER = process.env.SMTP_USER ?? "tcw-test-user";
  process.env.SMTP_PASS = process.env.SMTP_PASS ?? "tcw-test-pass";
});

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
let mentionAgentName: string;
let mentionAgentId: string;
let boundAgentKey: string;
let memberEditorJwt: string;
let sendEmailSpy: Mock<(payload: { to: string; subject: string; html: string }) => Promise<boolean>>;

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
  return jwt.sign({ sub: userId, username: `tcw-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
  body?: unknown;
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

function seedComment(
  taskId: string,
  content: string,
  parentId: string | null = null,
  authorType: "human" | "agent" | "remote_human" | "remote_orcy" = "agent",
  authorId: string | null = null,
): string {
  return commentRepo.createComment({
    taskId,
    content,
    parentId,
    authorType,
    authorId: authorId ?? assignedAgentId,
  }).id;
}

function snapshotComment(commentId: string) {
  return JSON.parse(
    JSON.stringify(getDb().select().from(taskComments).where(eq(taskComments.id, commentId)).all()),
  );
}

function snapshotMentions(commentId: string) {
  return JSON.parse(
    JSON.stringify(
      getDb()
        .select()
        .from(taskCommentMentions)
        .where(eq(taskCommentMentions.commentId, commentId))
        .all(),
    ),
  );
}

/** Seeds a durable mention row on a comment for non-vacuous denial snapshots. */
function seedCommentMention(commentId: string, name: string): string {
  return commentMentionRepo.createMentions([
    { commentId, mentionedType: "human", mentionedId: `snap-user-${name}`, mentionText: `@${name}` },
  ])[0]!.id;
}

function commentRowsFor(taskId: string) {
  return getDb().select().from(taskComments).where(eq(taskComments.taskId, taskId)).all();
}

// SSE publication: the spy wraps (does not suppress) the real broadcaster.
// Counters and TUPLE accessors both run on the full recorded call tuples —
// habitat ID, event type, task ID, payload — so a wrong-Habitat or
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

// Creation hooks: register a recorder to pin the truthful author/source the
// hook fan receives (hook exceptions are swallowed in production; recording
// here proves invocation and payload, not subscriber delivery).
const hookCalls: Array<{
  commentId: string;
  authorType: string;
  authorId: string;
  habitatId: string;
}> = [];
let unsubscribeHook: () => void = () => {};

/** Durable effect tables snapshot for denial proofs: notification events and
 * deliveries, Task lifecycle events and Task watchers. Snapshotting the
 * tables proves NO unexpected durable effects — it does not claim this path
 * writes any of them (no watcher notification or comment-created durable
 * Notification row is invented). */
function notificationTablesSnapshot() {
  return JSON.parse(
    JSON.stringify({
      events: getDb().select().from(notificationEvents).all(),
      deliveries: getDb().select().from(notificationDeliveries).all(),
      taskEvents: getDb().select().from(taskEventsTable).all(),
      taskWatchers: getDb().select().from(taskWatchersTable).all(),
    }),
  );
}

/**
 * This harness's settle boundary ONLY: two macrotask turns let the
 * broadcaster's fire-and-forget processEvent promise run to completion under
 * the synchronous-preference/DB work and mockResolvedValue email boundary
 * configured in this file. It is deterministic for THIS harness; it is not a
 * general proof that arbitrary downstream asynchronous fan (webhooks,
 * plugins, network delivery) completed — no such delivery is claimed.
 */
async function settleFan(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function hookCount(): number {
  return hookCalls.length;
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
    name: "tcw-org",
    slug: `tcw-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "tcw-team-a",
    slug: `tcw-team-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "tcw-team-b",
    slug: `tcw-team-b-${Date.now()}`,
  });
  teamAHabitatId = habitatRepo.createHabitat({ name: "tcw-habitat-a", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "tcw-habitat-b", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "tcw-personal-habitat" }).id;

  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tcw-member-admin", role: "member" });
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tcw-member-viewer", role: "member" });
  teamMemberRepo.addMember({ teamId: teamB.id, userId: "tcw-member-b", role: "member" });

  memberAdminJwt = mint("tcw-member-admin", "admin");
  memberViewerJwt = mint("tcw-member-viewer", "viewer");
  memberEditorJwt = mint("tcw-member-editor", "editor");
  memberBJwt = mint("tcw-member-b", "viewer");
  nonmemberAdminJwt = mint("tcw-nonmember-admin", "admin");
  teamMemberRepo.addMember({ teamId: teamA.id, userId: "tcw-member-editor", role: "member" });

  const assigned = agentRepo.createAgent({
    name: "tcw-agent-assigned",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  assignedAgentId = assigned.agent.id;
  assignedAgentKey = assigned.plainApiKey;

  const unbound = agentRepo.createAgent({
    name: "tcw-agent-unbound",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  unboundAgentKey = unbound.plainApiKey;

  mentionAgentId = agentRepo.createAgent({
    name: "tcw-mention-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  }).agent.id;
  mentionAgentName = "tcw-mention-agent";

  // Another-Habitat-BOUND agent: the actual binding mechanism is the agent's
  // currentTaskId pointing at a Task in ANOTHER Habitat (agents carry no
  // habitat column) — bound to Team B while the writes target Team A /
  // personal Tasks.
  const boundAnchorTask = makeTask(teamBHabitatId, "tcw-bound-anchor", "tcw-seed");
  const bound = agentRepo.createAgent({
    name: "tcw-agent-bound",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  getDb()
    .update(agentsTable)
    .set({ currentTaskId: boundAnchorTask })
    .where(eq(agentsTable.id, bound.agent.id))
    .run();
  boundAgentKey = bound.plainApiKey;

  // Human mention recipient with a real account row, real email and real
  // habitat-level mention preference — the production recipient path reads
  // exactly these rows.
  userRepo.createUser({
    id: "tcw-mention-human",
    username: "tcw-mention-human",
    passwordHash: "tcw-not-a-login-hash",
    role: "viewer",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  getDb()
    .update(users)
    .set({ email: "tcw-mention-human@example.test" })
    .where(eq(users.id, "tcw-mention-human"))
    .run();
  notificationPrefRepo.upsertPreferences("tcw-mention-human", teamAHabitatId, { taskMentioned: true });

  // Spy at the sendEmail boundary only: real processEvent resolution, real
  // preference/user rows, no network, no mocked repositories.
  sendEmailSpy = vi.spyOn(emailService, "sendEmail").mockResolvedValue(true);

  // The heavier describes each drive their own seeded agent (real 60/min
  // pre-auth rate limiter); the MCP child shares the assigned key's budget.
  const spawnKey = (name: string): string =>
    agentRepo.createAgent({ name, type: "claude-code", domain: "fullstack", capabilities: [] })
      .plainApiKey;
  ancestryKey = spawnKey("tcw-agent-ancestry");
  semanticsKey = spawnKey("tcw-agent-semantics");
  positiveKey = spawnKey("tcw-agent-positive");

  const pod = remotePodRepo.createRemotePod({
    habitatId: teamAHabitatId,
    name: "tcw-remote-pod",
  });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamAHabitatId,
    participantType: "remote_orcy",
    displayName: "tcw-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamAHabitatId,
    credentialType: "api",
    label: "tcw-remote-cred",
  }).plaintextSecret;

  unsubscribeHook = onCommentCreated((comment, habitatId) => {
    hookCalls.push({
      commentId: comment.id,
      authorType: comment.authorType,
      authorId: comment.authorId,
      habitatId,
    });
  });

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
    clientInfo: { name: "tcw-comment-access-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  child.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
}, 120_000);

afterAll(async () => {
  unsubscribeHook();
  sendEmailSpy.mockRestore();
  publishSpy.mockRestore();
  child.kill("SIGTERM");
  await childExit;
  await app.close();
  closeDb();
});

describe("comment writes — agent-only transport (both prefixes)", () => {
  it("EVERY local agent (genuinely assigned to the tested Task, and unassigned) performs ALL THREE writes on team and personal Tasks through both prefixes", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      for (const [label, habitatId] of [
        ["team", teamAHabitatId],
        ["personal", personalHabitatId],
      ] as const) {
        const owner = makeTask(habitatId, `tcw-three-${suffix}-${label}`, "tcw-seed");
        // GENUINE assignment: the tested Task's assignedAgentId IS the
        // assigned agent (no unrelated anchor).
        getDb()
          .update(tasks)
          .set({ assignedAgentId: assignedAgentId })
          .where(eq(tasks.id, owner))
          .run();
        const seeded = seedComment(owner, `tcw-three-seed-${suffix}-${label}`);

        for (const [agentLabel, key] of [
          ["assigned", assignedAgentKey],
          ["unassigned", unboundAgentKey],
        ] as const) {
          const tag = `${prefix} ${label} ${agentLabel}`;

          const created = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
            agentKey: key,
            body: { content: `tcw-three-${agentLabel}` },
          });
          expect(created.status, `${tag} POST`).toBe(201);
          expect(created.body.comment.taskId).toBe(owner);
          expect(created.body.comment.authorType).toBe("agent");

          const patched = await wire(
            prefix,
            "PATCH",
            `/tasks/${owner}/comments/${created.body.comment.id}`,
            {
              agentKey: key,
              body: { content: "edited by author" },
            },
          );
          expect(patched.status, `${tag} PATCH`).toBe(200);
          expect(patched.body.comment.content).toBe("edited by author");

          const deleted = await wire(
            prefix,
            "DELETE",
            `/tasks/${owner}/comments/${created.body.comment.id}`,
            {
              agentKey: key,
            },
          );
          expect(deleted.status, `${tag} DELETE`).toBe(204);
          expect(commentRowsFor(owner).map((r) => r.id)).toEqual([seeded]);
        }
      }
    }
  }, 60_000);

  it("a genuinely another-Habitat-BOUND agent (currentTaskId on a Team-B Task) performs ALL THREE writes on team and personal Tasks through both prefixes", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      for (const [label, habitatId] of [
        ["team", teamAHabitatId],
        ["personal", personalHabitatId],
      ] as const) {
        const owner = makeTask(habitatId, `tcw-bound-${suffix}-${label}`, "tcw-seed");
        const created = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
          agentKey: boundAgentKey,
          body: { content: `tcw-bound-${label}` },
        });
        expect(created.status, `${prefix} ${label} POST`).toBe(201);
        expect(created.body.comment.authorId).toBe(
          agentRepo.listAgents().find((a) => a.name === "tcw-agent-bound")!.id,
        );

        const patched = await wire(
          prefix,
          "PATCH",
          `/tasks/${owner}/comments/${created.body.comment.id}`,
          { agentKey: boundAgentKey, body: { content: "bound edit" } },
        );
        expect(patched.status, `${prefix} ${label} PATCH`).toBe(200);

        const deleted = await wire(
          prefix,
          "DELETE",
          `/tasks/${owner}/comments/${created.body.comment.id}`,
          { agentKey: boundAgentKey },
        );
        expect(deleted.status, `${prefix} ${label} DELETE`).toBe(204);
        expect(commentRowsFor(owner)).toHaveLength(0);
      }
    }
  }, 60_000);

  it("every human JWT stays 401 on all three writes — including a HUMAN-authored comment with a matching human ID; denied writes leave rows and SSE unchanged", async () => {
    const owner = makeTask(teamAHabitatId, "tcw-human-401", "tcw-seed");
    getDb()
      .update(tasks)
      .set({ assignedAgentId: assignedAgentId })
      .where(eq(tasks.id, owner))
      .run();
    const kid = seedComment(owner, "tcw-human-401-child");
    // The discriminating fixture: a comment authored by the HUMAN caller
    // with exactly their ID — typed-author equality would hold, but the
    // transport stays agent-only 401.
    const humanAuthored = seedComment(owner, "human-authored", null, "human", "tcw-member-admin");
    const before = snapshotComment(kid);
    const beforeHuman = snapshotComment(humanAuthored);
    const sseBefore = sseTotal();

    const personalOwner = makeTask(personalHabitatId, "tcw-human-401-personal", "tcw-seed");
    const personalKid = seedComment(personalOwner, "tcw-personal-child");
    const beforePersonal = snapshotComment(personalKid);
    const durableBefore = notificationTablesSnapshot();

    const humanCases: Array<[string, string, string, string]> = [
      ["member-admin", memberAdminJwt, humanAuthored, owner],
      ["member-editor", memberEditorJwt, kid, owner],
      ["member-viewer", memberViewerJwt, kid, owner],
      ["member-b", memberBJwt, kid, owner],
      ["nonmember-admin", nonmemberAdminJwt, kid, owner],
      ["personal-human", nonmemberAdminJwt, personalKid, personalOwner],
    ];

    for (const prefix of PREFIXES) {
      for (const [label, token, childId, taskId] of humanCases) {
        expect(
          (
            await wire(prefix, "POST", `/tasks/${taskId}/comments`, {
              token,
              body: { content: "no" },
            })
          ).status,
          `${prefix} ${label} POST`,
        ).toBe(401);
        expect(
          (
            await wire(prefix, "PATCH", `/tasks/${taskId}/comments/${childId}`, {
              token,
              body: { content: "no" },
            })
          ).status,
          `${prefix} ${label} PATCH`,
        ).toBe(401);
        expect(
          (await wire(prefix, "DELETE", `/tasks/${taskId}/comments/${childId}`, { token })).status,
          `${prefix} ${label} DELETE`,
        ).toBe(401);
      }
    }

    await settleFan();
    expect(snapshotComment(kid)).toEqual(before);
    expect(snapshotComment(humanAuthored)).toEqual(beforeHuman);
    expect(snapshotComment(personalKid)).toEqual(beforePersonal);
    expect(notificationTablesSnapshot()).toEqual(durableBefore);
    expect(sseTotal()).toBe(sseBefore);
  }, 60_000);

  it("anonymous, invalid agent key and VALID remote credential get 401 on all three writes with fields and publications unchanged", async () => {
    const owner = makeTask(teamAHabitatId, "tcw-authn", "tcw-seed");
    const kid = seedComment(owner, "tcw-authn-child");
    const before = snapshotComment(kid);
    const sseBefore = sseTotal();

    for (const prefix of PREFIXES) {
      for (const [method, path, opts] of [
        ["POST", `/tasks/${owner}/comments`, { body: { content: "no" } }],
        ["PATCH", `/tasks/${owner}/comments/${kid}`, { body: { content: "no" } }],
        ["DELETE", `/tasks/${owner}/comments/${kid}`, {}],
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

    expect(snapshotComment(kid)).toEqual(before);
    expect(sseTotal()).toBe(sseBefore);
  }, 60_000);

  it("valid local key plus extra human/remote credentials stays agent-attributed (existing precedence), on both prefixes", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tcw-precedence-${suffix}`, "tcw-seed");
      const created = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
        agentKey: assignedAgentKey,
        token: memberAdminJwt,
        remoteKey: validRemoteKey,
        body: { content: "stacked credentials" },
      });
      expect(created.status, prefix).toBe(201);
      expect(created.body.comment.authorType).toBe("agent");
      expect(created.body.comment.authorId).toBe(assignedAgentId);
    }
  }, 30_000);
});

describe("comment writes — Task ancestry 404s, validation precedence", () => {
  it("absent Task is 404 for all three writes on both prefixes; parent absence wins over child absence", async () => {
    const missing = "00000000-0000-4000-8000-0000000000d1";
    for (const prefix of PREFIXES) {
      expect(
        (
          await wire(prefix, "POST", `/tasks/${missing}/comments`, {
            agentKey: ancestryKey,
            body: { content: "orphan" },
          })
        ).status,
        `${prefix} POST`,
      ).toBe(404);
      expect(
        (
          await wire(
            prefix,
            "PATCH",
            `/tasks/${missing}/comments/00000000-0000-4000-8000-0000000000d2`,
            {
              agentKey: ancestryKey,
              body: { content: "x" },
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
            `/tasks/${missing}/comments/00000000-0000-4000-8000-0000000000d3`,
            {
              agentKey: ancestryKey,
            },
          )
        ).status,
        `${prefix} DELETE`,
      ).toBe(404);
    }

    // Missing-TASK credential precedence: the same three-write matrix as
    // the corrupted-ancestry cases — human JWT and anonymous stay 401
    // BEFORE Task admission (never a 404 disclosure), valid bodies, and
    // zero row/publication effects.
    await assertAncestryMatrix(missing, "00000000-0000-4000-8000-0000000000d2");
  }, 60_000);

  it("missing Mission and missing Habitat (corrupted-FK fixtures, finally-restored) are 404 for the agent and 401 for human/no-key on ALL THREE writes, with no row/event effects", async () => {
    // FK cascades normally remove the Task with its Mission, so the missing
    // intermediate levels are only reachable by disabling connection-level FK
    // enforcement, deleting the ancestor row directly, and re-enabling it in
    // a finally on EVERY exit path.
    const db = getDb();

    const noMissionOwner = makeTask(teamAHabitatId, "tcw-no-mission", "tcw-seed");
    const noMissionKid = seedComment(noMissionOwner, "tcw-no-mission-child");
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
      expect(commentRowsFor(noMissionOwner)).toHaveLength(1);

      await assertAncestryMatrix(noMissionOwner, noMissionKid);
    } finally {
      db.run(sql`PRAGMA foreign_keys = ON`);
    }
    expect(noMissionCorrupted).toBe(true);
    assertFkEnforcementFunctional();

    const noHabitatFixtureHabitat = habitatRepo.createHabitat({
      name: "tcw-no-habitat-fixture",
    }).id;
    const noHabitatOwner = makeTask(noHabitatFixtureHabitat, "tcw-no-habitat", "tcw-seed");
    const noHabitatKid = seedComment(noHabitatOwner, "tcw-no-habitat-child");
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
      expect(commentRowsFor(noHabitatOwner)).toHaveLength(1);

      await assertAncestryMatrix(noHabitatOwner, noHabitatKid);
    } finally {
      db.run(sql`PRAGMA foreign_keys = ON`);
    }
    expect(noHabitatCorrupted).toBe(true);
    assertFkEnforcementFunctional();
  }, 60_000);

  it("POST/PATCH body validation precedes ancestry: invalid bodies on a MISSING Task are 400; whitespace-only content stays accepted on an existing Task; unknown body fields are stripped", async () => {
    const missingTask = "00000000-0000-4000-8000-0000000000d6";
    for (const prefix of PREFIXES) {
      // Content validation fires before Task admission.
      const empty = await wire(prefix, "POST", `/tasks/${missingTask}/comments`, {
        agentKey: semanticsKey,
        body: { content: "" },
      });
      expect(empty.status, `${prefix} empty`).toBe(400);

      const tooLong = await wire(prefix, "POST", `/tasks/${missingTask}/comments`, {
        agentKey: semanticsKey,
        body: { content: "x".repeat(5001) },
      });
      expect(tooLong.status, `${prefix} too-long`).toBe(400);

      const badParent = await wire(prefix, "POST", `/tasks/${missingTask}/comments`, {
        agentKey: semanticsKey,
        body: { content: "ok", parentId: "not-a-uuid" },
      });
      expect(badParent.status, `${prefix} bad-parent-uuid`).toBe(400);

      const badPatch = await wire(
        prefix,
        "PATCH",
        `/tasks/${missingTask}/comments/00000000-0000-4000-8000-0000000000d7`,
        { agentKey: semanticsKey, body: { content: "" } },
      );
      expect(badPatch.status, `${prefix} patch-empty`).toBe(400);

      // Precedence discriminator: a MISSING Task with a valid body is 404,
      // proving the 400s above are validation, not ancestry.
      const valid = await wire(prefix, "POST", `/tasks/${missingTask}/comments`, {
        agentKey: semanticsKey,
        body: { content: "valid" },
      });
      expect(valid.status, `${prefix} missing-task`).toBe(404);
    }

    // Existing semantics on LIVE Tasks, both prefixes: whitespace-only
    // content accepted (min(1), no trim); unknown body fields stripped (no
    // author/task smuggling from the body).
    const semanticsAgentId = agentRepo.listAgents().find((a) => a.name === "tcw-agent-semantics")!.id;
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tcw-semantics-${suffix}`, "tcw-seed");
      const other = makeTask(teamAHabitatId, `tcw-semantics-other-${suffix}`, "tcw-seed");
      const created = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
        agentKey: semanticsKey,
        body: { content: "   ", taskId: other, authorType: "human", authorId: "smuggled" },
      });
      expect(created.status, prefix).toBe(201);
      expect(created.body.comment.taskId).toBe(owner);
      expect(created.body.comment.authorType).toBe("agent");
      expect(created.body.comment.authorId).toBe(semanticsAgentId);
      const row = commentRowsFor(owner)[0]!;
      expect(row.content).toBe("   ");

      // PATCH with body-supplied author/Task/parent fields on the CORRECT
      // pair: content is the only effective field — the row's Task, author
      // and parent linkage never move.
      const patched = await wire(prefix, "PATCH", `/tasks/${owner}/comments/${row.id}`, {
        agentKey: semanticsKey,
        body: {
          content: "scoped edit",
          taskId: other,
          authorType: "human",
          authorId: "smuggled",
          parentId: "00000000-0000-4000-8000-0000000000eb",
        },
      });
      expect(patched.status, `${prefix} patch`).toBe(200);
      const after = commentRowsFor(owner)[0]!;
      expect(after.taskId).toBe(owner);
      expect(after.authorType).toBe("agent");
      expect(after.authorId).toBe(semanticsAgentId);
      expect(after.parentId).toBeNull();
      expect(after.content).toBe("scoped edit");
      expect(commentRowsFor(other)).toHaveLength(0);
    }
  }, 60_000);

  /**
   * Three-write precedence matrix on a corrupted-ancestry Task:
   * authenticated agent 404 (ancestry admission), human JWT and anonymous
   * 401 (installed auth precedes handler authorization) — well-formed
   * bodies, no row or publication effects.
   */
  async function assertAncestryMatrix(owner: string, childId: string): Promise<void> {
    const before = snapshotComment(childId);
    const sseBefore = sseTotal();
    const ops: Array<[string, string, (o: WireOpts) => WireOpts]> = [
      ["POST", `/tasks/${owner}/comments`, (o) => ({ ...o, body: { content: "orphan" } })],
      ["PATCH", `/tasks/${owner}/comments/${childId}`, (o) => ({ ...o, body: { content: "x" } })],
      ["DELETE", `/tasks/${owner}/comments/${childId}`, (o) => ({ ...o })],
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
    expect(snapshotComment(childId)).toEqual(before);
    expect(sseTotal()).toBe(sseBefore);
  }

  /** FK enforcement restored proof: an FK-violating insert must now throw. */
  function assertFkEnforcementFunctional(): void {
    expect(() =>
      getDb()
        .insert(taskComments)
        .values({
          id: "fk-check-should-fail",
          taskId: "00000000-0000-4000-8000-0000000000ff",
          parentId: null,
          authorType: "agent",
          authorId: "fk-check",
          content: "fk enforcement check",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .run(),
    ).toThrow(/FOREIGN KEY/i);
  }
});

describe("POST /tasks/:id/comments — root and reply semantics with mention/SSE/hook fan", () => {
  it("root POST on each prefix: 201 enriched shape, typed author, persisted row, one task.commented + one task.mentioned per resolved mention, hook with truthful author; GET follow-up keeps the projection", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tcw-post-${suffix}`, "tcw-seed");
      const sseBefore = sseTotal();
      const hookBefore = hookCount();
      // Captured BEFORE the request so an immediate erroneous email
      // resolution cannot hide inside an already-counted baseline.
      const emailsBefore = sendEmailSpy.mock.calls.length;

      const res = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
        agentKey: positiveKey,
        // Case-preserved mention token resolving case-insensitively to the
        // seeded agent + an unresolved token that must be dropped.
        body: { content: `hey @Tcw-Mention-Agent and @nobody-xyz` },
      });

      expect(res.status, prefix).toBe(201);
      expect(res.body.comment.taskId).toBe(owner);
      expect(res.body.comment.parentId).toBeNull();
      expect(res.body.comment.authorType).toBe("agent");
      expect(res.body.comment.mentions).toHaveLength(1);
      expect(res.body.comment.mentions[0].mentionText).toBe("@Tcw-Mention-Agent");
      expect(res.body.comment.mentions[0].mentionedName).toBe(mentionAgentName);
      expect(res.body.comment.mentions[0].mentionedType).toBe("agent");
      expect(res.body.comment.mentions[0].mentionedId).toBe(mentionAgentId);

      const rows = commentRowsFor(owner);
      expect(rows).toHaveLength(1);
      expect(rows[0].content).toBe("hey @Tcw-Mention-Agent and @nobody-xyz");

      const pubs = pubsSince(sseBefore);
      expect(pubs, `${prefix} commented + one mention event`).toHaveLength(2);
      expect(pubs[0][0]).toBe(teamAHabitatId);
      expect(pubs[0][1].type).toBe("task.commented");
      expect(pubs[0][1].data.taskId).toBe(owner);
      expect(pubs[0][1].data.comment.id).toBe(rows[0].id);
      expect(pubs[1][0]).toBe(teamAHabitatId);
      expect(pubs[1][1].type).toBe("task.mentioned");
      expect(pubs[1][1].data.taskId).toBe(owner);
      expect(pubs[1][1].data.commentId).toBe(rows[0].id);
      expect(pubs[1][1].data.mentionedType).toBe("agent");
      // Recipient identity is part of the publication tuple.
      expect(pubs[1][1].data.mentionedId).toBe(mentionAgentId);
      expect(pubs[1][1].data.mentionedName).toBe(mentionAgentName);
      // AGENT mentions never take the human notification arm.
      await settleFan();
      expect(sendEmailSpy.mock.calls.length).toBe(emailsBefore);

      expect(hookCount()).toBe(hookBefore + 1);
      expect(hookCalls.at(-1)).toMatchObject({
        commentId: rows[0].id,
        authorType: "agent",
        authorId: agentRepo.listAgents().find((a) => a.name === "tcw-agent-positive")!.id,
        habitatId: teamAHabitatId,
      });

      // GET follow-up verifies the persisted row and existing mention
      // projection without changing GET policy.
      const list = await wire(prefix, "GET", `/tasks/${owner}/comments`, { agentKey: positiveKey });
      expect(list.status).toBe(200);
      expect(list.body.total).toBe(1);
      expect(list.body.comments[0].id).toBe(rows[0].id);
      expect(list.body.comments[0].mentions).toHaveLength(1);
    }
  }, 60_000);

  it("reply POST (including reply-to-reply and another author's parent) keeps parentId and the same fan; missing parent and wrong-Task parent are 400 with zero inserts/mentions/fan", async () => {
    const other = makeTask(teamAHabitatId, "tcw-reply-other", "tcw-seed");
    const otherRoot = seedComment(other, "other-task-root");

    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tcw-reply-${suffix}`, "tcw-seed");
      const sseBefore = sseTotal();
      const hookBefore = hookCount();

      // Another author's same-Task parent (human-authored) stays a legal
      // reply target; the reply itself is attributed to the calling agent.
      const parent = seedComment(owner, "parent-by-human", null, "human", "human-author");

      const reply = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
        agentKey: positiveKey,
        body: { content: "first reply", parentId: parent },
      });
      expect(reply.status, `${prefix} reply`).toBe(201);
      expect(reply.body.comment.parentId).toBe(parent);
      expect(reply.body.comment.authorType).toBe("agent");

      const nested = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
        agentKey: positiveKey,
        body: { content: "reply to reply", parentId: reply.body.comment.id },
      });
      expect(nested.status, `${prefix} nested`).toBe(201);
      expect(nested.body.comment.parentId).toBe(reply.body.comment.id);

      expect(sseCount("task.commented", owner)).toBe(2);
      expect(hookCount()).toBe(hookBefore + 2);

      // Missing parent: 400 with zero effects.
      const sse0 = sseTotal();
      const missing = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
        agentKey: positiveKey,
        body: { content: "orphan reply", parentId: "00000000-0000-4000-8000-0000000000e1" },
      });
      expect(missing.status, `${prefix} missing`).toBe(400);
      expect(missing.body.error).toBe("Parent comment not found");

      const wrongTask = await wire(prefix, "POST", `/tasks/${owner}/comments`, {
        agentKey: positiveKey,
        body: { content: "cross reply", parentId: otherRoot },
      });
      expect(wrongTask.status, `${prefix} wrong-task`).toBe(400);
      expect(wrongTask.body.error).toBe("Parent comment belongs to a different task");

      expect(commentRowsFor(owner)).toHaveLength(3);
      expect(sseTotal()).toBe(sse0);
      expect(hookCount()).toBe(hookBefore + 2);
    }
  }, 60_000);
});

describe("POST — REAL human-mention recipient path (production effect proof)", () => {
  it("a seeded human mention through real creation reaches the real broadcaster subscriber AND the real Notification recipient resolution with exact tuples; payload naming preserved; subscription cleaned up", async () => {
    const owner = makeTask(teamAHabitatId, "tcw-human-mention", "tcw-seed");
    const sseBefore = sseTotal();
    const hookBefore = hookCount();
    const emailsBefore = sendEmailSpy.mock.calls.length;
    const durableBefore = notificationTablesSnapshot();

    // Real production SSE subscription (the seam subscribers actually use),
    // released in a finally with the count back to zero.
    const received: Array<{ type: string; data: any }> = [];
    const unsubscribe = sseBroadcaster.subscribe(teamAHabitatId, (event) => {
      received.push({ type: (event as any).type, data: (event as any).data });
    });
    expect(sseBroadcaster.getSubscriberCount(teamAHabitatId)).toBe(1);

    let createdId: string;
    try {
      const res = await wire("/api/v1", "POST", `/tasks/${owner}/comments`, {
        agentKey: positiveKey,
        body: { content: "ping @tcw-mention-human" },
      });
      expect(res.status).toBe(201);
      expect(res.body.comment.authorType).toBe("agent");
      expect(res.body.comment.mentions).toHaveLength(1);
      expect(res.body.comment.mentions[0]).toMatchObject({
        mentionedType: "human",
        mentionedId: "tcw-mention-human",
        mentionText: "@tcw-mention-human",
        mentionedName: "tcw-mention-human",
      });
      createdId = res.body.comment.id;
    } finally {
      unsubscribe();
      expect(sseBroadcaster.getSubscriberCount(teamAHabitatId)).toBe(0);
    }

    // The REAL subscriber observed both events with exact tuples, including
    // the recipient identity; the mention payload keeps its current naming
    // (mentionedByName semantics downstream; no commentContent key).
    const commented = received.find((e) => e.type === "task.commented");
    const mentioned = received.find((e) => e.type === "task.mentioned");
    expect(commented?.data.taskId).toBe(owner);
    expect(commented?.data.comment.id).toBe(createdId);
    expect(mentioned?.data).toMatchObject({
      taskId: owner,
      commentId: createdId,
      mentionedType: "human",
      mentionedId: "tcw-mention-human",
      mentionedName: "tcw-mention-human",
      habitatId: teamAHabitatId,
    });
    expect(mentioned?.data).not.toHaveProperty("commentContent");

    // Publisher tuple carries the same recipient identity.
    const pubs = pubsSince(sseBefore).filter(([, e]) => e?.data?.taskId === owner);
    expect(pubs.map(([, e]) => e.type).toSorted()).toEqual(["task.commented", "task.mentioned"]);

    // REAL recipient resolution: processEvent resolves the exact human
    // recipient from the seeded preference + user rows and reaches the
    // sendEmail boundary with her address (spied — no network). Current
    // payload naming is preserved (mentionedByName = mentionedName; no
    // commentContent in the notification data).
    await vi.waitFor(
      () => {
        expect(sendEmailSpy.mock.calls.length).toBe(emailsBefore + 1);
      },
      { timeout: 3000 },
    );
    const payload = sendEmailSpy.mock.calls[emailsBefore]![0]!;
    expect(payload.to).toBe("tcw-mention-human@example.test");
    expect(payload.subject).toBeTruthy();
    expect(payload.html).toContain("tcw-mention-human");

    // Hook fan carries the truthful exact author.
    expect(hookCount()).toBe(hookBefore + 1);
    expect(hookCalls.at(-1)).toMatchObject({
      commentId: createdId,
      authorType: "agent",
      authorId: agentRepo.listAgents().find((a) => a.name === "tcw-agent-positive")!.id,
      habitatId: teamAHabitatId,
    });

    // Settled durable state: this path writes no notification table rows —
    // the durable-effect tables are unchanged (characterization, not a
    // delivery claim).
    await settleFan();
    expect(notificationTablesSnapshot()).toEqual(durableBefore);
  }, 30_000);

  it("denied writes produce NO recipient resolution: a 401 human attempt with a human mention never reaches sendEmail and no durable notification rows appear", async () => {
    const owner = makeTask(teamAHabitatId, "tcw-human-mention-denied", "tcw-seed");
    const emailsBefore = sendEmailSpy.mock.calls.length;
    const durableBefore = notificationTablesSnapshot();
    const sseBefore = sseTotal();

    const denied = await wire("/api/v1", "POST", `/tasks/${owner}/comments`, {
      token: memberAdminJwt,
      body: { content: "nope @tcw-mention-human" },
    });
    expect(denied.status).toBe(401);

    await settleFan();
    expect(sendEmailSpy.mock.calls.length).toBe(emailsBefore);
    expect(notificationTablesSnapshot()).toEqual(durableBefore);
    expect(sseTotal()).toBe(sseBefore);
    expect(commentRowsFor(owner)).toHaveLength(0);
  }, 30_000);
});

describe("PATCH/DELETE — containment, typed author and effects", () => {
  it("known comment of another Task with the ACTUAL agent as author: BOTH methods, BOTH prefixes, SAME and DIFFERENT Habitat — 404 with complete row/list/publication snapshots", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      for (const [label, otherHabitatId] of [
        ["same-habitat", teamAHabitatId],
        ["different-habitat", teamBHabitatId],
      ] as const) {
        const a = makeTask(teamAHabitatId, `tcw-cross-a-${suffix}-${label}`, "tcw-seed");
        const b = makeTask(otherHabitatId, `tcw-cross-b-${suffix}-${label}`, "tcw-seed");
        // B's comment authored by the CALLING agent: typed author equality
        // holds, so only URL containment discriminates.
        const bComment = seedComment(
          b,
          `tcw-cross-child-${suffix}-${label}`,
          null,
          "agent",
          agentRepo.listAgents().find((ag) => ag.name === "tcw-agent-positive")!.id,
        );
        // Nonempty durable mention rows so denial equality is non-vacuous.
        seedCommentMention(bComment, `cross-${suffix}-${label}`);
        const beforeChild = snapshotComment(bComment);
        const beforeMentions = snapshotMentions(bComment);
        const beforeA = JSON.parse(JSON.stringify(commentRowsFor(a)));
        const beforeB = JSON.parse(JSON.stringify(commentRowsFor(b)));
        const sseBefore = sseTotal();
        const durableBefore = notificationTablesSnapshot();

        const patched = await wire(prefix, "PATCH", `/tasks/${a}/comments/${bComment}`, {
          agentKey: positiveKey,
          body: { content: "hijacked", taskId: b },
        });
        expect(patched.status, `${prefix} ${label} PATCH`).toBe(404);
        expect(patched.body.error).toBe("Comment not found");

        const deleted = await wire(prefix, "DELETE", `/tasks/${a}/comments/${bComment}`, {
          agentKey: positiveKey,
        });
        expect(deleted.status, `${prefix} ${label} DELETE`).toBe(404);
        expect(deleted.body.error).toBe("Comment not found");

        await settleFan();
        expect(snapshotComment(bComment)).toEqual(beforeChild);
        expect(snapshotMentions(bComment)).toEqual(beforeMentions);
        expect(JSON.parse(JSON.stringify(commentRowsFor(a)))).toEqual(beforeA);
        expect(JSON.parse(JSON.stringify(commentRowsFor(b)))).toEqual(beforeB);
        expect(notificationTablesSnapshot()).toEqual(durableBefore);
        expect(sseTotal()).toBe(sseBefore);
      }
    }
  }, 60_000);

  it("unknown comment under an existing Task is 404; unknown Task is 404; with the correct pair a different agent stays 403 and a same-ID different stored authorType stays 403", async () => {
    const owner = makeTask(teamAHabitatId, "tcw-unknown-author", "tcw-seed");
    seedComment(owner, "real");
    const positiveAgentId = agentRepo
      .listAgents()
      .find((ag) => ag.name === "tcw-agent-positive")!.id;

    for (const prefix of PREFIXES) {
      const patched = await wire(
        prefix,
        "PATCH",
        `/tasks/${owner}/comments/00000000-0000-4000-8000-0000000000e7`,
        { agentKey: positiveKey, body: { content: "x" } },
      );
      expect(patched.status, `${prefix} PATCH unknown`).toBe(404);

      const deleted = await wire(
        prefix,
        "DELETE",
        `/tasks/${owner}/comments/00000000-0000-4000-8000-0000000000e8`,
        { agentKey: positiveKey },
      );
      expect(deleted.status, `${prefix} DELETE unknown`).toBe(404);
    }

    // Both-prefix denial matrix with full row/mention/effect snapshots:
    // correct-pair other-author 403, same-ID/type-mismatch 403, and
    // wrong-parent NON-author 404-before-403 in the SAME and a DIFFERENT
    // Habitat.
    const foreign = seedComment(owner, "other-agent-comment", null, "agent", assignedAgentId);
    const typed = seedComment(owner, "human-typed", null, "human", positiveAgentId);
    seedComment(owner, "keep-row");
    // Nonempty durable mention rows on BOTH denial targets so row/mention
    // equality is non-vacuous; exact before-state captured per target.
    seedCommentMention(foreign, "author403-foreign");
    seedCommentMention(typed, "author403-typed");
    const foreignBefore = snapshotComment(foreign);
    const foreignMentionsBefore = snapshotMentions(foreign);
    const typedBefore = snapshotComment(typed);
    const typedMentionsBefore = snapshotMentions(typed);
    // REAL retained watcher: a persisted user row plus the real
    // taskWatchers writer on the denial test's own Task, present BEFORE the
    // denial snapshot — proving denials cannot remove collateral watcher
    // rows (an empty table could only detect insertion).
    userRepo.createUser({
      id: "tcw-watch-user",
      username: "tcw-watch-user",
      passwordHash: "tcw-not-a-login-hash",
      role: "viewer",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    watcherRepo.addWatcher(owner, "tcw-watch-user");
    const watcherRowsBefore = JSON.parse(
      JSON.stringify(getDb().select().from(taskWatchersTable).where(eq(taskWatchersTable.taskId, owner)).all()),
    );
    expect(watcherRowsBefore.length).toBeGreaterThan(0);
    const durableBefore = notificationTablesSnapshot();
    const sseBefore = sseTotal();
    const hookBefore = hookCount();

    for (const prefix of PREFIXES) {
      for (const [target, rowBefore, mentionsBefore] of [
        [foreign, foreignBefore, foreignMentionsBefore],
        [typed, typedBefore, typedMentionsBefore],
      ] as const) {
        for (const [method, path] of [
          ["PATCH", `/tasks/${owner}/comments/${target}`],
          ["DELETE", `/tasks/${owner}/comments/${target}`],
        ] as const) {
          const res = await wire(prefix, method, path, {
            agentKey: positiveKey,
            body: method === "PATCH" ? { content: "x" } : undefined,
          });
          expect(res.status, `${prefix} ${target} ${method}`).toBe(403);
        }
      }
    }
    await settleFan();
    // Exact row + mention + SSE-publication + creation-hook zero-delta over
    // BOTH prefixes — not existence proofs.
    expect(snapshotComment(foreign)).toEqual(foreignBefore);
    expect(snapshotMentions(foreign)).toEqual(foreignMentionsBefore);
    expect(snapshotComment(typed)).toEqual(typedBefore);
    expect(snapshotMentions(typed)).toEqual(typedMentionsBefore);
    expect(sseTotal()).toBe(sseBefore);
    expect(hookCount()).toBe(hookBefore);
    expect(notificationTablesSnapshot()).toEqual(durableBefore);
    // The retained watcher's full tuple is byte-identical after denials.
    expect(
      JSON.parse(
        JSON.stringify(getDb().select().from(taskWatchersTable).where(eq(taskWatchersTable.taskId, owner)).all()),
      ),
    ).toEqual(watcherRowsBefore);
    expect(commentRowsFor(owner)).toHaveLength(4);

    // Wrong-Task URL with a NON-author caller: URL containment still yields
    // the generic 404 BEFORE any author evaluation (never 403, never
    // content) — same- AND different-Habitat targets, both prefixes, rows
    // and mention rows unchanged.
    for (const [label, otherHabitatId] of [
      ["same-habitat", teamAHabitatId],
      ["different-habitat", teamBHabitatId],
    ] as const) {
      const c = makeTask(teamAHabitatId, `tcw-nonauthor-url-${label}`, "tcw-seed");
      const otherTask = makeTask(otherHabitatId, `tcw-nonauthor-url-other-${label}`, "tcw-seed");
      const foreignNonAuthor = seedComment(otherTask, `non-author-target-${label}`, null, "human", "human-author");
      seedCommentMention(foreignNonAuthor, `nonauthor-${label}`);
      const rowBefore = snapshotComment(foreignNonAuthor);
      const mentionBefore = snapshotMentions(foreignNonAuthor);
      const sseBefore = sseTotal();

      for (const prefix of PREFIXES) {
        for (const [method, path] of [
          ["PATCH", `/tasks/${c}/comments/${foreignNonAuthor}`],
          ["DELETE", `/tasks/${c}/comments/${foreignNonAuthor}`],
        ] as const) {
          const res = await wire(prefix, method, path, {
            agentKey: positiveKey,
            body: method === "PATCH" ? { content: "x" } : undefined,
          });
          expect(res.status, `${prefix} ${label} ${method}`).toBe(404);
          expect(res.body.error).toBe("Comment not found");
        }
      }
      await settleFan();
      expect(snapshotComment(foreignNonAuthor)).toEqual(rowBefore);
      expect(snapshotMentions(foreignNonAuthor)).toEqual(mentionBefore);
      expect(sseTotal()).toBe(sseBefore);
    }
  }, 60_000);

  it("PATCH by the exact typed author keeps the mention projection and content, does NOT recompute mentions, emits no SSE and fires no creation hook", async () => {
    const owner = makeTask(teamAHabitatId, "tcw-patch-semantics", "tcw-seed");
    const created = await wire("/api/v1", "POST", `/tasks/${owner}/comments`, {
      agentKey: positiveKey,
      body: { content: `note @${mentionAgentName}` },
    });
    const commentId = created.body.comment.id;
    expect(created.body.comment.mentions).toHaveLength(1);
    const mentionsBefore = snapshotMentions(commentId);
    const sseBefore = sseTotal();
    const hookBefore = hookCount();

    const patched = await wire("/api/v1", "PATCH", `/tasks/${owner}/comments/${commentId}`, {
      agentKey: positiveKey,
      body: { content: `edited, mention gone @removed-name` },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.comment.content).toBe("edited, mention gone @removed-name");
    // Existing mention projection preserved verbatim — no recompute.
    expect(patched.body.comment.mentions).toHaveLength(1);
    expect(snapshotMentions(commentId)).toEqual(mentionsBefore);
    expect(row(commentId)!.updatedAt >= row(commentId)!.createdAt).toBe(true);
    expect(sseTotal()).toBe(sseBefore);
    expect(hookCount()).toBe(hookBefore);

    function row(id: string) {
      return getDb().select().from(taskComments).where(eq(taskComments.id, id)).get()!;
    }
  }, 60_000);

  it("DELETE by the exact typed author returns 204, removes the mixed-author same-Task thread via cascade with exactly ONE root deletion event, repeat is 404, other Tasks untouched", async () => {
    for (const prefix of PREFIXES) {
      const suffix = prefix.slice(5);
      const owner = makeTask(teamAHabitatId, `tcw-del-${suffix}`, "tcw-seed");
      const other = makeTask(teamAHabitatId, `tcw-del-other-${suffix}`, "tcw-seed");
      const positiveAgentId = agentRepo
        .listAgents()
        .find((ag) => ag.name === "tcw-agent-positive")!.id;
      // The root is authored by the CALLING agent (typed author equality);
      // the replies deliberately belong to other authors.
      const root = seedComment(owner, `tcw-del-root-${suffix}`, null, "agent", positiveAgentId);
      const replyHuman = seedComment(owner, "reply-human", root, "human", "human-author");
      const replyAgent = seedComment(owner, "reply-agent", root);
      seedComment(owner, "unrelated-root");
      const otherKeep = seedComment(other, "other-task-keep");
      const sseBefore = sseTotal();

      const res = await wire(prefix, "DELETE", `/tasks/${owner}/comments/${root}`, {
        agentKey: positiveKey,
      });
      expect(res.status, `${prefix} delete`).toBe(204);
      expect(res.text, `${prefix} empty body`).toBe("");

      const remaining = commentRowsFor(owner).map((r) => r.id);
      expect(remaining).toHaveLength(1); // the unrelated root
      expect(
        getDb().select().from(taskComments).where(eq(taskComments.id, replyHuman)).all(),
      ).toHaveLength(0);
      expect(
        getDb().select().from(taskComments).where(eq(taskComments.id, replyAgent)).all(),
      ).toHaveLength(0);

      const pubs = pubsSince(sseBefore);
      expect(pubs, `${prefix} exactly one publication`).toHaveLength(1);
      expect(pubs[0][0]).toBe(teamAHabitatId);
      expect(pubs[0][1].type).toBe("task.comment_deleted");
      expect(pubs[0][1].data.taskId).toBe(owner);
      expect(pubs[0][1].data.commentId).toBe(root);

      expect(snapshotComment(otherKeep)).toHaveLength(1);

      const repeat = await wire(prefix, "DELETE", `/tasks/${owner}/comments/${root}`, {
        agentKey: positiveKey,
      });
      expect(repeat.status, `${prefix} repeat`).toBe(404);
      expect(sseCount("task.comment_deleted", owner), `${prefix} stays 1`).toBe(1);
    }
  }, 60_000);
});

describe("comment operations — served MCP compatibility (real agent key over stdio)", () => {
  it("add-comment root and reply round-trip with truthful identity AND positive effect tuples; absent Task, missing parent and wrong-Task parent errors leave fan/mentions/durable tables untouched; get-comments keeps the enriched shape", async () => {
    const owner = makeTask(teamAHabitatId, "tcw-mcp", "tcw-seed");
    const sseBefore = sseTotal();
    const hookBefore = hookCount();
    const emailsBefore = sendEmailSpy.mock.calls.length;
    const durableBefore = notificationTablesSnapshot();

    const created = await callTool("orcy_habitat_task", {
      action: "add-comment",
      taskId: owner,
      content: `mcp root @${mentionAgentName}`,
    });
    expect(created.isError).toBeFalsy();
    const createdComment = JSON.parse(toolText(created)).comment;
    expect(createdComment.taskId).toBe(owner);
    expect(createdComment.parentId).toBeNull();
    expect(createdComment.authorType).toBe("agent");
    expect(createdComment.authorId).toBe(assignedAgentId);
    expect(createdComment.mentions).toHaveLength(1);
    expect(createdComment.mentions[0].mentionedId).toBe(mentionAgentId);

    const dbRow = getDb()
      .select()
      .from(taskComments)
      .where(eq(taskComments.id, createdComment.id))
      .get()!;
    expect(dbRow.taskId).toBe(owner);
    expect(dbRow.authorId).toBe(assignedAgentId);

    // Positive effect tuples for the root: exactly commented + mentioned,
    // both addressed to the actual Habitat with the recipient identity; the
    // hook carries the exact MCP-attributed author; the agent mention takes
    // no notification arm.
    let pubs = pubsSince(sseBefore).filter(([, e]) => e?.data?.taskId === owner);
    expect(pubs.map(([, e]) => e.type).toSorted()).toEqual(["task.commented", "task.mentioned"]);
    expect(pubs[0][0]).toBe(teamAHabitatId);
    // EXACT tuples for BOTH publications: each carries its own Habitat
    // argument, and the mention event carries the recipient identity and
    // the originating comment ID.
    expect(pubs[1][0]).toBe(teamAHabitatId);
    expect(pubs[1][1].type).toBe("task.mentioned");
    expect(pubs[1][1].data.commentId).toBe(createdComment.id);
    expect(pubs[1][1].data.mentionedId).toBe(mentionAgentId);
    expect(pubs[1][1].data.mentionedName).toBe(mentionAgentName);
    expect(pubs[0][1].data.comment.id).toBe(createdComment.id);
    expect(hookCount()).toBe(hookBefore + 1);
    expect(hookCalls.at(-1)).toMatchObject({
      commentId: createdComment.id,
      authorType: "agent",
      authorId: assignedAgentId,
      habitatId: teamAHabitatId,
    });
    await settleFan();
    expect(sendEmailSpy.mock.calls.length).toBe(emailsBefore);

    const replySse = sseTotal();
    const replyHook = hookCount();
    const reply = await callTool("orcy_habitat_task", {
      action: "add-comment",
      taskId: owner,
      content: "mcp reply",
      parentId: createdComment.id,
    });
    expect(reply.isError).toBeFalsy();
    const replyComment = JSON.parse(toolText(reply)).comment;
    expect(replyComment.parentId).toBe(createdComment.id);
    expect(replyComment.taskId).toBe(owner);
    pubs = pubsSince(replySse).filter(([, e]) => e?.data?.taskId === owner);
    expect(pubs).toHaveLength(1);
    expect(pubs[0][0]).toBe(teamAHabitatId);
    expect(pubs[0][1].type).toBe("task.commented");
    expect(pubs[0][1].data.comment.id).toBe(replyComment.id);
    expect(hookCount()).toBe(replyHook + 1);
    expect(hookCalls.at(-1)).toMatchObject({
      commentId: replyComment.id,
      authorType: "agent",
      authorId: assignedAgentId,
      habitatId: teamAHabitatId,
    });

    const list = await callTool("orcy_habitat_task", { action: "get-comments", taskId: owner });
    expect(list.isError).toBeFalsy();
    const listBody = JSON.parse(toolText(list));
    expect(listBody.total).toBeGreaterThanOrEqual(2);
    expect(listBody.comments.map((c: any) => c.id)).toContain(createdComment.id);
    expect(listBody.comments.find((c: any) => c.id === createdComment.id).mentions).toHaveLength(1);

    const other = makeTask(teamAHabitatId, "tcw-mcp-other", "tcw-seed");
    const otherRoot = seedComment(other, "other-root");

    // Denials: zero fan, zero mention-row change anywhere on EITHER
    // involved Task (full relevant mention table, not just the root's),
    // zero durable notification rows.
    const denialSse = sseTotal();
    const denialHook = hookCount();
    const denialEmails = sendEmailSpy.mock.calls.length;
    const denialDurable = notificationTablesSnapshot();
    const mentionsBefore = JSON.parse(
      JSON.stringify(
        getDb()
          .select()
          .from(taskCommentMentions)
          .where(
            sql`${taskCommentMentions.commentId} IN (SELECT id FROM task_comments WHERE task_id IN (${owner}, ${other}))`,
          )
          .all(),
      ),
    );

    const absent = await callTool("orcy_habitat_task", {
      action: "add-comment",
      taskId: "00000000-0000-4000-8000-0000000000e9",
      content: "nope",
    });
    expect(absent.isError).toBeTruthy();

    const missingParent = await callTool("orcy_habitat_task", {
      action: "add-comment",
      taskId: owner,
      content: "orphan",
      parentId: "00000000-0000-4000-8000-0000000000ea",
    });
    expect(missingParent.isError).toBeTruthy();

    const wrongTaskParent = await callTool("orcy_habitat_task", {
      action: "add-comment",
      taskId: owner,
      content: "cross",
      parentId: otherRoot,
    });
    expect(wrongTaskParent.isError).toBeTruthy();

    await settleFan();
    expect(commentRowsFor(owner).map((r) => r.id).toSorted()).toEqual(
      [createdComment.id, replyComment.id].toSorted(),
    );
    expect(
      JSON.parse(
        JSON.stringify(
          getDb()
            .select()
            .from(taskCommentMentions)
            .where(
              sql`${taskCommentMentions.commentId} IN (SELECT id FROM task_comments WHERE task_id IN (${owner}, ${other}))`,
            )
            .all(),
        ),
      ),
    ).toEqual(mentionsBefore);
    expect(sseTotal()).toBe(denialSse);
    expect(hookCount()).toBe(denialHook);
    expect(sendEmailSpy.mock.calls.length).toBe(denialEmails);
    expect(notificationTablesSnapshot()).toEqual(denialDurable);
  }, 60_000);
});
