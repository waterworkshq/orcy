/**
 * T5 Phase 3 — POST /tasks/:taskId/assignment-attempts (assignment-retry route)
 * + GET /task-creation-attempts/:attemptId projection extension.
 *
 * Additive. DORMANT in production (the route is gated behind
 * `ORCY_CREATION_PUBLICATION_ENABLED` until T11 cutover — see
 * `config/creationPublicationCutover.ts` + `routes/tasks/index.ts`). These
 * tests register the route DIRECTLY (bypassing the gate) to exercise the
 * load-bearing HTTP contract:
 *
 * Fix-P1 (C1) added TWO route-layer guards (independent of the gate):
 *   - Authority: agent callers → 403 (`AGENT_CANNOT_ASSIGN`). Explicit
 *     assignment is admin-only (mirror `batch.ts:26-29`); agents must claim
 *     for themselves via `POST /tasks/:id/claim`.
 *   - `created_unassigned` check: the route resolves taskId →
 *     taskCreationEnvelopes → taskCreationAttempts and REQUIRES
 *     `state === "created_unassigned"`. Legacy/ordinary Tasks (no creation
 *     attempt), still-recovering attempts, and already-`created` attempts →
 *     409 `not_retryable`. Closes the "assign ANY pending task" bypass.
 *
 * The happy-path tests (1-3) authenticate as a HUMAN admin (the retry route
 * is admin-only post-Fix-P1) and seed a `created_unassigned` creation trail
 * (the precondition the guard requires).
 *
 *   1. Idempotent success → lost: first call assigns to agent A; second call
 *      returns `{outcome:"lost", currentAssignee:{kind:"local", id:A}}` (no
 *      double-assign, no error).
 *   2. Lost after reservation release: task already claimed by agent B →
 *      retry for A returns `{outcome:"lost", currentAssignee:{B}}`.
 *   3. Refusal: ineligible requested agent (e.g. dependencies_unmet) → typed
 *      refusal 403 (category/reason preserved in body).
 *   4. not_found → 404.
 *   5. Authority: agent caller → 403.
 *   6-8. created_unassigned guard: no trail / recovering / created → 409.
 *   9. Anonymous → 401.
 *   10. Human without habitat membership → 403 (R4 cross-team isolation).
 *
 * Projection: `GET /task-creation-attempts/:id` surfaces the
 *      `published_pending_assignment` checkpoint + the `created_unassigned`
 *      terminal + the `assignmentFailure` reason (refusal + deadline_exceeded).
 *
 * Out of scope: the coordinator, the sweeper, `claimWithAuthority` primitives
 * (covered in `taskCreationAssignmentCoordinator.test.ts` +
 * `claimAuthority.test.ts`).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { eq } from "drizzle-orm";
import { tasks, taskCreationAttempts, taskCreationEnvelopes, users } from "../db/schema/index.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as organizationRepo from "../repositories/organization.js";
import * as taskRepo from "../repositories/taskCrud.js";
import { addTaskDependency } from "../repositories/dependency.js";
import { taskAssignmentRoutes } from "../routes/tasks/assignment.js";
import { taskCreationAttemptRoutes } from "../routes/taskCreationAttempts.js";
import { registerErrorHandler } from "../errors/plugin.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

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
      await f.register(taskAssignmentRoutes);
      await f.register(taskCreationAttemptRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

function seedAgent(name: string) {
  return agentRepo.createAgent({
    name,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
}

function seedPendingTask(title: string): { taskId: string } {
  const columnId = columnRepo.getColumnsByHabitatId(habitatId)[0].id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: `${title}-mission`,
    createdBy: "user-1",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title,
    createdBy: "user-1",
  });
  return { taskId: task.id };
}

/**
 * Seeds the post-cutover creation trail for `taskId` that the retry route's
 * `created_unassigned` guard requires: a `taskCreationAttempts` row at
 * `attemptState` + a `taskCreationEnvelopes` row linking the task to that
 * attempt. Mirrors `claimAuthority.test.ts:seedCreationEnvelope`.
 *
 * Fix-P1: the retry route now resolves taskId → envelope → attempt and
 * REQUIRES `state === "created_unassigned"` — tests must seed this trail to
 * reach the claim path (previously the route assigned ANY pending task).
 */
function seedCreationTrail(
  taskId: string,
  attemptState:
    | "created_unassigned"
    | "published_pending_assignment"
    | "published_pending_observation"
    | "created",
  suffix?: string,
): { attemptId: string; envelopeId: string } {
  const sfx = suffix ?? `trail-${Math.random().toString(36).slice(2, 8)}`;
  const attemptId = `attempt-${sfx}`;
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id: attemptId,
      source: "test",
      sourceScopeKind: "mission",
      sourceScopeId: "m-retry",
      attemptKey: `key-${sfx}`,
      requestFingerprint: `fp-${sfx}`,
      publicationKind: "create",
      habitatId,
      actorType: "human",
      actorId: "user-1",
      state: attemptState,
      terminalOutcome: attemptState === "created_unassigned" ? "assignment_refused" : null,
      completedAt: attemptState === "created_unassigned" ? new Date().toISOString() : null,
    })
    .run();
  const envelopeId = `env-${sfx}`;
  getDb()
    .insert(taskCreationEnvelopes)
    .values({
      eventId: envelopeId,
      lifecycleAction: "created",
      taskId,
      habitatId,
      occurredAt: new Date().toISOString(),
      attemptId,
      actorType: "human",
      actorId: "user-1",
      source: "test",
    })
    .run();
  return { attemptId, envelopeId };
}

let habitatId: string;
let agentApiKey: string;
let humanToken: string;

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Assignment Retry Habitat" });
  habitatId = habitat.id;
  columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });
  ensureUser("user-1", "user-1");
  const created = seedAgent("Seed Agent");
  agentApiKey = created.plainApiKey;
  // Fix-P1: the retry route is now admin-only (agents → 403). Tests that
  // exercise the happy/claim path authenticate as a human admin.
  humanToken = makeToken({ sub: "user-1", username: "user-1", role: "admin" });
});

afterEach(async () => {
  closeDb();
});

describe("POST /tasks/:taskId/assignment-attempts", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  // ------------------------------------------------------------------------
  // 1. Idempotent success → lost
  // ------------------------------------------------------------------------

  it("assigns the task on the first call and reports `lost` (currentAssignee) on the second", async () => {
    const a1 = seedAgent("a1");
    const { taskId } = seedPendingTask("idem");
    // Fix-P1: the retry route requires a `created_unassigned` creation trail.
    seedCreationTrail(taskId, "created_unassigned", "idem");

    // First call → assigned (human admin retry-assigns to a1).
    const first = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody).toEqual({
      outcome: "assigned",
      taskId,
      assigneeId: a1.agent.id,
    });
    // Task now claimed by a1.
    const taskRow = getDb().select().from(tasks).where(eq(tasks.id, taskId)).get();
    expect(taskRow?.assignedAgentId).toBe(a1.agent.id);
    expect(taskRow?.status).toBe("claimed");

    // Second call (same identity) → idempotent lost.
    const second = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);
    expect(secondBody).toEqual({
      outcome: "lost",
      taskId,
      currentAssignee: { kind: "local", id: a1.agent.id },
    });

    // **Failure mode**: if the route re-ran the mutation on the second call,
    // version would bump twice and the assignee would flip-flop. The
    // authority's `already_claimed` + the route's `lost` mapping preserve the
    // first assignment as idempotent.
  });

  // ------------------------------------------------------------------------
  // 2. Lost after reservation release (B already won)
  // ------------------------------------------------------------------------

  it("returns `lost` with the current assignee when another agent already holds the claim", async () => {
    const a1 = seedAgent("a1");
    const b1 = seedAgent("b1");
    const { taskId } = seedPendingTask("already-taken");
    seedCreationTrail(taskId, "created_unassigned", "already-taken");

    // B claims first via the same retry route.
    const bClaim = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: b1.agent.id },
    });
    expect(bClaim.statusCode).toBe(200);

    // A retries → lost with B as current assignee.
    const aRetry = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });
    expect(aRetry.statusCode).toBe(200);
    const body = JSON.parse(aRetry.body);
    expect(body.outcome).toBe("lost");
    expect(body.currentAssignee).toEqual({ kind: "local", id: b1.agent.id });

    // **Failure mode**: if the retry tried to "steal" the claim or surfaced
    // already_claimed as a 409, the caller would have to interpret a typed
    // refusal — the P3 contract says "report current assignee when retry
    // loses after reservation release".
  });

  // ------------------------------------------------------------------------
  // 3. Refusal — typed refusal with category + reason preserved
  // ------------------------------------------------------------------------

  it("returns a typed refusal 403 when the requested agent is ineligible", async () => {
    const a1 = seedAgent("a1");
    // Seed a blocker so the task has an unmet dependency.
    const { task: blocker } = (() => {
      const columnId = columnRepo.getColumnsByHabitatId(habitatId)[0].id;
      const mission = missionRepo.createMission({
        habitatId,
        columnId,
        title: "blocker-mission",
        createdBy: "user-1",
      });
      const blockerTask = taskRepo.createTask({
        missionId: mission.id,
        title: "blocker",
        createdBy: "user-1",
      });
      return { task: blockerTask };
    })();
    const { taskId } = seedPendingTask("refused");
    seedCreationTrail(taskId, "created_unassigned", "refused");
    addTaskDependency(taskId, blocker.id); // → dependencies_unmet → ineligible

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    // AppError envelope shape: error + code (category uppercased) + details.
    expect(body.code).toBe("INELIGIBLE");
    expect(body.details).toMatchObject({
      category: "ineligible",
      reason: "dependencies_unmet",
    });

    // **Failure mode**: if the route collapsed `ineligible` into a generic
    // 409 or omitted the category/reason, the UI couldn't distinguish
    // dependencies_unmet from capability_mismatch — the P3 contract demands
    // typed refusal preservation.
  });

  // ------------------------------------------------------------------------
  // 4. not_found
  // ------------------------------------------------------------------------

  it("returns 404 for a missing task", async () => {
    const a1 = seedAgent("a1");

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/does-not-exist/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });

    expect(res.statusCode).toBe(404);

    // **Failure mode**: a raw 500 would surface if the route used the
    // authority directly without first resolving the task — the authority's
    // `not_found` is a typed value, but the route's pre-handler SELECT
    // produces a typed 404 BEFORE the call.
  });

  // ------------------------------------------------------------------------
  // 5. Authority guard — agent caller → 403 (Fix-P1 / C1)
  // ------------------------------------------------------------------------

  it("returns 403 when an AGENT calls the route (explicit assignment is admin-only)", async () => {
    const a1 = seedAgent("a1");
    const { taskId } = seedPendingTask("agent-blocked");
    seedCreationTrail(taskId, "created_unassigned", "agent-blocked");

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { "x-agent-api-key": agentApiKey },
      payload: { requestedAgentId: a1.agent.id },
    });

    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("AGENT_CANNOT_ASSIGN");
    expect(body.error).toMatch(/admin-only/i);

    // **Failure mode**: pre-Fix-P1 the route let agents explicitly assign to
    // an arbitrary requestedAgentId — bypassing the admin-only authority
    // rule enforced in `batch.ts:26-29`. Agents must claim via
    // `POST /tasks/:id/claim`, not assign to others.
  });

  // ------------------------------------------------------------------------
  // 6. created_unassigned guard — no creation attempt → 409 (Fix-P1 / C1)
  // ------------------------------------------------------------------------

  it("returns 409 when the task has NO linked creation attempt (legacy/ordinary Task)", async () => {
    const a1 = seedAgent("a1");
    const { taskId } = seedPendingTask("no-trail");
    // Deliberately do NOT seed a creation trail — this is an ordinary legacy
    // Task (the bypass the cold review identified).

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.details).toMatchObject({
      category: "not_retryable",
      reason: "no_creation_attempt",
    });

    // **Failure mode**: pre-Fix-P1 the route assigned ANY pending Task — a
    // legacy Task with no publication attempt was assignable, creating a
    // POST_CUTOVER-shaped assignment on pre-cutover state. The guard rejects
    // unless the task has a `created_unassigned` creation trail.
  });

  // ------------------------------------------------------------------------
  // 7. created_unassigned guard — attempt still recovering → 409
  // ------------------------------------------------------------------------

  it("returns 409 when the attempt is still recovering (published_pending_assignment)", async () => {
    const a1 = seedAgent("a1");
    const { taskId } = seedPendingTask("recovering");
    seedCreationTrail(taskId, "published_pending_assignment", "recovering");

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.details).toMatchObject({
      category: "not_retryable",
      reason: "attempt_state_published_pending_assignment",
    });

    // **Failure mode**: a task whose attempt is still in-flight must not be
    // retry-assigned — the coordinator owns the pending→terminal transition.
    // Only `created_unassigned` (coordinator released the gate) is retryable.
  });

  // ------------------------------------------------------------------------
  // 8. created_unassigned guard — attempt already `created` → 409
  // ------------------------------------------------------------------------

  it("returns 409 when the attempt already terminalized to `created`", async () => {
    const a1 = seedAgent("a1");
    const { taskId } = seedPendingTask("already-created");
    seedCreationTrail(taskId, "created", "already-created");

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });

    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.details).toMatchObject({
      category: "not_retryable",
      reason: "attempt_state_created",
    });

    // **Failure mode**: a task whose creation attempt already succeeded
    // (`created`) was already assigned — retrying is a replay, not a fresh
    // claim. The guard surfaces it as 409 (not retryable).
  });

  // ------------------------------------------------------------------------
  // 9. Authorization — no auth → 401
  // ------------------------------------------------------------------------

  it("anonymous POST returns 401 (agentOrHumanAuth blocks)", async () => {
    const { taskId } = seedPendingTask("anon");

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${taskId}/assignment-attempts`,
      payload: { requestedAgentId: "x" },
    });

    expect(res.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------------
  // 10. Human auth + no habitat membership → 403 (no leak across team/habitat)
  // ------------------------------------------------------------------------

  it("human WITHOUT habitat membership gets 403 (R4 cross-team isolation)", async () => {
    const org = organizationRepo.createOrganization({ name: "P3 Org", slug: "p3-org" });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "P3 Team",
      slug: "p3-team",
    });
    // Task lives in a TEAM habitat (the default habitatId has no team — let's
    // create one that does).
    const teamHabitat = habitatRepo.createHabitat({
      name: "P3 Team Habitat",
      teamId: team.id,
    });
    columnRepo.createColumn({
      habitatId: teamHabitat.id,
      name: "P3 Todo",
      order: 0,
      requiresClaim: false,
    });
    const columnId = columnRepo.getColumnsByHabitatId(teamHabitat.id)[0].id;
    const mission = missionRepo.createMission({
      habitatId: teamHabitat.id,
      columnId,
      title: "P3 Mission",
      createdBy: "user-1",
    });
    const task = taskRepo.createTask({
      missionId: mission.id,
      title: "P3 Task",
      createdBy: "user-1",
    });

    ensureUser("user-stranger", "user-stranger");
    // user-stranger is NOT a member of team.
    const token = makeToken({ sub: "user-stranger", username: "stranger", role: "member" });

    const res = await app!.inject({
      method: "POST",
      url: `/api/tasks/${task.id}/assignment-attempts`,
      headers: { authorization: `Bearer ${token}` },
      payload: { requestedAgentId: "some-agent" },
    });

    expect(res.statusCode).toBe(403);

    // **Failure mode**: pre-R4 / pre-P3 the route was authenticated-only; a
    // stranger could trigger an attempt against a team-private task. P3's
    // habitat-scope check refuses without leaking the task exists.
  });
});

// ===========================================================================
// Projection — GET /task-creation-attempts/:attemptId surfaces
// `published_pending_assignment` checkpoint + `created_unassigned` terminal +
// `assignmentFailure` reason.
// ===========================================================================

describe("GET /task-creation-attempts/:attemptId — assignment-recovery projection", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  function seedAttempt(opts: {
    state: "published_pending_assignment" | "created_unassigned";
    terminalOutcome?: string | null;
    terminalResult?: unknown;
  }): string {
    const id = `attempt-${Math.random().toString(36).slice(2, 8)}`;
    getDb()
      .insert(taskCreationAttempts)
      .values({
        id,
        source: "test",
        sourceScopeKind: "mission",
        sourceScopeId: "m-p3",
        attemptKey: `key-${id}`,
        requestFingerprint: `fp-${id}`,
        publicationKind: "create",
        habitatId,
        actorType: "human",
        actorId: "user-1",
        state: opts.state,
        terminalOutcome: opts.terminalOutcome ?? null,
        terminalResult: (opts.terminalResult ?? null) as never,
        completedAt: opts.state === "created_unassigned" ? new Date().toISOString() : null,
      })
      .run();
    return id;
  }

  it("surfaces the `published_pending_assignment` checkpoint (in-flight recovery state)", async () => {
    const id = seedAttempt({ state: "published_pending_assignment" });

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe("published_pending_assignment");
    expect(body.terminalOutcome).toBeNull();
    expect(body.terminalResult).toBeNull();

    // **Failure mode**: a projection that dropped `state` would force the
    // UI to read the raw `terminalOutcome` to distinguish "in-flight" from
    // "settled" — the recovery surface must arrive verbatim.
  });

  it("surfaces the `created_unassigned` terminal + the `assignmentFailure` reason (refusal)", async () => {
    const id = seedAttempt({
      state: "created_unassigned",
      terminalOutcome: "assignment_refused",
      terminalResult: {
        outcome: "assignment_refused",
        attemptId: "ignored",
        taskId: "t-1",
        assignmentFailure: { category: "ineligible", reason: "dependencies_unmet" },
      },
    });

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe("created_unassigned");
    expect(body.terminalOutcome).toBe("assignment_refused");
    expect(body.terminalResult.assignmentFailure).toEqual({
      category: "ineligible",
      reason: "dependencies_unmet",
    });

    // **Failure mode**: if `terminalResult` were dropped by `rowToStatus`, the
    // retry UI couldn't surface WHY the attempt settled refused — the P3
    // contract demands the projection carry the typed reason.
  });

  it("surfaces the `deadline_exceeded` terminal with the deadline failure reason", async () => {
    const id = seedAttempt({
      state: "created_unassigned",
      terminalOutcome: "assignment_deadline_exceeded",
      terminalResult: {
        outcome: "assignment_deadline_exceeded",
        attemptId: "ignored",
        taskId: "t-2",
        assignmentFailure: { reason: "deadline_exceeded" },
      },
    });

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.state).toBe("created_unassigned");
    expect(body.terminalOutcome).toBe("assignment_deadline_exceeded");
    expect(body.terminalResult.assignmentFailure).toEqual({ reason: "deadline_exceeded" });
  });
});

// ===========================================================================
// Sanity: route registered under both /api and /api/v1 (mirrors index.ts
// registerApiRoutes indirection).
// ===========================================================================

describe("Route registration — /api/v1 prefix", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await registerErrorHandler(app);
    await app.register(
      async (f) => {
        f.addHook("preHandler", perAgentRateLimit);
        await f.register(taskAssignmentRoutes);
      },
      { prefix: "/api/v1" },
    );
    await app.ready();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("mounts under /api/v1/tasks/:taskId/assignment-attempts", async () => {
    const a1 = seedAgent("a1");
    const { taskId } = seedPendingTask("v1");
    seedCreationTrail(taskId, "created_unassigned", "v1");

    const res = await app!.inject({
      method: "POST",
      url: `/api/v1/tasks/${taskId}/assignment-attempts`,
      headers: { authorization: `Bearer ${humanToken}` },
      payload: { requestedAgentId: a1.agent.id },
    });
    expect(res.statusCode).toBe(200);
  });
});
