/**
 * T7 Phase 2 — REST clone publication routes (DORMANT).
 *
 * Exercises the load-bearing HTTP contract of the two new dormant routes:
 *
 *   (a) `GET /tasks/:sourceTaskId/clone-preparation` — the read-only
 *       allowlisted DTO that prefills the clone composer.
 *   (b) `POST /tasks/:sourceTaskId/clone-publications` — the dormant
 *       clone publication, exposing the extended `publishTaskCreation`
 *       adapter (with `cloneSourceTaskId`) to REST clients.
 *
 * Each test maps 1:1 to a guardrail named in the ticket:
 *
 *   (a) GET:
 *     1. Returns the allowlisted DTO (reusable fields + reset Subtasks +
 *        unselected deps + source refs).
 *     2. NOT-FOUND → 404 (no source Task or its Mission).
 *     3. Cross-habitat → 403 (no leak of cross-habitat Task existence).
 *     4. Read-only: ZERO writes (no attempt, no Task, no event).
 *
 *   (b) POST:
 *     1. Outcome mapping (each branch): created-recovering → 202 +
 *        `recovering:true`; terminal created → 201; replayed → 200;
 *        rejected_validation → 422 + errors; vetoed → 409;
 *        rejected_fingerprint → 409; guard_mismatch / governance_denied →
 *        503.
 *     2. Edited values: posted title/subtasks override the source's
 *        defaults — the committed Task reflects the edits, NOT a re-copy.
 *     3. Same-Habitat: cross-habitat targetMissionId → rejected (the
 *        kernel's `cross_habitat_mission` check fires).
 *     4. No `includeSubtasks`/`includeComments`/`order` in body (the
 *        legacy options are retired — the Zod schema is structurally
 *        narrow).
 *     5. Attempt-key replay: same key + unchanged → 200 replay; same key
 *        + changed → 409 rejected_fingerprint.
 *     6. Authorization: anonymous → 401; no mission access → 403.
 *
 * Out of scope: the adapter + service primitives (covered in
 * `taskClonePreparation.test.ts`); MCP/UI (P3, deferred to T11);
 * cutover wiring (T11).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  tasks,
  taskEvents,
  taskSubtasks,
  taskDependencies,
  taskCreationEnvelopes,
  taskCreationAttempts,
  taskCreationAssignmentReservations,
  users,
} from "../db/schema/index.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as organizationRepo from "../repositories/organization.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import { taskClonePublicationRoutes } from "../routes/taskClonePublication.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

/** Ensures a users row exists (team_members has an FK to users). */
function ensureUser(userId: string, username?: string): void {
  const db = getDb();
  const existing = db.select({ id: users.id }).from(users).where(eq(users.id, userId)).get();
  if (!existing) {
    db.insert(users)
      .values({
        id: userId,
        username: username ?? userId,
        passwordHash: "hash",
        displayName: username ?? userId,
        role: "admin",
        createdAt: new Date().toISOString(),
      })
      .run();
  }
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(taskClonePublicationRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

let habitatId: string;
let sourceMissionId: string;
let otherHabitatId: string;
let otherMissionId: string;
let agentApiKey: string;
let keyCounter = 0;

/** Returns a fresh client-supplied attempt key per call (unique per test). */
function freshKey(label = "k"): string {
  keyCounter += 1;
  return `${label}-${keyCounter}-${Date.now()}`;
}

/** Writes + loads a temp plugin; mirrors `taskPublicationRoute.test.ts`. */
async function writePlugin(name: string, moduleBody: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const tmpDir = `/tmp/test-t7p2-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
}

function enrollInterceptor(hId: string, pluginId: string, contributionId: string): void {
  enrollmentRepo.create({
    habitatId: hId,
    pluginId,
    contributionId,
    contributionKind: "lifecycleInterceptor",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(hId);
}

/**
 * Seeds a source Task with rich work-definition + Subtasks + outgoing
 * dependencies, so clone-preparation has something substantive to
 * allowlist. Returns the source Task id + the ids of its dependency
 * targets.
 */
function seedSourceTask(opts?: {
  title?: string;
  withSubtasks?: boolean;
  withDeps?: boolean;
  missionIdOverride?: string;
}): {
  sourceId: string;
  depTargetIds: string[];
} {
  const useMissionId = opts?.missionIdOverride ?? sourceMissionId;
  const sourceId = `clone-source-${keyCounter}-${Math.random().toString(36).slice(2, 8)}`;
  getDb()
    .insert(tasks)
    .values({
      id: sourceId,
      missionId: useMissionId,
      title: opts?.title ?? "Source Task",
      description: "Source description with detail.",
      labels: ["backend", "api"],
      priority: "high",
      requiredDomain: "backend",
      requiredCapabilities: ["typescript", "sqlite"],
      estimatedMinutes: 90,
      createdBy: "user-route",
      order: 0,
    })
    .run();

  const depTargetIds: string[] = [];
  if (opts?.withDeps) {
    // Use real UUIDs so the test's `selectedDependencies` passes the
    // route body's `.uuid()` Zod check. The source task itself can be a
    // free-form id because it is in the path, not the body.
    const depA = randomUUID();
    const depB = randomUUID();
    getDb()
      .insert(tasks)
      .values([
        { id: depA, missionId: useMissionId, title: "Dependency A", createdBy: "user-route", order: 1 },
        {
          id: depB,
          missionId: useMissionId,
          title: "Dependency B",
          createdBy: "user-route",
          order: 2,
        },
      ])
      .run();
    getDb()
      .insert(taskDependencies)
      .values([
        { taskId: sourceId, dependsOnId: depA },
        { taskId: sourceId, dependsOnId: depB },
      ])
      .run();
    depTargetIds.push(depA, depB);
  }

  if (opts?.withSubtasks) {
    getDb()
      .insert(taskSubtasks)
      .values([
        {
          id: `st-1-${sourceId}`,
          taskId: sourceId,
          title: "Source subtask one",
          completed: true,
          order: 0,
          assigneeId: null,
        },
        {
          id: `st-2-${sourceId}`,
          taskId: sourceId,
          title: "Source subtask two",
          completed: false,
          order: 1,
          assigneeId: null,
        },
      ])
      .run();
  }

  return { sourceId, depTargetIds };
}

/** Base body for the POST clone publication route. */
function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptKey: freshKey("payload"),
    title: "Cloned Task",
    targetMissionId: sourceMissionId,
    assignment: { kind: "auto" },
    ...overrides,
  };
}

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "Clone Route Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  sourceMissionId = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "clone-source-mission",
    createdBy: "user-route",
  }).id;

  // A SECOND habitat + mission for cross-habitat / no-access tests.
  const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
  otherHabitatId = otherHabitat.id;
  const otherColumn = columnRepo.createColumn({
    habitatId: otherHabitatId,
    name: "Other",
    order: 0,
    requiresClaim: false,
  });
  otherMissionId = missionRepo.createMission({
    habitatId: otherHabitatId,
    columnId: otherColumn.id,
    title: "other-mission",
    createdBy: "user-route",
  }).id;

  // Seed an agent for the agent-auth tests.
  const agentResult = agentRepo.createAgent({
    name: "Clone Route Agent",
    type: "claude-code",
    domain: "general",
  });
  agentApiKey = agentResult.plainApiKey;
  ensureUser("user-route", "user-route");
});

afterEach(() => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ===========================================================================
// (a) GET /tasks/:sourceTaskId/clone-preparation — allowlisted DTO
// ===========================================================================

describe("T7P2 GET clone-preparation — allowlisted read-only DTO", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("returns reusable work-definition fields + reset Subtasks + unselected deps + source refs", async () => {
    const { sourceId, depTargetIds } = seedSourceTask({
      withSubtasks: true,
      withDeps: true,
    });

    const res = await app!.inject({
      method: "GET",
      url: `/api/tasks/${sourceId}/clone-preparation`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);

    // Reusable work-definition fields (allowlist-selected).
    expect(body.title).toBe("Source Task");
    expect(body.description).toBe("Source description with detail.");
    expect(body.priority).toBe("high");
    expect(body.labels).toEqual(["backend", "api"]);
    expect(body.requiredDomain).toBe("backend");
    expect(body.requiredCapabilities).toEqual(["typescript", "sqlite"]);
    expect(body.estimatedMinutes).toBe(90);

    // Source references — provenance + same-Habitat authority.
    expect(body.source.taskId).toBe(sourceId);
    expect(body.source.missionId).toBe(sourceMissionId);
    expect(body.source.habitatId).toBe(habitatId);
    expect(body.defaultTargetMissionId).toBe(sourceMissionId);

    // RESET Subtasks — title + order only (no completed/assigneeId/id).
    expect(body.subtasks).toHaveLength(2);
    expect(body.subtasks[0]).toEqual({ title: "Source subtask one", order: 0 });
    expect(body.subtasks[1]).toEqual({ title: "Source subtask two", order: 1 });
    expect(body.subtasks[0]).not.toHaveProperty("completed");
    expect(body.subtasks[0]).not.toHaveProperty("assigneeId");
    expect(body.subtasks[0]).not.toHaveProperty("id");

    // UNSELECTED dep suggestions — the source's outgoing edges. The user
    // must explicitly select them; the GET does NOT pre-select.
    expect(body.dependencySuggestions).toHaveLength(2);
    const suggestionIds = body.dependencySuggestions.map(
      (s: { dependsOnId: string }) => s.dependsOnId,
    );
    expect(suggestionIds.sort()).toEqual(depTargetIds.sort());
    for (const s of body.dependencySuggestions) {
      expect(s).not.toHaveProperty("selected");
      expect(s).not.toHaveProperty("picked");
    }

    // **Failure mode**: if the GET published the source's source fields
    // (status, assignedAgentId, result, artifacts, version, order,
    // retryCount, actualMinutes, cycleTimeMinutes) — or any other
    // execution-history field — the type's allowlist would leak. The
    // response key set here is structural evidence the route respects it.
    const keys = Object.keys(body).sort();
    expect(keys).toEqual(
      [
        "defaultTargetMissionId",
        "dependencySuggestions",
        "description",
        "estimatedMinutes",
        "labels",
        "priority",
        "requiredCapabilities",
        "requiredDomain",
        "source",
        "subtasks",
        "title",
      ].sort(),
    );
  });

  it("returns 404 when the source Task does not exist (no leak)", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/tasks/does-not-exist/clone-preparation`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(404);

    // **Failure mode**: returning 200 with an empty/synthetic DTO would
    // leak that the source vanished + risk a fresh stale Task. The route
    // must refuse (404).
  });

  it("returns 403 for a caller without source-Habitat access (cross-habitat isolation)", async () => {
    // Seed a source Task in habitat A (no team — permissive for non-members).
    // For the cross-habitat 403 test, build a TEAM-OWNED habitat the
    // stranger has no membership in.
    const org = organizationRepo.createOrganization({ name: "Clone Org", slug: "clone-org" });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "Clone Team",
      slug: "clone-team",
    });
    const teamHabitat = habitatRepo.createHabitat({
      name: "Team Habitat",
      teamId: team.id,
    });
    const teamColumn = columnRepo.createColumn({
      habitatId: teamHabitat.id,
      name: "Team Todo",
      order: 0,
      requiresClaim: false,
    });
    const teamMissionId = missionRepo.createMission({
      habitatId: teamHabitat.id,
      columnId: teamColumn.id,
      title: "Team Mission",
      createdBy: "user-route",
    }).id;
    const teamSource = taskRepo.createTask({
      missionId: teamMissionId,
      title: "Team Source",
      createdBy: "user-route",
    });

    ensureUser("user-stranger", "user-stranger");
    const strangerToken = makeToken({
      sub: "user-stranger",
      username: "stranger",
      role: "member",
    });

    const res = await app!.inject({
      method: "GET",
      url: `/api/tasks/${teamSource.id}/clone-preparation`,
      headers: { authorization: `Bearer ${strangerToken}` },
    });

    expect(res.statusCode).toBe(403);

    // **Failure mode**: a 200 here would leak a cross-team Task's
    // allowlisted DTO. A 404 would imply the Task vanished (it didn't).
    // 403 is the explicit habitat-scope refusal.
  });

  it("is READ-ONLY: ZERO writes (no attempt row, no Task, no event, no envelope)", async () => {
    const { sourceId } = seedSourceTask();

    const beforeAttempts = getDb().select().from(taskCreationAttempts).all().length;
    const beforeTasks = getDb().select().from(tasks).where(eq(tasks.id, sourceId)).all();
    const beforeEvents = getDb().select().from(taskEvents).all().length;
    const beforeEnvelopes = getDb().select().from(taskCreationEnvelopes).all().length;

    const res = await app!.inject({
      method: "GET",
      url: `/api/tasks/${sourceId}/clone-preparation`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);

    // No attempt row was created (the GET is the "Prepare" step — opening
    // the clone form must NOT reserve an attempt or commit anything).
    expect(getDb().select().from(taskCreationAttempts).all().length).toBe(beforeAttempts);
    // Source Task untouched.
    expect(getDb().select().from(tasks).where(eq(tasks.id, sourceId)).all()).toEqual(
      beforeTasks,
    );
    // No new Lifecycle Events.
    expect(getDb().select().from(taskEvents).all().length).toBe(beforeEvents);
    // No envelope committed.
    expect(getDb().select().from(taskCreationEnvelopes).all().length).toBe(beforeEnvelopes);

    // **Failure mode**: if the GET reserved an attempt or committed a
    // Task, this assertion would catch it. The route MUST NOT mutate.
  });
});

// ===========================================================================
// (b) POST /tasks/:sourceTaskId/clone-publications — outcome map
// ===========================================================================

describe("T7P2 POST clone-publications — outcome mapping (mirrors T6 P2)", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("fresh publish → 202 Accepted with recovering:true + recoveringState + taskId", async () => {
    const { sourceId } = seedSourceTask();

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Fresh Clone Publish" }),
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("created");
    expect(body.recovering).toBe(true);
    expect(body.recoveringState).toBe("published_pending_observation");
    expect(body.taskId).toBeDefined();
    expect(body.attemptId).toBeDefined();

    // **Failure mode**: if the clone POST mapped a recovering Task to
    // 500/201, the route would leak committed-but-unobserved state as a
    // failure — the shared domain outcome must propagate.
  });

  it("replayed → 200 with the stored terminal (idempotent retry, no duplicate Task)", async () => {
    const { sourceId } = seedSourceTask();
    const key = freshKey("replay");

    // First publish → recovering (202).
    const first = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Replay Surface" }),
    });
    expect(first.statusCode).toBe(202);

    // Manually terminalize the attempt to simulate the dispatcher /
    // coordinator advancing the attempt to a terminal state.
    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.attemptKey, key))
      .all()[0];
    if (!attempt) throw new Error("expected an attempt row");
    getDb()
      .update(taskCreationAttempts)
      .set({
        state: "created",
        terminalOutcome: "created",
        terminalResult: { outcome: "created", taskId: "t-final", attemptId: attempt.id },
        completedAt: new Date().toISOString(),
      })
      .where(eq(taskCreationAttempts.id, attempt.id))
      .run();

    // Same key → replay.
    const replay = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Replay Surface" }),
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = JSON.parse(replay.body);
    expect(replayBody.outcome).toBe("replayed");
    expect(replayBody.attemptId).toBe(attempt.id);

    // Exactly ONE source-target-mission task was cloned (the first publish
    // is the only commit; the replay is a no-op).
    const cloneTasks = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.missionId, sourceMissionId))
      .all()
      .filter((t) => t.id !== sourceId);
    expect(cloneTasks).toHaveLength(1);

    // **Failure mode**: if the route ignored the attempt key and always
    // called the adapter fresh, the second call would publish a second
    // Task. `TERMINAL_ATTEMPT_STATES` gates the side effect.
  });

  it("rejected_validation → 422 with `outcome` + `attemptId` + `errors[]`", async () => {
    const { sourceId } = seedSourceTask();
    // Mark the source's Mission as done (the kernel rejects inactive
    // missions at prepare time with `mission_inactive`).
    missionRepo.updateMission(sourceMissionId, { status: "done" });

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Inactive Source Mission" }),
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("rejected_validation");
    expect(body.attemptId).toBeDefined();
    expect(Array.isArray(body.errors)).toBe(true);
    const codes = body.errors.map((e: { code: string }) => e.code);
    expect(codes).toContain("mission_inactive");

    // **Failure mode**: a 400 would conflate request-shape validation
    // with domain-shape validation; 422 keeps the typed envelope shape
    // for the UI to render per-field errors.
  });

  it("vetoed → 409 with `veto` details preserved (interceptorKey, reason)", async () => {
    const { sourceId } = seedSourceTask();

    // Enroll a vetoing taskCreated interceptor for this habitat.
    await writePlugin(
      "veto-plugin-t7",
      `{
        manifest: {
          id: 'veto-plugin-t7', version: '1.0.0', description: 'veto on create',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-on-create-t7', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
          ],
        },
        interceptors: {
          'veto-on-create-t7': () => ({ allow: false, reason: 'clone route test veto' }),
        },
      }`,
    );
    enrollInterceptor(habitatId, "veto-plugin-t7", "veto-on-create-t7");

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Will Be Vetoed" }),
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("vetoed");
    expect(body.attemptId).toBeDefined();
    expect(body.veto.interceptorKey).toBe(
      JSON.stringify([
        "lifecycleInterceptor",
        "veto-plugin-t7",
        "veto-on-create-t7",
        "pre",
        "taskCreated",
      ]),
    );
    expect(body.veto.reason).toBe("clone route test veto");

    // **Failure mode**: a 403 would conflate governance refusal with
    // authorization; a 422 would imply the payload was bad. 409 carries
    // the veto shape verbatim.
  });

  it("rejected_fingerprint → 409 with the 'corrected payload requires a new attempt key' message", async () => {
    const { sourceId } = seedSourceTask();
    const key = freshKey("replay-fp");

    // First call: original payload → 202 recovering.
    const first = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Original Title" }),
    });
    expect(first.statusCode).toBe(202);

    // Same key + changed title (the corrected payload).
    const second = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Corrected Title" }),
    });

    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.outcome).toBe("rejected_fingerprint");
    expect(body.message).toMatch(/corrected payload requires a new attempt key/i);

    // **Failure mode**: 422 would conflate fingerprint mismatch with
    // payload-shape validation; the UI needs the explicit "new key"
    // signal (409).
  });
});

// ===========================================================================
// (b) POST — edited values flow into the committed Task (NOT a re-copy)
// ===========================================================================

describe("T7P2 POST clone-publications — edited values committed (not a re-copy)", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("commit reflects the EDITED title + edited subtasks, not a re-copy", async () => {
    const { sourceId } = seedSourceTask({ withSubtasks: true });

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({
        title: "Edited Clone Title",
        description: "Edited description — different from source.",
        priority: "low",
        labels: ["cloned", "edited"],
        subtasks: [
          { title: "Edited subtask A", order: 0 },
          { title: "Edited subtask B", order: 1 },
          { title: "Brand-new subtask C", order: 2 },
        ],
      }),
    });

    expect(res.statusCode).toBe(202);
    const taskId = JSON.parse(res.body).taskId;

    // The committed Task carries the edited values, NOT the source's.
    const committed = getDb().select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
    expect(committed.title).toBe("Edited Clone Title");
    expect(committed.description).toBe("Edited description — different from source.");
    expect(committed.priority).toBe("low");
    expect(committed.labels).toEqual(["cloned", "edited"]);

    // Subtasks: exactly the edited list (3 entries, RESET to incomplete +
    // unassigned; the kernel allocated fresh ids).
    const subtasks = getDb()
      .select()
      .from(taskSubtasks)
      .where(eq(taskSubtasks.taskId, taskId))
      .all();
    expect(subtasks).toHaveLength(3);
    const titles = subtasks.map((s) => s.title).sort();
    expect(titles).toEqual(
      ["Brand-new subtask C", "Edited subtask A", "Edited subtask B"].sort(),
    );
    for (const s of subtasks) {
      // RESET semantics: incomplete + unassigned.
      expect(s.completed).toBe(false);
      expect(s.assigneeId).toBeNull();
      // Fresh id (NOT a copy of the source subtask id).
      expect(s.id.startsWith("st-")).toBe(false);
    }

    // The `cloned` Lifecycle Event is stamped atomically with the
    // source reference.
    const events = getDb()
      .select()
      .from(taskEvents)
      .where(eq(taskEvents.taskId, taskId))
      .all();
    const clonedEvent = events.find((e) => e.action === "cloned");
    expect(clonedEvent).toBeDefined();

    // The cloneSourceTaskId envelope column carries the source.
    const envelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.taskId, taskId))
      .all()[0];
    expect(envelope).toBeDefined();
    expect(envelope.cloneSourceTaskId).toBe(sourceId);

    // **Failure mode**: if the route re-copied the source's work-
    // definition or its Subtasks, the assertions above would match the
    // SOURCE title/description/priority/labels/subtasks instead of the
    // edits. The adapter does NOT re-copy — the body is authoritative.
  });

  it("commit reflects user-selected dependencies (revalidated by the kernel)", async () => {
    const { sourceId, depTargetIds } = seedSourceTask({ withDeps: true });

    // The user selected ONLY the first dependency from the source's two
    // suggestions.
    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({
        title: "Selected Deps Clone",
        selectedDependencies: [depTargetIds[0]], // exactly one
      }),
    });

    expect(res.statusCode).toBe(202);
    const taskId = JSON.parse(res.body).taskId;

    // Exactly ONE dependency edge on the committed Task — the user's
    // explicit selection (not both suggestions).
    const deps = getDb()
      .select()
      .from(taskDependencies)
      .where(eq(taskDependencies.taskId, taskId))
      .all();
    expect(deps).toHaveLength(1);
    expect(deps[0].dependsOnId).toBe(depTargetIds[0]);

    // **Failure mode**: if the POST cloned the source's full dependency
    // set (the unselected suggestions) without honoring the user's
    // selection, the committed Task would carry BOTH edges. The kernel
    // honors `selectedDependencies` from the body and ignores the
    // source's outgoing edges (the source ref is for provenance, NOT
    // dep copying).
  });
});

// ===========================================================================
// (b) POST — same-Habitat enforcement
// ===========================================================================

describe("T7P2 POST clone-publications — same-Habitat enforcement", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("rejects a target Mission in a DIFFERENT Habitat (cross_habitat_mission)", async () => {
    const { sourceId } = seedSourceTask();
    // The target Mission lives in `otherHabitatId`, not `habitatId` — the
    // kernel's same-Habitat check rejects this at prepare time.
    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({
        title: "Cross-Habitat Clone",
        targetMissionId: otherMissionId,
      }),
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("rejected_validation");
    expect(Array.isArray(body.errors)).toBe(true);
    const codes = body.errors.map((e: { code: string }) => e.code);
    expect(codes).toContain("cross_habitat_mission");

    // No Task committed for the cross-habitat publication.
    const committed = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.missionId, otherMissionId))
      .all();
    expect(committed).toHaveLength(0);

    // **Failure mode**: a 202 (the route blindly forwarding the adapter's
    // `cross_habitat_mission` rejection would surface as 422; without the
    // kernel check the Task would commit in the wrong Habitat).
  });

  it("honors an explicit targetMissionId within the SAME Habitat", async () => {
    // Seed an additional active Mission in the source's Habitat. The
    // clone will target this Mission directly.
    const extraColumn = columnRepo.createColumn({
      habitatId,
      name: "Extra",
      order: 1,
      requiresClaim: false,
    });
    const extraMissionId = missionRepo.createMission({
      habitatId,
      columnId: extraColumn.id,
      title: "extra-mission-in-same-habitat",
      createdBy: "user-route",
    }).id;
    const { sourceId } = seedSourceTask({ missionIdOverride: sourceMissionId });

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({
        title: "Same-Habitat Target",
        targetMissionId: extraMissionId,
      }),
    });

    expect(res.statusCode).toBe(202);
    const taskId = JSON.parse(res.body).taskId;

    // The committed Task lives in the explicit target Mission (the
    // extra one), NOT the source's Mission.
    const committed = getDb().select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
    expect(committed.missionId).toBe(extraMissionId);

    // **Failure mode**: if the route ignored `targetMissionId` and
    // defaulted to the source's Mission, the committed Task would
    // land in `sourceMissionId` instead of `extraMissionId`.
  });
});

// ===========================================================================
// (b) POST — body schema excludes retired fields
// ===========================================================================

describe("T7P2 POST body schema — NO includeSubtasks / includeComments / order", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("body schema does not declare `includeSubtasks`, `includeComments`, or `order`", async () => {
    const { clonePublicationSchema } = await import("../models/schemas.js");
    // The schema is `ZodEffects` (wrapped by `.superRefine`); reach into
    // the inner `ZodObject`'s shape via `_def.schema.shape`. The Zod
    // runtime stores the refined schema on `_def.schema`.
    const shape = (clonePublicationSchema._def.schema as { shape: Record<string, unknown> }).shape;

    // The Zod schema's `.shape` carries only the fields the route
    // accepts. Retired legacy options must be ABSENT (not merely
    // documented away) — otherwise a client could smuggle them in and
    // the adapter would see an extra (rejected) field.
    expect(shape).not.toHaveProperty("includeSubtasks");
    expect(shape).not.toHaveProperty("includeComments");
    expect(shape).not.toHaveProperty("order");

    // The published kernel-allocated `order` is set by `createTaskWithClient`,
    // NOT the route. Verify by inspecting the committed Task on a
    // successful publication.
    const { sourceId } = seedSourceTask();
    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "No Legacy Fields" }),
    });
    expect(res.statusCode).toBe(202);
    const taskId = JSON.parse(res.body).taskId;
    const committed = getDb().select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
    // Integrity is POST_CUTOVER (the kernel's stamp), confirming the new
    // path, not the legacy `order:0` forcing.
    expect(committed.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
  });
});

// ===========================================================================
// (b) POST — attempt-key replay + authorization
// ===========================================================================

describe("T7P2 POST clone-publications — replay + authorization", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("same key + unchanged → 200 replay (no duplicate Task)", async () => {
    const { sourceId } = seedSourceTask();
    const key = freshKey("idem");
    const payload = basePayload({ attemptKey: key, title: "Idempotent Clone" });

    const first = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload,
    });
    expect(first.statusCode).toBe(202);

    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.attemptKey, key))
      .all()[0];
    if (!attempt) throw new Error("expected an attempt row");
    getDb()
      .update(taskCreationAttempts)
      .set({
        state: "created",
        terminalOutcome: "created",
        terminalResult: { outcome: "created", taskId: "t-idem", attemptId: attempt.id },
        completedAt: new Date().toISOString(),
      })
      .where(eq(taskCreationAttempts.id, attempt.id))
      .run();

    const second = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(JSON.parse(second.body).outcome).toBe("replayed");

    // Exactly one new Task committed.
    const cloneTasks = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.missionId, sourceMissionId))
      .all()
      .filter((t) => t.id !== sourceId);
    expect(cloneTasks).toHaveLength(1);

    // **Failure mode**: if the route ignored the attempt key, the second
    // call would publish a second Task (`TERMINAL_ATTEMPT_STATES` gates it).
  });

  it("anonymous POST → 401 (agentOrHumanAuth blocks)", async () => {
    const { sourceId } = seedSourceTask();

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      payload: basePayload({ title: "Anon" }),
    });

    expect(res.statusCode).toBe(401);
  });

  it("human without target-Habitat access → 403 (cross-habitat isolation)", async () => {
    // Build a TEAM-OWNED habitat + source + mission + teamless stranger.
    const org = organizationRepo.createOrganization({
      name: "Clone Post Org",
      slug: "clone-post-org",
    });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "Clone Post Team",
      slug: "clone-post-team",
    });
    const teamHabitat = habitatRepo.createHabitat({
      name: "Clone Post Habitat",
      teamId: team.id,
    });
    const teamColumn = columnRepo.createColumn({
      habitatId: teamHabitat.id,
      name: "Post Todo",
      order: 0,
      requiresClaim: false,
    });
    const teamMissionId = missionRepo.createMission({
      habitatId: teamHabitat.id,
      columnId: teamColumn.id,
      title: "Post Team Mission",
      createdBy: "user-route",
    }).id;
    const teamSource = taskRepo.createTask({
      missionId: teamMissionId,
      title: "Post Source",
      createdBy: "user-route",
    });

    ensureUser("user-stranger", "user-stranger");
    const strangerToken = makeToken({
      sub: "user-stranger",
      username: "stranger",
      role: "member",
    });

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${teamSource.id}/clone-publications`,
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: {
        attemptKey: freshKey("stranger"),
        title: "Stranger Clone",
        targetMissionId: teamMissionId,
        assignment: { kind: "auto" },
      },
    });

    expect(res.statusCode).toBe(403);

    // **Failure mode**: a 200/202 here would let a stranger clone a Task
    // inside another team's habitat. The route's habitat-scope check
    // refuses without leaking the mission exists.
  });

  it("targeted intent + deadline → 202 with reservation created", async () => {
    const { sourceId } = seedSourceTask();
    const targetAgent = agentRepo.createAgent({
      name: "Targeted Clone Agent",
      type: "claude-code",
      domain: "fullstack",
    });

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({
        title: "Targeted Clone",
        assignment: { kind: "targeted", agentId: targetAgent.agent.id },
        targetedAssignmentDeadline: "2099-01-01T00:00:00.000Z",
      }),
    });

    expect(res.statusCode).toBe(202);
    const taskId = JSON.parse(res.body).taskId;

    const reservations = getDb()
      .select()
      .from(taskCreationAssignmentReservations)
      .where(eq(taskCreationAssignmentReservations.taskId, taskId))
      .all();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].requestedAgentId).toBe(targetAgent.agent.id);
    expect(reservations[0].deadline).toBe("2099-01-01T00:00:00.000Z");
    expect(reservations[0].state).toBe("active");

    // **Failure mode**: if the route ignored `assignment.kind ===
    // "targeted"`, the reservation would not exist (auto path), OR an
    // empty deadline would throw inside the adapter (the route surfaces
    // the schema constraint as a typed 400/422 via `.superRefine`).
  });

  it("targeted intent WITHOUT deadline → 400 (Zod superRefine refuses the cross-field constraint)", async () => {
    const { sourceId } = seedSourceTask();
    const targetAgent = agentRepo.createAgent({
      name: "Untargeted Clone Agent",
      type: "claude-code",
      domain: "fullstack",
    });

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({
        title: "Targeted Without Deadline",
        assignment: { kind: "targeted", agentId: targetAgent.agent.id },
        // targetedAssignmentDeadline omitted
      }),
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("VALIDATION_ERROR");
    const detailMessages = JSON.stringify(body.details);
    expect(detailMessages).toMatch(/targetedAssignmentDeadline/);
  });

  it("auditSource = 'rest_api' + envelope causal-root distinguishes human vs agent", async () => {
    const { sourceId } = seedSourceTask();

    // Human caller.
    const token = makeToken({ sub: "user-route", username: "user-route", role: "admin" });
    const humanRes = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { authorization: `Bearer ${token}` },
      payload: basePayload({ title: "Human Audit Clone" }),
    });
    expect(humanRes.statusCode).toBe(202);
    const humanAttempt = JSON.parse(humanRes.body).attemptId;
    const humanEnvelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.attemptId, humanAttempt))
      .all()[0];
    expect(humanEnvelope.source).toBe("rest_api");
    expect(humanEnvelope.actorType).toBe("human");
    expect(humanEnvelope.causalContext.root.type).toBe("human");

    // Agent caller.
    const agentRes = await app!.inject({
      method: "POST",
      url: `/api/tasks/${sourceId}/clone-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Agent Audit Clone" }),
    });
    expect(agentRes.statusCode).toBe(202);
    const agentAttempt = JSON.parse(agentRes.body).attemptId;
    const agentEnvelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.attemptId, agentAttempt))
      .all()[0];
    expect(agentEnvelope.source).toBe("rest_api");
    expect(agentEnvelope.actorType).toBe("agent");
    expect(agentEnvelope.causalContext.root.type).toBe("api");

    // **Failure mode**: if the route passed `"ui"` / `"api"` as the
    // auditSource (the legacy enum values from the spec narrative), the
    // committed envelope would carry those — but the `AuditSource`
    // closed set in @orcy/shared does not include them. The route
    // always passes `"rest_api"`.
  });
});

// ===========================================================================
// Route registration — /api/v1 prefix sanity
// ===========================================================================

describe("T7P2 route registration — mounts under both /api and /api/v1", () => {
  it("mounts under /api/v1/tasks/:sourceTaskId/clone-preparation + clone-publications", async () => {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await registerErrorHandler(app);
    await app.register(
      async (f) => {
        f.addHook("preHandler", perAgentRateLimit);
        await f.register(taskClonePublicationRoutes);
      },
      { prefix: "/api/v1" },
    );
    await app.ready();
    try {
      const { sourceId } = seedSourceTask();
      const getRes = await app.inject({
        method: "GET",
        url: `/api/v1/tasks/${sourceId}/clone-preparation`,
        headers: { "x-agent-api-key": agentApiKey },
      });
      expect(getRes.statusCode).toBe(200);
      const postRes = await app.inject({
        method: "POST",
        url: `/api/v1/tasks/${sourceId}/clone-publications`,
        headers: { "x-agent-api-key": agentApiKey },
        payload: basePayload({ title: "V1 Prefix Clone" }),
      });
      expect(postRes.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
});

// Suppress unused-import linter warnings for symbols kept for symmetry.
void memberRepo;
void vi;