/**
 * Task quality operations (quality-containment-contract, independent review
 * ACCEPT) — REAL HTTP wire matrix on BOTH served prefixes (`/api/v1`,
 * deprecated `/api`) plus served MCP compatibility over real stdio.
 *
 * Scope of claims (author evidence, not platform-wide Task isolation):
 *  - PUT /tasks/:id/quality-checklist/:checklistId/items/:itemId and
 *    POST /tasks/:id/quality-checklist/validate resolve the URL Task's actual
 *    Mission → Habitat and enforce the shared membership predicate
 *    (`authorizeTaskAccess`) before any child lookup, report read or write.
 *    PUT additionally binds the exact instance item → instance checklist →
 *    URL Task at the final SQL statement inside one immediate transaction
 *    that recalculates the same owned checklist.
 *  - Intended deltas: team-nonmember humans (including global admin) 403
 *    (was 200); absent ancestry / broken triple 404 (was foreign-item 200 or
 *    synthetic reads); malformed / ineffective bodies 400 (was a wrapped 500
 *    or silent acceptance); status-write faults roll the item UPDATE back.
 *  - Preserved: local_actor policy, broad local-agent access, human member
 *    (any role) and personal-Habitat access, 401 for anonymous / invalid
 *    local / remote-only credentials, unwrapped persisted item projection,
 *    report-derived read-only validation.
 *
 * Disclosed limits: admission-rejection claims assert zero mutation and zero
 * child-data disclosure through the wire; no query-count instrumentation is
 * used (that would require mocking, which this file forbids). Ancestry
 * corruption fixtures disable FK PRAGMA only to CREATE the corrupted state
 * (the only way; cascades remove it normally) and restore it immediately.
 * In-transaction seam proofs live in taskQualityContainment*.test.ts; this
 * file proves the real HTTP surface with real statement-fault triggers.
 */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from "vitest";
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
import * as qualityRepo from "../repositories/qualityGate.js";
import * as dependencyRepo from "../repositories/dependency.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import * as taskReviewerRepo from "../repositories/taskReviewer.js";
import * as eventCrudRepo from "../repositories/events/event-crud.js";
import * as notificationEventRepo from "../repositories/notificationEvent.js";
import * as notificationDeliveryRepo from "../repositories/notificationDelivery.js";
import {
  agents as agentsTable,
  tasks,
  missions,
  habitats,
  taskEvents,
  taskReviewers,
  taskQualityChecklists,
  taskQualityChecklistItems,
  qualityChecklistTemplates,
  notificationEvents,
  notificationDeliveries,
} from "../db/schema/index.js";
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
let assignedAgentKey: string;
let unboundAgentKey: string;
let boundAgentKey: string;
let validRemoteKey: string;

let memberAdminJwt: string;
let memberEditorJwt: string;
let memberViewerJwt: string;
let memberBJwt: string;
let dualMemberJwt: string;
let nonmemberAdminJwt: string;
let personalHumanJwt: string;

const publishSpy = vi.spyOn(sseBroadcaster, "publish");
const publishCount = () => publishSpy.mock.calls.length;

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
  return jwt.sign({ sub: userId, username: `tqw-${userId}`, role }, getJwtSecret(), {
    expiresIn: "1h",
    issuer: "orcy",
  });
}
// The real pre-auth rate limiter buckets by credential string at 60/min. The
// matrix below issues more requests than one bucket holds, so the member
// admin uses a freshly minted (equally valid, same sub) token per call site.
// Random jti: without it two mints in the same second serialize to the SAME
// token string and therefore the same bucket.
const freshAdminJwt = () =>
  jwt.sign(
    {
      sub: "tqw-member-admin",
      username: "tqw-member-admin",
      role: "admin",
      jti: Math.random().toString(36).slice(2),
    },
    getJwtSecret(),
    { expiresIn: "1h", issuer: "orcy" },
  );
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
  if (opts.body !== undefined || opts.rawBody !== undefined) {
    headers["Content-Type"] = "application/json";
  }
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
function makeTask(habitatId: string, title: string, createdBy = "tqw-seed"): string {
  const column = columnRepo.createColumn({
    habitatId,
    name: `tqw-col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `tqw-mission-${title}`,
    createdBy,
  });
  return taskRepo.createTask({ missionId: mission.id, title, createdBy }).id;
}
function makeQuality(habitatId: string, title: string, opts?: { isRequired?: boolean }) {
  const template = qualityRepo.createTemplate({
    name: `tqw-tpl-${title}`,
    category: "testing",
    isRequired: opts?.isRequired ?? true,
    items: [
      { title: `${title}::req-1`, required: true },
      { title: `${title}::req-2`, required: true },
      { title: `${title}::opt-1`, required: false },
    ],
  });
  const taskId = makeTask(habitatId, title);
  const checklist = qualityRepo.createTaskChecklist(taskId, template.id);
  const items = qualityRepo.getChecklistItems(checklist.id);
  return {
    template,
    taskId,
    checklistId: checklist.id,
    items,
    req: (n: 1 | 2) => {
      const want = `${title}::req-${n}`;
      const tpl = qualityRepo.getTemplateItems(template.id).find((t) => t.title === want)!;
      return items.find((i) => i.itemId === tpl.id)!;
    },
  };
}
function itemRow(id: string) {
  return getDb()
    .select()
    .from(taskQualityChecklistItems)
    .where(eq(taskQualityChecklistItems.id, id))
    .get();
}
function checklistRow(id: string) {
  return getDb().select().from(taskQualityChecklists).where(eq(taskQualityChecklists.id, id)).get();
}
function qualitySnapshot(): unknown {
  return JSON.parse(
    JSON.stringify({
      items: getDb().select().from(taskQualityChecklistItems).all(),
      checklists: getDb().select().from(taskQualityChecklists).all(),
      templates: getDb().select().from(qualityChecklistTemplates).all(),
    }),
  );
}
function durableCounts() {
  return JSON.stringify({
    taskEvents: getDb()
      .select({ n: sql`count(*)` })
      .from(taskEvents)
      .all(),
    taskReviewers: getDb()
      .select({ n: sql`count(*)` })
      .from(taskReviewers)
      .all(),
    notificationEvents: getDb()
      .select({ n: sql`count(*)` })
      .from(notificationEvents)
      .all(),
    notificationDeliveries: getDb()
      .select({ n: sql`count(*)` })
      .from(notificationDeliveries)
      .all(),
  });
}
/** FK-off corrupted-ancestry fixture (the only way to create it), restoring
 * whatever enforcement state preceded it. */
function withFkOff(fn: () => void): void {
  const prev = (getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>)[0]!
    .foreign_keys;
  getDb().run(sql`PRAGMA foreign_keys = OFF`);
  try {
    fn();
  } finally {
    getDb().run(sql.raw(`PRAGMA foreign_keys = ${prev}`));
  }
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
    name: "tqw-org",
    slug: `tqw-org-${Date.now()}`,
  });
  const teamA = teamRepo.createTeam({
    organizationId: org.id,
    name: "tqw-team-a",
    slug: `tqw-team-a-${Date.now()}`,
  });
  const teamB = teamRepo.createTeam({
    organizationId: org.id,
    name: "tqw-team-b",
    slug: `tqw-team-b-${Date.now()}`,
  });
  teamAHabitatId = habitatRepo.createHabitat({ name: "tqw-habitat-a", teamId: teamA.id }).id;
  teamBHabitatId = habitatRepo.createHabitat({ name: "tqw-habitat-b", teamId: teamB.id }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "tqw-personal-habitat" }).id;

  for (const [userId] of [
    ["tqw-member-admin"],
    ["tqw-member-editor"],
    ["tqw-member-viewer"],
    ["tqw-member-b"],
    ["tqw-dual-member"],
  ] as const) {
    const teamId = userId === "tqw-member-b" ? teamB.id : teamA.id;
    teamMemberRepo.addMember({ teamId, userId, role: "member" });
  }
  teamMemberRepo.addMember({ teamId: teamB.id, userId: "tqw-dual-member", role: "member" });

  memberAdminJwt = mint("tqw-member-admin", "admin");
  memberEditorJwt = mint("tqw-member-editor", "editor");
  memberViewerJwt = mint("tqw-member-viewer", "viewer");
  memberBJwt = mint("tqw-member-b", "viewer");
  dualMemberJwt = mint("tqw-dual-member", "viewer");
  nonmemberAdminJwt = mint("tqw-nonmember-admin", "admin");
  personalHumanJwt = mint("tqw-personal-human", "viewer");

  // Assigned agent: currentTaskId bound to a Team-A Task.
  const anchorA = makeTask(teamAHabitatId, "tqw-agent-anchor-a");
  const assigned = agentRepo.createAgent({
    name: "tqw-agent-assigned",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  getDb()
    .update(agentsTable)
    .set({ currentTaskId: anchorA })
    .where(eq(agentsTable.id, assigned.agent.id))
    .run();
  assignedAgentKey = assigned.plainApiKey;

  const unbound = agentRepo.createAgent({
    name: "tqw-agent-unbound",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  unboundAgentKey = unbound.plainApiKey;

  // Another-Habitat-BOUND agent: currentTaskId points into Team B.
  const anchorB = makeTask(teamBHabitatId, "tqw-agent-anchor-b");
  const bound = agentRepo.createAgent({
    name: "tqw-agent-bound",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  getDb()
    .update(agentsTable)
    .set({ currentTaskId: anchorB })
    .where(eq(agentsTable.id, bound.agent.id))
    .run();
  boundAgentKey = bound.plainApiKey;

  const pod = remotePodRepo.createRemotePod({ habitatId: teamAHabitatId, name: "tqw-remote-pod" });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamAHabitatId,
    participantType: "remote_orcy",
    displayName: "tqw-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamAHabitatId,
    credentialType: "api",
    label: "tqw-remote-cred",
  }).plaintextSecret;

  child = spawn(process.execPath, ["--import", "tsx", MCP_ENTRY], {
    env: {
      ...process.env,
      ORCY_API_URL: baseUrl,
      ORCY_AGENT_ID: assigned.agent.id,
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
    clientInfo: { name: "tqw-quality-access-wire-test", version: "1.0.0" },
  });
  expect(init?.serverInfo?.name).toBe("orcy-mcp-server");
  child.stdin!.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n",
  );
}, 120_000);

afterAll(async () => {
  if (child) {
    child.kill("SIGTERM");
    await childExit;
  }
  await app.close();
  publishSpy.mockRestore();
  closeDb();
});

describe("actor admission — both quality operations, both prefixes", () => {
  it("admitted actors get 200 on PUT (valid triple) and validate with exact projections", async () => {
    const fixtures = [
      ["assigned agent", { agentKey: assignedAgentKey }],
      ["unbound agent", { agentKey: unboundAgentKey }],
      ["other-habitat-bound agent", { agentKey: boundAgentKey }],
      ["team member admin", { token: freshAdminJwt() }],
      ["team member editor", { token: memberEditorJwt }],
      ["team member viewer", { token: memberViewerJwt }],
    ] as Array<[string, WireOpts]>;

    for (const [label, opts] of fixtures) {
      const q = makeQuality(teamAHabitatId, `tqw-admit-${label.replace(/\W+/g, "-")}`);
      for (const prefix of PREFIXES) {
        const put = await wire(
          prefix,
          "PUT",
          `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${q.req(1).id}`,
          { ...opts, body: { isCompleted: true } },
        );
        expect(put.status, `${label} ${prefix} PUT`).toBe(200);
        expect(put.body.id).toBe(q.req(1).id);
        expect(put.body.checklistId).toBe(q.checklistId);
        expect(put.body.isCompleted).toBe(true);
        expect(put.body.itemId).toBe(q.req(1).itemId);

        const val = await wire(
          prefix,
          "POST",
          `/tasks/${q.taskId}/quality-checklist/validate`,
          opts,
        );
        expect(val.status, `${label} ${prefix} validate`).toBe(200);
        expect(val.body.passed).toBe(false);
        expect(val.body.failures[0].category).toBe("testing");
      }
    }

    // Personal-Habitat human of any role: allowed on personal ancestry.
    const personal = makeQuality(personalHabitatId, "tqw-admit-personal");
    for (const prefix of PREFIXES) {
      const put = await wire(
        prefix,
        "PUT",
        `/tasks/${personal.taskId}/quality-checklist/${personal.checklistId}/items/${personal.req(1).id}`,
        { token: personalHumanJwt, body: { isCompleted: true } },
      );
      expect(put.status, `personal ${prefix}`).toBe(200);
      const val = await wire(
        prefix,
        "POST",
        `/tasks/${personal.taskId}/quality-checklist/validate`,
        {
          token: personalHumanJwt,
        },
      );
      expect(val.status).toBe(200);
    }

    // Mixed valid local key + human JWT: agent arm admitted.
    const mixed = makeQuality(teamAHabitatId, "tqw-admit-mixed");
    const put = await wire(
      "/api/v1",
      "PUT",
      `/tasks/${mixed.taskId}/quality-checklist/${mixed.checklistId}/items/${mixed.req(1).id}`,
      { agentKey: assignedAgentKey, token: freshAdminJwt(), body: { isCompleted: true } },
    );
    expect(put.status).toBe(200);
  }, 120_000);

  it("team nonmember (any global role) is 403 BOARD_ACCESS_DENIED on both ops with zero mutation; anonymous/invalid-local/remote-only are 401", async () => {
    const q = makeQuality(teamAHabitatId, "tqw-deny");
    const itemPath = `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${q.req(1).id}`;
    const valPath = `/tasks/${q.taskId}/quality-checklist/validate`;
    const before = qualitySnapshot();

    for (const prefix of PREFIXES) {
      for (const [label, opts] of [
        ["team-B member", { token: memberBJwt }],
        ["global-admin nonmember", { token: nonmemberAdminJwt }],
      ] as Array<[string, WireOpts]>) {
        const put = await wire(prefix, "PUT", itemPath, { ...opts, body: { isCompleted: true } });
        expect(put.status, `${label} ${prefix} PUT`).toBe(403);
        expect(put.body.code).toBe("BOARD_ACCESS_DENIED");
        expect(put.text).not.toContain("::req-");
        const val = await wire(prefix, "POST", valPath, opts);
        expect(val.status, `${label} ${prefix} validate`).toBe(403);
        expect(val.body.code).toBe("BOARD_ACCESS_DENIED");
      }
      for (const [label, opts] of [
        ["anonymous", {}],
        ["invalid local key", { agentKey: "not-a-key" }],
        ["valid remote-only", { remoteKey: validRemoteKey }],
        ["invalid local key + valid JWT", { agentKey: "not-a-key", token: freshAdminJwt() }],
      ] as Array<[string, WireOpts]>) {
        const put = await wire(prefix, "PUT", itemPath, { ...opts, body: { isCompleted: true } });
        expect(put.status, `${label} ${prefix} PUT`).toBe(401);
        const val = await wire(prefix, "POST", valPath, opts);
        expect(val.status, `${label} ${prefix} validate`).toBe(401);
      }
    }
    expect(qualitySnapshot()).toEqual(before);
  }, 120_000);

  it("ordering: auth 401 beats ancestry 404; body 400 beats ancestry 404 and admission 403", async () => {
    const missing = "00000000-0000-4000-8000-0000000000d1";
    for (const prefix of PREFIXES) {
      // 401 on a well-formed body even for an absent Task.
      expect(
        (
          await wire(prefix, "PUT", `/tasks/${missing}/quality-checklist/x/items/y`, {
            body: { isCompleted: true },
          })
        ).status,
        `anon ${prefix}`,
      ).toBe(401);
      // Malformed body 400 precedes ancestry lookup (member, absent Task).
      const bad = await wire(prefix, "PUT", `/tasks/${missing}/quality-checklist/x/items/y`, {
        token: freshAdminJwt(),
        body: {},
      });
      expect(bad.status, `bad-body+missing-task ${prefix}`).toBe(400);
      expect(bad.body.code).toBe("VALIDATION_ERROR");
      // Malformed body 400 also precedes admission denial (nonmember).
      const denied = await wire(prefix, "PUT", `/tasks/${missing}/quality-checklist/x/items/y`, {
        token: memberBJwt,
        body: {},
      });
      expect(denied.status, `bad-body+nonmember ${prefix}`).toBe(400);
      // Valid body + absent Task → 404.
      const absent = await wire(prefix, "PUT", `/tasks/${missing}/quality-checklist/x/items/y`, {
        token: freshAdminJwt(),
        body: { isCompleted: true },
      });
      expect(absent.status, `valid-body+missing-task ${prefix}`).toBe(404);
    }
  }, 60_000);

  it("missing/corrupted Mission or Habitat ancestry is 404 before any child read (both ops)", async () => {
    // Corrupted Mission: Task points at a mission id that does not exist.
    const brokenMission = makeQuality(teamAHabitatId, "tqw-broken-mission");
    // Missing Habitat: a DEDICATED personal habitat (admits any valid human,
    // so admission would pass if the row existed) removed under FK-off — the
    // only way to leave a dangling habitatId; cascades remove it normally.
    const orphanHabitat = habitatRepo.createHabitat({ name: "tqw-orphan-habitat" }).id;
    const brokenHabitat = makeQuality(orphanHabitat, "tqw-broken-habitat");

    withFkOff(() => {
      getDb()
        .update(tasks)
        .set({ missionId: "00000000-0000-4000-8000-0000000000d2" })
        .where(eq(tasks.id, brokenMission.taskId))
        .run();
      getDb().delete(habitats).where(eq(habitats.id, orphanHabitat)).run();
    });

    for (const [label, taskId, checklistId, itemId] of [
      ["missing Mission", brokenMission.taskId, brokenMission.checklistId, brokenMission.req(1).id],
      ["missing Habitat", brokenHabitat.taskId, brokenHabitat.checklistId, brokenHabitat.req(1).id],
    ] as const) {
      for (const prefix of PREFIXES) {
        const put = await wire(
          prefix,
          "PUT",
          `/tasks/${taskId}/quality-checklist/${checklistId}/items/${itemId}`,
          { token: freshAdminJwt(), body: { isCompleted: true } },
        );
        expect(put.status, `${label} ${prefix} PUT`).toBe(404);
        const val = await wire(prefix, "POST", `/tasks/${taskId}/quality-checklist/validate`, {
          token: freshAdminJwt(),
        });
        expect(val.status, `${label} ${prefix} validate`).toBe(404);
      }
    }
  }, 60_000);
});

describe("PUT exact-triple semantics on the wire (member actor)", () => {
  const putVia = async (
    prefix: string,
    q: ReturnType<typeof makeQuality>,
    itemId: string,
    body: unknown,
    opts: WireOpts = {},
  ) =>
    wire(prefix, "PUT", `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${itemId}`, {
      token: freshAdminJwt(),
      ...opts,
      body,
    });

  it("mapper boundary on BOTH prefixes: nondefault seed, ignored completedBy-without-isCompleted, real null/false clears, full RETURNING equality with the persisted row", async () => {
    for (const prefix of PREFIXES) {
      const q = makeQuality(teamAHabitatId, `tqw-map-${prefix.includes("v1") ? "v1" : "dep"}`);
      const item = q.req(1);
      const path = `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${item.id}`;
      const persisted = () => JSON.parse(JSON.stringify(itemRow(item.id)));

      // NONDEFAULT seed: completion with caller metadata + evidence + notes.
      let res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: {
          isCompleted: true,
          completedBy: "tqw-meta",
          evidenceUrl: "https://e.test/seed",
          notes: "seed-note",
        },
      });
      expect(res.status, `${prefix} seed`).toBe(200);
      expect(res.body).toEqual(persisted());
      const seedStamp = itemRow(item.id)!.completedAt;
      expect(seedStamp).not.toBeNull();
      expect(itemRow(item.id)!.completedBy).toBe("tqw-meta");
      expect(itemRow(item.id)!.evidenceUrl).toBe("https://e.test/seed");
      // Recalculation follows: one required item complete → in_progress, no stamp.
      expect(checklistRow(q.checklistId)!.status).toBe("in_progress");
      expect(checklistRow(q.checklistId)!.completedAt).toBeNull();

      // completedBy + evidence/notes WITHOUT isCompleted: completion metadata IGNORED.
      res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { completedBy: "tqw-ignored", evidenceUrl: "https://e.test/other", notes: "changed" },
      });
      expect(res.status, `${prefix} ignored-metadata`).toBe(200);
      const afterMeta = itemRow(item.id)!;
      expect(afterMeta.completedBy).toBe("tqw-meta");
      expect(afterMeta.completedAt).toBe(seedStamp);
      expect(afterMeta.evidenceUrl).toBe("https://e.test/other");
      expect(afterMeta.notes).toBe("changed");
      expect(res.body).toEqual(persisted());

      // REAL null clear from a nondefault value.
      res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { evidenceUrl: null },
      });
      expect(res.status, `${prefix} null-clear`).toBe(200);
      expect(itemRow(item.id)!.evidenceUrl).toBeNull();
      expect(res.body).toEqual(persisted());

      // Unknown fields mixed with legitimate data strip and succeed.
      res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { notes: "n", rogue: "x", taskId: "00000000-0000-4000-8000-0000000000e1" },
      });
      expect(res.status, `${prefix} unknown-strip`).toBe(200);
      expect(res.body).toEqual(persisted());
      expect(itemRow(item.id)!.notes).toBe("n");
      expect(itemRow(item.id)!.checklistId).toBe(q.checklistId);

      // Unchanged-value repeat succeeds.
      res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { isCompleted: true },
      });
      expect(res.status, `${prefix} unchanged`).toBe(200);
      expect(res.body).toEqual(persisted());

      // Complete the remaining required item → passed + checklist stamp.
      res = await wire(
        prefix,
        "PUT",
        `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${q.req(2).id}`,
        { token: freshAdminJwt(), body: { isCompleted: true } },
      );
      expect(res.status, `${prefix} pass`).toBe(200);
      expect(checklistRow(q.checklistId)!.status).toBe("passed");
      expect(checklistRow(q.checklistId)!.completedAt).not.toBeNull();

      // RE-SEED a NONNULL completedBy immediately before false (the unchanged
      // repeat above set completedBy to null by omitting it); the precondition
      // is OBSERVED from the persisted row, not assumed.
      res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { isCompleted: true, completedBy: "tqw-meta" },
      });
      expect(res.status, `${prefix} reseed`).toBe(200);
      const reseeded = itemRow(item.id)!;
      expect(reseeded.completedBy, `${prefix} reseed precondition`).toBe("tqw-meta");
      expect(reseeded.completedAt, `${prefix} reseed precondition`).not.toBeNull();

      // true→false from that NONNULL state: metadata cleared for real.
      res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { isCompleted: false },
      });
      expect(res.status, `${prefix} false-clear`).toBe(200);
      const cleared = itemRow(item.id)!;
      expect(cleared.isCompleted).toBe(false);
      expect(cleared.completedBy).toBeNull();
      expect(cleared.completedAt).toBeNull();
      expect(res.body).toEqual(persisted());
      // Checklist regresses with stamp clear.
      expect(checklistRow(q.checklistId)!.status).toBe("in_progress");
      expect(checklistRow(q.checklistId)!.completedAt).toBeNull();
    }
  }, 120_000);

  it("malformed / ineffective bodies are explicit 400s with zero mutation", async () => {
    const q = makeQuality(teamAHabitatId, "tqw-put-400");
    const item = q.req(1);
    const path = `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${item.id}`;
    const before = qualitySnapshot();

    const badBodies: Array<[string, unknown]> = [
      ["null body", null],
      ["array body", [1, 2]],
      ["scalar string body", "x"],
      ["scalar number body", 5],
      ["empty object", {}],
      ["unknown-only", { rogue: 1 }],
      ["completedBy-only", { completedBy: "tqw-x" }],
      ["isCompleted null", { isCompleted: null }],
      ["notes null", { notes: null }],
      ["isCompleted wrong type", { isCompleted: "yes" }],
      ["notes wrong type", { notes: 5 }],
      ["evidenceUrl wrong type", { evidenceUrl: 12 }],
      ["completedBy wrong type", { completedBy: 9 }],
    ];
    for (const prefix of PREFIXES) {
      for (const [label, body] of badBodies) {
        const res = await wire(prefix, "PUT", path, { token: freshAdminJwt(), body });
        expect(res.status, `${label} ${prefix}`).toBe(400);
        expect(res.body.code).toBe("VALIDATION_ERROR");
      }
      // Absent body (no payload at all).
      const absent = await wire(prefix, "PUT", path, { token: freshAdminJwt() });
      expect(absent.status, `absent ${prefix}`).toBe(400);
      // Framework-parser characterization (base-equal, NOT a candidate
      // delta): an empty raw application/json payload never reaches the
      // route's parsed-body validation; the pre-existing generic error
      // handler answers 500 INTERNAL_ERROR on both prefixes and on the
      // pristine base. No mutation (snapshot compared below).
      const emptyRaw = await wire(prefix, "PUT", path, { token: freshAdminJwt(), rawBody: "" });
      expect(emptyRaw.status, `empty-raw ${prefix}`).toBe(500);
      expect(emptyRaw.body).toEqual({ error: "Internal server error", code: "INTERNAL_ERROR" });
    }
    expect(qualitySnapshot()).toEqual(before);

    // The truthiness-refine boundary: false alone and null-evidence alone are
    // EFFECTIVE inputs and must not be rejected.
    expect(
      (await wire("/api/v1", "PUT", path, { token: freshAdminJwt(), body: { isCompleted: false } }))
        .status,
    ).toBe(200);
    expect(
      (await wire("/api", "PUT", path, { token: freshAdminJwt(), body: { evidenceUrl: null } }))
        .status,
    ).toBe(200);
    expect(itemRow(item.id)!.isCompleted).toBe(false);
    expect(itemRow(item.id)!.evidenceUrl).toBeNull();
  }, 60_000);
});

describe("PUT broken containment triples are generic 404s with byte-equal foreign state", () => {
  it("wrong Task / wrong checklist / foreign item (same Task) / template-ID confusion / nonexistent pairs", async () => {
    const inA = makeQuality(teamAHabitatId, "tqw-triple-a");
    const inB = makeQuality(teamBHabitatId, "tqw-triple-b");
    // GENUINE second instance checklist under inA's EXISTING Task (same
    // template) — asserted: equal persisted Task, distinct checklist ids.
    const inA2ChecklistId = qualityRepo.createTaskChecklist(inA.taskId, inA.template.id).id;
    const inA2FirstItem = qualityRepo.getChecklistItems(inA2ChecklistId)[0]!;
    expect(qualityRepo.getTaskChecklistById(inA2ChecklistId)!.taskId).toBe(
      qualityRepo.getTaskChecklistById(inA.checklistId)!.taskId,
    );
    expect(inA2ChecklistId).not.toBe(inA.checklistId);

    // Distinguishable nonempty status/stamps on every checklist involved
    // (both same-Task checklists and the foreign one).
    for (const cl of [inA.checklistId, inA2ChecklistId, inB.checklistId]) {
      getDb()
        .update(taskQualityChecklists)
        .set({ status: "in_progress", completedAt: "2000-01-01T00:00:00.000Z" })
        .where(eq(taskQualityChecklists.id, cl))
        .run();
    }
    const before = qualitySnapshot();

    // Cross-Task rows are attempted by the dual member (admitted on BOTH
    // ancestries) so the 404 comes from the triple, not from admission.
    const cases: Array<[string, string, string, string, string]> = [
      ["wrong Task, correct child pair", inB.taskId, inA.checklistId, inA.req(1).id, dualMemberJwt],
      [
        "right Task, checklist of another Task",
        inA.taskId,
        inB.checklistId,
        inB.req(1).id,
        memberAdminJwt,
      ],
      [
        "right Task+checklist, item of the SECOND checklist under the SAME Task",
        inA.taskId,
        inA.checklistId,
        inA2FirstItem.id,
        memberAdminJwt,
      ],
      [
        "right Task, SECOND checklist of the same Task, first checklist's item",
        inA.taskId,
        inA2ChecklistId,
        inA.req(1).id,
        memberAdminJwt,
      ],
      [
        "nonexistent checklist, known item",
        inA.taskId,
        "00000000-0000-4000-8000-0000000000d3",
        inA.req(1).id,
        memberAdminJwt,
      ],
      ["template id as checklist id", inA.taskId, inA.template.id, inA.req(1).id, memberAdminJwt],
      [
        "template-item id as item id",
        inA.taskId,
        inA.checklistId,
        inA.req(1).itemId,
        memberAdminJwt,
      ],
      [
        "absent item",
        inA.taskId,
        inA.checklistId,
        "00000000-0000-4000-8000-0000000000d4",
        memberAdminJwt,
      ],
      [
        "absent Task, otherwise exact triple",
        "00000000-0000-4000-8000-0000000000d5",
        inA.checklistId,
        inA.req(1).id,
        memberAdminJwt,
      ],
    ];
    for (const prefix of PREFIXES) {
      for (const [label, taskId, checklistId, itemId, token] of cases) {
        const res = await wire(
          prefix,
          "PUT",
          `/tasks/${taskId}/quality-checklist/${checklistId}/items/${itemId}`,
          { token, body: { isCompleted: true, notes: `must-not-land-${label}` } },
        );
        expect(res.status, `${label} ${prefix}`).toBe(404);
        expect(res.body.code).toBe("NOT_FOUND");
        // Missing ancestry outranks triple absence ("Task not found");
        // every broken containment relation is the GENERIC item message.
        if (taskId !== "00000000-0000-4000-8000-0000000000d5") {
          expect(res.body.error, `${label} ${prefix}`).toBe("Checklist item not found");
        }
        expect(res.text).not.toContain("::req-");
      }
    }
    // Nothing moved, nothing recalculated, no foreign data disclosed.
    expect(qualitySnapshot()).toEqual(before);
  }, 120_000);
});

describe("POST validate — report-derived read-only truth", () => {
  it("pending required checks fail with exact category/titles; completion flips them; optional templates and checklist-less Tasks pass", async () => {
    const q = makeQuality(teamAHabitatId, "tqw-val-req");
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "POST", `/tasks/${q.taskId}/quality-checklist/validate`, {
        token: memberViewerJwt,
      });
      expect(res.status).toBe(200);
      expect(res.body).toEqual({
        passed: false,
        failures: [
          { category: "testing", missingItems: ["tqw-val-req::req-1", "tqw-val-req::req-2"] },
        ],
      });
    }

    for (const item of [q.req(1), q.req(2)]) {
      await wire(
        "/api/v1",
        "PUT",
        `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${item.id}`,
        {
          token: freshAdminJwt(),
          body: { isCompleted: true },
        },
      );
    }
    const pass = await wire("/api/v1", "POST", `/tasks/${q.taskId}/quality-checklist/validate`, {
      token: memberViewerJwt,
    });
    expect(pass.body).toEqual({ passed: true, failures: [] });

    // Optional template with incomplete items does not fail validation.
    const opt = makeQuality(teamAHabitatId, "tqw-val-opt", { isRequired: false });
    const optRes = await wire(
      "/api/v1",
      "POST",
      `/tasks/${opt.taskId}/quality-checklist/validate`,
      { token: memberViewerJwt },
    );
    expect(optRes.body).toEqual({ passed: true, failures: [] });

    // Task without any checklists passes with empty failures.
    const bare = makeTask(teamAHabitatId, "tqw-val-bare");
    const bareRes = await wire("/api/v1", "POST", `/tasks/${bare}/quality-checklist/validate`, {
      token: memberViewerJwt,
    });
    expect(bareRes.body).toEqual({ passed: true, failures: [] });
  }, 60_000);

  it("validate repairs nothing: stale cached checklist status stays, and repeated validates mutate no durable state; zero SSE publications across quality ops", async () => {
    const q = makeQuality(teamAHabitatId, "tqw-val-pure");
    // Stale cached status: report truth is still blocked.
    getDb()
      .update(taskQualityChecklists)
      .set({ status: "passed", completedAt: "1999-01-01T00:00:00.000Z" })
      .where(eq(taskQualityChecklists.id, q.checklistId))
      .run();
    const taskBefore = JSON.stringify(
      getDb().select().from(tasks).where(eq(tasks.id, q.taskId)).all(),
    );

    const snap = qualitySnapshot();
    const counts = durableCounts();
    const pubs = publishCount();

    // Both prefixes, repeated: purity holds on the deprecated surface too.
    for (let i = 0; i < 2; i++) {
      for (const prefix of PREFIXES) {
        const res = await wire(prefix, "POST", `/tasks/${q.taskId}/quality-checklist/validate`, {
          token: freshAdminJwt(),
        });
        expect(res.status, `${prefix} repeat ${i}`).toBe(200);
        expect(res.body.passed).toBe(false);
      }
    }
    // Rejected operations publish nothing either (both prefixes).
    for (const prefix of PREFIXES) {
      await wire(
        prefix,
        "PUT",
        `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/00000000-0000-4000-8000-0000000000d6`,
        {
          token: freshAdminJwt(),
          body: { isCompleted: true },
        },
      );
      await wire(
        prefix,
        "PUT",
        `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${q.req(1).id}`,
        {
          token: memberBJwt,
          body: { isCompleted: true },
        },
      );
    }

    expect(qualitySnapshot()).toEqual(snap); // cached status NOT repaired
    expect(durableCounts()).toEqual(counts);
    expect(
      JSON.stringify(getDb().select().from(tasks).where(eq(tasks.id, q.taskId)).all()),
    ).toEqual(taskBefore);
    expect(publishCount()).toBe(pubs);

    // A successful PUT also publishes no SSE event for these operations.
    const pubs2 = publishCount();
    const ok = await wire(
      "/api/v1",
      "PUT",
      `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${q.req(1).id}`,
      {
        token: freshAdminJwt(),
        body: { isCompleted: true },
      },
    );
    expect(ok.status).toBe(200);
    expect(publishCount()).toBe(pubs2);
  }, 60_000);

  it("validate stays independent with a LIVE inaccessible foreign dependency, then a dangling edge — both prefixes, exact report, nonempty durable baseline unchanged", async () => {
    // INITIAL FIXTURE (clearly labeled; then PURE validate): source-legitimate
    // NONEMPTY durable state ON THE TARGET TASK, created through existing
    // repositories with valid FKs (reviewerId/recipientId are plain-text
    // columns with no user FK, so no user row is required), all writes
    // synchronous and settled at creation. No new feature; no invented
    // validation effect. Per-target ownership on ALL FOUR stores is asserted
    // BEFORE any validate call.
    const seedTargetDurableState = (taskId: string) => {
      const reviewer = taskReviewerRepo.create(taskId, "human", "tqw-val-reviewer");
      expect(reviewer.taskId).toBe(taskId); // ownership: the VALIDATED Task
      const event = eventCrudRepo.createEvent({
        taskId,
        actorType: "system",
        actorId: "tqw-val-seeder",
        action: "updated",
      });
      expect(event.taskId).toBe(taskId);
      const notifEvent = notificationEventRepo.createNotificationEvent({
        habitatId: teamAHabitatId,
        eventType: "task.assigned",
        sourceType: "task",
        sourceId: taskId,
        severity: "info",
        title: "tqw baseline notification",
        body: "pre-existing target-scoped notification fixture",
        createdByType: "system",
        createdById: "tqw-val-seeder",
      });
      expect(notifEvent.sourceId).toBe(taskId);
      const delivery = notificationDeliveryRepo.createNotificationDelivery({
        eventId: notifEvent.id,
        habitatId: teamAHabitatId,
        recipientType: "human",
        recipientId: "tqw-val-reviewer",
        channels: ["in_app"],
      });
      expect(delivery.eventId).toBe(notifEvent.id);
      return notifEvent.id;
    };
    const targetCounts = (taskId: string) => ({
      reviewers: getDb().select({ n: sql`count(*)` }).from(taskReviewers).where(eq(taskReviewers.taskId, taskId)).all()[0]!.n,
      events: getDb().select({ n: sql`count(*)` }).from(taskEvents).where(eq(taskEvents.taskId, taskId)).all()[0]!.n,
      notificationEvents: getDb().select({ n: sql`count(*)` }).from(notificationEvents).where(eq(notificationEvents.sourceId, taskId)).all()[0]!.n,
    });
    // Target-scoped (not global) full snapshot over ALL FOUR stores: a change
    // on the validated Task cannot hide among other rows, and unrelated-row
    // churn cannot mask it.
    const fullState = (taskId: string, seededNotifEventId: string) =>
      JSON.stringify({
        quality: qualitySnapshot(),
        task: getDb().select().from(tasks).where(eq(tasks.id, taskId)).all(),
        reviewers: getDb().select().from(taskReviewers).where(eq(taskReviewers.taskId, taskId)).all(),
        events: getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all(),
        notificationEvents: getDb().select().from(notificationEvents).where(eq(notificationEvents.sourceId, taskId)).all(),
        notificationDeliveries: getDb().select().from(notificationDeliveries).where(eq(notificationDeliveries.eventId, seededNotifEventId)).all(),
      });

    // LIVE foreign dependency: the inaccessible Team-B Task still EXISTS.
    const q = makeQuality(teamAHabitatId, "tqw-val-live");
    const foreignLive = makeTask(teamBHabitatId, "tqw-val-live-foreign");
    dependencyRepo.addTaskDependency(q.taskId, foreignLive);
    expect(getDb().select().from(tasks).where(eq(tasks.id, foreignLive)).all()).toHaveLength(1); // row exists — the live case, not the dangling one

    // Deliberately STALE cached status must remain unrepaired.
    getDb()
      .update(taskQualityChecklists)
      .set({ status: "passed", completedAt: "1999-01-01T00:00:00.000Z" })
      .where(eq(taskQualityChecklists.id, q.checklistId))
      .run();

    const seededNotifEventId = seedTargetDurableState(q.taskId);
    const counts = targetCounts(q.taskId);
    expect(counts.reviewers).toBeGreaterThan(0);
    expect(counts.events).toBeGreaterThan(0);
    expect(counts.notificationEvents).toBeGreaterThan(0);

    const liveBefore = fullState(q.taskId, seededNotifEventId);
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "POST", `/tasks/${q.taskId}/quality-checklist/validate`, {
        token: memberViewerJwt, // member of A, NO access to Team B
      });
      expect(res.status, `live ${prefix}`).toBe(200);
      expect(res.body).toEqual({
        passed: false,
        failures: [
          { category: "testing", missingItems: ["tqw-val-live::req-1", "tqw-val-live::req-2"] },
        ],
      });
      expect(res.text).not.toContain("tqw-val-live-foreign");
    }
    expect(fullState(q.taskId, seededNotifEventId)).toEqual(liveBefore); // stale cached status NOT repaired

    // DANGLING edge, separate fixture: FK-off deletion of the endpoint Task
    // (the only way to leave a dangling edge; restored immediately).
    const q2 = makeQuality(teamAHabitatId, "tqw-val-dangling");
    const foreign2 = makeTask(teamBHabitatId, "tqw-val-dangling-foreign");
    dependencyRepo.addTaskDependency(q2.taskId, foreign2);
    withFkOff(() => {
      getDb().delete(tasks).where(eq(tasks.id, foreign2)).run();
    });
    const seededNotif2 = seedTargetDurableState(q2.taskId);
    const counts2 = targetCounts(q2.taskId);
    expect(counts2.reviewers).toBeGreaterThan(0);
    expect(counts2.events).toBeGreaterThan(0);
    expect(counts2.notificationEvents).toBeGreaterThan(0);

    const danglingBefore = fullState(q2.taskId, seededNotif2);
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "POST", `/tasks/${q2.taskId}/quality-checklist/validate`, {
        token: memberViewerJwt,
      });
      expect(res.status, `dangling ${prefix}`).toBe(200);
      expect(res.body.passed).toBe(false);
      expect(res.text).not.toContain("tqw-val-dangling-foreign");
    }
    expect(fullState(q2.taskId, seededNotif2)).toEqual(danglingBefore);
  }, 120_000);
});

describe("real statement faults on the HTTP wire (sql.js test DB, temporary triggers)", () => {
  const drop = () => {
    getDb().run(sql`DROP TRIGGER IF EXISTS tqw_abort_item`);
    getDb().run(sql`DROP TRIGGER IF EXISTS tqw_abort_status`);
  };
  afterEach(drop);

  it("item-table fault is 500 after admission with both row sets unchanged, on each prefix; replay succeeds after drop", async () => {
    const q = makeQuality(teamAHabitatId, "tqw-fault-item");
    const item = q.req(1);
    const path = `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${item.id}`;
    getDb().run(
      sql`CREATE TRIGGER tqw_abort_item BEFORE UPDATE ON task_quality_checklist_items BEGIN SELECT RAISE(ABORT, 'tqw item fault'); END`,
    );
    const before = qualitySnapshot();
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { isCompleted: true },
      });
      expect(res.status, `${prefix} item fault`).toBe(500);
      expect(res.body.code).toBe("REPOSITORY_ERROR");
    }
    expect(qualitySnapshot()).toEqual(before);
    drop();
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { isCompleted: true },
      });
      expect(res.status, `${prefix} replay`).toBe(200);
    }
    expect(itemRow(item.id)!.isCompleted).toBe(true);
  }, 60_000);

  it("status-table fault AFTER a matched item UPDATE is 500 and rolls the item UPDATE back (transaction)", async () => {
    const q = makeQuality(teamAHabitatId, "tqw-fault-status");
    const item = q.req(1);
    const path = `/tasks/${q.taskId}/quality-checklist/${q.checklistId}/items/${item.id}`;
    getDb().run(
      sql`CREATE TRIGGER tqw_abort_status BEFORE UPDATE ON task_quality_checklists BEGIN SELECT RAISE(ABORT, 'tqw status fault'); END`,
    );
    const before = qualitySnapshot();
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "PUT", path, {
        token: freshAdminJwt(),
        body: { isCompleted: true },
      });
      expect(res.status, `${prefix} status fault`).toBe(500);
    }
    expect(qualitySnapshot()).toEqual(before);
    drop();
    expect(
      (await wire("/api/v1", "PUT", path, { token: freshAdminJwt(), body: { isCompleted: true } }))
        .status,
    ).toBe(200);
  }, 60_000);
});

describe("quality operations — served MCP compatibility (real stdio, real agent key, /api transport)", () => {
  it("update-quality-checklist-item success, containment denials, validate denials, 400 mapping, false mapping retained", async () => {
    const q = makeQuality(teamAHabitatId, "tqw-mcp");

    // Correct triple succeeds; response decodes to the persisted row.
    const ok = await callTool("orcy_habitat_task", {
      action: "update-quality-checklist-item",
      taskId: q.taskId,
      checklistId: q.checklistId,
      itemId: q.req(1).id,
      isCompleted: true,
      evidenceUrl: "https://ci.test/mcp",
      notes: "via mcp",
    });
    expect(ok.isError).toBeFalsy();
    const okBody = JSON.parse(toolText(ok));
    expect(okBody.id).toBe(q.req(1).id);
    expect(okBody.isCompleted).toBe(true);
    expect(itemRow(q.req(1).id)!.isCompleted).toBe(true);
    expect(checklistRow(q.checklistId)!.status).toBe("in_progress");

    // Wrong triple: isError, generic message, no DB effects. FULL snapshots
    // of both instance tables bracket every denial below.
    const tables = () =>
      JSON.stringify({
        items: getDb().select().from(taskQualityChecklistItems).all(),
        checklists: getDb().select().from(taskQualityChecklists).all(),
      });

    // KNOWN foreign pair under an EXISTING ADMITTED Task: a real checklist +
    // real item that exist — but under a different Task than the URL's.
    const otherTask = makeQuality(teamAHabitatId, "tqw-mcp-foreign");
    const tablesBeforeKnown = tables();
    const knownForeign = await callTool("orcy_habitat_task", {
      action: "update-quality-checklist-item",
      taskId: q.taskId, // existing, admitted Task
      checklistId: otherTask.checklistId, // REAL checklist of ANOTHER Task
      itemId: otherTask.req(1).id, // REAL item of that checklist
      isCompleted: true,
    });
    expect(knownForeign.isError).toBe(true);
    expect(toolText(knownForeign)).toContain("Checklist item not found");
    expect(tables()).toEqual(tablesBeforeKnown);

    const tablesBeforeAbsent = tables();
    const wrong = await callTool("orcy_habitat_task", {
      action: "update-quality-checklist-item",
      taskId: q.taskId,
      checklistId: q.checklistId,
      itemId: "00000000-0000-4000-8000-0000000000d7",
      isCompleted: true,
    });
    expect(wrong.isError).toBe(true);
    expect(toolText(wrong)).toContain("Checklist item not found");
    expect(tables()).toEqual(tablesBeforeAbsent);

    const foreign = await callTool("orcy_habitat_task", {
      action: "update-quality-checklist-item",
      taskId: "00000000-0000-4000-8000-0000000000d8",
      checklistId: q.checklistId,
      itemId: q.req(1).id,
      isCompleted: true,
    });
    expect(foreign.isError).toBe(true);
    expect(tables()).toEqual(tablesBeforeAbsent);

    // Empty effective update (no options mapped) → 400 isError.
    const empty = await callTool("orcy_habitat_task", {
      action: "update-quality-checklist-item",
      taskId: q.taskId,
      checklistId: q.checklistId,
      itemId: q.req(2).id,
    });
    expect(empty.isError).toBe(true);
    expect(toolText(empty)).toContain("400");

    // false mapping retained through MCP.
    const clear = await callTool("orcy_habitat_task", {
      action: "update-quality-checklist-item",
      taskId: q.taskId,
      checklistId: q.checklistId,
      itemId: q.req(1).id,
      isCompleted: false,
    });
    expect(clear.isError).toBeFalsy();
    expect(itemRow(q.req(1).id)!.isCompleted).toBe(false);
    expect(itemRow(q.req(1).id)!.completedAt).toBeNull();
    expect(checklistRow(q.checklistId)!.status).toBe("pending");

    // validate-quality-gates: truth on success, isError on missing Task.
    const val = await callTool("orcy_habitat_task", {
      action: "validate-quality-gates",
      taskId: q.taskId,
    });
    expect(val.isError).toBeFalsy();
    expect(JSON.parse(toolText(val)).passed).toBe(false);

    const valMissing = await callTool("orcy_habitat_task", {
      action: "validate-quality-gates",
      taskId: "00000000-0000-4000-8000-0000000000d9",
    });
    expect(valMissing.isError).toBe(true);
  }, 120_000);
});
