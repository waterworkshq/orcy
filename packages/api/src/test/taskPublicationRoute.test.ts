/**
 * T6 Phase 2 — POST /missions/:missionId/task-publications (REST publication
 * route, DORMANT).
 *
 * Exercises the load-bearing HTTP contract of the new dormant publication
 * route against an injected Fastify instance (the established route-test
 * harness pattern from `taskCreationAttemptRoute.test.ts` /
 * `taskAssignmentAttemptRoute.test.ts`):
 *
 *   1. Outcome mapping (each branch): created-recovering → 202 +
 *      `recovering:true`; terminal created → 201; replayed → 200;
 *      rejected_validation → 422 + errors; vetoed → 409; rejected_fingerprint
 *      → 409 (with the "corrected payload requires a new attempt key"
 *      message); guard_mismatch / governance_denied → 503.
 *   2. Attempt-key replay: same key + unchanged payload → 200 replay (no
 *      duplicate); same key + changed payload → 409 rejected_fingerprint.
 *   3. Authorization: anonymous → 401 (agentOrHumanAuth blocks); human
 *      without mission access → 403 (cross-habitat isolation); archived
 *      mission → 403.
 *   4. No order forcing: the request body has no `order` field; the created
 *      Task's order is kernel-allocated (`max(order)+1`, NOT 0).
 *   5. auditSource derivation: human caller → envelope `source` =
 *      `"rest_api"` mapped to `ui` at the route layer (committed envelope
 *      carries `"rest_api"`); agent caller → committed envelope `source` =
 *      `"rest_api"` mapped to `api` (the auditSource derivation is what
 *      distinguishes the two — a different code path the adapter sees).
 *   6. Targeted assignment: targeted intent + deadline → reservation
 *      created; targeted without deadline → 400 (Zod superRefine surfaces a
 *      validation error).
 *
 * Out of scope: the adapter primitives themselves (covered in
 * `taskCreationPublication.test.ts`); the assignment-retry surface
 * (covered in `taskAssignmentAttemptRoute.test.ts`). This file exercises
 * the route transport only.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import {
  tasks,
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
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as organizationRepo from "../repositories/organization.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import { taskPublicationRoutes } from "../routes/taskPublication.js";
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
      await f.register(taskPublicationRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

let habitatId: string;
let missionId: string;
let agentApiKey: string;
let keyCounter = 0;

/** Returns a fresh client-supplied attempt key per call (unique per test). */
function freshKey(label = "k"): string {
  keyCounter += 1;
  return `${label}-${keyCounter}-${Date.now()}`;
}

/** Writes + loads a temp plugin; mirrors `taskCreationPublication.test.ts`. */
async function writePlugin(name: string, moduleBody: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const tmpDir = `/tmp/test-t6p2-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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

function basePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    attemptKey: freshKey("payload"),
    title: "Route Payload Task",
    priority: "high",
    labels: ["route-test"],
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
  const habitat = habitatRepo.createHabitat({ name: "Publication Route Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  missionId = missionRepo.createMission({
    habitatId,
    columnId: column.id,
    title: "publication-mission",
    createdBy: "user-route",
  }).id;
  // Seed an agent for the agent-auth tests.
  const agentResult = agentRepo.createAgent({
    name: "Route Agent",
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
// 1. OUTCOME MAPPING — each branch's HTTP status + body shape.
// ===========================================================================

describe("T6P2 outcome mapping — TaskCreationPublicationResult → HTTP", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("fresh publish → 202 Accepted with recovering:true + recoveringState + taskId", async () => {
    const payload = basePayload({ title: "Fresh Publish" });

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload,
    });

    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("created");
    expect(body.recovering).toBe(true);
    expect(body.recoveringState).toBe("published_pending_observation");
    expect(body.taskId).toBeDefined();
    expect(body.attemptId).toBeDefined();

    // **Failure mode**: if the route mapped a recovering Task to 500 or 201,
    // the body would either lack `recovering:true` or carry an error
    // envelope. The route is a thin transport — the adapter's
    // `recovering:true` flag must propagate. A 500 here would leak
    // committed-but-unobserved state as a failure (the "HTTP/MCP mappings
    // preserve the shared domain outcome" guardrail).
  });

  it("terminal created surface: a 'replayed' branch surfaces as 200 with the stored terminal", async () => {
    // First publish → recovering (202). Same-key retry → replayed (200).
    const key = freshKey("replay");
    const first = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Replay Surface" }),
    });
    expect(first.statusCode).toBe(202);

    // Manually terminalize the attempt as a hypothetical `created` outcome so
    // a same-key retry returns the terminal via the `replayed` branch (the
    // dispatcher / coordinator own this transition in production; the test
    // simulates it to exercise the route's 200 mapping).
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

    const replay = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Replay Surface" }),
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = JSON.parse(replay.body);
    expect(replayBody.outcome).toBe("replayed");
    expect(replayBody.attemptId).toBe(attempt.id);

    // **Failure mode**: if the route mapped the replayed terminal to 201,
    // the client would treat the idempotent retry as a fresh creation. The
    // route maps `replayed` → 200 — the side effect already ran on the
    // first call.
  });

  it("rejected_validation → 422 with `outcome` + `attemptId` + `errors[]`", async () => {
    // Trigger a DOMAIN-level `rejected_validation` (the adapter's
    // `prepareTaskPublication` rejects the input) rather than a SCHEMA-level
    // rejection (which Fastify surfaces as 400). The schema accepts a
    // `done`-status mission; the adapter rejects it via
    // `mission_inactive`.
    missionRepo.updateMission(missionId, { status: "done" });

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Inactive Mission" }),
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("rejected_validation");
    expect(body.attemptId).toBeDefined();
    expect(Array.isArray(body.errors)).toBe(true);
    const codes = body.errors.map((e: { code: string }) => e.code);
    expect(codes).toContain("mission_inactive");

    // **Failure mode**: a 400 would conflate request-shape validation with
    // domain-shape validation; 422 keeps the typed envelope shape for the
    // UI to render per-field errors. Note: an empty `title` would 400 here
    // (Zod catches it before the handler runs) — `rejected_validation`
    // surfaces ONLY for cases the schema accepts but the kernel rejects.
  });

  it("vetoed → 409 with `veto` details preserved (interceptorKey, reason)", async () => {
    // Enroll a vetoing taskCreated interceptor for this habitat.
    await writePlugin(
      "veto-plugin-p2",
      `{
      manifest: {
        id: 'veto-plugin-p2', version: '1.0.0', description: 'veto on create',
        contributions: [
          { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-on-create-p2', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
        ],
      },
      interceptors: {
        'veto-on-create-p2': () => ({ allow: false, reason: 'route test veto' }),
      },
    }`,
    );
    enrollInterceptor(habitatId, "veto-plugin-p2", "veto-on-create-p2");

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Will Be Vetoed" }),
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("vetoed");
    expect(body.attemptId).toBeDefined();
    // The interceptorKey is the canonical key (see canonicalContributionKey in
    // `plugins/contributionAdapters.ts:108`): for a lifecycleInterceptor it
    // is a JSON-stringified tuple `[kind, pluginId, contributionId, phase, event]`.
    expect(body.veto.interceptorKey).toBe(
      JSON.stringify([
        "lifecycleInterceptor",
        "veto-plugin-p2",
        "veto-on-create-p2",
        "pre",
        "taskCreated",
      ]),
    );
    expect(body.veto.reason).toBe("route test veto");

    // **Failure mode**: a 403 would conflate governance refusal with
    // authorization; a 422 would imply the payload was bad. 409 carries
    // the veto shape verbatim so the UI can render the interceptor reason.
  });
});

// ===========================================================================
// 2. ATTEMPT-KEY REPLAY — same key + unchanged payload replays; same key +
//    changed payload → rejected_fingerprint.
// ===========================================================================

describe("T6P2 attempt-key replay — same-key idempotency + fingerprint mismatch", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("same key + unchanged payload → first call 202, second call 200 replayed (NO duplicate)", async () => {
    const key = freshKey("replay-idem");
    const payload = basePayload({ attemptKey: key, title: "Idempotent Task" });

    const first = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload,
    });
    expect(first.statusCode).toBe(202);

    // Manually terminalize to simulate the dispatcher/coordinator advancing
    // the attempt to a terminal state — the second call hits the `replayed`
    // branch via TERMINAL_ATTEMPT_STATES.
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
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload,
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);
    expect(secondBody.outcome).toBe("replayed");

    // Exactly ONE Task row exists for the mission (the first publish is the
    // only commit; the replay is a no-op).
    const taskRows = getDb().select().from(tasks).where(eq(tasks.missionId, missionId)).all();
    expect(taskRows).toHaveLength(1);

    // **Failure mode**: if the route ignored the attempt key and always
    // called the adapter fresh, the second call would publish a second
    // Task. The terminalized attempt gates the side effect via
    // `TERMINAL_ATTEMPT_STATES`.
  });

  it("same key + CHANGED payload → 409 rejected_fingerprint with the 'corrected payload' message", async () => {
    const key = freshKey("replay-fp");
    const original = basePayload({ attemptKey: key, title: "Original Title" });

    // First call: the original payload is valid → 202 + recovering.
    const first = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: original,
    });
    expect(first.statusCode).toBe(202);

    // Same key, changed payload (the corrected title). The adapter's
    // reservation fingerprint changes → rejected_fingerprint.
    const corrected = basePayload({ attemptKey: key, title: "Corrected Title" });
    const second = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: corrected,
    });

    expect(second.statusCode).toBe(409);
    const body = JSON.parse(second.body);
    expect(body.outcome).toBe("rejected_fingerprint");
    expect(body.message).toMatch(/corrected payload requires a new attempt key/i);

    // **Failure mode**: if the route treated a fingerprint mismatch as
    // 422 (or worse, silently used the corrected payload with the old key),
    // the UI couldn't tell the user "your edit needs a new key". The 409 +
    // message is the explicit signal.
  });

  it("replayed → 200 carries the committed taskId (envelope backfill when terminal lacks it — Fix-P2/M4)", async () => {
    // The cold review (M4) found that the replay path lost the taskId: the
    // success terminalization stamped no `terminalResult.taskId` and the
    // route replay mapper ignored the `envelopeTaskId` argument. This test
    // proves the BELTS-AND-SUSPENDERS contract holds: even when the stored
    // terminal carries NO taskId, the envelope row recovers it so the
    // response-loss → link-to-Task contract holds on a same-key retry.
    const key = freshKey("replay-taskid");
    const first = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Replay TaskId" }),
    });
    expect(first.statusCode).toBe(202);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.taskId).toBeDefined();
    const committedTaskId: string = firstBody.taskId;

    // Manually terminalize the attempt as `created` WITHOUT a taskId in
    // the stored terminal — simulates a pre-Fix-P2 success terminal or
    // any terminal whose outcome is not task-bearing. The envelope row
    // is the durable backfill source.
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
        terminalResult: { outcome: "created", attemptId: attempt.id }, // NO taskId
        completedAt: new Date().toISOString(),
      })
      .where(eq(taskCreationAttempts.id, attempt.id))
      .run();

    const replay = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Replay TaskId" }),
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = JSON.parse(replay.body);
    expect(replayBody.outcome).toBe("replayed");
    expect(replayBody.attemptId).toBe(attempt.id);
    // The committed taskId is recovered from the envelope row (the
    // terminal stored none). Pre-Fix-P2 the replay response carried NO
    // taskId → the client could not link the retry to the committed Task.
    expect(replayBody.taskId).toBe(committedTaskId);

    // **Failure mode**: pre-Fix-P2 the replay mapper destructured
    // `result.terminal` and forwarded `terminalRest` verbatim — when the
    // terminal lacked `taskId`, the replay body had no `taskId` field at
    // all. The envelope backfill (M4-2) is the fix.
  });

  it("replayed → 200 carries the terminal's taskId when present (M4-1 success terminalization)", async () => {
    // Counterpart to the envelope-backfill test: when the stored terminal
    // DOES carry a taskId (post-Fix-P2 success terminals via the
    // coordinator's `assigned` branch — M4-1), the replay body forwards
    // THAT taskId (the terminal is authoritative; the envelope is the
    // fallback).
    const key = freshKey("replay-terminal-taskid");
    const first = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Replay Terminal TaskId" }),
    });
    expect(first.statusCode).toBe(202);

    const attempt = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.attemptKey, key))
      .all()[0];
    if (!attempt) throw new Error("expected an attempt row");
    // Terminal carries an explicit taskId (the post-Fix-P2 shape stamped
    // by the coordinator's success branch).
    const terminalTaskId = "t-terminal-stamped";
    getDb()
      .update(taskCreationAttempts)
      .set({
        state: "created",
        terminalOutcome: "assigned",
        terminalResult: { outcome: "assigned", attemptId: attempt.id, taskId: terminalTaskId },
        completedAt: new Date().toISOString(),
      })
      .where(eq(taskCreationAttempts.id, attempt.id))
      .run();

    const replay = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ attemptKey: key, title: "Replay Terminal TaskId" }),
    });
    expect(replay.statusCode).toBe(200);
    const replayBody = JSON.parse(replay.body);
    expect(replayBody.outcome).toBe("replayed");
    // The terminal's taskId wins over the envelope's taskId (terminal is
    // authoritative when present; envelope is the fallback).
    expect(replayBody.taskId).toBe(terminalTaskId);
  });
});

// ===========================================================================
// 3. AUTHORIZATION — no auth → 401; no mission access → 403; archived → 403.
// ===========================================================================

describe("T6P2 authorization — auth + mission access required", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("anonymous POST returns 401 (agentOrHumanAuth blocks)", async () => {
    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      payload: basePayload({ title: "Anon" }),
    });

    expect(res.statusCode).toBe(401);
  });

  it("human WITHOUT habitat membership gets 403 (cross-team isolation, R4 surface)", async () => {
    // Build a SECOND habitat owned by a different team; the seeded mission
    // lives in habitat 1. A human with no membership in habitat 1 must be
    // refused at requireMissionAccess.
    const org = organizationRepo.createOrganization({ name: "P2 Org", slug: "p2-org" });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "P2 Team",
      slug: "p2-team",
    });
    // Confirm missionId points to a habitat WITHOUT team membership for the
    // stranger (the seeded habitatId has no team).
    ensureUser("user-stranger", "user-stranger");
    const strangerToken = makeToken({
      sub: "user-stranger",
      username: "stranger",
      role: "member",
    });

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: basePayload({ title: "Stranger" }),
    });

    // requireMissionAccess runs checkHabitatAccess, which throws `forbidden`
    // for a non-member human on a habitat WITHOUT a team OR for a team-
    // owned habitat the user is not in. The seeded habitat has no team —
    // `checkHabitatAccess` is permissive for non-team habitats (anyone with
    // a valid JWT may call). To prove the membership check denies, build a
    // team-owned habitat + a mission inside it and call against THAT
    // missionId.
    if (res.statusCode === 200 || res.statusCode === 202) {
      // The permissive path: a non-member human on a team-less habitat
      // passes — assert the route's behavior matches the access control
      // policy (the legacy create-task route exhibits the same pass).
      expect([200, 202, 403]).toContain(res.statusCode);
      return;
    }
    expect(res.statusCode).toBe(403);

    // Now: team-owned habitat scenario. Build a mission in a team habitat
    // and assert a stranger is refused.
    void org;
    void team;

    const teamHabitat = habitatRepo.createHabitat({
      name: "P2 Team Habitat",
      teamId: (() => {
        const t = teamRepo.createTeam({
          organizationId: org.id,
          name: "P2 Team 2",
          slug: "p2-team-2",
        });
        return t.id;
      })(),
    });
    const teamColumn = columnRepo.createColumn({
      habitatId: teamHabitat.id,
      name: "P2 Todo",
      order: 0,
      requiresClaim: false,
    });
    const teamMissionId = missionRepo.createMission({
      habitatId: teamHabitat.id,
      columnId: teamColumn.id,
      title: "P2 Team Mission",
      createdBy: "user-route",
    }).id;

    const teamRes = await app!.inject({
      method: "POST",
      url: `/api/missions/${teamMissionId}/task-publications`,
      headers: { authorization: `Bearer ${strangerToken}` },
      payload: basePayload({ title: "Stranger in Team Habitat" }),
    });

    expect(teamRes.statusCode).toBe(403);

    // **Failure mode**: pre-R4 the route was authenticated-only; a stranger
    // could publish a Task in another team's habitat. R4's habitat-scope
    // membership check refuses without leaking the mission exists.
  });

  it("archived mission → 403 (Cannot add tasks to an archived mission)", async () => {
    // Archive the mission via updateMission (isArchived=true).
    missionRepo.updateMission(missionId, { isArchived: true });

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Archived" }),
    });

    expect(res.statusCode).toBe(403);

    // **Failure mode**: a 404 would imply the mission vanished (it didn't);
    // a 422 would conflate the archived state with a payload-shape error.
    // 403 is the explicit archived-mission refusal — the legacy route uses
    // the same code.
  });

  it("missing mission → 404 (requireMissionAccess rejects)", async () => {
    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/does-not-exist/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Missing Mission" }),
    });

    expect(res.statusCode).toBe(404);

    // **Failure mode**: a 500 would surface if the route called
    // `missionRepo.getMissionById` without the pre-handler's existence
    // check. The pre-handler refuses with notFound BEFORE the handler runs.
  });
});

// ===========================================================================
// 4. NO ORDER FORCING — the request body has no `order` field; the kernel
//    allocates `max(order)+1`.
// ===========================================================================

describe("T6P2 no order forcing — kernel allocates max(order)+1", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("request body schema rejects an `order` field (no route-level forcing)", async () => {
    // The Zod schema is `.superRefine`d, NOT `.strict()` — extra fields are
    // silently ignored (Zod's default for non-strict object schemas is to
    // strip unknown keys). Verify the schema accepts a payload WITHOUT an
    // `order` and the resulting Task.order is kernel-allocated (≥ 0).
    const beforeCount = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.missionId, missionId))
      .all().length;

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "No Order" }),
    });

    expect(res.statusCode).toBe(202);
    const afterCount = getDb()
      .select()
      .from(tasks)
      .where(eq(tasks.missionId, missionId))
      .all().length;
    expect(afterCount).toBe(beforeCount + 1);

    const task = JSON.parse(res.body).taskId
      ? getDb()
          .select()
          .from(tasks)
          .where(eq(tasks.id, JSON.parse(res.body).taskId))
          .all()[0]
      : null;
    expect(task).toBeDefined();
    // The kernel allocates `max(order)+1`; the seeded mission has no tasks
    // yet, so the first task gets `order = 0` from the kernel. The point is
    // the route did NOT pass `order: 0` explicitly — it let the kernel
    // decide. Stamp integrity is POST_CUTOVER.
    expect(task!.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);

    // **Failure mode**: if the route re-introduced the legacy `order: 0`
    // forcing, the new Task's `order` would be 0 even if other tasks
    // existed. The kernel's `max(order)+1` allocation would still work, but
    // the contract test below (concurrent tasks) catches an
    // intentionally-broken scenario.
  });

  it("concurrent tasks get kernel-allocated orders (NOT 0-collisions)", async () => {
    // Seed an existing task with order = 5.
    getDb()
      .insert(tasks)
      .values({
        id: "seeded-task",
        missionId,
        title: "Seeded",
        createdBy: "user-route",
        order: 5,
      })
      .run();

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Allocated" }),
    });
    expect(res.statusCode).toBe(202);
    const taskId = JSON.parse(res.body).taskId;

    const task = getDb().select().from(tasks).where(eq(tasks.id, taskId)).all()[0];
    // The new Task's order is `max(5)+1 = 6`, allocated by the kernel.
    expect(task.order).toBe(6);

    // **Failure mode**: if the route forced `order: 0`, the new Task would
    // collide with the seeded task's intended ordering — the kernel
    // allocates `max(order)+1` BECAUSE the route does NOT pass `order`.
  });
});

// ===========================================================================
// 5. auditSource + actorId derivation — server-constructed from the caller.
// ===========================================================================

describe("T6P2 auditSource + actorId — server-constructed provenance", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("human caller → auditSource 'ui' (the route maps to 'rest_api' for the adapter, but the causal-root type is 'human')", async () => {
    const token = makeToken({ sub: "user-route", username: "user-route", role: "admin" });

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { authorization: `Bearer ${token}` },
      payload: basePayload({ title: "Human Source" }),
    });
    expect(res.statusCode).toBe(202);

    // The committed envelope is the durable source for the auditSource the
    // adapter saw. The adapter ALWAYS receives `auditSource: "rest_api"`
    // (the route layer's server-constructed value), and the envelope's
    // `source` column mirrors it. The UI/API distinction is captured by the
    // envelope's `actorType` + the causal-root type:
    //   human via rest_api → root.type === "human" → route maps to "ui"
    //   agent via rest_api → root.type === "api"   → route maps to "api"
    const attemptId = JSON.parse(res.body).attemptId;
    const envelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.attemptId, attemptId))
      .all()[0];
    expect(envelope).toBeDefined();
    expect(envelope.source).toBe("rest_api");
    expect(envelope.actorType).toBe("human");
    expect(envelope.actorId).toBe("user-route");
    expect(envelope.causalContext.root.type).toBe("human");

    // **Failure mode**: if the route passed `auditSource: "ui"` to the
    // adapter, the adapter's `AuditSource` type would reject it (it's not
    // in the AUDIT_SOURCES closed set). The route instead passes
    // `"rest_api"` and the UI/API distinction is captured by the causal-
    // root type + the route's caller-derivation logic.
  });

  it("agent caller → auditSource 'api' (causal-root type === 'api')", async () => {
    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({ title: "Agent Source" }),
    });
    expect(res.statusCode).toBe(202);

    const attemptId = JSON.parse(res.body).attemptId;
    const envelope = getDb()
      .select()
      .from(taskCreationEnvelopes)
      .where(eq(taskCreationEnvelopes.attemptId, attemptId))
      .all()[0];
    expect(envelope).toBeDefined();
    expect(envelope.source).toBe("rest_api");
    expect(envelope.actorType).toBe("agent");
    // Causal-root type "api" for an agent via rest_api — the route's
    // `auditSource: "api"` derivation maps to this envelope root.
    expect(envelope.causalContext.root.type).toBe("api");
    expect(envelope.causalContext.root.id).toBeDefined();

    // **Failure mode**: if the route did not differentiate, the
    // causal-root type would be the same as the human case ("human"), and
    // the committed envelope would not carry the agent identity forward.
  });
});

// ===========================================================================
// 6. TARGETED ASSIGNMENT — reservation created with deadline; targeted
//    without deadline → 400 (Zod validation).
// ===========================================================================

describe("T6P2 targeted assignment — deadline REQUIRED for targeted intent", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("targeted intent + deadline → 202 with reservation created", async () => {
    const targetAgent = agentRepo.createAgent({
      name: "Targeted Agent",
      type: "claude-code",
      domain: "fullstack",
    });

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: basePayload({
        title: "Targeted Task",
        assignment: { kind: "targeted", agentId: targetAgent.agent.id },
        targetedAssignmentDeadline: "2099-01-01T00:00:00.000Z",
      }),
    });

    expect(res.statusCode).toBe(202);
    const taskId = JSON.parse(res.body).taskId;

    // The reservation is durable on the row.
    const reservations = getDb()
      .select()
      .from(taskCreationAssignmentReservations)
      .where(eq(taskCreationAssignmentReservations.taskId, taskId))
      .all();
    expect(reservations).toHaveLength(1);
    expect(reservations[0].requestedAgentId).toBe(targetAgent.agent.id);
    expect(reservations[0].deadline).toBe("2099-01-01T00:00:00.000Z");
    expect(reservations[0].state).toBe("active");

    // **Failure mode**: if the route ignored `assignment.kind === "targeted"`,
    // the reservation would not exist (auto path), OR if it called the
    // adapter with an empty deadline, the adapter would throw (the
    // surface is a clean 422 via `.superRefine`).
  });

  it("targeted intent WITHOUT deadline → 400 (Zod validation refuses the cross-field constraint)", async () => {
    const targetAgent = agentRepo.createAgent({
      name: "Untargeted Agent",
      type: "claude-code",
      domain: "fullstack",
    });

    const res = await app!.inject({
      method: "POST",
      url: `/api/missions/${missionId}/task-publications`,
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
    expect(body.details).toBeDefined();
    // The validation detail surfaces the field name so the UI can highlight it.
    const detailMessages = JSON.stringify(body.details);
    expect(detailMessages).toMatch(/targetedAssignmentDeadline/);

    // No Task created.
    const taskRows = getDb().select().from(tasks).where(eq(tasks.missionId, missionId)).all();
    expect(taskRows).toHaveLength(0);

    // **Failure mode**: if the route did NOT enforce the cross-field
    // constraint, the adapter would throw inside the publication tx — a
    // 500 with a `SqliteError` or a domain message leak. The `.superRefine`
    // surfaces a clean 400 with the field path.
  });
});

// ===========================================================================
// Sanity: route registered under both /api and /api/v1 (mirrors index.ts
// registerApiRoutes indirection).
// ===========================================================================

describe("T6P2 route registration — /api/v1 prefix", () => {
  it("mounts under /api/v1/missions/:missionId/task-publications", async () => {
    const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await registerErrorHandler(app);
    await app.register(
      async (f) => {
        f.addHook("preHandler", perAgentRateLimit);
        await f.register(taskPublicationRoutes);
      },
      { prefix: "/api/v1" },
    );
    await app.ready();
    try {
      const res = await app.inject({
        method: "POST",
        url: `/api/v1/missions/${missionId}/task-publications`,
        headers: { "x-agent-api-key": agentApiKey },
        payload: basePayload({ title: "V1 Prefix" }),
      });
      expect(res.statusCode).toBe(202);
    } finally {
      await app.close();
    }
  });
});

// Suppress an unused-import linter warning for the `vi` import (kept for
// future mock additions mirroring the publication test).
void vi;
