/**
 * Six Task admission operations — REAL HTTP wire matrix on BOTH served
 * prefixes (`/api/v1`, deprecated `/api`).
 *
 * The six operations all resolve the TARGET Task's actual ancestry
 * (Task -> Mission -> Habitat) and enforce the shared membership predicate
 * BEFORE any mutation, own-pair read, or adjunct row query:
 *
 *   1. PUT    /tasks/:id/estimate          (local_actor)
 *   2. POST   /tasks/:id/watch             (human)  — admission OUTSIDE the try
 *   3. DELETE /tasks/:id/watch             (human)
 *   4. GET    /tasks/:id/watchers          (human)
 *   5. GET    /tasks/:id/pull-requests     (human)
 *   6. GET    /tasks/:id/pipeline-events   (human)
 *
 * Scope of claims (author evidence, not universal Task isolation):
 *  - Intended deltas: team-nonmember humans (INCLUDING global admins) get
 *    403 BOARD_ACCESS_DENIED on all six (previously all six admitted any
 *    authenticated local actor by known ID); authenticated missing Task is
 *    404 on all six.
 *  - DISCLOSED deliberate delta on the two adjunct reads: a missing Task
 *    used to answer 200 with an empty array; it now answers 404 Task not
 *    found. An EXISTING Task with no rows still answers 200 with `[]`.
 *  - DISCLOSED deliberate delta on unwatch: the missing-Task 404 wording
 *    changes from `Not watching this task` (absent own pair) to
 *    `Task not found` (ancestry resolved first). An absent own pair on an
 *    EXISTING, admitted Task still answers `Not watching this task`.
 *  - Preserved: every authPolicy id; local agents keep broad existing-Habitat
 *    admission on estimate; any authenticated human keeps personal-Habitat
 *    admission; JWT-derived watcher identity; own-pair-only DELETE; duplicate
 *    watch 201; the POST catch's downstream error mapping; empty arrays for
 *    existing Tasks; human-only routes stay JWT-only.
 *  - Admission is REQUEST-TIME only. It claims no membership-revocation
 *    fence, no statement-time ancestry join, no Task/Mission reparent or
 *    ABA protection, no optimistic CAS, and no atomicity between the
 *    admission read and the final write.
 *
 * No admission mocks: every request crosses a real TCP socket into the real
 * production application with a real JWT or real agent key. Spies are used
 * only to prove that a downstream repository call was NOT reached on a
 * denial; they never replace the admission decision.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import net from "node:net";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskCrudRepo from "../repositories/taskCrud.js";
import * as taskHubRepo from "../repositories/task.js";
import * as watcherRepo from "../repositories/watcher.js";
import * as watcherService from "../services/watcherService.js";
import * as prRepo from "../repositories/pullRequest.js";
import * as pipelineRepo from "../repositories/pipelineEvent.js";
import * as agentRepo from "../repositories/agent.js";
import * as organizationRepo from "../repositories/organization.js";
import * as teamRepo from "../repositories/team.js";
import * as teamMemberRepo from "../repositories/teamMember.js";
import * as userRepo from "../repositories/user.js";
import * as remotePodRepo from "../repositories/remotePod.js";
import * as remoteParticipantRepo from "../repositories/remoteParticipant.js";
import * as remoteCredentialService from "../services/remoteCredentialService.js";
import {
  tasks,
  taskEvents,
  taskWatchers,
  missions,
  pullRequests,
  pipelineEvents,
} from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";
import * as pluginManager from "../plugins/pluginManager.js";

const PREFIXES = ["/api/v1", "/api"] as const;

let app: HttpRuntimeHandle;
let baseUrl: string;

let teamId: string;
let otherTeamId: string;
let teamHabitatId: string;
let personalHabitatId: string;
let agentKey: string;
let boundAgentKey: string;
let validRemoteKey: string;

let memberOwnerJwt: string;
let editorJwt: string;
let memberAdminJwt: string;
let memberViewerJwt: string;
let nonmemberAdminJwt: string;
let otherTeamMemberJwt: string;

// Targets.
let teamTaskId: string;
let emptyTeamTaskId: string;
let personalTaskId: string;
let archivedTaskId: string;
let archivedMissionId: string;

/** The exact six shapes, parameterized so the matrix is not a Cartesian explosion. */
type Op = {
  name: string;
  method: string;
  path: (taskId: string) => string;
  body?: unknown;
  /**
   * The repository seam whose non-reach proves admission ran first. Spied
   * through the live module namespace, never mocked into the route.
   */
  seam: { obj: object; key: string };
  /** Success status for an admitted member. */
  okStatus: number;
  /** Whether the operation mutates Task/watcher state on success. */
  mutates: boolean;
};

const OPS: Op[] = [
  {
    name: "PUT estimate",
    method: "PUT",
    path: (id) => `/tasks/${id}/estimate`,
    body: { estimatedMinutes: 45 },
    seam: { obj: taskHubRepo, key: "updateTask" },
    okStatus: 200,
    mutates: true,
  },
  {
    name: "POST watch",
    method: "POST",
    path: (id) => `/tasks/${id}/watch`,
    body: {},
    seam: { obj: watcherService, key: "watchTask" },
    okStatus: 201,
    mutates: true,
  },
  {
    name: "DELETE watch",
    method: "DELETE",
    path: (id) => `/tasks/${id}/watch`,
    seam: { obj: watcherRepo, key: "removeWatcher" },
    okStatus: 204,
    mutates: true,
  },
  {
    name: "GET watchers",
    method: "GET",
    path: (id) => `/tasks/${id}/watchers`,
    seam: { obj: watcherRepo, key: "getWatchersForTask" },
    okStatus: 200,
    mutates: false,
  },
  {
    name: "GET pull-requests",
    method: "GET",
    path: (id) => `/tasks/${id}/pull-requests`,
    seam: { obj: prRepo, key: "getByTaskId" },
    okStatus: 200,
    mutates: false,
  },
  {
    name: "GET pipeline-events",
    method: "GET",
    path: (id) => `/tasks/${id}/pipeline-events`,
    seam: { obj: pipelineRepo, key: "getByTaskId" },
    okStatus: 200,
    mutates: false,
  },
];

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
 * Every mint carries a unique `jti`, so each call yields a DISTINCT token
 * string. This matters because the installed per-agent rate-limit preHandler
 * keys on the raw `Authorization` header and is scope-level, so it runs BEFORE
 * the route's authentication preHandler — `request.user` is still unset when
 * `getLimit` reads it and every caller therefore gets the 60/min agent ceiling.
 * Re-minting per test keeps each test's bucket independent. Reusing one module
 * -level token across ~20 tests exhausts that shared bucket and manufactures
 * spurious 429s that have nothing to do with the behaviour under test.
 */
let mintCounter = 0;
function mint(userId: string, role: string): string {
  return jwt.sign(
    { sub: userId, username: `soa-${userId}`, role, jti: `m${++mintCounter}` },
    getJwtSecret(),
    { expiresIn: "1h", issuer: "orcy" },
  );
}

interface WireOpts {
  token?: string;
  agentKey?: string;
  remoteKey?: string;
  body?: unknown;
  /** Extra headers; used for the mixed-header controls. */
  extraHeaders?: Record<string, string>;
}

async function wire(
  prefix: string,
  method: string,
  path: string,
  opts: WireOpts = {},
): Promise<{ status: number; body: any; text: string }> {
  const headers: Record<string, string> = { ...opts.extraHeaders };
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
function makeTask(habitatId: string, title: string, createdBy = "soa-seed"): string {
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
  return taskCrudRepo.createTask({ missionId: mission.id, title, createdBy }).id;
}

// ---- live-DB state probes ---------------------------------------------------
function taskRow(taskId: string) {
  return JSON.parse(JSON.stringify(getDb().select().from(tasks).where(eq(tasks.id, taskId)).get()));
}
function watcherRows(taskId: string) {
  return JSON.parse(
    JSON.stringify(
      getDb()
        .select()
        .from(taskWatchers)
        .where(eq(taskWatchers.taskId, taskId))
        .orderBy(taskWatchers.createdAt)
        .all(),
    ),
  );
}
function eventRows(taskId: string) {
  return JSON.parse(
    JSON.stringify(getDb().select().from(taskEvents).where(eq(taskEvents.taskId, taskId)).all()),
  );
}
function prRows(taskId: string) {
  return JSON.parse(
    JSON.stringify(
      getDb().select().from(pullRequests).where(eq(pullRequests.taskId, taskId)).all(),
    ),
  );
}
function pipelineRows(taskId: string) {
  return JSON.parse(
    JSON.stringify(
      getDb().select().from(pipelineEvents).where(eq(pipelineEvents.taskId, taskId)).all(),
    ),
  );
}
/**
 * Full state snapshot of every surface the six operations could touch. A
 * denial must leave ALL of it byte-identical — this is the no-effect proof
 * that does not depend on any spy.
 */
function fullStateSnapshot(taskId: string) {
  const t = taskRow(taskId);
  return {
    task: t,
    estimatedMinutes: t?.estimatedMinutes ?? null,
    version: t?.version ?? null,
    updatedAt: t?.updatedAt ?? null,
    watchers: watcherRows(taskId),
    events: eventRows(taskId),
    pullRequests: prRows(taskId),
    pipelineEvents: pipelineRows(taskId),
  };
}
function setFk(on: boolean): void {
  getDb().run(on ? sql`PRAGMA foreign_keys = ON` : sql`PRAGMA foreign_keys = OFF`);
  const pragma = getDb().all(sql`PRAGMA foreign_keys`) as Array<{ foreign_keys: number }>;
  expect(pragma[0]!.foreign_keys).toBe(on ? 1 : 0);
}

beforeAll(async () => {
  await initTestDb();
  // Normal fixtures run with FK ON (asserted by read-back); only the corrupt
  // ancestry fixtures disable it, each in a finally-protected block.
  setFk(true);
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;

  const org = organizationRepo.createOrganization({
    name: "soa-org",
    slug: `soa-org-${Date.now()}`,
  });
  teamId = teamRepo.createTeam({
    organizationId: org.id,
    name: "soa-team",
    slug: `soa-team-${Date.now()}`,
  }).id;
  otherTeamId = teamRepo.createTeam({
    organizationId: org.id,
    name: "soa-other-team",
    slug: `soa-other-${Date.now()}`,
  }).id;
  teamHabitatId = habitatRepo.createHabitat({ name: "soa-team-habitat", teamId }).id;
  personalHabitatId = habitatRepo.createHabitat({ name: "soa-personal-habitat" }).id;

  // Real user rows: team_members.user_id references users.id, so members must
  // exist before membership fixtures under FK ON.
  const userNow = new Date().toISOString();
  for (const [userId, role] of [
    ["soa-member-owner", "viewer"],
    ["soa-member-admin", "admin"],
    ["soa-member-viewer", "viewer"],
    ["soa-member-editor", "editor"],
    ["soa-nonmember-admin", "admin"],
    ["soa-nonmember-viewer", "viewer"],
    ["soa-otherteam-member", "viewer"],
    ["soa-personal-admin", "admin"],
  ] as const) {
    userRepo.createUser({
      id: userId,
      username: `soa-${userId}`,
      passwordHash: "soa-unused-hash",
      role,
      createdAt: userNow,
      updatedAt: userNow,
    });
  }
  teamMemberRepo.addMember({ teamId, userId: "soa-member-owner", role: "owner" });
  teamMemberRepo.addMember({ teamId, userId: "soa-member-admin", role: "member" });
  teamMemberRepo.addMember({ teamId, userId: "soa-member-viewer", role: "member" });
  teamMemberRepo.addMember({ teamId, userId: "soa-member-editor", role: "member" });
  // Membership in a DIFFERENT team must not count for the team Habitat.
  teamMemberRepo.addMember({ teamId: otherTeamId, userId: "soa-otherteam-member", role: "owner" });
  expect(teamMemberRepo.listMembers(teamId).length).toBe(4);

  const created = agentRepo.createAgent({
    name: "soa-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  agentKey = created.plainApiKey;

  // Second agent BOUND to a personal-habitat task: proves binding elsewhere
  // changes nothing for the TEAM-habitat operation.
  const bound = agentRepo.createAgent({
    name: "soa-bound-agent",
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  boundAgentKey = bound.plainApiKey;
  agentRepo.heartbeat(bound.agent.id, makeTask(personalHabitatId, "soa-bound-anchor"));

  // Fully VALID remote credential: still 401 on these local policies.
  const pod = remotePodRepo.createRemotePod({ habitatId: teamHabitatId, name: "soa-remote-pod" });
  remotePodRepo.activateRemotePod(pod.id);
  const participant = remoteParticipantRepo.createRemoteParticipant({
    remotePodId: pod.id,
    habitatId: teamHabitatId,
    participantType: "remote_orcy",
    displayName: "soa-remote-orcy",
  });
  remoteParticipantRepo.activateRemoteParticipant(participant.id);
  validRemoteKey = remoteCredentialService.createCredentialWithSecret({
    remoteParticipantId: participant.id,
    habitatId: teamHabitatId,
    credentialType: "api",
    label: "soa-remote-cred",
  }).plaintextSecret;

  // Populated team Task: nonempty PR / pipeline / watcher rows.
  teamTaskId = makeTask(teamHabitatId, "soa-team-task");
  // getByTaskId orders createdAt DESC (repositories/pullRequest.ts:73-81), so the
  // NEWER row (PR 7) must come back first. Direct inserts with explicit timestamps:
  // createPullRequest stamps repo-side `now` and cannot carry a fixture timestamp
  // (same style as the watcher fixtures below). The two timestamps are 24h apart, so
  // no environment can tie-break their order.
  getDb()
    .insert(pullRequests)
    .values({
      id: crypto.randomUUID(),
      taskId: teamTaskId,
      provider: "github",
      repo: "acme/widgets",
      prNumber: 41,
      prTitle: "soa pr one",
      prUrl: "https://github.example/acme/widgets/pull/41",
      branchName: "soa/branch-1",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  getDb()
    .insert(pullRequests)
    .values({
      id: crypto.randomUUID(),
      taskId: teamTaskId,
      provider: "gitlab",
      repo: "acme/gadgets",
      prNumber: 7,
      prTitle: "soa pr two",
      prUrl: "https://gitlab.example/acme/gadgets/-/merge_requests/7",
      state: "merged",
      createdAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    })
    .run();
  pipelineRepo.createPipelineEvent({
    taskId: teamTaskId,
    provider: "github",
    repo: "acme/widgets",
    runId: "9001",
    status: "success",
    branch: "soa/branch-1",
    commitSha: "a".repeat(40),
  });
  pipelineRepo.createPipelineEvent({
    taskId: teamTaskId,
    provider: "gitlab",
    repo: "acme/gadgets",
    runId: "9002",
    status: "failure",
    branch: "soa/branch-2",
  });
  // Two watchers with DISTINCT createdAt so the ascending order is provable.
  getDb()
    .insert(taskWatchers)
    .values({
      taskId: teamTaskId,
      userId: "soa-member-viewer",
      createdAt: "2026-01-01T00:00:00.000Z",
    })
    .run();
  getDb()
    .insert(taskWatchers)
    .values({
      taskId: teamTaskId,
      userId: "soa-member-admin",
      createdAt: "2026-01-02T00:00:00.000Z",
    })
    .run();
  // Own watcher row for the DELETE success path.
  getDb()
    .insert(taskWatchers)
    .values({
      taskId: teamTaskId,
      userId: "soa-member-owner",
      createdAt: "2026-01-03T00:00:00.000Z",
    })
    .run();
  taskCrudRepo.updateTask(teamTaskId, { estimatedMinutes: 30 });

  // Existing Task with NO adjunct rows: the empty-projection control.
  emptyTeamTaskId = makeTask(teamHabitatId, "soa-empty-task");
  personalTaskId = makeTask(personalHabitatId, "soa-personal-task");

  // Task inside an ARCHIVED Mission: existing read/write semantics preserved.
  archivedMissionId = missionRepo.createMission({
    habitatId: teamHabitatId,
    columnId: columnRepo.createColumn({
      habitatId: teamHabitatId,
      name: "col-archived",
      order: 900,
      requiresClaim: false,
    }).id,
    title: "soa-archived-mission",
    createdBy: "soa-seed",
  }).id;
  archivedTaskId = taskCrudRepo.createTask({
    missionId: archivedMissionId,
    title: "soa-archived-task",
    createdBy: "soa-seed",
  }).id;
  missionRepo.updateMission(archivedMissionId, { isArchived: true });
}, 120_000);

afterAll(async () => {
  await app.close();
  closeDb();
});

/** Fresh tokens per test, so no test exhausts a shared rate-limit bucket. */
function freshTokens() {
  memberOwnerJwt = mint("soa-member-owner", "viewer");
  memberAdminJwt = mint("soa-member-admin", "admin");
  memberViewerJwt = mint("soa-member-viewer", "viewer");
  nonmemberAdminJwt = mint("soa-nonmember-admin", "admin");
  otherTeamMemberJwt = mint("soa-otherteam-member", "viewer");
  editorJwt = mint("soa-member-editor", "editor");
}

// Minted here, not at module scope and not in `beforeAll`: the rate-limit
// bucket is keyed on the Authorization header, and every caller's ceiling is
// the 60/min agent default (the scope-level preHandler runs before
// authentication, so `request.user` is unset when `getLimit` reads it). A
// per-test mint keeps each test's bucket its own.
beforeEach(() => {
  freshTokens();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("six Task admission operations — member success matrix (both prefixes)", () => {
  it("admits every member shape on every operation with unchanged envelopes, row order and own-watch state", async () => {
    for (const prefix of PREFIXES) {
      for (const token of [memberOwnerJwt, memberAdminJwt, memberViewerJwt]) {
        // Populated reads first: exact rows, descending createdAt for PR and
        // pipeline, ascending createdAt for watchers, own-watch boolean.
        const prs = await wire(prefix, "GET", `/tasks/${teamTaskId}/pull-requests`, { token });
        expect(prs.status).toBe(200);
        expect(Array.isArray(prs.body.pullRequests)).toBe(true);
        expect(prs.body.pullRequests).toHaveLength(2);
        // createdAt DESC: newer PR 7 first, older PR 41 second.
        expect(prs.body.pullRequests[0].prNumber).toBe(7);
        expect(prs.body.pullRequests[1].prNumber).toBe(41);

        const pipelines = await wire(prefix, "GET", `/tasks/${teamTaskId}/pipeline-events`, {
          token,
        });
        expect(pipelines.status).toBe(200);
        expect(pipelines.body.pipelineEvents).toHaveLength(2);

        const watchers = await wire(prefix, "GET", `/tasks/${teamTaskId}/watchers`, { token });
        expect(watchers.status).toBe(200);
        expect(watchers.body.watchers).toHaveLength(3);
        // Ascending createdAt is the repository's contract; assert the order.
        expect(watchers.body.watchers.map((w: any) => w.userId)).toEqual([
          "soa-member-viewer",
          "soa-member-admin",
          "soa-member-owner",
        ]);
        // Own-watch boolean is derived from the AUTHENTICATED user only.
        // All three tokens here are seeded watchers, so this asserts the
        // boolean tracks the caller rather than being unconditionally true.
        expect(watchers.body.isWatching).toBe(true);
        const others = watchers.body.watchers.filter(
          (w: any) => w.userId !== "soa-member-owner" && w.userId !== "soa-member-admin",
        );
        expect(others).toHaveLength(1);
        expect(watchers.body.watchers[0].taskId).toBe(teamTaskId);
        expect(typeof watchers.body.watchers[0].createdAt).toBe("string");
      }
    }
  });

  it("existing Task with no adjunct rows keeps 200 empty arrays and isWatching false", async () => {
    for (const prefix of PREFIXES) {
      const prs = await wire(prefix, "GET", `/tasks/${emptyTeamTaskId}/pull-requests`, {
        token: memberAdminJwt,
      });
      expect(prs.status).toBe(200);
      expect(prs.body.pullRequests).toEqual([]);

      const pipelines = await wire(prefix, "GET", `/tasks/${emptyTeamTaskId}/pipeline-events`, {
        token: memberAdminJwt,
      });
      expect(pipelines.status).toBe(200);
      expect(pipelines.body.pipelineEvents).toEqual([]);

      const watchers = await wire(prefix, "GET", `/tasks/${emptyTeamTaskId}/watchers`, {
        token: memberAdminJwt,
      });
      expect(watchers.status).toBe(200);
      expect(watchers.body.watchers).toEqual([]);
      expect(watchers.body.isWatching).toBe(false);
    }
  });

  it("estimate, watch and unwatch succeed for members; duplicate watch stays 201 and other users' rows survive", async () => {
    for (const prefix of PREFIXES) {
      const est = await wire(prefix, "PUT", `/tasks/${teamTaskId}/estimate`, {
        token: memberAdminJwt,
        body: { estimatedMinutes: 45 },
      });
      expect(est.status).toBe(200);
      expect(est.body.task.estimatedMinutes).toBe(45);
      expect(est.body.task.id).toBe(teamTaskId);

      const watch = await wire(prefix, "POST", `/tasks/${emptyTeamTaskId}/watch`, {
        token: memberAdminJwt,
        body: {},
      });
      expect(watch.status).toBe(201);
      expect(watch.body.watcher.taskId).toBe(emptyTeamTaskId);
      expect(watch.body.watcher.userId).toBe("soa-member-admin");

      // Duplicate POST: still 201, exactly ONE row persisted.
      const dup = await wire(prefix, "POST", `/tasks/${emptyTeamTaskId}/watch`, {
        token: memberAdminJwt,
        body: {},
      });
      expect(dup.status).toBe(201);
      const afterDup = watcherRows(emptyTeamTaskId);
      expect(afterDup.filter((w: any) => w.userId === "soa-member-admin")).toHaveLength(1);

      // Absent own pair on an existing admitted Task: the PRESERVED 404.
      const noPair = await wire(prefix, "DELETE", `/tasks/${emptyTeamTaskId}/watch`, {
        token: memberViewerJwt,
      });
      expect(noPair.status).toBe(404);
      expect(noPair.body.error).toBe("Not watching this task");

      // Own pair removed; OTHER users' rows untouched. The pair is re-seeded at
      // the top of each prefix iteration because DELETE is destructive and not
      // idempotent — without this the second prefix would find no own pair and
      // answer the preserved 404 instead of 204.
      getDb()
        .insert(taskWatchers)
        .values({
          taskId: teamTaskId,
          userId: "soa-member-owner",
          createdAt: "2026-01-03T00:00:00.000Z",
        })
        .onConflictDoNothing()
        .run();
      // Counted AFTER the re-seed, so the post-delete delta is exactly one.
      const beforeOthers = watcherRows(teamTaskId).length;
      const unwatch = await wire(prefix, "DELETE", `/tasks/${teamTaskId}/watch`, {
        token: memberOwnerJwt,
      });
      expect(unwatch.status, `unwatch @ ${prefix}`).toBe(204);
      expect(unwatch.text).toBe("");
      const after = watcherRows(teamTaskId);
      expect(after).toHaveLength(beforeOthers - 1);
      expect(after.some((w: any) => w.userId === "soa-member-owner")).toBe(false);
      expect(after.some((w: any) => w.userId === "soa-member-viewer")).toBe(true);
      expect(after.some((w: any) => w.userId === "soa-member-admin")).toBe(true);
    }
  });

  it("local agents keep broad existing-Habitat admission on estimate", async () => {
    for (const prefix of PREFIXES) {
      for (const key of [agentKey, boundAgentKey]) {
        const est = await wire(prefix, "PUT", `/tasks/${teamTaskId}/estimate`, {
          agentKey: key,
          body: { estimatedMinutes: 60 },
        });
        expect(est.status).toBe(200);
        expect(est.body.task.estimatedMinutes).toBe(60);
      }
      // Personal Habitat: the agent predicate is Habitat-existence only.
      const personal = await wire(prefix, "PUT", `/tasks/${personalTaskId}/estimate`, {
        agentKey: agentKey,
        body: { estimatedMinutes: 15 },
      });
      expect(personal.status).toBe(200);
    }
  });

  it("personal Habitat admits any authenticated human on all six operations", async () => {
    for (const prefix of PREFIXES) {
      for (const op of OPS) {
        const res = await wire(prefix, op.method, op.path(personalTaskId), {
          token: nonmemberAdminJwt,
          body: op.body,
        });
        expect(res.status, `${op.name} on personal habitat`).toBe(op.okStatus);
      }
    }
  });

  it("archived Mission: existing read and write semantics preserved (no new archive rule)", async () => {
    for (const prefix of PREFIXES) {
      const est = await wire(prefix, "PUT", `/tasks/${archivedTaskId}/estimate`, {
        token: memberAdminJwt,
        body: { estimatedMinutes: 20 },
      });
      expect(est.status).toBe(200);

      const prs = await wire(prefix, "GET", `/tasks/${archivedTaskId}/pull-requests`, {
        token: memberAdminJwt,
      });
      expect(prs.status).toBe(200);
      expect(prs.body.pullRequests).toEqual([]);

      const watch = await wire(prefix, "POST", `/tasks/${archivedTaskId}/watch`, {
        token: memberAdminJwt,
        body: {},
      });
      expect(watch.status).toBe(201);
    }
  });
});

describe("six Task admission operations — nonmember denial (both prefixes)", () => {
  // Resolved INSIDE each test, not at describe-collection time: the tokens are
  // minted per test in `beforeEach`, so capturing them into a module- or
  // describe-scoped array would capture `undefined` and every request would
  // silently go out unauthenticated (401 instead of the 403 under test).
  const DENIED_CASES: Array<[string, () => string]> = [
    ["team nonmember global admin", () => nonmemberAdminJwt],
    ["member of a different team", () => otherTeamMemberJwt],
  ];

  for (const [label, getToken] of DENIED_CASES) {
    it(`${label} gets 403 BOARD_ACCESS_DENIED on all six operations with byte-identical state and no downstream seam reached`, async () => {
      const token = getToken();
      const before = fullStateSnapshot(teamTaskId);
      // Nonempty denominators asserted BEFORE the snapshot is relied upon.
      expect(before.watchers.length).toBeGreaterThanOrEqual(2);
      expect(before.pullRequests.length).toBeGreaterThanOrEqual(2);
      expect(before.pipelineEvents.length).toBeGreaterThanOrEqual(2);
      expect(before.estimatedMinutes).not.toBeNull();

      for (const prefix of PREFIXES) {
        for (const op of OPS) {
          const seamSpy = vi.spyOn(
            op.seam.obj as Record<string, (...args: never[]) => unknown>,
            op.seam.key,
          );

          const res = await wire(prefix, op.method, op.path(teamTaskId), {
            token,
            body: op.body,
          });

          const label2 = `${op.name} @ ${prefix} for ${label}: ${res.status} ${res.text}`;
          expect(res.status, label2).toBe(403);
          expect(res.body.code, label2).toBe("BOARD_ACCESS_DENIED");

          // The downstream query/mutation seam was never reached.
          expect(seamSpy, `${op.name} seam should not be reached`).not.toHaveBeenCalled();
          seamSpy.mockRestore();
        }
      }

      // No-effect proof independent of any spy.
      expect(fullStateSnapshot(teamTaskId)).toEqual(before);
    });
  }

  it("denial precedes input validation: a nonmember with an invalid estimate body is 403, never 400", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "PUT", `/tasks/${teamTaskId}/estimate`, {
        token: nonmemberAdminJwt,
        body: { estimatedMinutes: -5 },
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
    }
  });

  it("denial precedes the unwatch pair read: a nonmember without an own pair is 403, never the 404", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "DELETE", `/tasks/${emptyTeamTaskId}/watch`, {
        token: nonmemberAdminJwt,
      });
      expect(res.status).toBe(403);
      expect(res.body.code).toBe("BOARD_ACCESS_DENIED");
    }
  });

  it("body and query spoofing grants no authority: a denied caller cannot reach a Task or Habitat it names", async () => {
    for (const prefix of PREFIXES) {
      // The caller is a nonmember of the team Habitat but a member of
      // `otherTeamId`; naming that Habitat in the body changes nothing.
      const spoofed = await wire(prefix, "POST", `/tasks/${teamTaskId}/watch`, {
        token: otherTeamMemberJwt,
        body: { userId: "soa-member-admin", habitatId: otherTeamId, taskId: personalTaskId },
      });
      expect(spoofed.status).toBe(403);
      expect(spoofed.body.code).toBe("BOARD_ACCESS_DENIED");

      // Spoofed watcher identity on an ADMITTED caller is still JWT-derived.
      const admitted = await wire(prefix, "POST", `/tasks/${emptyTeamTaskId}/watch`, {
        token: memberAdminJwt,
        body: { userId: "soa-member-viewer" },
      });
      expect(admitted.status).toBe(201);
      expect(admitted.body.watcher.userId).toBe("soa-member-admin");
      expect(watcherRows(emptyTeamTaskId).some((w: any) => w.userId === "soa-member-viewer")).toBe(
        false,
      );
    }
  });
});

describe("six Task admission operations — authentication boundary (both prefixes)", () => {
  it("agent-key-only, invalid-key, remote-key-only and anonymous are 401 before any object work on the five human-only operations", async () => {
    const humanOnly = OPS.filter((op) => op.method !== "PUT");
    for (const prefix of PREFIXES) {
      for (const op of humanOnly) {
        const agentOnly = await wire(prefix, op.method, op.path(teamTaskId), {
          agentKey: agentKey,
          body: op.body,
        });
        expect(agentOnly.status, `${op.name} agent-only`).toBe(401);

        const badKey = await wire(prefix, op.method, op.path(teamTaskId), {
          agentKey: "soa-bogus-key",
          body: op.body,
        });
        expect(badKey.status, `${op.name} bad key`).toBe(401);

        const remoteOnly = await wire(prefix, op.method, op.path(teamTaskId), {
          remoteKey: validRemoteKey,
          body: op.body,
        });
        expect(remoteOnly.status, `${op.name} remote-only`).toBe(401);

        const anon = await wire(prefix, op.method, op.path(teamTaskId), { body: op.body });
        expect(anon.status, `${op.name} anonymous`).toBe(401);
      }
    }
  });

  it("estimate keeps local_actor: anonymous/invalid/remote-only are 401, and an invalid key never falls back to a valid JWT", async () => {
    const op = OPS[0]!;
    for (const prefix of PREFIXES) {
      const anon = await wire(prefix, op.method, op.path(teamTaskId), { body: op.body });
      expect(anon.status).toBe(401);

      const badKey = await wire(prefix, op.method, op.path(teamTaskId), {
        agentKey: "soa-bogus-key",
        body: op.body,
      });
      expect(badKey.status).toBe(401);

      const remoteOnly = await wire(prefix, op.method, op.path(teamTaskId), {
        remoteKey: validRemoteKey,
        body: op.body,
      });
      expect(remoteOnly.status).toBe(401);

      // Valid JWT PLUS an invalid agent key on a local_actor route: the
      // agent key is preferred and 401s WITHOUT falling back to the JWT.
      const mixedInvalid = await wire(prefix, op.method, op.path(teamTaskId), {
        token: memberAdminJwt,
        agentKey: "soa-bogus-key",
        body: op.body,
      });
      expect(mixedInvalid.status).toBe(401);
    }
  });

  it("a valid human JWT plus irrelevant agent/remote headers retains the human result (not blanket-denied)", async () => {
    for (const prefix of PREFIXES) {
      const mixed = await wire(prefix, "GET", `/tasks/${teamTaskId}/pull-requests`, {
        token: memberAdminJwt,
        extraHeaders: {
          "x-agent-api-key": agentKey,
          "x-orcy-remote-key": validRemoteKey,
        },
      });
      expect(mixed.status).toBe(200);
      expect(mixed.body.pullRequests).toHaveLength(2);

      const mixedWatch = await wire(prefix, "POST", `/tasks/${emptyTeamTaskId}/watch`, {
        token: memberAdminJwt,
        extraHeaders: { "x-agent-api-key": agentKey },
      });
      expect(mixedWatch.status).toBe(201);
      expect(mixedWatch.body.watcher.userId).toBe("soa-member-admin");
    }
  });
});

describe("six Task admission operations — missing ancestry (both prefixes)", () => {
  it("authenticated missing Task is 404 Task not found on all six, replacing the previous 200-empty adjunct reads", async () => {
    const ghost = "soa-no-such-task";
    for (const prefix of PREFIXES) {
      for (const op of OPS) {
        const res = await wire(prefix, op.method, op.path(ghost), {
          token: memberAdminJwt,
          body: op.body,
        });
        expect(res.status, `${op.name} @ ${prefix}`).toBe(404);
        expect(res.body.error, `${op.name} @ ${prefix}`).toBe("Task not found");
      }
    }
  });

  it("POST watch keeps the 404 OUTSIDE the catch: a missing Task is 404, never the catch's 500", async () => {
    for (const prefix of PREFIXES) {
      const res = await wire(prefix, "POST", `/tasks/soa-no-such-task/watch`, {
        token: memberAdminJwt,
        body: {},
      });
      expect(res.status).toBe(404);
      expect(res.body.error).toBe("Task not found");
      expect(res.body.code).toBe("NOT_FOUND");
      expect(res.status).not.toBe(500);
    }
  });

  it("missing Mission and missing Habitat (FK-off owned fixtures) are 404 on all six, with FK restored", async () => {
    const orphanHabitat = habitatRepo.createHabitat({ name: "soa-orphan-habitat" }).id;
    const orphanHabitatTask = makeTask(orphanHabitat, "soa-orphan-habitat-task");
    const orphanHabitatMissionId = getDb()
      .select({ missionId: tasks.missionId })
      .from(tasks)
      .where(eq(tasks.id, orphanHabitatTask))
      .get()!.missionId;

    const orphanMission = missionRepo.createMission({
      habitatId: teamHabitatId,
      columnId: columnRepo.createColumn({
        habitatId: teamHabitatId,
        name: "col-orphan-mission",
        order: 901,
        requiresClaim: false,
      }).id,
      title: "soa-orphan-mission",
      createdBy: "soa-seed",
    }).id;
    const orphanMissionTask = taskCrudRepo.createTask({
      missionId: orphanMission,
      title: "soa-orphan-mission-task",
      createdBy: "soa-seed",
    }).id;

    const habitatBefore = fullStateSnapshot(orphanHabitatTask);
    const missionBefore = fullStateSnapshot(orphanMissionTask);

    // Owned corrupt-ancestry fixtures: FK off for the parent delete, restored
    // in finally and re-asserted.
    setFk(false);
    try {
      getDb().run(sql`DELETE FROM habitats WHERE id = ${orphanHabitat}`);
    } finally {
      setFk(true);
    }
    setFk(false);
    try {
      getDb().run(sql`DELETE FROM missions WHERE id = ${orphanMission}`);
    } finally {
      setFk(true);
    }
    expect(orphanHabitatMissionId).toBeTruthy();

    for (const prefix of PREFIXES) {
      for (const op of OPS) {
        const missingHabitat = await wire(prefix, op.method, op.path(orphanHabitatTask), {
          token: memberAdminJwt,
          body: op.body,
        });
        expect(missingHabitat.status, `${op.name} missing habitat`).toBe(404);
        expect(missingHabitat.body.error, `${op.name} missing habitat`).toBe("Habitat not found");

        const missingMission = await wire(prefix, op.method, op.path(orphanMissionTask), {
          token: memberAdminJwt,
          body: op.body,
        });
        expect(missingMission.status, `${op.name} missing mission`).toBe(404);
        expect(missingMission.body.error, `${op.name} missing mission`).toBe("Mission not found");
      }
    }

    expect(fullStateSnapshot(orphanHabitatTask)).toEqual(habitatBefore);
    expect(fullStateSnapshot(orphanMissionTask)).toEqual(missionBefore);
  });

  it("credential refusals still precede corrupt-ancestry resolution", async () => {
    const orphanHabitat = habitatRepo.createHabitat({ name: "soa-orphan-habitat-2" }).id;
    const orphanTask = makeTask(orphanHabitat, "soa-orphan-2");
    setFk(false);
    try {
      getDb().run(sql`DELETE FROM habitats WHERE id = ${orphanHabitat}`);
    } finally {
      setFk(true);
    }
    for (const prefix of PREFIXES) {
      for (const op of OPS) {
        const anon = await wire(prefix, op.method, op.path(orphanTask), { body: op.body });
        expect(anon.status, `${op.name} anon vs orphan`).toBe(401);
        const badKey = await wire(prefix, op.method, op.path(orphanTask), {
          agentKey: "soa-bogus-key",
          body: op.body,
        });
        expect(badKey.status, `${op.name} bad key vs orphan`).toBe(401);
      }
    }
  });
});

describe("six Task admission operations — preserved input and downstream semantics", () => {
  it("admitted estimate keeps its scalar validation: negative, string and null are 400", async () => {
    for (const prefix of PREFIXES) {
      for (const body of [
        { estimatedMinutes: -1 },
        { estimatedMinutes: "not-a-number" },
        { estimatedMinutes: null },
      ]) {
        const res = await wire(prefix, "PUT", `/tasks/${teamTaskId}/estimate`, {
          token: memberAdminJwt,
          body,
        });
        expect(res.status, `body ${JSON.stringify(body)}`).toBe(400);
        expect(res.body.error).toBe("estimatedMinutes must be a non-negative number");
      }
    }
  });

  it("admitted estimate accepts the existing accepted range and returns the whole Task", async () => {
    for (const prefix of PREFIXES) {
      for (const minutes of [0, 12.5]) {
        const res = await wire(prefix, "PUT", `/tasks/${teamTaskId}/estimate`, {
          token: memberAdminJwt,
          body: { estimatedMinutes: minutes },
        });
        expect(res.status).toBe(200);
        expect(res.body.task.estimatedMinutes).toBe(minutes);
        expect(res.body.task.id).toBe(teamTaskId);
        expect(res.body.task.missionId).toBeTruthy();
      }
    }
  });

  it("estimate emits no Task event, watcher notification or adjunct row (unchanged)", async () => {
    const before = fullStateSnapshot(teamTaskId);
    const res = await wire("/api/v1", "PUT", `/tasks/${teamTaskId}/estimate`, {
      token: memberAdminJwt,
      body: { estimatedMinutes: 99 },
    });
    expect(res.status).toBe(200);
    const after = fullStateSnapshot(teamTaskId);
    expect(after.events).toEqual(before.events);
    expect(after.watchers).toEqual(before.watchers);
    expect(after.pullRequests).toEqual(before.pullRequests);
    expect(after.pipelineEvents).toEqual(before.pipelineEvents);
    // Only the estimate and the version/updatedAt the shared repo maintains.
    expect(after.estimatedMinutes).toBe(99);
    expect(after.version).toBe(before.version! + 1);
  });

  it("watcher GET reflects a just-added own row immediately (own-pair state stays consistent)", async () => {
    for (const prefix of PREFIXES) {
      const target = makeTask(teamHabitatId, `soa-ownpair-${prefix.replace(/\W/g, "")}`);
      const beforeWatch = await wire(prefix, "GET", `/tasks/${target}/watchers`, {
        token: editorJwt,
      });
      expect(beforeWatch.status).toBe(200);
      expect(beforeWatch.body.isWatching).toBe(false);

      const watch = await wire(prefix, "POST", `/tasks/${target}/watch`, {
        token: editorJwt,
        body: {},
      });
      expect(watch.status).toBe(201);

      const afterWatch = await wire(prefix, "GET", `/tasks/${target}/watchers`, {
        token: editorJwt,
      });
      expect(afterWatch.status).toBe(200);
      expect(afterWatch.body.isWatching).toBe(true);
      expect(afterWatch.body.watchers).toHaveLength(1);
    }
  });
});
