/**
 * RM-7 bounded orphan-map route — authority, atomicity, and identity tests.
 *
 * `POST /api/habitats/:habitatId/triage/orphans/:missionId/map` is the
 * dedicated agent-owned replacement for routing `map_orphan_mission` through
 * the generic `PATCH /missions/:id`. These tests pin the contract from the
 * triage-registration-restoration implementation contract:
 *
 *   - happy path: the current claimant of the orphan's single ACTIVE
 *     investigation Task positions the orphan; DB carries the dependsOn
 *     projection, the missionDependencies edge, a version bump, and ONE
 *     agent-attributed mission event (`actorType: "agent"`, source
 *     `triage_orphan_map`).
 *   - humans are denied this route (agent-only) while the existing generic
 *     Mission PATCH keeps working for them (control unchanged).
 *   - fail-closed denials with ZERO writes: unrelated agent, unclaimed,
 *     released claim, ambiguous (two active-claim Tasks), other assignee
 *     (reassignment), no junction, resolved junction, wrong Habitat (404
 *     collapse), already-mapped target, missing/cross-Habitat/cyclic
 *     dependency, stale expectedVersion.
 *   - strict body: unknown fields and empty dependsOn are 400s.
 *   - team Habitat: agents denied (BOARD_ACCESS_DENIED).
 *   - sequential double-map (mapping race loser): the second call hits the
 *     first call's committed edges and refuses (MISSION_NOT_ORPHAN) — no
 *     partial second write.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { triageRoutes } from "../routes/triage.js";
import { missionRoutes } from "../routes/missions.js";
import { taskCrudRoutes } from "../routes/tasks/crud.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import * as teamRepo from "../repositories/team.js";
import * as memberRepo from "../repositories/teamMember.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { eq, and, sql } from "drizzle-orm";
import {
  missions,
  missionDependencies,
  missionEvents,
  triageClusterMissions,
  findingTriage,
  organizations,
  taskCreationAttempts,
} from "../db/schema/index.js";

const JWT_SECRET = "dev-secret-change-in-production";

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(
    async (f) => {
      await f.register(triageRoutes);
      await f.register(missionRoutes);
      await f.register(taskCrudRoutes); // real public task deletion (fixup2 attack regression)
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

let app: FastifyInstance;
let habitatId: string;
let columnId: string;
let agentId: string;
let agentApiKey: string;
let otherAgentId: string;
let otherAgentApiKey: string;

/** Seeds: orphan mission + anchor mission + open junction + investigation mission/task WITH publication-ledger proof (default) or without (legacy shape, `ledger: false`). */
function seedOrphanInvestigation(opts: { claimBy?: string | null; ledger?: boolean } = {}) {
  const anchor = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Anchor mission",
    createdBy: "user-1",
  });
  const orphan = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Orphan mission",
    createdBy: "user-1",
  });
  const investigation = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Triage: position orphan mission — Orphan mission",
    createdBy: "user-1",
  });
  const investigateTask = taskRepo.createTask({
    missionId: investigation.id,
    title: "Investigate cluster: orphan-mission:" + orphan.id,
    description: "investigate",
    requiredCapabilities: [],
    labels: [],
    createdBy: "user-1",
  });
  const db = getDb();
  db.insert(triageClusterMissions)
    .values({
      id: crypto.randomUUID(),
      habitatId,
      clusterKey: `orphan-mission:${orphan.id}`,
      missionId: investigation.id,
      status: "open",
    })
    .run();

  // Realistic default: every genuinely published investigation carries the
  // publication-ledger proof of the committed investigate Task.
  if (opts.ledger !== false) {
    seedPublicationAttempt({
      orphanId: orphan.id,
      investigationMissionId: investigation.id,
      taskId: investigateTask.id,
    });
  }

  if (opts.claimBy) {
    const result = taskStateMachine.claimTask(investigateTask.id, opts.claimBy);
    if (!result.success) throw new Error(`claimTask failed: ${result.reason}`);
  }
  return { anchor, orphan, investigation, investigateTask };
}

/** Seeds a triage publication attempt row proving `taskId` is the published investigate Task for `orphanId`. */
function seedPublicationAttempt(opts: {
  orphanId: string;
  investigationMissionId: string;
  taskId: string;
  attemptKey?: string;
}) {
  getDb()
    .insert(taskCreationAttempts)
    .values({
      id: crypto.randomUUID(),
      source: "system",
      sourceScopeKind: "orphan_mission",
      sourceScopeId: opts.orphanId,
      attemptKey: opts.attemptKey ?? "triage-investigation-template-0",
      requestFingerprint: crypto.randomUUID(),
      publicationKind: "create",
      actorType: "system",
      actorId: "triage",
      committedTaskId: opts.taskId,
      committedMissionId: opts.investigationMissionId,
      state: "created",
      reservedAt: new Date().toISOString(),
    })
    .run();
}

function mapUrl(habitat: string, missionId: string): string {
  return `/api/habitats/${habitat}/triage/orphans/${missionId}/map`;
}

function postMap(
  missionId: string,
  body: Record<string, unknown>,
  headers: Record<string, string>,
  habitat = habitatId,
) {
  return app.inject({ method: "POST", url: mapUrl(habitat, missionId), payload: body, headers });
}

const agentHeaders = () => ({ "x-agent-api-key": agentApiKey });
const otherAgentHeaders = () => ({ "x-agent-api-key": otherAgentApiKey });
const humanHeaders = () => ({
  authorization: `Bearer ${makeToken({ sub: "user-1", username: "test", role: "admin" })}`,
});
const VALID_BODY = { dependsOn: [] as string[] }; // filled per-test with anchor id

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.run(sql`DELETE FROM tasks`);
  db.run(sql`DELETE FROM mission_events`);
  db.run(sql`DELETE FROM finding_triage`);
  db.run(sql`DELETE FROM triage_cluster_missions`);

  const habitat = habitatRepo.createHabitat({ name: "Orphan Map Habitat" });
  habitatId = habitat.id;
  const col = columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });
  columnId = col.id;

  const result = agentRepo.createAgent({
    name: "Map Agent",
    type: "claude-code",
    domain: "general",
  });
  agentId = result.agent.id;
  agentApiKey = result.plainApiKey;
  const other = agentRepo.createAgent({
    name: "Other Map Agent",
    type: "claude-code",
    domain: "general",
  });
  otherAgentId = other.agent.id;
  otherAgentApiKey = other.plainApiKey;

  app = await buildApp();
});

afterEach(async () => {
  await app.close();
  closeDb();
});

describe("RM-7 orphan-map route — happy path and persisted effects", () => {
  it("current claimant positions the orphan: deps + edge + version bump + agent-attributed audit, in one commit", async () => {
    const { anchor, orphan, investigation, investigateTask } = seedOrphanInvestigation({
      claimBy: agentId,
    });

    const res = await postMap(orphan.id, { dependsOn: [anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.mission.id).toBe(orphan.id);
    expect(body.habitatId).toBe(habitatId);
    expect(body.clusterKey).toBe(`orphan-mission:${orphan.id}`);
    expect(body.investigationMissionId).toBe(investigation.id);
    expect(body.investigationTaskId).toBe(investigateTask.id);

    // Persisted: dependsOn projection on the mission row.
    const mission = missionRepo.getMissionById(orphan.id)!;
    expect(mission.dependsOn).toEqual([anchor.id]);
    expect(mission.version).toBe(2); // created at 1, map bumped to 2

    // Persisted: the missionDependencies edge.
    const edge = getDb()
      .select()
      .from(missionDependencies)
      .where(
        and(
          eq(missionDependencies.missionId, orphan.id),
          eq(missionDependencies.dependsOnId, anchor.id),
        ),
      )
      .get();
    expect(edge).toBeTruthy();

    // Persisted: ONE agent-attributed mission event with the verified identity.
    const events = getDb()
      .select()
      .from(missionEvents)
      .where(eq(missionEvents.missionId, orphan.id))
      .all();
    expect(events).toHaveLength(1);
    expect(events[0].actorType).toBe("agent");
    expect(events[0].actorId).toBe(agentId);
    const meta = (events[0].metadata ?? {}) as Record<string, unknown>;
    expect(meta.source).toBe("triage_orphan_map");
    expect(meta.investigationMissionId).toBe(investigation.id);
    expect(meta.investigationTaskId).toBe(investigateTask.id);
  });

  it("release gate fields ride along when supplied", async () => {
    const { anchor, orphan } = seedOrphanInvestigation({ claimBy: agentId });
    const res = await postMap(
      orphan.id,
      { dependsOn: [anchor.id], releaseGateType: "minor", releaseGateVersion: "v0.41" },
      agentHeaders(),
    );
    expect(res.statusCode).toBe(200);
    const mission = missionRepo.getMissionById(orphan.id)!;
    expect(mission.releaseGateType).toBe("minor");
    expect(mission.releaseGateVersion).toBe("v0.41");
  });

  it("expectedVersion matching the observed version succeeds; a stale one refuses with current version and no write", async () => {
    const { anchor, orphan } = seedOrphanInvestigation({ claimBy: agentId });

    const stale = await postMap(
      orphan.id,
      { dependsOn: [anchor.id], expectedVersion: 99 },
      agentHeaders(),
    );
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).code).toBe("MISSION_VERSION_MISMATCH");
    expect(stale.headers["x-current-version"]).toBe("1");
    expect(missionRepo.getMissionById(orphan.id)!.dependsOn ?? []).toEqual([]);
    expect(getDb().select().from(missionEvents).all()).toHaveLength(0);

    const ok = await postMap(
      orphan.id,
      { dependsOn: [anchor.id], expectedVersion: 1 },
      agentHeaders(),
    );
    expect(ok.statusCode).toBe(200);
  });
});

describe("RM-7 orphan-map route — authority denials (zero writes)", () => {
  it("humans are denied this route (agent-only) but keep the generic Mission PATCH", async () => {
    const { anchor, orphan } = seedOrphanInvestigation({ claimBy: agentId });

    const denied = await postMap(orphan.id, { dependsOn: [anchor.id] }, humanHeaders());
    expect(denied.statusCode).toBe(403);
    expect(JSON.parse(denied.body).code).toBe("TRIAGE_ORPHAN_MAP_AGENT_ONLY");

    // Control unchanged: the same human edits the same mission via the
    // generic PATCH successfully.
    const generic = await app.inject({
      method: "PATCH",
      url: `/api/missions/${orphan.id}`,
      payload: { title: "Human renamed it" },
      headers: humanHeaders(),
    });
    expect(generic.statusCode).toBe(200);
    expect(JSON.parse(generic.body).mission.title).toBe("Human renamed it");
  });

  it("unrelated agent (not the claimant) is denied", async () => {
    const { anchor, orphan } = seedOrphanInvestigation({ claimBy: agentId });
    const res = await postMap(orphan.id, { dependsOn: [anchor.id] }, otherAgentHeaders());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("TRIAGE_NOT_AUTHORIZED");
    expect(missionRepo.getMissionById(orphan.id)!.dependsOn ?? []).toEqual([]);
  });

  it("unclaimed investigation task is denied (no live claim)", async () => {
    const { anchor, orphan } = seedOrphanInvestigation({});
    const res = await postMap(orphan.id, { dependsOn: [anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("TRIAGE_NOT_AUTHORIZED");
  });

  it("released claim is denied (stale claim)", async () => {
    const { anchor, orphan, investigateTask } = seedOrphanInvestigation({ claimBy: agentId });
    taskStateMachine.releaseTask(investigateTask.id, agentId);
    const res = await postMap(orphan.id, { dependsOn: [anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(403);
  });

  it("a second claimed Task does not confuse identity — the ledger-resolved genuine Task authorizes", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const second = taskRepo.createTask({
      missionId: seeded.investigation.id,
      title: "Second investigate",
      description: "extra task",
      requiredCapabilities: [],
      labels: [],
      createdBy: "user-1",
    });
    const claim = taskStateMachine.claimTask(second.id, agentId);
    expect(claim.success).toBe(true);

    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).investigationTaskId).toBe(seeded.investigateTask.id);
  });

  it("claim held by a different agent (reassignment) is denied", async () => {
    const { anchor, orphan } = seedOrphanInvestigation({ claimBy: otherAgentId });
    const res = await postMap(orphan.id, { dependsOn: [anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(403);
  });

  it("H1: UNCLAIMED published investigate + UNRELATED claimed Task never authorizes (publication evidence resolves the real Task)", async () => {
    // The genuine investigate Task exists with publication evidence but is
    // unclaimed; an unrelated Task on the same investigation Mission is
    // claimed by the caller. The pre-fix code accepted the sole active claim.
    const seeded = seedOrphanInvestigation({}); // investigate Task left unclaimed
    const unrelated = taskRepo.createTask({
      missionId: seeded.investigation.id,
      title: "Unrelated side task",
      description: "not the investigation",
      requiredCapabilities: [],
      labels: [],
      createdBy: "user-1",
    });
    const claim = taskStateMachine.claimTask(unrelated.id, agentId);
    expect(claim.success).toBe(true);

    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("TRIAGE_NOT_AUTHORIZED");
    // Zero writes.
    expect(missionRepo.getMissionById(seeded.orphan.id)!.dependsOn ?? []).toEqual([]);
    expect(
      getDb()
        .select()
        .from(missionEvents)
        .where(eq(missionEvents.missionId, seeded.orphan.id))
        .all(),
    ).toHaveLength(0);
  });

  it("H1 positive: publication evidence resolves the genuine investigate Task even with another claimed Task present", async () => {
    // The published investigate Task is claimed by the caller; an unrelated
    // extra Task is claimed by ANOTHER agent. Identity resolution (not
    // sole-active-claim) makes this an authorized map — and would have been
    // ambiguous under the old rule.
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const unrelated = taskRepo.createTask({
      missionId: seeded.investigation.id,
      title: "Unrelated side task",
      description: "not the investigation",
      requiredCapabilities: [],
      labels: [],
      createdBy: "user-1",
    });
    const claim = taskStateMachine.claimTask(unrelated.id, otherAgentId);
    expect(claim.success).toBe(true);

    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.investigationTaskId).toBe(seeded.investigateTask.id);
    expect(missionRepo.getMissionById(seeded.orphan.id)!.dependsOn).toEqual([seeded.anchor.id]);
  });

  it("H1: MULTIPLE published investigate candidates (template multiplicity) fail closed", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId }); // seeds attemptKey -0
    const second = taskRepo.createTask({
      missionId: seeded.investigation.id,
      title: "Second published task",
      description: "template multiplicity",
      requiredCapabilities: [],
      labels: [],
      createdBy: "user-1",
    });
    const claim = taskStateMachine.claimTask(second.id, agentId);
    expect(claim.success).toBe(true);
    seedPublicationAttempt({
      orphanId: seeded.orphan.id,
      investigationMissionId: seeded.investigation.id,
      taskId: second.id,
      attemptKey: "triage-investigation-template-1",
    });

    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("TRIAGE_INVESTIGATION_TASK_UNPROVABLE");
  });

  it("fixup2 HIGH: legacy investigation with NO publication proof denies with the typed unprovable outcome — even one legit-looking claimed Task", async () => {
    const seeded = seedOrphanInvestigation({ ledger: false, claimBy: agentId });
    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("TRIAGE_INVESTIGATION_TASK_UNPROVABLE");
    // Truthful remediation text (fixup3): automatic mapping refused; human
    // handles the mission via existing Mission editing; junction is NOT
    // repaired by that edit; no promised re-admit workflow.
    expect(body.message).toContain("Automatic mapping is refused");
    expect(body.message).toContain("existing Mission editing UI/API");
    expect(body.message).toContain("does not close or repair the orphan investigation junction");
    expect(body.message).not.toContain("verified workflow");
    // Zero writes.
    expect(missionRepo.getMissionById(seeded.orphan.id)!.dependsOn ?? []).toEqual([]);
    expect(
      getDb()
        .select()
        .from(missionEvents)
        .where(eq(missionEvents.missionId, seeded.orphan.id))
        .all(),
    ).toHaveLength(0);
  });

  it("fixup2 HIGH: delete-and-replace attack via the REAL public task-delete route is denied (dangling committed identity)", async () => {
    const seeded = seedOrphanInvestigation({}); // genuine task published + ledger, UNCLAIMED
    // Attack step 1: delete the genuine unclaimed investigate Task through the
    // real public route (permitted for a non-archived mission with no dependents).
    const del = await app.inject({
      method: "DELETE",
      url: `/api/tasks/${seeded.investigateTask.id}`,
      headers: agentHeaders(),
    });
    expect(del.statusCode).toBe(200);
    // Attack step 2: create + claim an unrelated replacement in the same Mission.
    const replacement = taskRepo.createTask({
      missionId: seeded.investigation.id,
      title: "Investigate cluster: orphan-mission:" + seeded.orphan.id, // look-alike title
      description: "replacement",
      requiredCapabilities: [],
      labels: [],
      createdBy: "user-1",
    });
    const claim = taskStateMachine.claimTask(replacement.id, agentId);
    expect(claim.success).toBe(true);
    // Junction is still open; the mission has exactly ONE claimed task — but
    // the ledger's committed Task is dangling, so identity cannot be proven.
    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("TRIAGE_INVESTIGATION_TASK_UNPROVABLE");
    // Zero writes: no edges, no audit events.
    expect(missionRepo.getMissionById(seeded.orphan.id)!.dependsOn ?? []).toEqual([]);
    expect(
      getDb()
        .select()
        .from(missionDependencies)
        .where(eq(missionDependencies.missionId, seeded.orphan.id))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(missionEvents)
        .where(eq(missionEvents.missionId, seeded.orphan.id))
        .all(),
    ).toHaveLength(0);
  });

  it("agents are denied on team habitats (BOARD_ACCESS_DENIED)", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    getDb()
      .insert(organizations)
      .values({ id: `org-${suffix}`, name: "Org", slug: `org-${suffix}` })
      .run();
    const team = teamRepo.createTeam({
      organizationId: `org-${suffix}`,
      name: "Map Team",
      slug: `team-${suffix}`,
    });
    const teamHabitat = habitatRepo.createHabitat({ name: "Team Habitat", teamId: team.id });
    const orphan = missionRepo.createMission({
      habitatId: teamHabitat.id,
      columnId,
      title: "Team orphan",
      createdBy: "user-1",
    });
    const res = await postMap(orphan.id, { dependsOn: ["m-any"] }, agentHeaders(), teamHabitat.id);
    expect(res.statusCode).toBe(403);
    expect(JSON.parse(res.body).code).toBe("BOARD_ACCESS_DENIED");
    void memberRepo;
  });
});

describe("RM-7 orphan-map route — state denials (zero writes)", () => {
  it("no junction (never investigated) → 409 NO_OPEN_ORPHAN_INVESTIGATION", async () => {
    const anchor = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Anchor",
      createdBy: "user-1",
    });
    const orphan = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Never investigated",
      createdBy: "user-1",
    });
    const res = await postMap(orphan.id, { dependsOn: [anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("NO_OPEN_ORPHAN_INVESTIGATION");
  });

  it("resolved junction → 409 NO_OPEN_ORPHAN_INVESTIGATION", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    getDb()
      .update(triageClusterMissions)
      .set({ status: "resolved", resolvedAt: new Date().toISOString() })
      .where(eq(triageClusterMissions.clusterKey, `orphan-mission:${seeded.orphan.id}`))
      .run();
    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("NO_OPEN_ORPHAN_INVESTIGATION");
  });

  it("H2: target mission that went DONE after the scan opened the junction refuses (404 collapse, zero writes)", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    // The scan admits not_started orphans; the mission completes before mapping.
    const done = missionRepo.updateMission(seeded.orphan.id, { status: "done" });
    expect(done.success).toBe(true);

    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(404);
    // Zero writes despite the open junction and the live claim.
    expect(missionRepo.getMissionById(seeded.orphan.id)!.dependsOn ?? []).toEqual([]);
    expect(
      getDb()
        .select()
        .from(missionDependencies)
        .where(eq(missionDependencies.missionId, seeded.orphan.id))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(missionEvents)
        .where(eq(missionEvents.missionId, seeded.orphan.id))
        .all(),
    ).toHaveLength(0);
  });

  it("H2: FAILED target mission refuses identically", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const failed = missionRepo.updateMission(seeded.orphan.id, { status: "failed" });
    expect(failed.success).toBe(true);

    const res = await postMap(seeded.orphan.id, { dependsOn: [seeded.anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(404);
  });

  it("wrong habitat in path → 404 (collapsed; no cross-habitat oracle)", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
    const res = await postMap(
      seeded.orphan.id,
      { dependsOn: [seeded.anchor.id] },
      agentHeaders(),
      otherHabitat.id,
    );
    expect(res.statusCode).toBe(404);
  });

  it("already-mapped target (existing dependsOn) → 409 MISSION_NOT_ORPHAN", async () => {
    const anchor = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Anchor",
      createdBy: "user-1",
      dependsOn: [],
    });
    const mapped = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Already mapped",
      createdBy: "user-1",
      dependsOn: [anchor.id],
    });
    const res = await postMap(mapped.id, { dependsOn: [anchor.id] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("MISSION_NOT_ORPHAN");
  });

  it("mapping race loser: a second map of the just-committed orphan refuses NOT_ORPHAN with no further write", async () => {
    const { anchor, orphan } = seedOrphanInvestigation({ claimBy: agentId });
    const first = await postMap(orphan.id, { dependsOn: [anchor.id] }, agentHeaders());
    expect(first.statusCode).toBe(200);

    const second = await postMap(orphan.id, { dependsOn: [anchor.id] }, agentHeaders());
    expect(second.statusCode).toBe(409);
    expect(JSON.parse(second.body).code).toBe("MISSION_NOT_ORPHAN");

    // Exactly one audit event from the winning map.
    expect(
      getDb().select().from(missionEvents).where(eq(missionEvents.missionId, orphan.id)).all(),
    ).toHaveLength(1);
  });
});

describe("RM-7 orphan-map route — dependency validation", () => {
  it("missing dependency id → 409 INVALID_DEPENDENCY naming the position only", async () => {
    const { orphan } = seedOrphanInvestigation({ claimBy: agentId });
    const res = await postMap(orphan.id, { dependsOn: ["m-missing"] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("INVALID_DEPENDENCY");
    expect(body.message).toContain("position 0");
    expect(body.message).not.toContain("m-missing");
  });

  it("cross-habitat dependency is indistinguishable from a missing one", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
    const foreign = missionRepo.createMission({
      habitatId: otherHabitat.id,
      columnId,
      title: "Foreign",
      createdBy: "user-1",
    });
    const res = await postMap(seeded.orphan.id, { dependsOn: [foreign.id] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("INVALID_DEPENDENCY");
    expect(body.message).not.toContain(foreign.id);
  });

  it("self-dependency (would create a cycle) → 409 INVALID_DEPENDENCY", async () => {
    const { orphan } = seedOrphanInvestigation({ claimBy: agentId });
    const res = await postMap(orphan.id, { dependsOn: [orphan.id] }, agentHeaders());
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("INVALID_DEPENDENCY");
  });

  it("denied dependency leaves zero partial writes", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    await postMap(seeded.orphan.id, { dependsOn: ["m-missing", seeded.anchor.id] }, agentHeaders());
    expect(missionRepo.getMissionById(seeded.orphan.id)!.dependsOn ?? []).toEqual([]);
    expect(
      getDb()
        .select()
        .from(missionDependencies)
        .where(eq(missionDependencies.missionId, seeded.orphan.id))
        .all(),
    ).toHaveLength(0);
    expect(
      getDb()
        .select()
        .from(missionEvents)
        .where(eq(missionEvents.missionId, seeded.orphan.id))
        .all(),
    ).toHaveLength(0);
  });
});

describe("GET /habitats/:habitatId/triage/orphans/:missionId/investigation (M1 scoped junction read)", () => {
  it("open junction → { open: true, investigationMissionId }", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/triage/orphans/${seeded.orphan.id}/investigation`,
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.open).toBe(true);
    expect(body.investigationMissionId).toBe(seeded.investigation.id);
    expect(body.targetEligible).toBe(true); // not_started target IS mappable
  });

  it("fixup2 MEDIUM: DONE target with an open junction reads open=true but targetEligible=false", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const done = missionRepo.updateMission(seeded.orphan.id, { status: "done" });
    expect(done.success).toBe(true);
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/triage/orphans/${seeded.orphan.id}/investigation`,
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.open).toBe(true);
    expect(body.targetEligible).toBe(false);
  });

  it("never-admitted mission → { open: false } with no investigation id", async () => {
    const orphan = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Never admitted",
      createdBy: "user-1",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/triage/orphans/${orphan.id}/investigation`,
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.open).toBe(false);
    expect(body.investigationMissionId).toBeUndefined();
  });

  it("resolved junction → { open: false }", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    getDb()
      .update(triageClusterMissions)
      .set({ status: "resolved", resolvedAt: new Date().toISOString() })
      .where(eq(triageClusterMissions.clusterKey, `orphan-mission:${seeded.orphan.id}`))
      .run();
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${habitatId}/triage/orphans/${seeded.orphan.id}/investigation`,
      headers: agentHeaders(),
    });
    expect(JSON.parse(res.body).open).toBe(false);
  });

  it("agent denied on team habitat", async () => {
    const suffix = Math.random().toString(36).slice(2, 10);
    getDb()
      .insert(organizations)
      .values({ id: `org-${suffix}`, name: "Org", slug: `org-${suffix}` })
      .run();
    const team = teamRepo.createTeam({
      organizationId: `org-${suffix}`,
      name: "Read Team",
      slug: `team-${suffix}`,
    });
    const teamHabitat = habitatRepo.createHabitat({ name: "Team Habitat", teamId: team.id });
    const orphan = missionRepo.createMission({
      habitatId: teamHabitat.id,
      columnId,
      title: "Team orphan",
      createdBy: "user-1",
    });
    const res = await app.inject({
      method: "GET",
      url: `/api/habitats/${teamHabitat.id}/triage/orphans/${orphan.id}/investigation`,
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(403);
  });
});

describe("RM-7 orphan-map route — strict body", () => {
  it("unknown fields are rejected (strict)", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const res = await postMap(
      seeded.orphan.id,
      { dependsOn: [seeded.anchor.id], actorId: "forged" },
      agentHeaders(),
    );
    expect(res.statusCode).toBe(400);
  });

  it("empty dependsOn is rejected at the schema", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const res = await postMap(seeded.orphan.id, { dependsOn: [] }, agentHeaders());
    expect(res.statusCode).toBe(400);
  });

  it("caller cannot forge a mission version of 0 or negative (schema)", async () => {
    const seeded = seedOrphanInvestigation({ claimBy: agentId });
    const res = await postMap(
      seeded.orphan.id,
      { dependsOn: [seeded.anchor.id], expectedVersion: -1 },
      agentHeaders(),
    );
    expect(res.statusCode).toBe(400);
  });
});

describe("expectedHabitatId on POST /triage/findings/:id/route", () => {
  function seedAdmittedFinding() {
    const admittingMission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Admitting Triage Mission",
      createdBy: "user-1",
    });
    const investigateTask = taskRepo.createTask({
      missionId: admittingMission.id,
      title: "Investigate",
      description: "investigate the cluster",
      requiredCapabilities: [],
      labels: [],
      createdBy: "user-1",
    });
    const pulse = pulseRepo.createPulse({
      habitatId,
      missionId: admittingMission.id,
      scope: "mission",
      fromType: "agent",
      fromId: agentId,
      signalType: "finding",
      subject: "expected-hab#1",
      body: "Test body",
      metadata: { findingKind: "bug" },
    });
    const finding = findingTriageRepo.createForPulse(pulse);
    getDb()
      .update(findingTriage)
      .set({
        admittedByTriageMissionId: admittingMission.id,
        admittedByInvestigationTaskId: investigateTask.id,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(findingTriage.id, finding.id))
      .run();
    const claim = taskStateMachine.claimTask(investigateTask.id, agentId);
    expect(claim.success).toBe(true);
    return { findingId: finding.id };
  }

  it("matching expectedHabitatId routes normally", async () => {
    const { findingId } = seedAdmittedFinding();
    const res = await app.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/route`,
      payload: {
        bucket: "document_as_known_limitation",
        expectedHabitatId: habitatId,
      },
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).finding.status).toBe("triaged");
  });

  it("mismatched expectedHabitatId refuses with INVALID_INPUT and zero writes", async () => {
    const { findingId } = seedAdmittedFinding();
    const otherHabitat = habitatRepo.createHabitat({ name: "Other Habitat" });
    const res = await app.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/route`,
      payload: {
        bucket: "document_as_known_limitation",
        expectedHabitatId: otherHabitat.id,
      },
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("INVALID_INPUT");
    expect(body.message).toContain("HABITAT_MISMATCH");
    // The finding is untouched.
    const row = findingTriageRepo.getById(findingId)!;
    expect(row.status).toBe("open");
    expect(row.bucket).toBeNull();
  });

  it("omitting expectedHabitatId keeps the legacy behavior (unchanged callers)", async () => {
    const { findingId } = seedAdmittedFinding();
    const res = await app.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/route`,
      payload: { bucket: "document_as_known_limitation" },
      headers: agentHeaders(),
    });
    expect(res.statusCode).toBe(200);
  });
});
