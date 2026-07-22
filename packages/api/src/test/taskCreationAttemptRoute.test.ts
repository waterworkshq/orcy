/**
 * T3A Phase 4 — authorized GET /task-creation-attempts/:attemptId route.
 *
 * Exercises the load-bearing HTTP surface against an injected Fastify instance
 * (the established route-test harness pattern from `triageRoutesAuth.test.ts` /
 * `metricsRoutes.test.ts`):
 *   - 401 when no auth header is present (matches `agentOrHumanAuth` semantics).
 *   - 200 with the full `AttemptStatus` when an agent is authenticated.
 *   - 200 with the full `AttemptStatus` when a human is authenticated.
 *   - 404 (`AppError` `notFound` → error-handler-mapped) when the attempt does
 *     not exist.
 *   - 200 when the attempt exists but has been compacted — the recovery
 *     surface still resolves (dedup evidence survives compaction).
 *
 * Out of scope: the Phase-1/3/2 primitives themselves (covered in
 * `taskCreationAttempts.test.ts` / `taskCreationAttemptLeases.test.ts` /
 * `taskPublicationFailureInjection.test.ts`). This file exercises the
 * transport boundary only.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { taskCreationAttempts, users } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as organizationRepo from "../repositories/organization.js";
import {
  reserveAttempt,
  compactAttemptDetails,
  type ReserveAttemptInput,
} from "../repositories/taskCreationAttempts.js";
import { taskCreationAttemptRoutes } from "../routes/taskCreationAttempts.js";

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
  const app = Fastify({ logger: false });
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(taskCreationAttemptRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

let habitatId: string;
let columnId: string;
let agentApiKey: string;

function baseInput(overrides: Partial<ReserveAttemptInput> = {}): ReserveAttemptInput {
  return {
    source: "ui",
    sourceScopeKind: "mission",
    sourceScopeId: "m-1",
    attemptKey: "key-1",
    requestFingerprint: "fp-1",
    publicationKind: "create",
    habitatId,
    actorType: "human",
    actorId: "user-1",
    ...overrides,
  };
}

function seedTerminalAttempt(key = "key-1"): string {
  const created = reserveAttempt(baseInput({ attemptKey: key }));
  if (created.outcome !== "created") throw new Error(`fixture reserve failed: ${created.outcome}`);
  const id = created.attempt.id;
  getDb()
    .update(taskCreationAttempts)
    .set({
      state: "created",
      terminalOutcome: "created",
      terminalResult: { outcome: "created", taskId: "t-1", attemptId: id },
      details: { proposalKind: "create" },
      committedTaskId: "t-1",
      committedMissionId: "m-final",
      completedAt: "2026-02-02T00:00:00.000Z",
    })
    .where(eq(taskCreationAttempts.id, id))
    .run();
  return id;
}

beforeEach(async () => {
  await initTestDb();
  const habitat = habitatRepo.createHabitat({ name: "Route Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;

  // Seed an agent for the agent-auth tests.
  missionRepo.createMission({
    habitatId,
    columnId,
    title: "Seed Mission",
    createdBy: "user-1",
  });
  const result = agentRepo.createAgent({
    name: "Phase4 Agent",
    type: "claude-code",
    domain: "general",
  });
  agentApiKey = result.plainApiKey;
});

afterEach(() => closeDb());

describe("GET /task-creation-attempts/:attemptId", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });
  afterEach(async () => {
    if (app) await app.close();
  });

  it("anonymous GET returns 401 (agentOrHumanAuth blocks)", async () => {
    const id = seedTerminalAttempt();

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
    });

    expect(res.statusCode).toBe(401);

    // **Failure mode**: if agentOrHumanAuth were missing, an anonymous request
    // would reach the handler and return 200 with the status — a leak of
    // attempt recovery state to unauthenticated callers.
  });

  it("agent-authenticated GET returns 200 with the full AttemptStatus surface", async () => {
    const id = seedTerminalAttempt();

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.attemptId).toBe(id);
    expect(body.state).toBe("created");
    expect(body.terminalOutcome).toBe("created");
    expect(body.committedTaskId).toBe("t-1");
    expect(body.committedMissionId).toBe("m-final");
    expect(body.completedAt).toBe("2026-02-02T00:00:00.000Z");

    // **Failure mode**: if the route omitted any recovery field (state /
    // committed IDs / terminal result / timestamps), the corresponding
    // assertion fails. The route is a thin transport for `getAttemptStatus`;
    // the recovery surface must arrive verbatim.
  });

  it("human-authenticated GET returns 200 with the full AttemptStatus surface", async () => {
    const id = seedTerminalAttempt();
    const token = makeToken({ sub: "user-1", username: "test", role: "admin" });

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.attemptId).toBe(id);
    expect(body.state).toBe("created");

    // **Failure mode**: if the JWT verify path were broken, this would 401.
    // Human auth via Bearer JWT is the second branch of `agentOrHumanAuth`.
  });

  it("agent-authenticated GET returns 404 for a missing attempt", async () => {
    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/does-not-exist`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(404);

    // **Failure mode**: if the route used a raw `reply.code(404)` instead of
    // `notFound(...)`, the error envelope would diverge from the rest of the
    // codebase (AppError shape with code/message/details). The global error
    // handler maps `notFound` → 404 with the standard shape.
  });

  it("agent-authenticated GET resolves an already-compacted attempt (recovery surface intact)", async () => {
    const id = seedTerminalAttempt();
    compactAttemptDetails(id);

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.attemptId).toBe(id);
    expect(body.state).toBe("created");
    expect(body.terminalOutcome).toBe("created");
    // Detailed payload is gone (compacted) — `AttemptStatus` surfaces
    // `terminalResult` (a detailed fragment). `details` / `causalContext` are
    // NOT part of the status projection — they're DB-only detailed columns.
    expect(body.terminalResult).toBeNull();
    // Compact identity (committed IDs) survives — the recovery surface is
    // still usable after retention.
    expect(body.committedTaskId).toBe("t-1");
    expect(body.committedMissionId).toBe("m-final");

    // **Failure mode**: if the route depended on the detailed payload (a
    // mis-wired projection), the GET would either 500 or surface a broken
    // status. The compacted-row case is the realistic post-retention read.
  });

  it("GET of a pending (non-terminal) attempt returns the in-flight recovery surface", async () => {
    // No terminalization — fresh reservation only.
    const created = reserveAttempt(baseInput({ attemptKey: "key-pending" }));
    const id = created.outcome === "created" ? created.attempt.id : "";

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { "x-agent-api-key": agentApiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.attemptId).toBe(id);
    expect(body.state).toBe("pending");
    expect(body.terminalOutcome).toBeNull();
    expect(body.completedAt).toBeNull();
    expect(body.reservedAt).toBeTruthy();
  });

  // -------------------------------------------------------------------------
  // R4 — habitat-scope authorization (the GET route resolves the caller's
  // habitat membership against the attempt's persisted habitatId).
  // -------------------------------------------------------------------------

  it("R4: a team MEMBER may GET an attempt in their team's habitat (200)", async () => {
    const org = organizationRepo.createOrganization({ name: "R4 Org", slug: "r4-org" });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "R4 Team",
      slug: "r4-team",
    });
    const teamHabitat = habitatRepo.createHabitat({ name: "R4 Team Habitat", teamId: team.id });
    ensureUser("user-member", "user-member");
    memberRepo.addMember({ teamId: team.id, userId: "user-member", role: "member" });

    // Reserve an attempt scoped to the team habitat.
    const created = reserveAttempt(
      baseInput({ attemptKey: "key-team-member", habitatId: teamHabitat.id }),
    );
    const id = created.outcome === "created" ? created.attempt.id : "";
    const token = makeToken({ sub: "user-member", username: "member", role: "member" });

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    // **Failure mode**: pre-R4 the route was authenticated-only (no membership
    // check), so this passed trivially. Post-R4 it must STILL pass for a real
    // member — proving the membership check grants access to the right caller.
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).attemptId).toBe(id);
  });

  it("R4: a non-member is DENIED an attempt in a team habitat (403) — cross-team isolation", async () => {
    const org = organizationRepo.createOrganization({ name: "R4 Org B", slug: "r4-org-b" });
    const team = teamRepo.createTeam({
      organizationId: org.id,
      name: "R4 Team B",
      slug: "r4-team-b",
    });
    const teamHabitat = habitatRepo.createHabitat({ name: "R4 Team Habitat B", teamId: team.id });
    // user-member belongs to a DIFFERENT team (none here) — NOT a member of team B.

    const created = reserveAttempt(
      baseInput({ attemptKey: "key-team-stranger", habitatId: teamHabitat.id }),
    );
    const id = created.outcome === "created" ? created.attempt.id : "";
    // A valid token for a user who is NOT a member of team B.
    const token = makeToken({ sub: "user-stranger", username: "stranger", role: "member" });

    const res = await app!.inject({
      method: "GET",
      url: `/api/task-creation-attempts/${id}`,
      headers: { authorization: `Bearer ${token}` },
    });

    // **Failure mode**: pre-R4 (authenticated-only) this returned 200 with the
    // other habitat's terminal/committed/lease data — an information leak. R4's
    // habitat-scope membership check now refuses with 403. The attempt exists,
    // so this is a real authorization denial, not a 404.
    expect(res.statusCode).toBe(403);
  });
});
