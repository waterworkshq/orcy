/**
 * T8 — Client cutover production-path discriminators.
 *
 * Real HTTP routes against the real test DB, with RE-FETCH verification
 * (not merely 2xx — the Zod-strip false-positive trap):
 *
 *   - Resolve persists the COMPLETE Resolution record (rootCause + kind +
 *     text) through `POST /triage/findings/:id/resolve`; verified by
 *     re-fetching `GET /triage/resolutions` after the call.
 *   - Wontfix persists the reason and `wontfix` kind the same way.
 *   - The `{status:'resolved'}`-only legacy shape (the documented UI data-loss
 *     defect) is rejected by the retired PATCH surface — no
 *     terminal-without-payload request can survive anywhere.
 *   - Terminal resurrection through the legacy PATCH gets the single
 *     retirement response (FU13) with zero writes.
 *   - The superseded `POST /triage/findings/:id/promote` route is RETIRED
 *     (404) — manual activation is `/activate` on the existing Mission.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { triageRoutes } from "../routes/triage.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as findingTriageRepo from "../repositories/findingTriage.js";
import { eq, sql } from "drizzle-orm";
import { findingTriage } from "../db/schema/index.js";

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
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

let habitatId: string;
let app: FastifyInstance | null = null;

beforeEach(async () => {
  await initTestDb();
  const db = getDb();
  db.run(sql`DELETE FROM tasks`);
  db.run(sql`DELETE FROM finding_triage`);
  db.run(sql`DELETE FROM pulses`);

  const habitat = habitatRepo.createHabitat({ name: "Cutover Habitat" });
  habitatId = habitat.id;
  const col = columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false });

  const admittingMission = missionRepo.createMission({
    habitatId,
    columnId: col.id,
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
    fromId: "agent-1",
    signalType: "finding",
    subject: "cutover-cluster",
    body: "Test body",
    metadata: { findingKind: "bug" },
  });
  const finding = findingTriageRepo.createForPulse(pulse);
  db.update(findingTriage)
    .set({
      admittedByTriageMissionId: admittingMission.id,
      admittedByInvestigationTaskId: investigateTask.id,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(findingTriage.id, finding.id))
    .run();
});

afterEach(async () => {
  if (app) await app.close();
  closeDb();
});

/** The seeded finding id (fresh per test). */
function seededFindingId(): string {
  const rows = findingTriageRepo.findByHabitat(habitatId, {});
  expect(rows.length).toBeGreaterThan(0);
  return rows[0].id;
}

function humanHeaders() {
  return {
    authorization: `Bearer ${makeToken({ sub: "user-1", username: "test", role: "admin" })}`,
  };
}

describe("T8 — client cutover discriminators (real routes + re-fetch)", () => {
  beforeEach(async () => {
    app = await buildApp();
  });

  it("resolve persists the COMPLETE Resolution record — rootCause/kind/text verified by re-fetch", async () => {
    const findingId = seededFindingId();
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/resolve`,
      payload: {
        resolution: "fixed with a lock around the cache refresh",
        resolutionKind: "code_fix",
        rootCause: "unsynchronized cache invalidation",
      },
      headers: humanHeaders(),
    });
    expect(res.statusCode).toBe(200);

    // RE-FETCH the canonical read model — a 2xx alone proves nothing.
    const refetch = await app!.inject({
      method: "GET",
      url: `/api/triage/findings/${findingId}`,
      headers: humanHeaders(),
    });
    expect(refetch.statusCode).toBe(200);
    const finding = JSON.parse(refetch.body).finding;
    expect(finding.status).toBe("resolved");
    expect(finding.correctiveMissionId).toBe(null);

    const resolutionsRes = await app!.inject({
      method: "GET",
      url: `/api/triage/resolutions?habitatId=${habitatId}&clusterKey=${encodeURIComponent(finding.clusterKey)}`,
      headers: humanHeaders(),
    });
    expect(resolutionsRes.statusCode).toBe(200);
    const resolutions = JSON.parse(resolutionsRes.body).resolutions;
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].source).toBe("finding_triage");
    expect(resolutions[0].sourceId).toBe(findingId);
    expect(resolutions[0].resolution).toBe("fixed with a lock around the cache refresh");
    expect(resolutions[0].resolutionKind).toBe("code_fix");
    expect(resolutions[0].rootCause).toBe("unsynchronized cache invalidation");
  });

  it("wontfix persists the reason and `wontfix` kind — verified by re-fetch", async () => {
    const findingId = seededFindingId();
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/wontfix`,
      payload: { reason: "accepted trade-off for the current architecture" },
      headers: humanHeaders(),
    });
    expect(res.statusCode).toBe(200);

    const seeded = findingTriageRepo.getById(findingId)!;
    const resolutionsRes = await app!.inject({
      method: "GET",
      url: `/api/triage/resolutions?habitatId=${habitatId}&clusterKey=${encodeURIComponent(seeded.clusterKey)}`,
      headers: humanHeaders(),
    });
    const resolutions = JSON.parse(resolutionsRes.body).resolutions;
    expect(resolutions).toHaveLength(1);
    expect(resolutions[0].resolutionKind).toBe("wontfix");
    expect(resolutions[0].resolution).toContain("accepted trade-off");
  });

  it("the {status:'resolved'}-only legacy shape is retired — the data-loss defect cannot recur", async () => {
    const findingId = seededFindingId();
    const res = await app!.inject({
      method: "PATCH",
      url: `/api/triage/findings/${findingId}`,
      payload: { status: "resolved" },
      headers: humanHeaders(),
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_RETIRED");

    // Nothing was written.
    const finding = findingTriageRepo.getById(findingId)!;
    expect(finding.status).toBe("open");
  });

  it("terminal resurrection through the legacy PATCH gets the single retirement response", async () => {
    const findingId = seededFindingId();
    const resolved = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/resolve`,
      payload: { resolution: "done", resolutionKind: "other" },
      headers: humanHeaders(),
    });
    expect(resolved.statusCode).toBe(200);

    // FU13: the adapter is RETIRED — every legacy shape, including terminal
    // resurrection attempts and the removed unlink shape, gets the SAME typed
    // 400 with zero writes (the terminal row is never reached, never mutated).
    for (const payload of [
      { status: "open" },
      { status: "triaged", bucket: "needs_investigation" },
      { triageMissionId: null },
    ]) {
      const res = await app!.inject({
        method: "PATCH",
        url: `/api/triage/findings/${findingId}`,
        payload,
        headers: humanHeaders(),
      });
      expect(res.statusCode).toBe(400);
      expect(JSON.parse(res.body).code).toBe("LEGACY_PATCH_RETIRED");
    }

    // The terminal row is untouched.
    const finding = findingTriageRepo.getById(findingId)!;
    expect(finding.status).toBe("resolved");
  });

  it("the superseded POST /promote route is retired (404)", async () => {
    const findingId = seededFindingId();
    const res = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/promote`,
      headers: humanHeaders(),
    });
    expect(res.statusCode).toBe(404);
  });

  it("manual activation activates the EXISTING corrective Mission — id never changes, gate clears", async () => {
    const findingId = seededFindingId();

    // Route to a deferred bucket first — creates + links the gated Mission.
    const routed = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/route`,
      payload: {
        bucket: "defer_to_patch",
        missionTitle: "Corrective: cutover-cluster",
        missionDescription: "Fix the cutover cluster defect.",
        releaseGateType: "patch",
        releaseGateVersion: "v0.40.0",
      },
      headers: humanHeaders(),
    });
    expect(routed.statusCode).toBe(200);
    const routedFinding = JSON.parse(routed.body).finding;
    expect(routedFinding.status).toBe("triaged");
    const correctiveMissionId = routedFinding.correctiveMissionId;
    expect(correctiveMissionId).toBeTruthy();

    // Stale version → 409 + X-Current-Version header, Mission untouched.
    const stale = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/activate`,
      payload: { expectedMissionVersion: 999 },
      headers: humanHeaders(),
    });
    expect(stale.statusCode).toBe(409);
    expect(JSON.parse(stale.body).code).toBe("MISSION_VERSION_MISMATCH");
    expect(stale.headers["x-current-version"]).toBeTruthy();
    expect(missionRepo.getMissionById(correctiveMissionId)!.releaseGateType).toBe("patch");

    // Correct version → applied; SAME Mission id, gate cleared.
    const currentVersion = missionRepo.getMissionById(correctiveMissionId)!.version;
    const activated = await app!.inject({
      method: "POST",
      url: `/api/triage/findings/${findingId}/activate`,
      payload: { expectedMissionVersion: currentVersion },
      headers: humanHeaders(),
    });
    expect(activated.statusCode).toBe(200);
    const activation = JSON.parse(activated.body).activation;
    expect(activation.mission.id).toBe(correctiveMissionId);
    expect(activation.mission.releaseGateType).toBeNull();
    expect(activation.findings.map((f: { id: string }) => f.id)).toContain(findingId);

    // Re-fetch: the canonical read shows in_progress on the SAME Mission.
    const refetch = await app!.inject({
      method: "GET",
      url: `/api/triage/findings/${findingId}`,
      headers: humanHeaders(),
    });
    const finding = JSON.parse(refetch.body).finding;
    expect(finding.status).toBe("in_progress");
    expect(finding.correctiveMissionId).toBe(correctiveMissionId);
  });
});
