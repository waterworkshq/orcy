/**
 * Effort POST containment — REAL HTTP wire matrix on BOTH served prefixes
 * (`/api/v1`, deprecated `/api`) plus served MCP compatibility.
 *
 * Scope of claims (author evidence, not universal Task isolation):
 *  - POST /tasks/:id/effort-entries and POST /tasks/:id/effort-entries/:entryId/correct
 *    resolve the TARGET Task → Mission → Habitat and enforce the shared
 *    membership predicate BEFORE any containment read or write. Intended
 *    deltas: team-nonmember humans (including global admins) 403 (was 200);
 *    authenticated missing Task 404. Previously these two writes had no Task
 *    admission at all — any local actor could log or correct effort on any
 *    Task in any Habitat.
 *  - Preserved: local_actor policy and 401 for anonymous / invalid local /
 *    remote-only credentials; member (any role) and personal-Habitat human
 *    admission; bound/unbound local agents; actor attribution (agent vs human
 *    vs default source); body validation unchanged (schema 400 runs at the
 *    framework layer before admission); correction pre-check semantics
 *    (missing entry 404, foreign-Task entry 400) for admitted actors.
 *  - Denied writes leave zero rows and zero metric mutations (state-unchanged
 *    proofs query the live DB, not just the status code).
 *  - Ordering: admission runs before the correction containment pre-check
 *    (nonmember + foreign entry is 403, never 400), and before any row is
 *    written (nonmember writes produce no effort_entries row and no
 *    task.actualMinutes/estimationAccuracy recalculation).
 *
 * No middleware mocks: every request crosses a real TCP socket into the real
 * application; MCP checks drive the spawned server over stdio with a real
 * agent key.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { join } from "node:path";
import jwt from "jsonwebtoken";
import { eq, sql, inArray } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as effortRepo from "../repositories/effortEntry.js";
import {
  effortEntries,
  tasks,
  taskEvents,
  missions,
  notificationDeliveries,
  taskWatchers,
  taskTimeRecords,
  taskReviewers,
  notificationEvents,
} from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import * as userRepo from "../repositories/user.js";

const MCP_ENTRY = join(import.meta.dirname, "..", "..", "..", "mcp", "src", "index.ts");
const PREFIXES = ["/api/v1", "/api"] as const;

const EFFORT_NOTE = "ewc-effort-note-marker";

let app: HttpRuntimeHandle;
let baseUrl: string;
let child: ChildProcess;
let childExit: Promise<void>;

let teamId: string;
let teamHabitatId: string;
let personalHabitatId: string;
let agentKey: string;
let agentId: string;
let boundAgentKey: string;
let validRemoteKey: string;

let memberOwnerJwt: string;
let memberAdminJwt: string;
let memberViewerJwt: string;
let nonmemberAdminJwt: string;

// Seeded team-habitat task with one effort entry available for corrections.
let teamTaskId: string;
let teamEntryId: string;

let personalTaskId: string;

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
  return jwt.sign({ sub: userId, username: `ewc-${userId}`, role }, getJwtSecret(), {
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

/** Live-DB state probes: denied writes must leave both unchanged. */
function effortRowsFor(taskId: string) {
  return getDb().select().from(effortEntries).where(eq(effortEntries.taskId, taskId)).all();
}
function taskMetricsRow(taskId: string) {
  const row = getDb()
    .select({
      actualMinutes: tasks.actualMinutes,
      estimationAccuracy: tasks.estimationAccuracy,
      version: tasks.version,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  return JSON.parse(JSON.stringify(row));
}
function taskRowFull(taskId: string) {
  return JSON.parse(JSON.stringify(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()));
}
function taskLifecycleRow(taskId: string) {
  const row = getDb()
    .select({
      status: tasks.status,
      assignedAgentId: tasks.assignedAgentId,
      startedAt: tasks.startedAt,
      completedAt: tasks.completedAt,
      cycleTimeMinutes: tasks.cycleTimeMinutes,
      leadTimeMinutes: tasks.leadTimeMinutes,
    })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get();
  return JSON.parse(JSON.stringify(row));
}
function missionRowFor(taskId: string) {
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as
    | { missionId: string }
    | undefined;
  if (!task) return null;
  const row = getDb()
    .select({
      actualMinutes: missions.actualMinutes,
      plannedMinutes: missions.plannedMinutes,
      planningAccuracy: missions.planningAccuracy,
      version: missions.version,
      updatedAt: missions.updatedAt,
    })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .get();
  return row ? JSON.parse(JSON.stringify(row)) : null;
}
function auditRowsFor(taskId: string) {
  return JSON.parse(
    JSON.stringify(getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all()),
  );
}
function watchersFor(taskId: string) {
  return JSON.parse(
    JSON.stringify(
      getDb().select().from(taskWatchers).where(eq(taskWatchers.taskId, taskId)).all(),
    ),
  );
}
function reviewersFor(taskId: string) {
  return JSON.parse(
    JSON.stringify(
      getDb().select().from(taskReviewers).where(eq(taskReviewers.taskId, taskId)).all(),
    ),
  );
}
function inferredRecordsFor(taskId: string) {
  return JSON.parse(
    JSON.stringify(
      getDb().select().from(taskTimeRecords).where(eq(taskTimeRecords.taskId, taskId)).all(),
    ),
  );
}
/** Raw-body wire request: sends the literal payload byte-for-byte. */
async function rawWire(
  prefix: string,
  path: string,
  rawBody: string,
  agentKeyOverride?: string,
): Promise<{ status: number; body: any; text: string }> {
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method: "POST",
    headers: {
      "x-agent-api-key": agentKeyOverride ?? agentKey,
      "Content-Type": "application/json",
    },
    body: rawBody,
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
function notificationsCount() {
  const row = getDb()
    .select({ count: sql<number>`count(*)` })
    .from(notificationDeliveries)
    .get();
  return row?.count ?? 0;
}
function seedInferredPresence(taskId: string, agent: string, minutes: number) {
  getDb()
    .insert(taskTimeRecords)
    .values({
      id: `ewc-inferred-${taskId}`,
      taskId,
      agentId: agent,
      minutesSpent: minutes,
      recordedAt: "2026-01-01T00:00:00.000Z",
      statusDuringWork: "in_progress",
    })
    .run();
}
function setFk(on: boolean): void {
  getDb().run(on ? sql`PRAGMA foreign_keys = ON` : sql`PRAGMA foreign_keys = OFF`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(on ? 1 : 0);
}
/** The ACTUAL Habitat owning a Task, derived through Task→Mission. */
function habitatIdForTask(taskId: string): string | null {
  const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get() as
    | { missionId: string }
    | undefined;
  if (!task) return null;
  const mission = getDb()
    .select({ habitatId: missions.habitatId })
    .from(missions)
    .where(eq(missions.id, task.missionId))
    .get() as { habitatId: string } | undefined;
  return mission?.habitatId ?? null;
}
/** Task-ASSOCIATED delivery rows: deliveries of this Task's notification
 * events (joined through the event's sourceId) — immune to unrelated
 * same-Habitat deliveries. */
function deliveriesForTask(taskId: string) {
  const eventIds = getDb()
    .select({ id: notificationEvents.id })
    .from(notificationEvents)
    .where(eq(notificationEvents.sourceId, taskId))
    .all()
    .map((r: any) => r.id);
  if (eventIds.length === 0) return [];
  return getDb()
    .select()
    .from(notificationDeliveries)
    .where(inArray(notificationDeliveries.eventId, eventIds))
    .all();
}
/** Full denial-effect snapshot across every affected surface — notification
 * state is Habitat-derived from the Task's ACTUAL Mission (never hardcoded),
 * capturing the task-associated notification events (sourceId = Task) and
 * that Habitat's deliveries. */
function fullTaskStateSnapshot(taskId: string) {
  const habitatId = habitatIdForTask(taskId);
  return {
    rows: JSON.parse(JSON.stringify(effortRowsFor(taskId))),
    metrics: taskMetricsRow(taskId),
    task: taskRowFull(taskId),
    lifecycle: taskLifecycleRow(taskId),
    mission: missionRowFor(taskId),
    audits: auditRowsFor(taskId),
    watchers: watchersFor(taskId),
    reviewers: reviewersFor(taskId),
    inferred: inferredRecordsFor(taskId),
    notificationEvents: JSON.parse(
      JSON.stringify(
        getDb()
          .select()
          .from(notificationEvents)
          .where(eq(notificationEvents.sourceId, taskId))
          .all(),
      ),
    ),
    notificationDeliveries: JSON.parse(JSON.stringify(deliveriesForTask(taskId))),
    habitatId,
  };
}
/**
 * Seed the target-owned nonempty denial surfaces (watcher, reviewer, inferred
 * presence, notification event+delivery) on a Task IN ITS OWN ACTUAL Habitat
 * (derived Task→Mission→Habitat — personal Tasks seed personal-Habitat rows).
 * Returns nothing; callers assert the nonempty denominators themselves before
 * snapshotting. The notification row is a plain persisted
 * notification_events/deliveries pair (sourceId = the Task, recipient = a
 * member human); observing its unchanged bytes is a CHARACTERIZATION OF
 * UNCHANGED PERSISTED STATE, not proof of configured downstream delivery.
 */
function seedDenialSurfaces(taskId: string) {
  const habitatId = habitatIdForTask(taskId)!;
  const recipient = habitatId === teamHabitatId ? "ewc-member-viewer" : "ewc-member-admin";
  getDb()
    .insert(taskWatchers)
    .values({ taskId, userId: recipient, createdAt: "2026-01-01T00:00:00.000Z" })
    .run();
  getDb()
    .insert(taskReviewers)
    .values({
      id: `ewc-reviewer-${taskId}`,
      taskId,
      reviewerType: "human",
      reviewerId: habitatId === teamHabitatId ? "ewc-member-admin" : "ewc-member-owner",
      status: "pending",
      assignedAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  seedInferredPresence(taskId, agentId, 20);
  getDb()
    .insert(notificationEvents)
    .values({
      id: `ewc-notify-event-${taskId}`,
      habitatId,
      eventType: "task_updated",
      sourceType: "habitat",
      sourceId: taskId,
      targetType: "user",
      targetId: recipient,
      severity: "info",
      title: "ewc seeded notification",
      body: "persisted-state characterization fixture",
      createdByType: "human",
      createdById: "ewc-member-admin",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  getDb()
    .insert(notificationDeliveries)
    .values({
      id: `ewc-notify-delivery-${taskId}`,
      eventId: `ewc-notify-event-${taskId}`,
      habitatId,
      recipientType: "user",
      recipientId: recipient,
      status: "pending",
      channels: ["in_app"],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
}

/** Settled all-event census of a stream, with the initial `connected` frame
 * distinctly accounted: returns non-connected deliveries only. */
async function settledNonConnectedEvents(
  stream: { events: any[] },
  quiesceMs = 150,
): Promise<any[]> {
  await new Promise((resolve) => setTimeout(resolve, quiesceMs));
  return stream.events.filter((e: any) => e.type !== "connected");
}
/** Real SSE subscription on the habitat stream (agent-key authenticated). */
async function sseSubscribe(habitatId: string) {
  const res = await fetch(`${baseUrl}/sse/habitats/${habitatId}/stream`, {
    headers: { "x-agent-api-key": agentKey },
  });
  expect(res.status).toBe(200);
  const events: any[] = [];
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  void (async () => {
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n\n")) >= 0) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (line) {
            try {
              events.push(JSON.parse(line.slice(6)));
            } catch {
              /* non-JSON frame */
            }
          }
        }
      }
    } catch {
      /* stream closed */
    }
  })();
  await vi.waitFor(() => expect(events.some((e) => e.type === "connected")).toBe(true), {
    timeout: 5_000,
  });
  return {
    events,
    effortUpdates: () => events.filter((e) => e.type === "effort.updated"),
    close: () => reader.cancel().catch(() => {}),
  };
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
  // Normal wire fixtures run with FK enforcement ON (asserted by read-back);
  // only the explicitly corrupt-ancestry fixtures below may disable it, each
  // in a finally-protected block that restores and re-asserts it.
  setFk(true);
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const org = organizationRepo.createOrganization({
    name: "ewc-org",
    slug: `ewc-org-${Date.now()}`,
  });
  teamId = teamRepo.createTeam({
    organizationId: org.id,
    name: "ewc-team",
    slug: `ewc-team-${Date.now()}`,
  }).id;
  teamHabitatId = habitatRepo.createHabitat({
    name: "ewc-team-habitat",
    teamId,
  }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "ewc-personal-habitat" }).id;

  // Real user rows for every named human identity: with FK ON,
  // team_members.user_id references users.id, so members must exist before
  // the membership fixtures (and the JWT-only personal humans get rows too).
  const userNow = new Date().toISOString();
  for (const [userId, role] of [
    ["ewc-member-owner", "viewer"],
    ["ewc-member-admin", "admin"],
    ["ewc-member-viewer", "viewer"],
    ["ewc-member-editor", "editor"],
    ["ewc-nonmember-admin", "admin"],
    ["ewc-personal-admin", "admin"],
    ["ewc-personal-editor", "editor"],
    ["ewc-personal-viewer", "viewer"],
  ] as const) {
    userRepo.createUser({
      id: userId,
      username: `ewc-${userId}`,
      passwordHash: "ewc-unused-hash",
      role,
      createdAt: userNow,
      updatedAt: userNow,
    });
  }
  teamMemberRepo.addMember({ teamId, userId: "ewc-member-owner", role: "owner" });
  teamMemberRepo.addMember({ teamId, userId: "ewc-member-admin", role: "member" });
  teamMemberRepo.addMember({ teamId, userId: "ewc-member-viewer", role: "member" });
  // Fixture ownership asserted up front: the member rows exist and are
  // nonempty before any proof runs.
  expect(teamMemberRepo.listMembers(teamId).length).toBeGreaterThanOrEqual(3);

  memberOwnerJwt = mint("ewc-member-owner", "viewer");
  memberAdminJwt = mint("ewc-member-admin", "admin");
  memberViewerJwt = mint("ewc-member-viewer", "viewer");
  nonmemberAdminJwt = mint("ewc-nonmember-admin", "admin");

  const created = agentRepo.createAgent({
    name: "ewc-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentId = created.agent.id;
  agentKey = created.plainApiKey;

  // Second agent BOUND (currentTaskId) to a personal-habitat task: proves
  // binding elsewhere changes nothing for the TEAM-habitat writes below.
  const boundAgent = agentRepo.createAgent({
    name: "ewc-bound-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  boundAgentKey = boundAgent.plainApiKey;
  const boundAnchorTask = makeTask(personalHabitatId, "ewc-bound-anchor", "ewc-seed");
  agentRepo.heartbeat(boundAgent.agent.id, boundAnchorTask);

  // Fully VALID remote credential: must still get 401 on these
  // local-credential policies.
  const pod = remotePodRepo.createRemotePod({
    habitatId: teamHabitatId,
    name: "ewc-remote-pod",
  });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamHabitatId,
    participantType: "remote_orcy",
    displayName: "ewc-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamHabitatId,
    credentialType: "api",
    label: "ewc-remote-cred",
  }).plaintextSecret;

  teamTaskId = makeTask(teamHabitatId, "ewc-team-task", "ewc-seed");
  teamEntryId = effortRepo.createEffortEntry({
    taskId: teamTaskId,
    actorType: "human",
    actorId: "ewc-member-admin",
    minutes: 30,
    source: "human_manual",
    note: `${EFFORT_NOTE}-seed`,
  }).id;
  personalTaskId = makeTask(personalHabitatId, "ewc-personal-task", "ewc-seed");

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
    clientInfo: { name: "ewc-effort-write-wire-test", version: "1.0.0" },
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

describe("effort POST containment — admission matrix (both prefixes)", () => {
  it("admits every member shape and local agent on both prefixes; shapes and attribution unchanged", async () => {
    for (const prefix of PREFIXES) {
      for (const token of [memberOwnerJwt, memberAdminJwt, memberViewerJwt]) {
        const logged = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
          token,
          body: { minutes: 15, note: `${EFFORT_NOTE}-member` },
        });
        expect(logged.status).toBe(200);
        expect(logged.body.actorType).toBe("human");
        expect(logged.body.source).toBe("human_manual");
        expect(logged.body.minutes).toBe(15);

        const corrected = await wire(
          prefix,
          "POST",
          `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
          { token, body: { minutesDelta: -5, correctionReason: "ewc-member-correction" } },
        );
        expect(corrected.status).toBe(200);
        expect(corrected.body.source).toBe("correction_adjustment");
        expect(corrected.body.correctsEntryId).toBe(teamEntryId);
      }

      for (const key of [agentKey, boundAgentKey]) {
        const logged = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
          agentKey: key,
          body: { minutes: 10, note: `${EFFORT_NOTE}-agent` },
        });
        expect(logged.status).toBe(200);
        expect(logged.body.actorType).toBe("agent");
        expect(logged.body.source).toBe("agent_reported");

        const corrected = await wire(
          prefix,
          "POST",
          `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
          { agentKey: key, body: { minutesDelta: -1, correctionReason: "ewc-agent-correction" } },
        );
        expect(corrected.status).toBe(200);
        expect(corrected.body.actorType).toBe("agent");
      }
    }
  });

  it("nonmember humans — including global admins — get 403 on both writes with zero state change on every seeded surface and a silent stream", async () => {
    seedDenialSurfaces(teamTaskId);
    // Nonempty, target-owned denominators asserted BEFORE the snapshot.
    expect(watchersFor(teamTaskId).length).toBeGreaterThanOrEqual(1);
    expect(reviewersFor(teamTaskId).length).toBeGreaterThanOrEqual(1);
    expect(inferredRecordsFor(teamTaskId).length).toBeGreaterThanOrEqual(1);
    const before = fullTaskStateSnapshot(teamTaskId);
    expect(before.notificationDeliveries.length).toBeGreaterThanOrEqual(1);

    const stream = await sseSubscribe(teamHabitatId);
    try {
      for (const prefix of PREFIXES) {
        const logged = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
          token: nonmemberAdminJwt,
          body: { minutes: 60, note: "ewc-denied-log" },
        });
        expect(logged.status).toBe(403);
        expect(logged.body.code).toBe("BOARD_ACCESS_DENIED");

        const corrected = await wire(
          prefix,
          "POST",
          `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
          { token: nonmemberAdminJwt, body: { minutesDelta: -30, correctionReason: "ewc-denied" } },
        );
        expect(corrected.status).toBe(403);
        expect(corrected.body.code).toBe("BOARD_ACCESS_DENIED");
      }

      // Stream stays OPEN through the settled observation window: silence is
      // measured on a live connection, not after cancellation. The initial
      // `connected` frame is distinctly accounted.
      const delivered = await settledNonConnectedEvents(stream);
      expect(delivered).toHaveLength(0);
      expect(fullTaskStateSnapshot(teamTaskId)).toEqual(before);
    } finally {
      stream.close();
    }
  });

  it("personal-habitat humans stay admitted (existing any-human access preserved)", async () => {
    for (const prefix of PREFIXES) {
      const logged = await wire(prefix, "POST", `/tasks/${personalTaskId}/effort-entries`, {
        token: nonmemberAdminJwt,
        body: { minutes: 20, note: "ewc-personal" },
      });
      expect(logged.status).toBe(200);
      expect(logged.body.actorType).toBe("human");
    }
  });

  it("anonymous, invalid agent key and valid remote credentials stay 401 on both writes", async () => {
    for (const prefix of PREFIXES) {
      const anonLog = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        body: { minutes: 5 },
      });
      expect(anonLog.status).toBe(401);

      const anonCorrect = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(anonCorrect.status).toBe(401);

      const badKey = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        agentKey: "ewc-bogus-key",
        body: { minutes: 5 },
      });
      expect(badKey.status).toBe(401);

      const remoteLog = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        remoteKey: validRemoteKey,
        body: { minutes: 5 },
      });
      expect(remoteLog.status).toBe(401);

      const remoteCorrect = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { remoteKey: validRemoteKey, body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(remoteCorrect.status).toBe(401);
    }
  });

  it("missing Task stays 404 on both writes; body validation still 400 at the framework layer", async () => {
    for (const prefix of PREFIXES) {
      const missingLog = await wire(prefix, "POST", "/tasks/ewc-nonexistent/effort-entries", {
        agentKey,
        body: { minutes: 5 },
      });
      expect(missingLog.status).toBe(404);

      const missingCorrect = await wire(
        prefix,
        "POST",
        `/tasks/ewc-nonexistent/effort-entries/${teamEntryId}/correct`,
        { agentKey, body: { minutesDelta: -5, correctionReason: "x" } },
      );
      expect(missingCorrect.status).toBe(404);

      const invalidBody = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: nonmemberAdminJwt,
        body: { minutes: 0 },
      });
      expect(invalidBody.status).toBe(400);
    }
  });
});

describe("effort POST containment — correction containment ordering", () => {
  it("foreign-Task entry stays 400 for admitted actors with zero new rows (pre-check preserved)", async () => {
    const otherTaskId = makeTask(teamHabitatId, "ewc-other-task", "ewc-seed");
    const otherEntryId = effortRepo.createEffortEntry({
      taskId: otherTaskId,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 25,
      source: "human_manual",
    }).id;
    // Full state for BOTH involved Tasks (URL Task and the original's Task).
    const urlBefore = fullTaskStateSnapshot(teamTaskId);
    const otherBefore = fullTaskStateSnapshot(otherTaskId);
    const stream = await sseSubscribe(teamHabitatId);
    try {
      for (const prefix of PREFIXES) {
        const res = await wire(
          prefix,
          "POST",
          `/tasks/${teamTaskId}/effort-entries/${otherEntryId}/correct`,
          { token: memberAdminJwt, body: { minutesDelta: -5, correctionReason: "ewc-foreign" } },
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Effort entry does not belong to this task");
      }
      const delivered = await settledNonConnectedEvents(stream);
      expect(delivered).toHaveLength(0);
      expect(fullTaskStateSnapshot(teamTaskId)).toEqual(urlBefore);
      expect(fullTaskStateSnapshot(otherTaskId)).toEqual(otherBefore);
    } finally {
      stream.close();
    }
  });

  it("admission runs BEFORE the containment pre-check: nonmember + foreign entry is 403, never 400", async () => {
    const otherTaskId = makeTask(teamHabitatId, "ewc-other-task-2", "ewc-seed");
    const otherEntryId = effortRepo.createEffortEntry({
      taskId: otherTaskId,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 25,
      source: "human_manual",
    }).id;

    for (const prefix of PREFIXES) {
      const res = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${otherEntryId}/correct`,
        { token: nonmemberAdminJwt, body: { minutesDelta: -5, correctionReason: "ewc-foreign" } },
      );
      expect(res.status).toBe(403);
    }
  });

  it("missing entry stays 404 for admitted actors", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/ewc-nonexistent-entry/correct`,
        { token: memberAdminJwt, body: { minutesDelta: -5, correctionReason: "x" } },
      );
      expect(res.status).toBe(404);
    }
  });
});

describe("effort POST containment — served MCP compatibility (team habitat, real agent key)", () => {
  it("log-effort and correct-effort-entry dispatch through the agent key to the guarded routes", async () => {
    // The dispatch action schemas forward taskId+minutes (log) and
    // taskId+entryId+minutesDelta+correctionReason (correct) — distinctive
    // scalar markers make the landed rows unambiguous in the live DB.
    const logged = await callTool("orcy_habitat_task", {
      action: "log-effort",
      taskId: teamTaskId,
      minutes: 17,
    });
    expect(logged.isError).toBeFalsy();
    expect(effortRowsFor(teamTaskId).some((r) => r.minutes === 17 && r.actorType === "agent")).toBe(
      true,
    );

    const corrected = await callTool("orcy_habitat_task", {
      action: "correct-effort-entry",
      taskId: teamTaskId,
      entryId: teamEntryId,
      minutesDelta: -3,
      correctionReason: "ewc-mcp-correction",
    });
    expect(corrected.isError).toBeFalsy();
    expect(effortRowsFor(teamTaskId).some((r) => r.correctionReason === "ewc-mcp-correction")).toBe(
      true,
    );

    const missing = await callTool("orcy_habitat_task", {
      action: "log-effort",
      taskId: "ewc-nonexistent",
      minutes: 5,
    });
    expect(missing.isError).toBeTruthy();
    expect(toolText(missing)).toMatch(/404|not found/i);
  }, 60_000);

  it("correction errors: missing original and wrong-Task pair are isError with no mutation; raw row shape on success", async () => {
    const before = effortRowsFor(teamTaskId).length;

    const missingOriginal = await callTool("orcy_habitat_task", {
      action: "correct-effort-entry",
      taskId: teamTaskId,
      entryId: "ewc-nonexistent-entry",
      minutesDelta: -3,
      correctionReason: "ewc-mcp-missing-original",
    });
    expect(missingOriginal.isError).toBeTruthy();
    expect(toolText(missingOriginal)).toMatch(/404|not found/i);
    expect(effortRowsFor(teamTaskId)).toHaveLength(before);

    const otherTask = makeTask(teamHabitatId, "ewc-mcp-other-task", "ewc-seed");
    const otherEntry = effortRepo.createEffortEntry({
      taskId: otherTask,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 20,
      source: "human_manual",
    }).id;
    const wrongPair = await callTool("orcy_habitat_task", {
      action: "correct-effort-entry",
      taskId: teamTaskId,
      entryId: otherEntry,
      minutesDelta: -3,
      correctionReason: "ewc-mcp-wrong-pair",
    });
    expect(wrongPair.isError).toBeTruthy();
    expect(toolText(wrongPair)).toMatch(/400|belong/i);
    expect(effortRowsFor(teamTaskId)).toHaveLength(before);
    expect(effortRowsFor(otherTask)).toHaveLength(1);

    // Raw response shape: the dispatch serializes the returned raw row.
    const logged = await callTool("orcy_habitat_task", {
      action: "log-effort",
      taskId: teamTaskId,
      minutes: 21,
      note: "ewc-mcp-raw-row",
    });
    expect(logged.isError).toBeFalsy();
    const raw = JSON.parse(toolText(logged));
    expect(raw.taskId).toBe(teamTaskId);
    expect(raw.minutes).toBe(21);
    expect(raw.note).toBe("ewc-mcp-raw-row");
    expect(raw.actorType).toBe("agent");
    expect(raw.actorId).toBe(agentId);
    expect(raw.correctsEntryId).toBeNull();
    expect(raw.correctionReason).toBeNull();
    expect(typeof raw.recordedAt).toBe("string");
  }, 60_000);

  it("repeated corrections and correction-of-correction through MCP: distinct rows, exact references, agent identity and mcp_tool provenance", async () => {
    const first = await callTool("orcy_habitat_task", {
      action: "correct-effort-entry",
      taskId: teamTaskId,
      entryId: teamEntryId,
      minutesDelta: -2,
      correctionReason: "ewc-mcp-repeat-1",
    });
    expect(first.isError).toBeFalsy();
    const firstRow = JSON.parse(toolText(first));

    const second = await callTool("orcy_habitat_task", {
      action: "correct-effort-entry",
      taskId: teamTaskId,
      entryId: teamEntryId,
      minutesDelta: -2,
      correctionReason: "ewc-mcp-repeat-2",
    });
    expect(second.isError).toBeFalsy();
    const secondRow = JSON.parse(toolText(second));
    expect(secondRow.id).not.toBe(firstRow.id);
    expect(secondRow.correctsEntryId).toBe(teamEntryId);

    // Correction-of-correction stores the exact correction id.
    const ofCorrection = await callTool("orcy_habitat_task", {
      action: "correct-effort-entry",
      taskId: teamTaskId,
      entryId: firstRow.id,
      minutesDelta: 1,
      correctionReason: "ewc-mcp-corr-of-corr",
    });
    expect(ofCorrection.isError).toBeFalsy();
    const chainRow = JSON.parse(toolText(ofCorrection));
    expect(chainRow.correctsEntryId).toBe(firstRow.id);

    // DB truth: agent identity on every MCP-written row, and the audit
    // provenance for the MCP transport (mcp_tool + toolName).
    for (const id of [firstRow.id, secondRow.id, chainRow.id]) {
      const row = getDb().select().from(effortEntries).where(eq(effortEntries.id, id)).get() as {
        actorType: string;
        actorId: string;
        source: string;
      };
      expect(row.actorType).toBe("agent");
      expect(row.actorId).toBe(agentId);
      expect(row.source).toBe("correction_adjustment");
    }
    const auditRows = auditRowsFor(teamTaskId).filter(
      (a: any) => a.action === "effort_corrected" && a.metadata?.effortEntryId === chainRow.id,
    );
    expect(auditRows).toHaveLength(1);
    expect((auditRows[0] as any).actorType).toBe("agent");
    expect((auditRows[0] as any).actorId).toBe(agentId);
    const meta = (auditRows[0] as any).metadata as Record<string, unknown>;
    const audit = meta.audit as Record<string, unknown> | undefined;
    expect(audit?.source).toBe("mcp_tool");
    expect(audit?.toolName).toBe("orcy_habitat_task");
  }, 60_000);

  it("raw thirteen-field MCP responses equal the DB rows for both actions; audit carries action provenance, deltas and references; originals and totals preserved; denials leave full state unchanged", async () => {
    const t = makeTask(teamHabitatId, "ewc-mcp-full", "ewc-seed");
    const original = effortRepo.createEffortEntry({
      taskId: t,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 90,
      source: "human_manual",
    });
    const originalBefore = JSON.parse(JSON.stringify(original));

    const logged = await callTool("orcy_habitat_task", {
      action: "log-effort",
      taskId: t,
      minutes: 45,
      note: "ewc-mcp-full-log",
    });
    expect(logged.isError).toBeFalsy();
    const rawLog = JSON.parse(toolText(logged));
    const dbLog = JSON.parse(
      JSON.stringify(
        getDb().select().from(effortEntries).where(eq(effortEntries.id, rawLog.id)).get(),
      ),
    );
    expect(rawLog).toEqual(dbLog);
    expect(Object.keys(rawLog).sort()).toEqual(
      [
        "id",
        "taskId",
        "actorType",
        "actorId",
        "minutes",
        "source",
        "note",
        "startedAt",
        "endedAt",
        "recordedAt",
        "correctsEntryId",
        "correctionReason",
        "metadata",
      ].sort(),
    );

    const corrected = await callTool("orcy_habitat_task", {
      action: "correct-effort-entry",
      taskId: t,
      entryId: original.id,
      minutesDelta: -20,
      correctionReason: "ewc-mcp-full-corr",
      note: "ewc-mcp-full-corr-note",
    });
    expect(corrected.isError).toBeFalsy();
    const rawCorr = JSON.parse(toolText(corrected));
    const dbCorr = JSON.parse(
      JSON.stringify(
        getDb().select().from(effortEntries).where(eq(effortEntries.id, rawCorr.id)).get(),
      ),
    );
    expect(rawCorr).toEqual(dbCorr);
    expect(rawCorr.note).toBe("ewc-mcp-full-corr-note");
    expect(rawCorr.minutes).toBe(-20);
    expect(rawCorr.correctsEntryId).toBe(original.id);

    // Audit truth for both actions: actor, reference, delta and MCP action
    // provenance (mcp_tool + toolName + action).
    const logAudit = auditRowsFor(t).find((a: any) => a.action === "effort_logged");
    expect(logAudit).toBeDefined();
    expect((logAudit as any).actorType).toBe("agent");
    expect((logAudit as any).actorId).toBe(agentId);
    const logMeta = (logAudit as any).metadata as any;
    expect(logMeta.effortEntryId).toBe(rawLog.id);
    expect(logMeta.minutes).toBe(45);
    expect(logMeta.audit.source).toBe("mcp_tool");
    expect(logMeta.audit.toolName).toBe("orcy_habitat_task");
    expect(logMeta.audit.mcpAction).toBe("log-effort");

    const corrAudit = auditRowsFor(t).find(
      (a: any) => a.action === "effort_corrected" && a.metadata?.effortEntryId === rawCorr.id,
    );
    expect(corrAudit).toBeDefined();
    const corrMeta = (corrAudit as any).metadata as any;
    expect(corrMeta.correctsEntryId).toBe(original.id);
    expect(corrMeta.minutesDelta).toBe(-20);
    expect(corrMeta.note).toBe("ewc-mcp-full-corr-note");
    expect(corrMeta.audit.source).toBe("mcp_tool");
    expect(corrMeta.audit.mcpAction).toBe("correct-effort-entry");

    // Originals untouched; totals and persisted metrics follow.
    expect(
      JSON.parse(
        JSON.stringify(
          getDb().select().from(effortEntries).where(eq(effortEntries.id, original.id)).get(),
        ),
      ),
    ).toEqual(originalBefore);
    const totals = effortRepo.getEffortTotalsForTask(t);
    expect(totals.loggedEffortMinutes).toBe(135);
    expect(totals.correctionAdjustmentMinutes).toBe(-20);
    expect(taskMetricsRow(t).actualMinutes).toBe(115);

    // Full denial effects through MCP: missing original and wrong-Task pair
    // leave BOTH tasks' complete state untouched and the stream silent.
    const before = fullTaskStateSnapshot(t);
    const otherTask = makeTask(teamHabitatId, "ewc-mcp-full-other", "ewc-seed");
    const otherEntry = effortRepo.createEffortEntry({
      taskId: otherTask,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 10,
      source: "human_manual",
    }).id;
    const otherBefore = fullTaskStateSnapshot(otherTask);
    const denialStream = await sseSubscribe(teamHabitatId);
    try {
      const missingOriginal = await callTool("orcy_habitat_task", {
        action: "correct-effort-entry",
        taskId: t,
        entryId: "ewc-mcp-nonexistent",
        minutesDelta: -3,
        correctionReason: "x",
      });
      expect(missingOriginal.isError).toBeTruthy();
      const wrongPair = await callTool("orcy_habitat_task", {
        action: "correct-effort-entry",
        taskId: t,
        entryId: otherEntry,
        minutesDelta: -3,
        correctionReason: "x",
      });
      expect(wrongPair.isError).toBeTruthy();
      expect(await settledNonConnectedEvents(denialStream)).toHaveLength(0);
      expect(fullTaskStateSnapshot(t)).toEqual(before);
      expect(fullTaskStateSnapshot(otherTask)).toEqual(otherBefore);
      expect(taskMetricsRow(t).actualMinutes).toBe(115);
    } finally {
      denialStream.close();
    }
  }, 60_000);
});

describe("effort POST containment — completed actor matrix (both prefixes)", () => {
  it("personal-habitat human correction stays admitted", async () => {
    const entry = effortRepo.createEffortEntry({
      taskId: personalTaskId,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 30,
      source: "human_manual",
    }).id;
    for (const prefix of PREFIXES) {
      const res = await wire(
        prefix,
        "POST",
        `/tasks/${personalTaskId}/effort-entries/${entry}/correct`,
        {
          token: nonmemberAdminJwt,
          body: { minutesDelta: -5, correctionReason: "ewc-personal-corr" },
        },
      );
      expect(res.status).toBe(200);
      expect(res.body.taskId).toBe(personalTaskId);
      expect(res.body.correctsEntryId).toBe(entry);
    }
  });

  it("member with editor JWT role is admitted (any existing role)", async () => {
    teamMemberRepo.addMember({ teamId, userId: "ewc-member-editor", role: "member" });
    const editorJwt = mint("ewc-member-editor", "editor");
    for (const prefix of PREFIXES) {
      const logged = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: editorJwt,
        body: { minutes: 12, note: "ewc-editor" },
      });
      expect(logged.status).toBe(200);
      expect(logged.body.actorId).toBe("ewc-member-editor");
      const corrected = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: editorJwt, body: { minutesDelta: -1, correctionReason: "ewc-editor-corr" } },
      );
      expect(corrected.status).toBe(200);
    }
  });

  it("assigned-agent shape (task.assignedAgentId set) logs and corrects like any local agent", async () => {
    const assignedTask = makeTask(teamHabitatId, "ewc-assigned-task", "ewc-seed");
    getDb().update(tasks).set({ assignedAgentId: agentId }).where(eq(tasks.id, assignedTask)).run();
    const entry = effortRepo.createEffortEntry({
      taskId: assignedTask,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 30,
      source: "human_manual",
    }).id;
    for (const prefix of PREFIXES) {
      const logged = await wire(prefix, "POST", `/tasks/${assignedTask}/effort-entries`, {
        agentKey,
        body: { minutes: 9 },
      });
      expect(logged.status).toBe(200);
      expect(logged.body.actorType).toBe("agent");
      const corrected = await wire(
        prefix,
        "POST",
        `/tasks/${assignedTask}/effort-entries/${entry}/correct`,
        { agentKey, body: { minutesDelta: -1, correctionReason: "ewc-assigned-corr" } },
      );
      expect(corrected.status).toBe(200);
      expect(corrected.body.actorType).toBe("agent");
    }
  });

  it("invalid agent key on correction stays 401", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { agentKey: "ewc-bogus-key", body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(res.status).toBe(401);
    }
  });

  it("mixed credentials keep existing precedence: valid key + JWT attributes to the agent; invalid key + JWT stays 401", async () => {
    for (const prefix of PREFIXES) {
      const agentWins = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        agentKey,
        token: memberAdminJwt,
        body: { minutes: 6, note: "ewc-mixed-agent-first" },
      });
      expect(agentWins.status).toBe(200);
      expect(agentWins.body.actorType).toBe("agent");
      expect(agentWins.body.actorId).toBe(agentId);

      const invalidKeyWithJwt = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        agentKey: "ewc-bogus-key",
        token: memberAdminJwt,
        body: { minutes: 6 },
      });
      expect(invalidKeyWithJwt.status).toBe(401);

      const agentWithRemote = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        agentKey,
        remoteKey: validRemoteKey,
        body: { minutes: 6, note: "ewc-mixed-agent-remote" },
      });
      expect(agentWithRemote.status).toBe(200);
      expect(agentWithRemote.body.actorType).toBe("agent");

      // LOG equivalent of the invalid-key+valid-remote cell.
      const invalidKeyWithRemoteLog = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries`,
        { agentKey: "ewc-bogus-key", remoteKey: validRemoteKey, body: { minutes: 6 } },
      );
      expect(invalidKeyWithRemoteLog.status).toBe(401);
    }
  });

  it("invalid-body precedence pinned separately: schema 400 precedes credential checks", async () => {
    for (const prefix of PREFIXES) {
      // No credentials at all — invalid body still yields the schema 400,
      // proving validation order is not an admission artifact.
      const noKeyInvalid = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        body: { minutes: 0 },
      });
      expect(noKeyInvalid.status).toBe(400);

      const nullBody = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        body: null,
      });
      expect(nullBody.status).toBe(400);

      const scalarBody = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        body: 15,
      });
      expect(scalarBody.status).toBe(400);
    }
  });
});

describe("effort POST containment — corrupt ancestry with full denial snapshots", () => {
  it("missing Mission (corrupt ancestry, FK-off fixture): 404 for both writes with every surface unchanged; noncredential stays 401", async () => {
    const brokenTask = makeTask(teamHabitatId, "ewc-broken-mission-task", "ewc-seed");
    const task = getDb().select().from(tasks).where(eq(tasks.id, brokenTask)).get() as {
      missionId: string;
    };
    const otherTaskRowsBefore = JSON.parse(JSON.stringify(effortRowsFor(teamTaskId)));
    const notificationsBeforeCount = notificationsCount();

    setFk(false);
    try {
      getDb().run(sql`DELETE FROM missions WHERE id = ${task.missionId}`);
    } finally {
      setFk(true);
    }

    // Baseline snapshot of the CORRUPT state — the claim under test is that
    // denials change nothing from here.
    const before = fullTaskStateSnapshot(brokenTask);

    for (const prefix of PREFIXES) {
      const logged = await wire(prefix, "POST", `/tasks/${brokenTask}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 10, note: "ewc-broken-mission" },
      });
      expect(logged.status).toBe(404);
      expect(logged.body.error).toBe("Mission not found");

      const corrected = await wire(
        prefix,
        "POST",
        `/tasks/${brokenTask}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(corrected.status).toBe(404);
      expect(corrected.body.error).toBe("Mission not found");

      // Missing ancestry outranks correction pair semantics for valid bodies;
      // noncredential variants stay 401 regardless of ancestry state — the
      // anonymous correction, invalid local key and valid remote-only too.
      const anon = await wire(prefix, "POST", `/tasks/${brokenTask}/effort-entries`, {
        body: { minutes: 10 },
      });
      expect(anon.status).toBe(401);
      const anonCorrect = await wire(
        prefix,
        "POST",
        `/tasks/${brokenTask}/effort-entries/${teamEntryId}/correct`,
        { body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(anonCorrect.status).toBe(401);
      const invalidKeyMission = await wire(prefix, "POST", `/tasks/${brokenTask}/effort-entries`, {
        agentKey: "ewc-bogus-key",
        body: { minutes: 10 },
      });
      expect(invalidKeyMission.status).toBe(401);
      const remoteOnlyMission = await wire(prefix, "POST", `/tasks/${brokenTask}/effort-entries`, {
        remoteKey: validRemoteKey,
        body: { minutes: 10 },
      });
      expect(remoteOnlyMission.status).toBe(401);
      const invalidKeyMissionCorrect = await wire(
        prefix,
        "POST",
        `/tasks/${brokenTask}/effort-entries/${teamEntryId}/correct`,
        { agentKey: "ewc-bogus-key", body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(invalidKeyMissionCorrect.status).toBe(401);
      const remoteOnlyMissionCorrect = await wire(
        prefix,
        "POST",
        `/tasks/${brokenTask}/effort-entries/${teamEntryId}/correct`,
        { remoteKey: validRemoteKey, body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(remoteOnlyMissionCorrect.status).toBe(401);
    }

    expect(fullTaskStateSnapshot(brokenTask)).toEqual(before);
    expect(notificationsCount()).toBe(notificationsBeforeCount);
    expect(JSON.parse(JSON.stringify(effortRowsFor(teamTaskId)))).toEqual(otherTaskRowsBefore);
  });

  it("missing Habitat (corrupt ancestry, FK-off fixture): 404 with full snapshots unchanged", async () => {
    const orphanHabitat = habitatRepo.createHabitat({ name: "ewc-orphan-habitat" }).id;
    const orphanTask = makeTask(orphanHabitat, "ewc-orphan-task", "ewc-seed");
    const entry = effortRepo.createEffortEntry({
      taskId: orphanTask,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 30,
      source: "human_manual",
    }).id;
    const before = fullTaskStateSnapshot(orphanTask);

    setFk(false);
    try {
      getDb().run(sql`DELETE FROM habitats WHERE id = ${orphanHabitat}`);
    } finally {
      setFk(true);
    }

    for (const prefix of PREFIXES) {
      const logged = await wire(prefix, "POST", `/tasks/${orphanTask}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 10 },
      });
      expect(logged.status).toBe(404);
      expect(logged.body.error).toBe("Habitat not found");

      const corrected = await wire(
        prefix,
        "POST",
        `/tasks/${orphanTask}/effort-entries/${entry}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(corrected.status).toBe(404);
      expect(corrected.body.error).toBe("Habitat not found");

      // Valid-body noncredential variants stay 401 regardless of the
      // corrupt ancestry (authentication precedes ancestry resolution).
      const anon = await wire(prefix, "POST", `/tasks/${orphanTask}/effort-entries`, {
        body: { minutes: 10 },
      });
      expect(anon.status).toBe(401);
      const anonCorrect = await wire(
        prefix,
        "POST",
        `/tasks/${orphanTask}/effort-entries/${entry}/correct`,
        { body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(anonCorrect.status).toBe(401);
      const badKey = await wire(prefix, "POST", `/tasks/${orphanTask}/effort-entries`, {
        agentKey: "ewc-bogus-key",
        body: { minutes: 10 },
      });
      expect(badKey.status).toBe(401);
      const remoteOnly = await wire(prefix, "POST", `/tasks/${orphanTask}/effort-entries`, {
        remoteKey: validRemoteKey,
        body: { minutes: 10 },
      });
      expect(remoteOnly.status).toBe(401);
      // Correction noncredential variants against the missing-Habitat Task.
      const badKeyCorrect = await wire(
        prefix,
        "POST",
        `/tasks/${orphanTask}/effort-entries/${entry}/correct`,
        { agentKey: "ewc-bogus-key", body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(badKeyCorrect.status).toBe(401);
      const remoteOnlyCorrect = await wire(
        prefix,
        "POST",
        `/tasks/${orphanTask}/effort-entries/${entry}/correct`,
        { remoteKey: validRemoteKey, body: { minutesDelta: -1, correctionReason: "x" } },
      );
      expect(remoteOnlyCorrect.status).toBe(401);
    }

    expect(fullTaskStateSnapshot(orphanTask)).toEqual(before);
  });

  it("different-Habitat wrong pair stays the deterministic initial 400 with originals unchanged", async () => {
    const originalSnapshot = JSON.parse(
      JSON.stringify(
        getDb().select().from(effortEntries).where(eq(effortEntries.id, teamEntryId)).get(),
      ),
    );
    const rowsBefore = JSON.parse(JSON.stringify(effortRowsFor(teamTaskId)));

    for (const prefix of PREFIXES) {
      const res = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        {
          token: memberAdminJwt,
          body: { minutesDelta: -5, correctionReason: "ewc-cross-habitat-pair" },
        },
      );
      expect(res.status).toBe(200); // same-Task pair on the TEAM task is valid — sanity baseline
    }

    // Now the foreign pair: personal-habitat entry under the team-task URL.
    const personalEntry = effortRepo.createEffortEntry({
      taskId: personalTaskId,
      actorType: "human",
      actorId: "ewc-member-admin",
      minutes: 15,
      source: "human_manual",
    });
    // Seed the personal Task's OWN denial surfaces (team Task's were seeded
    // by the earlier nonmember test) so BOTH involved snapshots carry
    // nonempty target-owned notification/watcher/reviewer/inferred state.
    seedDenialSurfaces(personalTaskId);
    const personalSnapshot = JSON.parse(JSON.stringify(personalEntry));
    const teamFullBefore = fullTaskStateSnapshot(teamTaskId);
    const personalFullBefore = fullTaskStateSnapshot(personalTaskId);
    expect(teamFullBefore.notificationDeliveries.length).toBeGreaterThanOrEqual(1);
    expect(personalFullBefore.notificationDeliveries.length).toBeGreaterThanOrEqual(1);
    expect(
      personalFullBefore.notificationDeliveries.some((d: any) => d.habitatId === personalHabitatId),
    ).toBe(true);
    expect(
      personalFullBefore.notificationEvents.some((e: any) => e.sourceId === personalTaskId),
    ).toBe(true);
    const teamRowsBeforeForeign = JSON.parse(JSON.stringify(effortRowsFor(teamTaskId)));
    // Both involved Habitat streams stay open through the settled window.
    const teamStream = await sseSubscribe(teamHabitatId);
    const personalStream = await sseSubscribe(personalHabitatId);
    try {
      for (const prefix of PREFIXES) {
        const res = await wire(
          prefix,
          "POST",
          `/tasks/${teamTaskId}/effort-entries/${personalEntry.id}/correct`,
          {
            token: memberAdminJwt,
            body: { minutesDelta: -5, correctionReason: "ewc-cross-habitat-foreign" },
          },
        );
        expect(res.status).toBe(400);
        expect(res.body.error).toBe("Effort entry does not belong to this task");
      }
      expect(JSON.parse(JSON.stringify(effortRowsFor(teamTaskId)))).toEqual(teamRowsBeforeForeign);
      // Full state for BOTH involved Tasks unchanged (rows, metrics, task row,
      // mission, audits, watchers, reviewers, inferred, notifications).
      expect(fullTaskStateSnapshot(teamTaskId)).toEqual(teamFullBefore);
      expect(fullTaskStateSnapshot(personalTaskId)).toEqual(personalFullBefore);
      expect(await settledNonConnectedEvents(teamStream)).toHaveLength(0);
      expect(await settledNonConnectedEvents(personalStream)).toHaveLength(0);
    } finally {
      teamStream.close();
      personalStream.close();
    }
    expect(
      JSON.parse(
        JSON.stringify(
          getDb().select().from(effortEntries).where(eq(effortEntries.id, personalEntry.id)).get(),
        ),
      ),
    ).toEqual(personalSnapshot);
    // The earlier same-Task baseline snapshot stays coherent too.
    expect(JSON.parse(JSON.stringify(effortRowsFor(teamTaskId))).length).toBeGreaterThan(
      rowsBefore.length,
    );
    expect(
      JSON.parse(
        JSON.stringify(
          getDb().select().from(effortEntries).where(eq(effortEntries.id, teamEntryId)).get(),
        ),
      ),
    ).toEqual(originalSnapshot);
  });
});

describe("effort POST containment — input preservation, projection and spoof stripping", () => {
  it("log with only required minutes returns the exact 13-field raw row with null optionals on BOTH prefixes", async () => {
    for (const prefix of PREFIXES) {
      const t = makeTask(
        teamHabitatId,
        `ewc-projection-task-${prefix.replace(/\W/g, "")}`,
        "ewc-seed",
      );
      const res = await wire(prefix, "POST", `/tasks/${t}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 42 },
      });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          "id",
          "taskId",
          "actorType",
          "actorId",
          "minutes",
          "source",
          "note",
          "startedAt",
          "endedAt",
          "recordedAt",
          "correctsEntryId",
          "correctionReason",
          "metadata",
        ].sort(),
      );
      expect(res.body.taskId).toBe(t);
      expect(res.body.actorType).toBe("human");
      expect(res.body.actorId).toBe("ewc-member-admin");
      expect(res.body.minutes).toBe(42);
      expect(res.body.source).toBe("human_manual");
      expect(res.body.note).toBeNull();
      expect(res.body.startedAt).toBeNull();
      expect(res.body.endedAt).toBeNull();
      expect(res.body.correctsEntryId).toBeNull();
      expect(res.body.correctionReason).toBeNull();
      expect(res.body.metadata).toBeNull();
    }
  });

  it("independent datetime acceptance includes reversed intervals on BOTH prefixes; explicit datetimes stored verbatim", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: {
          minutes: 5,
          startedAt: "2026-05-02T10:00:00.000Z",
          endedAt: "2026-05-01T09:00:00.000Z",
        },
      });
      expect(res.status).toBe(200);
      expect(res.body.startedAt).toBe("2026-05-02T10:00:00.000Z");
      expect(res.body.endedAt).toBe("2026-05-01T09:00:00.000Z");
    }
  });

  it("source labels stay free metadata on BOTH prefixes: explicit cross-labels are honored verbatim, never silently relabeled", async () => {
    for (const prefix of PREFIXES) {
      const humanAgentLabel = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 5, source: "agent_reported" },
      });
      expect(humanAgentLabel.status).toBe(200);
      expect(humanAgentLabel.body.actorType).toBe("human");
      expect(humanAgentLabel.body.source).toBe("agent_reported");

      const agentHumanLabel = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        agentKey,
        body: { minutes: 5, source: "human_manual" },
      });
      expect(agentHumanLabel.status).toBe(200);
      expect(agentHumanLabel.body.actorType).toBe("agent");
      expect(agentHumanLabel.body.source).toBe("human_manual");
    }
  });

  it("identity/reference/audit spoof fields in the body are stripped — including a forged metadata.audit context — while trusted actor, REST provenance and forced correction source survive in row, event and SSE", async () => {
    for (const prefix of PREFIXES) {
      const t = makeTask(teamHabitatId, `ewc-spoof-task-${prefix.replace(/\W/g, "")}`, "ewc-seed");
      const auditBefore = auditRowsFor(t);
      const stream = await sseSubscribe(teamHabitatId);
      let logged: { status: number; body: any };
      try {
        logged = await wire(prefix, "POST", `/tasks/${t}/effort-entries`, {
          token: memberViewerJwt,
          body: {
            minutes: 25,
            actorType: "agent",
            actorId: "ewc-spoof-actor",
            taskId: teamTaskId,
            id: "ewc-spoof-id",
            correctsEntryId: "ewc-spoof-ref",
            metadata: {
              spoof: true,
              // Forged audit-provenance context: must never reach the stored
              // row or the emitted event/SSE.
              audit: {
                actorId: "ewc-spoof-actor",
                source: "mcp_tool",
                requestId: "ewc-spoof-request",
                route: "/spoofed/route",
              },
            },
            recordedAt: "1999-01-01T00:00:00.000Z",
            note: "ewc-spoof-probe",
          },
        });
        expect(logged.status).toBe(200);
        expect(logged.body.id).not.toBe("ewc-spoof-id");
        expect(logged.body.taskId).toBe(t);
        expect(logged.body.actorType).toBe("human");
        expect(logged.body.actorId).toBe("ewc-member-viewer");
        expect(logged.body.correctsEntryId).toBeNull();
        expect(logged.body.metadata).toBeNull();
        expect(logged.body.recordedAt).not.toBe("1999-01-01T00:00:00.000Z");

        // Actual audit row: trusted actor + reference, and the REAL REST
        // provenance built from request context (not the forged body fields).
        const audits = auditRowsFor(t).filter(
          (a: any) => !auditBefore.some((b: any) => b.id === a.id),
        );
        expect(audits).toHaveLength(1);
        expect(audits[0].action).toBe("effort_logged");
        expect(audits[0].actorType).toBe("human");
        expect(audits[0].actorId).toBe("ewc-member-viewer");
        const meta = audits[0].metadata as any;
        expect(meta.effortEntryId).toBe(logged.body.id);
        expect(meta.audit.source).toBe("rest_api");
        expect(meta.audit.actorId).not.toBe("ewc-spoof-actor");
        // The route carries the mounted prefix (request.routeOptions.url).
        expect(meta.audit.route).toBe(`${prefix}/tasks/:id/effort-entries`);
        expect(meta.audit.method).toBe("POST");
        expect(meta.audit.requestId).not.toBe("ewc-spoof-request");

        // SSE delivery carries the trusted actor too — measured as a settled
        // ALL-EVENT census: nothing but this one effort.updated.
        const delivered = await settledNonConnectedEvents(stream);
        expect(delivered).toHaveLength(1);
        expect(delivered[0].type).toBe("effort.updated");
        expect(delivered[0].data).toEqual({
          taskId: t,
          entryId: logged.body.id,
          actorType: "human",
          actorId: "ewc-member-viewer",
          source: "human_manual",
          minutes: 25,
        });

        // Correction spoof (still inside the open-stream window): unknown
        // source field stripped, forced correction_adjustment stamp survives,
        // and the correction's OWN SSE delivery is observed on the live stream.
        const corr = await wire(
          prefix,
          "POST",
          `/tasks/${t}/effort-entries/${logged.body.id}/correct`,
          {
            token: memberViewerJwt,
            body: {
              minutesDelta: -5,
              correctionReason: "ewc-spoof-corr",
              source: "human_manual",
              actorType: "agent",
              actorId: "ewc-spoof-actor",
              correctsEntryId: teamEntryId,
              metadata: { audit: { source: "mcp_tool", actorId: "ewc-spoof-actor" } },
            },
          },
        );
        expect(corr.status).toBe(200);
        expect(corr.body.source).toBe("correction_adjustment");
        expect(corr.body.correctsEntryId).toBe(logged.body.id);
        expect(corr.body.actorType).toBe("human");
        expect(corr.body.actorId).toBe("ewc-member-viewer");
        expect(corr.body.metadata).toBeNull();

        const corrDeliveries = await settledNonConnectedEvents(stream);
        expect(corrDeliveries).toHaveLength(2);
        const corrDelivery = corrDeliveries[1];
        expect(corrDelivery.type).toBe("effort.updated");
        expect(corrDelivery.data).toEqual({
          taskId: t,
          entryId: corr.body.id,
          actorType: "human",
          actorId: "ewc-member-viewer",
          source: "correction_adjustment",
          minutes: -5,
        });

        const corrAudits = auditRowsFor(t).filter((a: any) => a.action === "effort_corrected");
        expect(corrAudits).toHaveLength(1);
        expect(corrAudits[0].actorType).toBe("human");
        expect(corrAudits[0].actorId).toBe("ewc-member-viewer");
        expect((corrAudits[0].metadata as any).effortEntryId).toBe(corr.body.id);
        expect((corrAudits[0].metadata as any).correctsEntryId).toBe(logged.body.id);
        expect((corrAudits[0].metadata as any).audit.source).toBe("rest_api");
      } finally {
        stream.close();
      }
    }
  });
  it("exact schema boundaries: minutes 1..1440 accepted, violations rejected; delta ±1440 accepted, 0 rejected; note/reason limits and whitespace truth", async () => {
    const accept = async (minutes: number) =>
      (
        await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries`, {
          token: memberAdminJwt,
          body: { minutes },
        })
      ).status;
    expect(await accept(1)).toBe(200);
    expect(await accept(1440)).toBe(200);
    for (const bad of [0, -5, 1.5, 1441]) {
      expect(await accept(bad)).toBe(400);
    }
    expect(
      (
        await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries`, {
          token: memberAdminJwt,
          body: { minutes: "15" },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries`, {
          token: memberAdminJwt,
          body: { minutes: 5, note: null },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries`, {
          token: memberAdminJwt,
          body: { minutes: 5, source: "correction_adjustment" },
        })
      ).status,
    ).toBe(400);

    const note500 = await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries`, {
      token: memberAdminJwt,
      body: { minutes: 5, note: "x".repeat(500) },
    });
    expect(note500.status).toBe(200);
    const note501 = await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries`, {
      token: memberAdminJwt,
      body: { minutes: 5, note: "x".repeat(501) },
    });
    expect(note501.status).toBe(400);

    const entryId = note500.body.id;
    const deltaAccept = async (minutesDelta: number) =>
      (
        await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries/${entryId}/correct`, {
          token: memberAdminJwt,
          body: { minutesDelta, correctionReason: "bounds" },
        })
      ).status;
    expect(await deltaAccept(1440)).toBe(200);
    expect(await deltaAccept(-1440)).toBe(200);
    expect(await deltaAccept(0)).toBe(400);

    const whitespace = await wire(
      "/api/v1",
      "POST",
      `/tasks/${teamTaskId}/effort-entries/${entryId}/correct`,
      { token: memberAdminJwt, body: { minutesDelta: -1, correctionReason: "   " } },
    );
    expect(whitespace.status).toBe(200);
    expect(whitespace.body.correctionReason).toBe("   ");
    expect(
      (
        await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries/${entryId}/correct`, {
          token: memberAdminJwt,
          body: { minutesDelta: -1, correctionReason: "x".repeat(501) },
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await wire("/api/v1", "POST", `/tasks/${teamTaskId}/effort-entries/${entryId}/correct`, {
          token: memberAdminJwt,
          body: { minutesDelta: -1 },
        })
      ).status,
    ).toBe(400);
  });

  it("repeated deltas and correction-of-correction on the wire on BOTH prefixes: distinct ids, exact references, negative totals persist", async () => {
    for (const prefix of PREFIXES) {
      const t = makeTask(
        teamHabitatId,
        `ewc-history-wire-${prefix.replace(/\W/g, "")}`,
        "ewc-seed",
      );
      const orig = effortRepo.createEffortEntry({
        taskId: t,
        actorType: "human",
        actorId: "ewc-member-admin",
        minutes: 10,
        source: "human_manual",
      });
      const origSnapshot = JSON.parse(JSON.stringify(orig));

      const c1 = await wire(prefix, "POST", `/tasks/${t}/effort-entries/${orig.id}/correct`, {
        token: memberAdminJwt,
        body: { minutesDelta: -30, correctionReason: `wire-negative-total-${prefix}` },
      });
      expect(c1.status).toBe(200);
      const c2 = await wire(prefix, "POST", `/tasks/${t}/effort-entries/${orig.id}/correct`, {
        token: memberAdminJwt,
        body: { minutesDelta: -5, correctionReason: `wire-repeat-2-${prefix}` },
      });
      expect(c2.status).toBe(200);
      expect(c2.body.id).not.toBe(c1.body.id);
      const c3 = await wire(prefix, "POST", `/tasks/${t}/effort-entries/${c1.body.id}/correct`, {
        token: memberAdminJwt,
        body: { minutesDelta: 3, correctionReason: `wire-corr-of-corr-${prefix}` },
      });
      expect(c3.status).toBe(200);
      expect(c3.body.correctsEntryId).toBe(c1.body.id);

      const totals = effortRepo.getEffortTotalsForTask(t);
      expect(totals.loggedEffortMinutes).toBe(10);
      expect(totals.correctionAdjustmentMinutes).toBe(-32);
      expect(taskMetricsRow(t).actualMinutes).toBe(-22);

      expect(
        JSON.parse(
          JSON.stringify(
            getDb().select().from(effortEntries).where(eq(effortEntries.id, orig.id)).get(),
          ),
        ),
      ).toEqual(origSnapshot);
    }
  });
});

describe("effort POST containment — positive effects, inferred separation and non-effects", () => {
  it("positive log on BOTH prefixes: per-response SSE binding, Task/Mission/accuracy truth, inferred immutability, all-event census, and full byte-preserved non-effect state", async () => {
    for (const prefix of PREFIXES) {
      const t = makeTask(teamHabitatId, `ewc-effects-log-${prefix.replace(/\W/g, "")}`, "ewc-seed");
      const habitatId = habitatIdForTask(t)!;
      expect(habitatId).toBe(teamHabitatId); // ownership: derived habitat is the task's own
      // Meaningful non-default fixtures: estimate, watcher, assigned reviewer
      // row, inferred time record and a persisted notification event+delivery
      // pair are all NONEMPTY and target-owned before the write.
      getDb().update(tasks).set({ estimatedMinutes: 60 }).where(eq(tasks.id, t)).run();
      getDb()
        .insert(taskWatchers)
        .values({ taskId: t, userId: "ewc-member-viewer", createdAt: "2026-01-01T00:00:00.000Z" })
        .run();
      getDb()
        .insert(taskReviewers)
        .values({
          id: `ewc-reviewer-${t}`,
          taskId: t,
          reviewerType: "human",
          reviewerId: "ewc-member-admin",
          status: "pending",
          assignedAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
      seedInferredPresence(t, agentId, 45);
      getDb()
        .insert(notificationEvents)
        .values({
          id: `ewc-notify-event-${t}`,
          habitatId,
          eventType: "task_updated",
          sourceType: "habitat",
          sourceId: t,
          targetType: "user",
          targetId: "ewc-member-viewer",
          severity: "info",
          title: "ewc seeded notification",
          body: "persisted-state characterization fixture",
          createdByType: "human",
          createdById: "ewc-member-admin",
          createdAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
      getDb()
        .insert(notificationDeliveries)
        .values({
          id: `ewc-notify-delivery-${t}`,
          eventId: `ewc-notify-event-${t}`,
          habitatId,
          recipientType: "user",
          recipientId: "ewc-member-viewer",
          status: "pending",
          channels: ["in_app"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
        .run();

      // Baseline ownership + nonempty denominators asserted BEFORE snapshots.
      const watchersBefore = watchersFor(t);
      const reviewersBefore = reviewersFor(t);
      const inferredBefore = inferredRecordsFor(t);
      const notifyEventsBefore = JSON.parse(
        JSON.stringify(
          getDb().select().from(notificationEvents).where(eq(notificationEvents.sourceId, t)).all(),
        ),
      );
      const notifyDeliveriesBefore = JSON.parse(JSON.stringify(deliveriesForTask(t)));
      expect(watchersBefore).toHaveLength(1);
      expect(watchersBefore[0].taskId).toBe(t);
      expect(reviewersBefore).toHaveLength(1);
      expect(reviewersBefore[0].taskId).toBe(t);
      expect(inferredBefore).toHaveLength(1);
      expect(notifyEventsBefore).toHaveLength(1);
      expect(notifyEventsBefore[0].sourceId).toBe(t);
      expect(notifyDeliveriesBefore).toHaveLength(1);
      expect(notifyDeliveriesBefore[0].habitatId).toBe(habitatId);
      expect(notifyDeliveriesBefore[0].eventId).toBe(`ewc-notify-event-${t}`);
      const taskEstimate = getDb()
        .select({ estimatedMinutes: tasks.estimatedMinutes })
        .from(tasks)
        .where(eq(tasks.id, t))
        .get() as { estimatedMinutes: number | null };
      expect(taskEstimate.estimatedMinutes).toBe(60);

      const metricsBefore = taskMetricsRow(t);
      const missionBefore = missionRowFor(t);
      const lifecycleBefore = taskLifecycleRow(t);
      const auditsBefore = auditRowsFor(t);

      const stream = await sseSubscribe(teamHabitatId);
      try {
        const res = await wire(prefix, "POST", `/tasks/${t}/effort-entries`, {
          token: memberViewerJwt,
          body: { minutes: 30, note: `ewc-effects-${prefix}` },
        });
        expect(res.status).toBe(200);

        // Settled ALL-EVENT census: exactly the initial `connected` frame
        // (distinctly accounted) plus ONE effort.updated whose entryId binds
        // to THIS response — nothing else, on either prefix.
        const delivered = await settledNonConnectedEvents(stream);
        expect(delivered).toHaveLength(1);
        expect(delivered[0].type).toBe("effort.updated");
        expect(delivered[0].data).toEqual({
          taskId: t,
          entryId: res.body.id,
          actorType: "human",
          actorId: "ewc-member-viewer",
          source: "human_manual",
          minutes: 30,
        });

        // Task metrics: preferred-logged basis (30), NOT the 45 inferred
        // minutes — while the report total legitimately counts both.
        // Accuracy formula from source: actual / estimatedMinutes.
        expect(taskMetricsRow(t).actualMinutes).toBe(30);
        expect(taskMetricsRow(t).version).toBe(metricsBefore.version + 1);
        expect(taskMetricsRow(t).estimationAccuracy).toBeCloseTo(30 / 60, 10);
        const totals = effortRepo.getEffortTotalsForTask(t);
        expect(totals.loggedEffortMinutes).toBe(30);
        expect(totals.inferredPresenceMinutes).toBe(45);
        expect(totals.totalAccountedMinutes).toBe(75);

        // Mission metrics actually followed (row read, not implied) with the
        // source aggregation: actual/planned sums over the mission's tasks.
        const missionAfter = missionRowFor(t);
        expect(missionAfter.actualMinutes).toBe(30);
        expect(missionAfter.plannedMinutes).toBe(60);
        expect(missionAfter.planningAccuracy).toBeCloseTo(30 / 60, 10);
        expect(missionAfter.updatedAt).not.toBe(missionBefore.updatedAt);

        // FULL audit delta: every pre-existing row preserved byte-identically
        // and the ONLY addition is the single prescribed effort action with
        // trusted attribution, entry reference and REST provenance.
        const auditsAfter = auditRowsFor(t);
        const added = auditsAfter.filter((a: any) => !auditsBefore.some((b: any) => b.id === a.id));
        const removedOrChanged = auditsBefore.filter(
          (b: any) => !auditsAfter.some((a: any) => JSON.stringify(a) === JSON.stringify(b)),
        );
        expect(removedOrChanged).toHaveLength(0);
        expect(added).toHaveLength(1);
        expect(added[0].action).toBe("effort_logged");
        expect(added[0].actorType).toBe("human");
        expect(added[0].actorId).toBe("ewc-member-viewer");
        expect((added[0].metadata as any).effortEntryId).toBe(res.body.id);
        expect((added[0].metadata as any).minutes).toBe(30);
        expect((added[0].metadata as any).audit.source).toBe("rest_api");
        expect((added[0].metadata as any).audit.method).toBe("POST");
      } finally {
        stream.close();
      }

      // Persisted-state characterization after settling: FULL BYTE equality
      // for lifecycle, watcher, reviewer, notification event/delivery rows
      // and the inferred time records — unchanged-persisted-state evidence,
      // NOT configured downstream delivery proof.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(taskLifecycleRow(t)).toEqual(lifecycleBefore);
      expect(watchersFor(t)).toEqual(watchersBefore);
      expect(reviewersFor(t)).toEqual(reviewersBefore);
      expect(inferredRecordsFor(t)).toEqual(inferredBefore);
      expect(
        JSON.parse(
          JSON.stringify(
            getDb()
              .select()
              .from(notificationEvents)
              .where(eq(notificationEvents.sourceId, t))
              .all(),
          ),
        ),
      ).toEqual(notifyEventsBefore);
      expect(JSON.parse(JSON.stringify(deliveriesForTask(t)))).toEqual(notifyDeliveriesBefore);
    }
  });

  it("positive correction on BOTH prefixes: per-response SSE binding, Mission row/version/accuracy follow, full byte-preserved non-effect state, all-event census", async () => {
    for (const prefix of PREFIXES) {
      const t = makeTask(
        teamHabitatId,
        `ewc-effects-corr-${prefix.replace(/\W/g, "")}`,
        "ewc-seed",
      );
      const habitatId = habitatIdForTask(t)!;
      getDb().update(tasks).set({ estimatedMinutes: 100 }).where(eq(tasks.id, t)).run();
      getDb()
        .insert(taskWatchers)
        .values({ taskId: t, userId: "ewc-member-admin", createdAt: "2026-01-01T00:00:00.000Z" })
        .run();
      getDb()
        .insert(taskReviewers)
        .values({
          id: `ewc-reviewer-${t}`,
          taskId: t,
          reviewerType: "human",
          reviewerId: "ewc-member-owner",
          status: "pending",
          assignedAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
      seedInferredPresence(t, agentId, 15);
      getDb()
        .insert(notificationEvents)
        .values({
          id: `ewc-notify-event-${t}`,
          habitatId,
          eventType: "task_updated",
          sourceType: "habitat",
          sourceId: t,
          targetType: "user",
          targetId: "ewc-member-admin",
          severity: "info",
          title: "ewc seeded notification",
          body: "persisted-state characterization fixture",
          createdByType: "human",
          createdById: "ewc-member-admin",
          createdAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
      getDb()
        .insert(notificationDeliveries)
        .values({
          id: `ewc-notify-delivery-${t}`,
          eventId: `ewc-notify-event-${t}`,
          habitatId,
          recipientType: "user",
          recipientId: "ewc-member-admin",
          status: "pending",
          channels: ["in_app"],
          createdAt: "2026-01-01T00:00:00.000Z",
          updatedAt: "2026-01-01T00:00:00.000Z",
        })
        .run();
      const original = effortRepo.createEffortEntry({
        taskId: t,
        actorType: "human",
        actorId: "ewc-member-admin",
        minutes: 30,
        source: "human_manual",
      });
      const originalBefore = JSON.parse(JSON.stringify(original));

      const watchersBefore = watchersFor(t);
      const reviewersBefore = reviewersFor(t);
      const inferredBefore = inferredRecordsFor(t);
      const notifyEventsBefore = JSON.parse(
        JSON.stringify(
          getDb().select().from(notificationEvents).where(eq(notificationEvents.sourceId, t)).all(),
        ),
      );
      const notifyDeliveriesBefore = JSON.parse(JSON.stringify(deliveriesForTask(t)));
      expect(watchersBefore).toHaveLength(1);
      expect(reviewersBefore).toHaveLength(1);
      expect(inferredBefore).toHaveLength(1);
      expect(notifyEventsBefore).toHaveLength(1);
      expect(notifyDeliveriesBefore).toHaveLength(1);
      expect(notifyDeliveriesBefore[0].eventId).toBe(`ewc-notify-event-${t}`);
      const taskEstimate = getDb()
        .select({ estimatedMinutes: tasks.estimatedMinutes })
        .from(tasks)
        .where(eq(tasks.id, t))
        .get() as { estimatedMinutes: number | null };
      expect(taskEstimate.estimatedMinutes).toBe(100);

      const metricsBefore = taskMetricsRow(t);
      const lifecycleBefore = taskLifecycleRow(t);
      const auditsBefore = auditRowsFor(t);

      const stream = await sseSubscribe(teamHabitatId);
      try {
        const res = await wire(
          prefix,
          "POST",
          `/tasks/${t}/effort-entries/${original.id}/correct`,
          {
            token: memberViewerJwt,
            body: { minutesDelta: -10, correctionReason: "ewc-correct-effects" },
          },
        );
        expect(res.status).toBe(200);
        expect(res.body.correctsEntryId).toBe(original.id);
        expect(res.body.source).toBe("correction_adjustment");
        expect(res.body.actorId).toBe("ewc-member-viewer");

        // Settled ALL-EVENT census with per-response binding: exactly one
        // effort.updated for THIS response's entryId — no task.updated or
        // any other event type (the extra-event mutant must fail exactly
        // here).
        const delivered = await settledNonConnectedEvents(stream);
        expect(delivered).toHaveLength(1);
        expect(delivered[0].type).toBe("effort.updated");
        expect(delivered[0].data).toEqual({
          taskId: t,
          entryId: res.body.id,
          actorType: "human",
          actorId: "ewc-member-viewer",
          source: "correction_adjustment",
          minutes: -10,
        });

        // Task/Mission rows follow exactly (source formulas): 30 - 10 = 20,
        // accuracy 20/100, mission planning 20/100.
        expect(taskMetricsRow(t).actualMinutes).toBe(20);
        expect(taskMetricsRow(t).version).toBe(metricsBefore.version + 1);
        expect(taskMetricsRow(t).estimationAccuracy).toBeCloseTo(20 / 100, 10);
        const missionAfter = missionRowFor(t);
        expect(missionAfter.actualMinutes).toBe(20);
        expect(missionAfter.plannedMinutes).toBe(100);
        expect(missionAfter.planningAccuracy).toBeCloseTo(20 / 100, 10);

        // FULL audit delta: all pre-existing rows byte-identical, the only
        // addition is the single prescribed effort_corrected action with
        // reference, delta, actor and REST provenance; the original row is
        // untouched.
        const auditsAfter = auditRowsFor(t);
        const added = auditsAfter.filter((a: any) => !auditsBefore.some((b: any) => b.id === a.id));
        const removedOrChanged = auditsBefore.filter(
          (b: any) => !auditsAfter.some((a: any) => JSON.stringify(a) === JSON.stringify(b)),
        );
        expect(removedOrChanged).toHaveLength(0);
        expect(added).toHaveLength(1);
        expect(added[0].action).toBe("effort_corrected");
        expect((added[0].metadata as any).effortEntryId).toBe(res.body.id);
        expect((added[0].metadata as any).correctsEntryId).toBe(original.id);
        expect((added[0].metadata as any).minutesDelta).toBe(-10);
        expect((added[0].metadata as any).audit.source).toBe("rest_api");
        expect(
          JSON.parse(
            JSON.stringify(
              getDb().select().from(effortEntries).where(eq(effortEntries.id, original.id)).get(),
            ),
          ),
        ).toEqual(originalBefore);
      } finally {
        stream.close();
      }

      // Full byte-preserved non-effect state after settling.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(taskLifecycleRow(t)).toEqual(lifecycleBefore);
      expect(watchersFor(t)).toEqual(watchersBefore);
      expect(reviewersFor(t)).toEqual(reviewersBefore);
      expect(inferredRecordsFor(t)).toEqual(inferredBefore);
      expect(
        JSON.parse(
          JSON.stringify(
            getDb()
              .select()
              .from(notificationEvents)
              .where(eq(notificationEvents.sourceId, t))
              .all(),
          ),
        ),
      ).toEqual(notifyEventsBefore);
      expect(JSON.parse(JSON.stringify(deliveriesForTask(t)))).toEqual(notifyDeliveriesBefore);
    }
  });
  it("correction equivalents: valid key+JWT attributes to the agent; invalid key+JWT stays 401; valid key+remote attributes to the agent; invalid key+valid remote stays 401", async () => {
    for (const prefix of PREFIXES) {
      const agentWins = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        {
          agentKey,
          token: memberAdminJwt,
          body: { minutesDelta: -1, correctionReason: "ewc-mixed-corr-agent" },
        },
      );
      expect(agentWins.status).toBe(200);
      expect(agentWins.body.actorType).toBe("agent");
      expect(agentWins.body.actorId).toBe(agentId);

      const invalidKeyWithJwt = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        {
          agentKey: "ewc-bogus-key",
          token: memberAdminJwt,
          body: { minutesDelta: -1, correctionReason: "x" },
        },
      );
      expect(invalidKeyWithJwt.status).toBe(401);

      const agentWithRemote = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        {
          agentKey,
          remoteKey: validRemoteKey,
          body: { minutesDelta: -1, correctionReason: "ewc-mixed-corr-remote" },
        },
      );
      expect(agentWithRemote.status).toBe(200);
      expect(agentWithRemote.body.actorType).toBe("agent");

      const invalidKeyWithRemote = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        {
          agentKey: "ewc-bogus-key",
          remoteKey: validRemoteKey,
          body: { minutesDelta: -1, correctionReason: "x" },
        },
      );
      expect(invalidKeyWithRemote.status).toBe(401);
    }
  });

  it("personal-habitat humans of every existing JWT role (admin/editor/viewer) stay admitted on both writes", async () => {
    const roles: Array<[string, string]> = [
      ["ewc-personal-admin", "admin"],
      ["ewc-personal-editor", "editor"],
      ["ewc-personal-viewer", "viewer"],
    ];
    for (const [userId, role] of roles) {
      const token = mint(userId, role);
      const t = makeTask(personalHabitatId, `ewc-personal-${role}`, "ewc-seed");
      const entry = effortRepo.createEffortEntry({
        taskId: t,
        actorType: "human",
        actorId: userId,
        minutes: 30,
        source: "human_manual",
      }).id;
      for (const prefix of PREFIXES) {
        const logged = await wire(prefix, "POST", `/tasks/${t}/effort-entries`, {
          token,
          body: { minutes: 5, note: `ewc-personal-${role}` },
        });
        expect(logged.status).toBe(200);
        expect(logged.body.actorId).toBe(userId);
        const corrected = await wire(
          prefix,
          "POST",
          `/tasks/${t}/effort-entries/${entry}/correct`,
          { token, body: { minutesDelta: -1, correctionReason: `ewc-personal-corr-${role}` } },
        );
        expect(corrected.status).toBe(200);
        expect(corrected.body.actorId).toBe(userId);
      }
    }
  });
});

describe("effort POST containment — both-prefix input matrix completion", () => {
  it("parsed-body boundaries hold identically on /api: bounds, types, unknown-only, arrays, malformed dates, arbitrary source", async () => {
    for (const prefix of PREFIXES) {
      const accept = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 1440 },
      });
      expect(accept.status).toBe(200);
      const acceptOne = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 1 },
      });
      expect(acceptOne.status).toBe(200);
      const rejectMinutes = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 1441 },
      });
      expect(rejectMinutes.status).toBe(400);
      const zero = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 0 },
      });
      expect(zero.status).toBe(400);
      const negative = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: -5 },
      });
      expect(negative.status).toBe(400);
      const fraction = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 1.5 },
      });
      expect(fraction.status).toBe(400);
      const stringMinutes = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: "15" },
      });
      expect(stringMinutes.status).toBe(400);
      const nullNote = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 5, note: null },
      });
      expect(nullNote.status).toBe(400);
      const correctionSourceOnLog = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries`,
        { token: memberAdminJwt, body: { minutes: 5, source: "correction_adjustment" } },
      );
      expect(correctionSourceOnLog.status).toBe(400);
      const note500 = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 5, note: "x".repeat(500) },
      });
      expect(note500.status).toBe(200);
      const note501 = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 5, note: "x".repeat(501) },
      });
      expect(note501.status).toBe(400);
      const arrayBody = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: [1, 2, 3],
      });
      expect(arrayBody.status).toBe(400);
      const unknownOnly = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { foo: "bar" },
      });
      expect(unknownOnly.status).toBe(400);
      const malformedDate = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 5, startedAt: "not-a-date" },
      });
      expect(malformedDate.status).toBe(400);
      const arbitrarySource = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 5, source: "bogus_source" },
      });
      expect(arbitrarySource.status).toBe(400);
    }
  });

  it("interval shape freedom on both prefixes: future, start-only, end-only and REVERSED intervals all accepted and stored verbatim", async () => {
    for (const prefix of PREFIXES) {
      // REVERSED interval actually sent: started AFTER ended, no ordering
      // rule rejects it, both datetimes stored verbatim.
      const reversed = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: {
          minutes: 5,
          startedAt: "2026-06-02T10:00:00.000Z",
          endedAt: "2026-06-01T09:00:00.000Z",
        },
      });
      expect(reversed.status).toBe(200);
      expect(reversed.body.startedAt).toBe("2026-06-02T10:00:00.000Z");
      expect(reversed.body.endedAt).toBe("2026-06-01T09:00:00.000Z");

      const future = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: {
          minutes: 5,
          startedAt: "2099-01-01T10:00:00.000Z",
          endedAt: "2099-01-01T11:00:00.000Z",
        },
      });
      expect(future.status).toBe(200);
      expect(future.body.startedAt).toBe("2099-01-01T10:00:00.000Z");
      expect(future.body.endedAt).toBe("2099-01-01T11:00:00.000Z");

      const startOnly = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 5, startedAt: "2026-01-01T10:00:00.000Z" },
      });
      expect(startOnly.status).toBe(200);
      expect(startOnly.body.startedAt).toBe("2026-01-01T10:00:00.000Z");
      expect(startOnly.body.endedAt).toBeNull();

      const endOnly = await wire(prefix, "POST", `/tasks/${teamTaskId}/effort-entries`, {
        token: memberAdminJwt,
        body: { minutes: 5, endedAt: "2026-01-01T12:00:00.000Z" },
      });
      expect(endOnly.status).toBe(200);
      expect(endOnly.body.startedAt).toBeNull();
      expect(endOnly.body.endedAt).toBe("2026-01-01T12:00:00.000Z");
    }
  });

  it("correction boundaries on both prefixes: fraction/out-of-range/type/null rejections, note limits, whitespace reason; exact 13-field wire projection; schema 400 precedes credential checks", async () => {
    for (const prefix of PREFIXES) {
      // Schema-vs-no-key precedence for the correction body: invalid parsed
      // body with NO credentials is still the schema 400.
      const noKeyInvalid = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { body: { minutesDelta: 0 } },
      );
      expect(noKeyInvalid.status).toBe(400);

      const fraction = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: 1.5, correctionReason: "x" } },
      );
      expect(fraction.status).toBe(400);
      const aboveRange = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: 1441, correctionReason: "x" } },
      );
      expect(aboveRange.status).toBe(400);
      const belowRange = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: -1441, correctionReason: "x" } },
      );
      expect(belowRange.status).toBe(400);
      const stringDelta = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: "5", correctionReason: "x" } },
      );
      expect(stringDelta.status).toBe(400);
      const nullDelta = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: null, correctionReason: "x" } },
      );
      expect(nullDelta.status).toBe(400);
      const note501 = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        {
          token: memberAdminJwt,
          body: { minutesDelta: -1, correctionReason: "x", note: "y".repeat(501) },
        },
      );
      expect(note501.status).toBe(400);
      const reasonWhitespace = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: -1, correctionReason: " \t " } },
      );
      expect(reasonWhitespace.status).toBe(200);
      expect(reasonWhitespace.body.correctionReason).toBe(" \t ");
      const correctionArray = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: [1, 2] },
      );
      expect(correctionArray.status).toBe(400);
      const correctionUnknownOnly = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { foo: "bar" } },
      );
      expect(correctionUnknownOnly.status).toBe(400);
      // Remaining required boundary cells on BOTH prefixes: delta endpoints
      // accepted, zero rejected with credentials, empty and over-long
      // reasons rejected (against the seeded team entry).
      const deltaMax = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        {
          token: memberAdminJwt,
          body: { minutesDelta: 1440, correctionReason: `bounds-max-${prefix}` },
        },
      );
      expect(deltaMax.status).toBe(200);
      const deltaMin = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        {
          token: memberAdminJwt,
          body: { minutesDelta: -1440, correctionReason: `bounds-min-${prefix}` },
        },
      );
      expect(deltaMin.status).toBe(200);
      const deltaZeroWithCreds = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: 0, correctionReason: "x" } },
      );
      expect(deltaZeroWithCreds.status).toBe(400);
      const emptyReason = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: -1, correctionReason: "" } },
      );
      expect(emptyReason.status).toBe(400);
      const longReason = await wire(
        prefix,
        "POST",
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
        { token: memberAdminJwt, body: { minutesDelta: -1, correctionReason: "r".repeat(501) } },
      );
      expect(longReason.status).toBe(400);

      // Exact 13-field wire projection for a correction — on THIS prefix.
      const t = makeTask(
        teamHabitatId,
        `ewc-corr-projection-${prefix.replace(/\W/g, "")}`,
        "ewc-seed",
      );
      const entry = effortRepo.createEffortEntry({
        taskId: t,
        actorType: "human",
        actorId: "ewc-member-admin",
        minutes: 30,
        source: "human_manual",
      }).id;
      const res = await wire(prefix, "POST", `/tasks/${t}/effort-entries/${entry}/correct`, {
        token: memberAdminJwt,
        body: { minutesDelta: -7, correctionReason: `ewc-corr-projection-${prefix}` },
      });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body).sort()).toEqual(
        [
          "id",
          "taskId",
          "actorType",
          "actorId",
          "minutes",
          "source",
          "note",
          "startedAt",
          "endedAt",
          "recordedAt",
          "correctsEntryId",
          "correctionReason",
          "metadata",
        ].sort(),
      );
      expect(res.body.taskId).toBe(t);
      expect(res.body.minutes).toBe(-7);
      expect(res.body.source).toBe("correction_adjustment");
      expect(res.body.correctsEntryId).toBe(entry);
      expect(res.body.correctionReason).toBe(`ewc-corr-projection-${prefix}`);
      expect(res.body.note).toBeNull();
      expect(res.body.startedAt).toBeNull();
      expect(res.body.endedAt).toBeNull();
      expect(res.body.metadata).toBeNull();
    }
  });
});

describe("effort POST containment — raw parser truth (characterization of existing global behavior, not a candidate change)", () => {
  it("raw malformed and empty JSON bodies return the existing generic 500 INTERNAL_ERROR envelope on both operations and prefixes — parsed-body schema invalidity is the 400, this is the pre-existing parser limit", async () => {
    for (const prefix of PREFIXES) {
      const paths = [
        `/tasks/${teamTaskId}/effort-entries`,
        `/tasks/${teamTaskId}/effort-entries/${teamEntryId}/correct`,
      ];
      for (const path of paths) {
        const malformed = await rawWire(prefix, path, "{");
        expect(malformed.status).toBe(500);
        // Exact known envelope from the generic error-handler fallback.
        expect(malformed.body.code).toBe("INTERNAL_ERROR");
        expect(typeof malformed.body.error).toBe("string");
        expect(malformed.body.error.length).toBeGreaterThan(0);

        const empty = await rawWire(prefix, path, "");
        expect(empty.status).toBe(500);
        expect(empty.body.code).toBe("INTERNAL_ERROR");
        expect(typeof empty.body.error).toBe("string");
      }
    }
  });
});
