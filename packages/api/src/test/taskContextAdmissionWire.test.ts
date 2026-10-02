/**
 * Task workflow-context / failure-context admission — REAL HTTP wire matrix on
 * BOTH served prefixes (`/api/v1`, deprecated `/api`) through the real
 * production HTTP assembly, a real TCP socket, real credentials, and a real
 * database. No `vi.mock` of any authorization authority; the only spies are
 * read-through observers on the two projection services.
 *
 * Scope of claims (author evidence, bounded to REQUESTED-Task admission):
 *  - GET /tasks/:id/workflow-context and GET /tasks/:id/failure-context resolve
 *    the URL Task's actual Mission -> Habitat and run the shared membership
 *    predicate (`authorizeTaskAccess`) BEFORE any projection service call.
 *  - Intended deltas: team-nonmember humans (including global admin) 403
 *    `BOARD_ACCESS_DENIED` (was 200 with the stored rows); missing Task 404
 *    `Task not found` (was the projection's own 404 wording); missing Mission /
 *    Habitat 404.
 *  - Preserved: `local_actor` policy, broad local-agent admission (bound or
 *    unbound, any Habitat), personal-Habitat access for any human role, 401 for
 *    anonymous / invalid local / remote-only credentials, the exact admitted
 *    envelopes (raw gate rows incl. `matchConfig`/`condition`/all statuses, and
 *    the full Failure Context row), latest-unresolved `failedTaskId` selection
 *    with NO Recovery-ID reverse lookup, and the existing post-admission 404s for
 *    an admitted Task that has no projection.
 *
 * Disclosed limits — this is NOT a disclosure-isolation contract:
 *  - Linked-object disclosure is unchanged. Each returned gate still exposes
 *    `workflowId`/`missionId`/`habitatId`/the opposite endpoint id and optional
 *    `recoveryTaskId` with no predicate on those objects; `attachWorkflow` stores
 *    node task ids with FK-existence only. The raw shape is asserted here as
 *    COMPATIBILITY, not as privacy approval.
 *  - Captured Failure Context scope is unchanged: the row keeps its own
 *    `habitatId`/`workflowId` captured at build time, while admission uses
 *    CURRENT Task -> Mission -> Habitat ancestry. Authorizing current ancestry
 *    does not certify captured-scope content.
 *  - The Failure bundle still carries individual Experience subjects/lifecycle
 *    metadata. No Experience redaction choice is made here.
 *  - No same-Mission ban, no remote-grant broadening, no owner/assignment/
 *    status policy. The shared `/api/shared` surface and the `adminOnly`
 *    Mission-level workflow routes are untouched and out of scope.
 *
 * Absent-Task ordering is proven two ways that do not require manufacturing
 * FK-violating projection rows (gate rows and failure-context rows both
 * cascade from `tasks`, so an "orphan stored projection" cannot exist under
 * enforced FKs): the response message itself is the guard's, and the projection
 * service spy is asserted uncalled. The two ancestry-corruption fixtures
 * (dangling Mission, removed Habitat) are the only abnormal-parent state, each
 * created under the prior PRAGMA state and restored in a `finally`.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import net from "node:net";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as workflowService from "../services/workflowService.js";
import * as failureContextService from "../services/failureContextService.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import {
  agents as agentsTable,
  tasks,
  missions,
  habitats,
  taskWorkflowGates,
  failureContexts,
} from "../db/schema/index.js";
import * as pluginManager from "../plugins/pluginManager.js";

const PREFIXES = ["/api/v1", "/api"] as const;
const MISSING_TASK_ID = "00000000-0000-4000-8000-0000000000d1";
const MISSING_MISSION_ID = "00000000-0000-4000-8000-0000000000d2";

let app: HttpRuntimeHandle;
let baseUrl: string;

let teamAHabitatId: string;
let teamBHabitatId: string;
let personalHabitatId: string;

let assignedAgentKey: string;
let unboundAgentKey: string;
let boundAgentKey: string;
let validRemoteKey: string;

// Read-through observers. Never replaced, never given an implementation: the
// admitted cases assert they ARE reached and the denied/absent cases assert they
// are NOT, which is the ordering proof for the guard.
const gateContextSpy = vi.spyOn(workflowService, "getTaskWorkflowContext");
const failureContextSpy = vi.spyOn(failureContextService, "getFailureContext");

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

/**
 * The real pre-auth rate limiter buckets by credential string at 60/min per
 * prefix scope, and this matrix issues more requests than one bucket holds, so
 * every human credential is minted fresh at each call site. A random `jti` is
 * required: without it two mints in the same second serialize to the SAME token
 * string and therefore the same bucket.
 */
function mint(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, username: userId, role, jti: Math.random().toString(36).slice(2) },
    getJwtSecret(),
    { expiresIn: "1h", issuer: "orcy" },
  );
}

const MEMBER_ADMIN = "tcw-member-admin";
const MEMBER_EDITOR = "tcw-member-editor";
const MEMBER_VIEWER = "tcw-member-viewer";
const TEAM_B_MEMBER = "tcw-team-b-member";
const NONMEMBER_ADMIN = "tcw-nonmember-admin";
const PERSONAL_HUMAN = "tcw-personal-human";

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
}

async function wire(
  prefix: string,
  path: string,
  opts: WireOpts = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["x-agent-api-key"] = opts.agentKey;
  if (opts.remoteKey) headers["x-orcy-remote-key"] = opts.remoteKey;
  const res = await fetch(`${baseUrl}${prefix}${path}`, { method: "GET", headers });
  const text = await res.text();
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, body, text };
}

const gatePath = (taskId: string) => `/tasks/${taskId}/workflow-context`;
const failurePath = (taskId: string) => `/tasks/${taskId}/failure-context`;

// ---- fixtures --------------------------------------------------------------

let columnOrder = 0;

function makeTaskInMission(
  habitatId: string,
  title: string,
): { taskId: string; missionId: string } {
  const column = columnRepo.createColumn({
    habitatId,
    name: `tcw-col-${title}-${++columnOrder}`,
    order: columnOrder,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: `tcw-mission-${title}`,
    createdBy: "tcw-seed",
  });
  return {
    missionId: mission.id,
    taskId: taskRepo.createTask({ missionId: mission.id, title, createdBy: "tcw-seed" }).id,
  };
}

function makeBareTask(habitatId: string, title: string): string {
  return makeTaskInMission(habitatId, title).taskId;
}

/** A Mission holding three Tasks joined by a two-gate DAG, so the middle Task
 * has BOTH nonempty upstream and downstream projections. */
function makeWorkflowFixture(habitatId: string, label: string) {
  const { missionId } = makeTaskInMission(habitatId, `wf-${label}`);
  const up = taskRepo.createTask({ missionId, title: `wf-${label}-up`, createdBy: "tcw-seed" }).id;
  const mid = taskRepo.createTask({
    missionId,
    title: `wf-${label}-mid`,
    createdBy: "tcw-seed",
  }).id;
  const down = taskRepo.createTask({
    missionId,
    title: `wf-${label}-down`,
    createdBy: "tcw-seed",
  }).id;
  const workflowId = workflowService.attachWorkflow(
    missionId,
    habitatId,
    {
      gates: [
        {
          upstreamTaskKey: up,
          downstreamTaskKey: mid,
          gateType: "on_complete",
          matchConfig: { signalType: "experience", subjectContains: `${label}-upstream-marker` },
        },
        { upstreamTaskKey: mid, downstreamTaskKey: down, gateType: "on_approve" },
      ],
    },
    {},
    "tcw-seed",
  );
  const rows = getDb().select().from(taskWorkflowGates).all();
  const upstream = rows.find((r) => r.downstreamTaskId === mid)!;
  const downstream = rows.find((r) => r.upstreamTaskId === mid)!;
  return { workflowId, missionId, up, mid, down, upstream, downstream };
}

function makeFailureFixture(
  habitatId: string,
  label: string,
  opts?: { withExperiencePulse?: boolean },
): { taskId: string; missionId: string; contextId: string } {
  const { missionId, taskId } = makeTaskInMission(habitatId, `fc-${label}`);
  if (opts?.withExperiencePulse) {
    pulseRepo.createPulse({
      habitatId,
      missionId,
      fromType: "agent",
      fromId: "tcw-failing-agent",
      signalType: "experience",
      subject: `stuck on ${label}`,
      taskId,
      metadata: { experience: "stuck", implicit: true, timing: "mid_task" },
    });
  }
  const row = failureContextService.buildFailureContext(taskId, "lifecycle_failed", {
    failureReason: `tcw-reason-${label}`,
  })!;
  return { taskId, missionId, contextId: row.id };
}

/** Durable-state fingerprint used for the "denials mutate nothing" proofs. */
function projectionSnapshot(): string {
  return JSON.stringify(
    JSON.parse(
      JSON.stringify({
        gates: getDb().select().from(taskWorkflowGates).all(),
        contexts: getDb().select().from(failureContexts).all(),
      }),
    ),
  );
}

/** FK-off corrupted-ancestry fixture (the only way to create it), restoring
 * whatever enforcement state preceded it. `PRAGMA foreign_keys` is
 * connection-level, not part of the sql.js snapshot bytes, so the prior state is
 * read back and re-applied explicitly. */
function withFkOff(fn: () => void): void {
  const prior = (getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>)[0]!
    .foreign_keys;
  getDb().run(sql`PRAGMA foreign_keys = OFF`);
  try {
    fn();
  } finally {
    getDb().run(sql.raw(`PRAGMA foreign_keys = ${prior}`));
  }
}

// ---- lifecycle -------------------------------------------------------------

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

  for (const userId of [MEMBER_ADMIN, MEMBER_EDITOR, MEMBER_VIEWER]) {
    teamMemberRepo.addMember({ teamId: teamA.id, userId, role: "member" });
  }
  teamMemberRepo.addMember({ teamId: teamB.id, userId: TEAM_B_MEMBER, role: "member" });

  const anchorA = makeBareTask(teamAHabitatId, "agent-anchor-a");
  const assigned = agentRepo.createAgent({
    name: "tcw-agent-assigned",
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
    name: "tcw-agent-unbound",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  unboundAgentKey = unbound.plainApiKey;

  // Other-Habitat-BOUND agent: currentTaskId points into Team B. Broad local
  // agent admission is existing policy and must survive the guard unchanged.
  const anchorB = makeBareTask(teamBHabitatId, "agent-anchor-b");
  const bound = agentRepo.createAgent({
    name: "tcw-agent-bound",
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

  const pod = remotePodRepo.createRemotePod({ habitatId: teamAHabitatId, name: "tcw-remote-pod" });
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
}, 180_000);

afterAll(async () => {
  await app.close();
  gateContextSpy.mockRestore();
  failureContextSpy.mockRestore();
  closeDb();
});

// ---- admitted actors -------------------------------------------------------

describe("admitted actors get the unchanged envelopes on both contexts, both prefixes", () => {
  it("member roles, personal-Habitat human, and bound/unbound local agents all read the exact raw projections", async () => {
    const cases: Array<[string, WireOpts, string]> = [
      ["team member admin", { token: mint(MEMBER_ADMIN, "admin") }, teamAHabitatId],
      ["team member editor", { token: mint(MEMBER_EDITOR, "editor") }, teamAHabitatId],
      ["team member viewer", { token: mint(MEMBER_VIEWER, "viewer") }, teamAHabitatId],
      ["assigned local agent", { agentKey: assignedAgentKey }, teamAHabitatId],
      ["unbound local agent", { agentKey: unboundAgentKey }, teamAHabitatId],
      ["other-habitat-bound local agent", { agentKey: boundAgentKey }, teamAHabitatId],
      // Any human role on a personal Habitat: no team, no membership required.
      ["personal-habitat human", { token: mint(PERSONAL_HUMAN, "viewer") }, personalHabitatId],
    ];

    for (const [label, opts, habitatId] of cases) {
      const wf = makeWorkflowFixture(habitatId, `admit-${label.replace(/\W+/g, "-")}`);
      const fc = makeFailureFixture(habitatId, `admit-${label.replace(/\W+/g, "-")}`, {
        withExperiencePulse: true,
      });

      for (const prefix of PREFIXES) {
        const gates = await wire(prefix, gatePath(wf.mid), opts);
        expect(gates.status, `${label} ${prefix} workflow-context`).toBe(200);
        // Raw full-row gate projection — no redaction, no status filter.
        expect(gates.body.upstream).toHaveLength(1);
        expect(gates.body.downstream).toHaveLength(1);
        expect(gates.body.upstream[0]).toEqual(wf.upstream);
        expect(gates.body.downstream[0]).toEqual(wf.downstream);
        expect(Object.keys(gates.body.upstream[0]).toSorted()).toEqual([
          "condition",
          "createdAt",
          "downstreamTaskId",
          "gateType",
          "habitatId",
          "id",
          "matchConfig",
          "missionId",
          "recoveryDepth",
          "recoveryTaskId",
          "satisfied",
          "satisfiedAt",
          "satisfiedByEventId",
          "upstreamTaskId",
          "workflowId",
        ]);

        const ctx = await wire(prefix, failurePath(fc.taskId), opts);
        expect(ctx.status, `${label} ${prefix} failure-context`).toBe(200);
        expect(ctx.body.failureContext.failedTaskId).toBe(fc.taskId);
        expect(ctx.body.failureContext.failureKind).toBe("lifecycle_failed");
        expect(ctx.body.failureContext.failureReason).toBe(
          `tcw-reason-admit-${label.replace(/\W+/g, "-")}`,
        );
        expect(ctx.body.failureContext.resolvedAt).toBeNull();
        // The bundle's Experience snapshot field is `createdAt`, never `timestamp`.
        expect(ctx.body.failureContext.bundle.experienceSignals).toHaveLength(1);
        expect(ctx.body.failureContext.bundle.experienceSignals[0].createdAt).toBeTruthy();
        expect(ctx.body.failureContext.bundle.experienceSignals[0].timestamp).toBeUndefined();
      }
    }

    // Mixed valid local key + human JWT: the agent arm is admitted (agent key
    // takes precedence) and the human arm is not the deciding factor.
    const mixed = makeWorkflowFixture(teamAHabitatId, "admit-mixed");
    const mixedRes = await wire("/api/v1", gatePath(mixed.mid), {
      agentKey: assignedAgentKey,
      token: mint(MEMBER_ADMIN, "admin"),
    });
    expect(mixedRes.status).toBe(200);
    expect(mixedRes.body.upstream).toHaveLength(1);
  }, 120_000);

  it("all gate statuses, a detached workflow, a terminal Task, and an archived Mission stay admitted and unfiltered", async () => {
    const wf = makeWorkflowFixture(teamAHabitatId, "statuses");
    // Satisfy the upstream gate directly: the projection must still return it,
    // and a detached workflow's gates must not disappear into an empty result.
    getDb()
      .update(taskWorkflowGates)
      .set({
        satisfied: true,
        satisfiedAt: "2026-01-01T00:00:00.000Z",
        satisfiedByEventId: "tcw-manual-event",
      })
      .where(eq(taskWorkflowGates.id, wf.upstream.id))
      .run();
    workflowService.detachWorkflow(wf.workflowId, "tcw-seed");
    getDb().update(tasks).set({ status: "done" }).where(eq(tasks.id, wf.mid)).run();
    getDb()
      .update(missions)
      .set({ status: "done", isArchived: true })
      .where(eq(missions.id, wf.missionId))
      .run();

    for (const prefix of PREFIXES) {
      const res = await wire(prefix, gatePath(wf.mid), { token: mint(MEMBER_ADMIN, "admin") });
      expect(res.status, `detached+terminal+archived ${prefix}`).toBe(200);
      expect(res.body.upstream).toHaveLength(1);
      expect(res.body.upstream[0].satisfied).toBe(true);
      expect(res.body.upstream[0].satisfiedAt).toBe("2026-01-01T00:00:00.000Z");
      expect(res.body.upstream[0].satisfiedByEventId).toBe("tcw-manual-event");
      expect(res.body.downstream).toHaveLength(1);
      expect(res.body.downstream[0].satisfied).toBe(false);
      expect(res.body.downstream[0].satisfiedAt).toBeNull();
    }
  }, 60_000);
});

// ---- denied actors ---------------------------------------------------------

describe("denied actors are refused before the projection service and mutate nothing", () => {
  it("team nonmember and nonmember global admin get 403 BOARD_ACCESS_DENIED on both contexts, both prefixes, with no row disclosure", async () => {
    const wf = makeWorkflowFixture(teamAHabitatId, "deny");
    const fc = makeFailureFixture(teamAHabitatId, "deny", { withExperiencePulse: true });
    const before = projectionSnapshot();

    for (const prefix of PREFIXES) {
      for (const [label, opts] of [
        ["team-B member", { token: mint(TEAM_B_MEMBER, "viewer") }],
        ["nonmember global admin", { token: mint(NONMEMBER_ADMIN, "admin") }],
      ] as Array<[string, WireOpts]>) {
        const gates = await wire(prefix, gatePath(wf.mid), opts);
        expect(gates.status, `${label} ${prefix} workflow-context`).toBe(403);
        expect(gates.body.code).toBe("BOARD_ACCESS_DENIED");
        expect(gates.text).not.toContain(wf.workflowId);
        expect(gates.text).not.toContain(wf.up);
        expect(gates.text).not.toContain(wf.down);

        const ctx = await wire(prefix, failurePath(fc.taskId), opts);
        expect(ctx.status, `${label} ${prefix} failure-context`).toBe(403);
        expect(ctx.body.code).toBe("BOARD_ACCESS_DENIED");
        expect(ctx.text).not.toContain("tcw-reason-deny");
        expect(ctx.text).not.toContain(fc.contextId);
      }
    }

    expect(projectionSnapshot()).toEqual(before);
  }, 120_000);

  it("anonymous, invalid local key, valid remote-only, and invalid-local-plus-valid-JWT are 401 before the guard", async () => {
    const wf = makeWorkflowFixture(teamAHabitatId, "unauth");
    const fc = makeFailureFixture(teamAHabitatId, "unauth");

    for (const prefix of PREFIXES) {
      for (const [label, opts] of [
        ["anonymous", {}],
        ["invalid local key", { agentKey: "not-a-key" }],
        ["valid remote-only", { remoteKey: validRemoteKey }],
        [
          "invalid local key + valid JWT",
          { agentKey: "not-a-key", token: mint(MEMBER_ADMIN, "admin") },
        ],
      ] as Array<[string, WireOpts]>) {
        const gates = await wire(prefix, gatePath(wf.mid), opts);
        expect(gates.status, `${label} ${prefix} workflow-context`).toBe(401);
        const ctx = await wire(prefix, failurePath(fc.taskId), opts);
        expect(ctx.status, `${label} ${prefix} failure-context`).toBe(401);
      }
    }
  }, 60_000);
});

// ---- ancestry 404 and ordering --------------------------------------------

describe("ancestry is resolved before the projection, and the existing projection 404s survive admission", () => {
  it("absent Task is the guard's own 404 and the projection service is never reached", async () => {
    // Positive control first: the spies are read-through observers that MUST be
    // seen moving on an admitted read, otherwise the "not reached" assertions
    // below would be vacuous.
    const admittedGates = makeWorkflowFixture(teamAHabitatId, "spy-positive-control");
    const admittedCtx = makeFailureFixture(teamAHabitatId, "spy-positive-control");
    const gatesMark = gateContextSpy.mock.calls.length;
    const ctxMark = failureContextSpy.mock.calls.length;
    expect((await wire("/api/v1", gatePath(admittedGates.mid), { token: mint(MEMBER_ADMIN, "admin") })).status).toBe(200);
    expect((await wire("/api/v1", failurePath(admittedCtx.taskId), { token: mint(MEMBER_ADMIN, "admin") })).status).toBe(200);
    expect(gateContextSpy.mock.calls.length, "gate spy must observe the admitted read").toBe(gatesMark + 1);
    expect(failureContextSpy.mock.calls.length, "failure spy must observe the admitted read").toBe(ctxMark + 1);

    for (const prefix of PREFIXES) {
      const gatesBefore = gateContextSpy.mock.calls.length;
      const ctxBefore = failureContextSpy.mock.calls.length;

      const gates = await wire(prefix, gatePath(MISSING_TASK_ID), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(gates.status, `absent task ${prefix} workflow-context`).toBe(404);
      expect(gates.body.error).toMatch(/task not found/i);
      expect(gates.text).not.toMatch(/not part of any workflow/i);

      const ctx = await wire(prefix, failurePath(MISSING_TASK_ID), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(ctx.status, `absent task ${prefix} failure-context`).toBe(404);
      expect(ctx.body.error).toMatch(/task not found/i);
      expect(ctx.text).not.toMatch(/no failure context found/i);

      expect(gateContextSpy.mock.calls.length).toBe(gatesBefore);
      expect(failureContextSpy.mock.calls.length).toBe(ctxBefore);
    }
  }, 60_000);

  it("a Task with a dangling Mission, and a Task whose Habitat row is gone, are 404 on both contexts", async () => {
    const brokenMissionTask = makeBareTask(teamAHabitatId, "broken-mission");

    // A DEDICATED personal habitat (admits any valid human, so admission would
    // pass if the row existed) removed under FK-off — the only way to leave a
    // dangling habitatId, because cascades remove it normally.
    const orphanHabitat = habitatRepo.createHabitat({ name: "tcw-orphan-habitat" }).id;
    const brokenHabitatTask = makeBareTask(orphanHabitat, "broken-habitat");

    withFkOff(() => {
      getDb()
        .update(tasks)
        .set({ missionId: MISSING_MISSION_ID })
        .where(eq(tasks.id, brokenMissionTask))
        .run();
      getDb().delete(habitats).where(eq(habitats.id, orphanHabitat)).run();
    });

    for (const prefix of PREFIXES) {
      const [missionCase, habitatCase] = [
        ["missing Mission", brokenMissionTask, /mission not found/i],
        ["missing Habitat", brokenHabitatTask, /habitat not found/i],
      ] as const;
      for (const [label, taskId, re] of [missionCase, habitatCase] as const) {
        const gates = await wire(prefix, gatePath(taskId), { token: mint(MEMBER_ADMIN, "admin") });
        expect(gates.status, `${label} ${prefix} workflow-context`).toBe(404);
        expect(gates.body.error).toMatch(re);
        const ctx = await wire(prefix, failurePath(taskId), { token: mint(MEMBER_ADMIN, "admin") });
        expect(ctx.status, `${label} ${prefix} failure-context`).toBe(404);
        expect(ctx.body.error).toMatch(re);
      }
    }
  }, 60_000);

  it("an admitted Task with no projection keeps the pre-existing 404 wording on both contexts", async () => {
    const emptyTask = makeBareTask(teamAHabitatId, "empty-projection");

    for (const prefix of PREFIXES) {
      const gates = await wire(prefix, gatePath(emptyTask), { token: mint(MEMBER_ADMIN, "admin") });
      expect(gates.status, `no gates ${prefix}`).toBe(404);
      expect(gates.body.error).toMatch(/not part of any workflow/i);

      const ctx = await wire(prefix, failurePath(emptyTask), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(ctx.status, `no context ${prefix}`).toBe(404);
      expect(ctx.body.error).toMatch(/no failure context found/i);
    }
  }, 60_000);
});

// ---- failed-ID semantics ---------------------------------------------------

describe("Failure Context lookup stays failed-Task-ID keyed, latest unresolved, with no reverse resolution", () => {
  it("the newest unresolved row wins; a resolved newer row is skipped in favour of the older unresolved one", async () => {
    const fc = makeFailureFixture(teamAHabitatId, "latest");

    // Second, newer unresolved row for the same failedTaskId.
    const newer = failureContextService.buildFailureContext(fc.taskId, "lifecycle_rejected", {
      failureReason: "tcw-reason-newer",
    })!;
    getDb()
      .update(failureContexts)
      .set({ failedAt: "2026-02-02T00:00:00.000Z" })
      .where(eq(failureContexts.id, newer.id))
      .run();
    getDb()
      .update(failureContexts)
      .set({ failedAt: "2026-01-01T00:00:00.000Z" })
      .where(eq(failureContexts.id, fc.contextId))
      .run();

    for (const prefix of PREFIXES) {
      const latest = await wire(prefix, failurePath(fc.taskId), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(latest.status, `newest unresolved ${prefix}`).toBe(200);
      expect(latest.body.failureContext.id).toBe(newer.id);
      expect(latest.body.failureContext.failureReason).toBe("tcw-reason-newer");
    }

    // Resolving the newest row must fall back to the older UNRESOLVED one, not
    // to the resolved row and not to an empty result.
    failureContextService.resolveFailureContext(newer.id, "superseded");
    for (const prefix of PREFIXES) {
      const fallback = await wire(prefix, failurePath(fc.taskId), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(fallback.status, `resolved-newer fallback ${prefix}`).toBe(200);
      expect(fallback.body.failureContext.id).toBe(fc.contextId);
      expect(fallback.body.failureContext.failureReason).toBe(`tcw-reason-latest`);
    }
  }, 60_000);

  it("a linked Recovery Task has no reverse lookup: it has no own context, and the original failed Task still resolves", async () => {
    const fc = makeFailureFixture(teamAHabitatId, "recovery");
    // A normal Task in the same Mission standing in for a spawned Recovery Task,
    // linked through the denormalized `recoveryTaskId` convenience field.
    const recoveryTask = makeBareTask(teamAHabitatId, "recovery-task");
    failureContextService.linkRecoveryTask(fc.contextId, recoveryTask);

    for (const prefix of PREFIXES) {
      // The Recovery Task ID must NOT resolve the original failure.
      const byRecovery = await wire(prefix, failurePath(recoveryTask), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(byRecovery.status, `recovery-task-id ${prefix}`).toBe(404);
      expect(byRecovery.body.error).toMatch(/no failure context found/i);

      // The failed Task ID still resolves its own context.
      const byFailed = await wire(prefix, failurePath(fc.taskId), {
        token: mint(MEMBER_ADMIN, "admin"),
      });
      expect(byFailed.status, `failed-task-id ${prefix}`).toBe(200);
      expect(byFailed.body.failureContext.id).toBe(fc.contextId);
      expect(byFailed.body.failureContext.recoveryTaskId).toBe(recoveryTask);
    }
  }, 60_000);
});
