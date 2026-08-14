/**
 * Finding Triage Lifecycle — inverse-mutation history guards (restored
 * lifecycle T5), exercised through the REAL Mission/Pulse routes.
 *
 * Production-path discriminators:
 *  - DELETE /pulse/:id rejects any Pulse referenced as source or
 *    corroborating evidence by ANY Finding — terminal or not (409 with an
 *    actionable dependency identifier); unreferenced pulses still delete.
 *  - DELETE /missions/:missionId rejects any investigation
 *    (`admittedByTriageMissionId`) or corrective (`correctiveMissionId`)
 *    link, terminal or not.
 *  - POST /missions/:missionId/archive rejects a corrective Mission with any
 *    non-terminal linked Finding; succeeds after every link is terminal.
 *  - PATCH /missions/:missionId cannot clear the last gate while linked
 *    Findings are non-terminal (directed to activation) and cannot
 *    add/replace a gate while linked Findings are `in_progress`;
 *    non-null-to-non-null gate changes and dependency edits remain ordinary
 *    versioned edits while `triaged`.
 *
 * Mutate/revert evidence for each guard is captured in the ticket report.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { findingTriage, missions, missionEvents, pulses, tasks } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import { missionRoutes } from "../routes/missions.js";
import { pulseRoutes } from "../routes/pulse.js";
import { registerErrorHandler } from "../errors/plugin.js";
import {
  routeFinding,
  resolveFinding,
  activateCorrectiveMission,
} from "../services/findingTriageLifecycle.js";

const USER_ID = "user-1";
const JWT_SECRET = "dev-secret-change-in-production";
const AUTH = { authorization: `Bearer ${jwt.sign({ sub: USER_ID, username: "test", role: "admin" }, JWT_SECRET, { issuer: "orcy" })}` };

let habitatId: string;
let columnId: string;
let app: FastifyInstance;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.delete(tasks).run();
  db.delete(missionEvents).run();
  db.delete(missions).run();
  db.delete(pulses).run();
  db.run(sql`DELETE FROM finding_triage`);

  const habitat = habitatRepo.createHabitat({ name: "History Guards Habitat" });
  habitatId = habitat.id;
  const col = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = col.id;

  app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Error handler on the ROOT instance — a sibling registration is not
  // caught under Fastify encapsulation and `details` would be dropped.
  await registerErrorHandler(app);
  await app.register(
    async (f) => {
      await f.register(missionRoutes);
      await f.register(pulseRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
});

afterEach(async () => {
  await app.close();
  closeDb();
});

const ACTOR = { type: "human" as const, id: USER_ID };

/** Seeds a `triaged` finding linked to its own gated corrective Mission. */
function seedDeferredFinding(subject: string) {
  const pulse = pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    fromType: "human",
    fromId: USER_ID,
    signalType: "finding",
    subject,
    body: "History guard body",
    metadata: { findingKind: "pre_existing_bug" },
  });
  const finding = findingTriageRepo.createForPulse(pulse);
  const outcome = routeFinding({
    findingId: finding.id,
    actor: ACTOR,
    route: {
      bucket: "defer_to_patch",
      missionTitle: `Corrective: ${subject}`,
      missionDescription: "Deferred",
      releaseGateType: "patch",
      releaseGateVersion: "9.9.9",
    },
  });
  if (outcome.outcome !== "applied") throw new Error("seed routeFinding failed");
  return outcome.value;
}

/** An unreferenced pulse authored by the test human. */
function seedPlainPulse(subject: string) {
  return pulseRepo.createPulse({
    habitatId,
    scope: "habitat",
    fromType: "human",
    fromId: USER_ID,
    signalType: "experience",
    subject,
    body: "Plain pulse",
    metadata: { experience: "tooling" },
  });
}

/** Stamps an investigation admission link onto a finding. */
function stampInvestigationLink(findingId: string, missionId: string, taskId: string): void {
  getDb()
    .update(findingTriage)
    .set({
      admittedByTriageMissionId: missionId,
      admittedByInvestigationTaskId: taskId,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(findingTriage.id, findingId))
    .run();
}

/** Appends a corroborating evidence row for a pulse onto a finding. */
function appendCorroboratingEvidence(findingId: string, pulseId: string): void {
  findingTriageRepo.appendEvidenceWithClient(getDb(), {
    findingTriageId: findingId,
    pulseIds: [pulseId],
    role: "corroborating",
  });
}

// ---------------------------------------------------------------------------
// Pulse deletion guard
// ---------------------------------------------------------------------------

describe("DELETE /pulse/:id — lifecycle evidence guard", () => {
  it("rejects deletion of the SOURCE pulse of an ACTIVE finding (409 + dependency)", async () => {
    const finding = seedDeferredFinding("Pulse guard source");
    const sourcePulse = finding.pulseId;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/pulse/${sourcePulse}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("PULSE_IS_LIFECYCLE_EVIDENCE");
    expect(body.details.findingTriageIds).toContain(finding.id);

    // The pulse is still there.
    expect(pulseRepo.getPulseById(sourcePulse)).not.toBeNull();
  });

  it("rejects deletion of a CORROBORATING evidence pulse", async () => {
    const finding = seedDeferredFinding("Pulse guard corroboration");
    const corroborating = seedPlainPulse("Corroborating signal");
    appendCorroboratingEvidence(finding.id, corroborating.id);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/pulse/${corroborating.id}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("PULSE_IS_LIFECYCLE_EVIDENCE");
  });

  it("rejects deletion of a TERMINAL finding's source pulse (history is durable)", async () => {
    const finding = seedDeferredFinding("Pulse guard terminal");
    const resolved = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "done",
      resolutionKind: "code_fix",
    });
    expect(resolved.outcome).toBe("applied");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/pulse/${finding.pulseId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
  });

  it("still deletes an UNREFERENCED pulse by its author (204)", async () => {
    const plain = seedPlainPulse("Unreferenced signal");
    const res = await app.inject({
      method: "DELETE",
      url: `/api/pulse/${plain.id}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
    expect(pulseRepo.getPulseById(plain.id)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Mission deletion guard
// ---------------------------------------------------------------------------

describe("DELETE /missions/:missionId — finding-link guard", () => {
  it("rejects deletion of a Mission with a CORRECTIVE link (active finding)", async () => {
    const finding = seedDeferredFinding("Mission guard corrective");
    const missionId = finding.correctiveMissionId!;

    const res = await app.inject({
      method: "DELETE",
      url: `/api/missions/${missionId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("MISSION_HAS_FINDING_LINKS");
    expect(missionRepo.getMissionById(missionId)).not.toBeNull();
  });

  it("rejects deletion of a Mission with a TERMINAL corrective link", async () => {
    const finding = seedDeferredFinding("Mission guard terminal link");
    const missionId = finding.correctiveMissionId!;
    const resolved = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "done",
      resolutionKind: "code_fix",
    });
    expect(resolved.outcome).toBe("applied");

    const res = await app.inject({
      method: "DELETE",
      url: `/api/missions/${missionId}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("MISSION_HAS_FINDING_LINKS");
  });

  it("rejects deletion of a Mission with an INVESTIGATION link (admittedByTriageMissionId)", async () => {
    // An admitting Triage Mission with an investigation Task.
    const admittingMission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Admitting Triage Mission",
      createdBy: USER_ID,
    });
    const investigateTask = taskRepo.createTask({
      missionId: admittingMission.id,
      title: "Investigate",
      description: "investigate",
      requiredCapabilities: [],
      labels: [],
      createdBy: USER_ID,
    });

    const plain = seedPlainPulse("Investigation source");
    const pulse2 = pulseRepo.createPulse({
      habitatId,
      scope: "habitat",
      fromType: "human",
      fromId: USER_ID,
      signalType: "finding",
      subject: "Investigation finding",
      body: "body",
      metadata: { findingKind: "pre_existing_bug" },
    });
    void plain;
    const finding = findingTriageRepo.createForPulse(pulse2);
    stampInvestigationLink(finding.id, admittingMission.id, investigateTask.id);

    const res = await app.inject({
      method: "DELETE",
      url: `/api/missions/${admittingMission.id}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("MISSION_HAS_FINDING_LINKS");
  });

  it("still deletes an UNLINKED mission (204)", async () => {
    const mission = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Ordinary mission",
      createdBy: USER_ID,
    });
    const res = await app.inject({
      method: "DELETE",
      url: `/api/missions/${mission.id}`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(204);
  });
});

// ---------------------------------------------------------------------------
// Corrective Mission archive guard
// ---------------------------------------------------------------------------

describe("POST /missions/:missionId/archive — corrective link guard", () => {
  it("rejects archive while ANY linked finding is non-terminal (mission already done)", async () => {
    const finding = seedDeferredFinding("Archive guard target");
    const missionId = finding.correctiveMissionId!;
    missionRepo.updateMission(missionId, { status: "done" });

    const res = await app.inject({
      method: "POST",
      url: `/api/missions/${missionId}/archive`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("MISSION_ARCHIVE_HAS_NON_TERMINAL_FINDINGS");
    expect(missionRepo.getMissionById(missionId)!.isArchived).toBe(false);
  });

  it("allows archive once every linked finding is TERMINAL (link stays queryable)", async () => {
    const finding = seedDeferredFinding("Archive allowed target");
    const missionId = finding.correctiveMissionId!;
    missionRepo.updateMission(missionId, { status: "done" });

    const resolved = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "done",
      resolutionKind: "code_fix",
    });
    expect(resolved.outcome).toBe("applied");

    const res = await app.inject({
      method: "POST",
      url: `/api/missions/${missionId}/archive`,
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(missionRepo.getMissionById(missionId)!.isArchived).toBe(true);
    // Link stays queryable after archive.
    expect(findingTriageRepo.findByTriageMissionId(missionId)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Generic Mission gate-edit guards
// ---------------------------------------------------------------------------

describe("PATCH /missions/:missionId — gate-edit guards", () => {
  it("rejects CLEARING the last gate while linked findings are non-terminal (directs to activation)", async () => {
    const finding = seedDeferredFinding("Gate clear guard target");
    const missionId = finding.correctiveMissionId!;
    const mission = missionRepo.getMissionById(missionId)!;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${missionId}`,
      payload: { releaseGateType: null, releaseGateVersion: null, version: mission.version },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("MISSION_GATE_CLEAR_BLOCKED");
    expect(body.details.findingTriageIds).toContain(finding.id);
    // Gate intact, version unchanged.
    expect(missionRepo.getMissionById(missionId)!.releaseGateType).toBe("patch");
  });

  it("rejects ADDING a gate while linked findings are in_progress", async () => {
    const finding = seedDeferredFinding("Gate add guard target");
    const missionId = finding.correctiveMissionId!;
    // Activate through the kernel (the legitimate path).
    const activated = activateCorrectiveMission({
      findingId: finding.id,
      actor: ACTOR,
      expectedMissionVersion: missionRepo.getMissionById(missionId)!.version,
    });
    expect(activated.outcome).toBe("applied");
    // The gate is cleared by manual activation; re-adding one is now the
    // blocked "add on in_progress work" case.
    const mission = missionRepo.getMissionById(missionId)!;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${missionId}`,
      payload: { releaseGateType: "minor", releaseGateVersion: "1.0.0", version: mission.version },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("MISSION_GATE_CHANGE_BLOCKED");
  });

  it("rejects REPLACING a gate while linked findings are in_progress", async () => {
    const finding = seedDeferredFinding("Gate replace guard target");
    const missionId = finding.correctiveMissionId!;
    findingTriageRepo.transitionStatus(finding.id, "in_progress", ACTOR);
    const mission = missionRepo.getMissionById(missionId)!;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${missionId}`,
      payload: { releaseGateType: "minor", version: mission.version },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).code).toBe("MISSION_GATE_CHANGE_BLOCKED");
  });

  it("ALLOWS non-null→non-null gate changes while linked findings are triaged", async () => {
    const finding = seedDeferredFinding("Gate replace allowed target");
    const missionId = finding.correctiveMissionId!;
    const mission = missionRepo.getMissionById(missionId)!;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${missionId}`,
      payload: { releaseGateType: "minor", releaseGateVersion: "1.0.0", version: mission.version },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(missionRepo.getMissionById(missionId)!.releaseGateType).toBe("minor");
  });

  it("ALLOWS dependency edits while linked findings are triaged", async () => {
    const finding = seedDeferredFinding("Deps edit allowed target");
    const missionId = finding.correctiveMissionId!;
    const other = missionRepo.createMission({
      habitatId,
      columnId,
      title: "Other mission",
      createdBy: USER_ID,
    });
    const mission = missionRepo.getMissionById(missionId)!;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${missionId}`,
      payload: { dependsOn: [other.id], version: mission.version },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(missionRepo.getMissionById(missionId)!.dependsOn).toEqual([other.id]);
  });

  it("ALLOWS clearing the gate after every linked finding is TERMINAL", async () => {
    const finding = seedDeferredFinding("Gate clear after terminal target");
    const missionId = finding.correctiveMissionId!;
    const resolved = resolveFinding({
      findingId: finding.id,
      actor: ACTOR,
      resolution: "done",
      resolutionKind: "code_fix",
    });
    expect(resolved.outcome).toBe("applied");
    const mission = missionRepo.getMissionById(missionId)!;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/missions/${missionId}`,
      payload: { releaseGateType: null, releaseGateVersion: null, version: mission.version },
      headers: AUTH,
    });
    expect(res.statusCode).toBe(200);
    expect(missionRepo.getMissionById(missionId)!.releaseGateType).toBeNull();
  });
});
