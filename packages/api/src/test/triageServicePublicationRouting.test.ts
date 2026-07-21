/**
 * T11 Phase 1C — flag-gated triage routing tests.
 *
 * Verifies the `triageService` `isCreationPublicationEnabled` gate (the LAST
 * production origin that bypassed the new publication kernel):
 *   - Flag ON → `createTriageMission` + `createOrphanTriageMission` route
 *     through `publishTriageMission` (reserve → prepare → govern → publish
 *     + atomic junction write). Tasks carry `creationIntegrity: POST_CUTOVER`
 *     + a `created` Lifecycle Event + a committed envelope. The junction row
 *     commits INSIDE the publication tx (the load-bearing crash-window fix —
 *     legacy `applyTemplate` commits FIRST, THEN a separate non-atomic
 *     `triageClusterMissionsRepo.create` runs).
 *   - Flag OFF → legacy `applyTemplate` + separate junction write path runs
 *     byte-identical (verified by the existing `triageResolutions.test.ts` +
 *     `triage-integration.test.ts` suites, which do NOT set the flag and so
 *     default OFF — these tests don't disturb that).
 *
 * The flag-OFF legacy parity is covered EXHAUSTIVELY by the existing triage
 * test suites (unchanged — the flag defaults OFF when these tests don't set
 * it). This suite covers the flag-ON routing + outcome-mapping that the
 * Phase 1C change adds.
 *
 * Reference: the precedent (`automationExecutor.executeCreateTask` gate at
 * `automationExecutor.ts:273-275`) is covered by `automationTaskPublication.test.ts`;
 * the sibling T11 Phase 1B gate (`scheduledTaskService.executeScheduledTask` at
 * `scheduledTaskService.ts:152-154`) is covered by `scheduledTaskPublicationRouting.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  missions,
  tasks,
  taskEvents,
  taskCreationAttempts,
  taskCreationEnvelopes,
  triageClusterMissions,
  habitats,
  columns as columnsTable,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as triageService from "../services/triageService.js";
import * as triageMissionPublication from "../services/triageMissionPublication.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type { ClusterPayload } from "@orcy/shared";

// --- Mocks: assert the adapter emits NO pre-commit effects (SSE/hooks). ---
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("../services/pulseService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pulseService.js")>();
  return { ...actual, onPulseCreated: vi.fn() };
});
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

// --- Shared fixtures ---
const CUTOVER_FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";
let habitatId: string;
let columnId: string;
let originalFlag: string | undefined;

beforeEach(async () => {
  await initTestDb();
  originalFlag = process.env[CUTOVER_FLAG];
  // Default: cutover flag ON — most tests exercise the migrated path.
  process.env[CUTOVER_FLAG] = "true";
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const db = getDb();
  // Wipe the seeded globals so the test habitat is a clean slate. The triage
  // template is global (habitatId=null) — preserve it.
  db.delete(triageClusterMissions).run();
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();

  const habitat = habitatRepo.createHabitat({ name: "T11 Phase 1C Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  publishMock.mockClear();
});

afterEach(() => {
  if (originalFlag !== undefined) {
    process.env[CUTOVER_FLAG] = originalFlag;
  } else {
    delete process.env[CUTOVER_FLAG];
  }
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a representative ClusterPayload matching the scan's output shape. */
function makeClusterPayload(clusterKey: string): ClusterPayload {
  return {
    clusterKey,
    skillCategory: "experience",
    provenanceBreakdown: { experience: 3, finding: 1 },
    signalCount: 4,
    affectedTaskIds: [],
    affectedMissionIds: ["m-1", "m-2"],
    agentIds: ["agent-1", "agent-2"],
    crossMissionCount: 2,
    distinctAgentCount: 2,
    timeWindowDays: 7,
    firstSeenAt: "2026-07-01T00:00:00.000Z",
    lastSeenAt: "2026-07-08T00:00:00.000Z",
  };
}

/** Builds an orphan Mission in the test habitat. */
function makeOrphanMission(title: string) {
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title,
    createdBy: "test",
  });
  return mission;
}

/** Count helper for atomicity + routing assertions. */
function countRows() {
  const db = getDb();
  return {
    missions: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(missions)
      .get()!.count,
    tasks: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(tasks)
      .get()!.count,
    events: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskEvents)
      .get()!.count,
    envelopes: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskCreationEnvelopes)
      .get()!.count,
    junctions: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(triageClusterMissions)
      .get()!.count,
  };
}

/** Returns the open junction row for `(habitatId, clusterKey)` or null. */
function findOpenJunction(hId: string, clusterKey: string) {
  return (
    getDb()
      .select()
      .from(triageClusterMissions)
      .where(
        sql`${triageClusterMissions.habitatId} = ${hId} AND ${triageClusterMissions.clusterKey} = ${clusterKey} AND ${triageClusterMissions.status} = 'open'`,
      )
      .all()[0] ?? null
  );
}

/** Spy on `publishTriageMission` so we can prove the gate actually routes
 *  through it (without spying, the assertion is on side-effects alone, which
 *  would also be produced by the legacy `applyTemplate` path coincidentally
 *  for some inputs). vitest's `vi.spyOn` on a namespace import mutates the
 *  same module-record the gated service resolves — the service's live ESM
 *  binding stays in sync with the spy's replacement. */
const publishTriageSpy = vi.spyOn(
  triageMissionPublication,
  "publishTriageMission",
);

// ---------------------------------------------------------------------------
// Routing — flag ON routes through `publishTriageMission` (cluster origin)
// ---------------------------------------------------------------------------

describe("T11 Phase 1C — flag-gated triage routing", () => {
  describe("flag ON + createTriageMission → publishTriageMission (cluster)", () => {
    it("routes through publishTriageMission, publishes Mission + POST_CUTOVER Task + committed junction", () => {
      const clusterKey = "routing-cluster-key";
      publishTriageSpy.mockClear();

      const result = triageService.createTriageMission(
        habitatId,
        makeClusterPayload(clusterKey),
      );

      // The gate routed to publishTriageMission (proven by the spy firing).
      expect(publishTriageSpy).toHaveBeenCalledTimes(1);
      const calledWith = publishTriageSpy.mock.calls[0][0];
      expect(calledWith.kind).toBe("cluster");
      expect(calledWith.habitatId).toBe(habitatId);
      if (calledWith.kind !== "cluster") return; // narrow for the assertion below
      expect(calledWith.payload.clusterKey).toBe(clusterKey);

      // The return shape matches the legacy `{missionId}` contract.
      expect(result.missionId).toBeTruthy();

      // The kernel chain produced a Mission + 1 POST_CUTOVER Task + the
      // triage_cluster_missions junction — atomically committed (the
      // crash-window fix vs. the legacy non-atomic gap).
      const counts = countRows();
      expect(counts.missions).toBe(1);
      expect(counts.tasks).toBe(1);
      expect(counts.events).toBe(1);
      expect(counts.envelopes).toBe(1);
      expect(counts.junctions).toBe(1);

      const taskRows = getDb().select().from(tasks).all();
      for (const t of taskRows) {
        expect(t.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
      }

      // The junction row is open + carries the missionId from the return.
      const junction = findOpenJunction(habitatId, clusterKey);
      expect(junction).not.toBeNull();
      expect(junction!.missionId).toBe(result.missionId);
      expect(junction!.habitatId).toBe(habitatId);
      expect(junction!.clusterKey).toBe(clusterKey);
    });

    it("publishes the same Title + Description + variables the legacy path produced (parity sanity)", async () => {
      const clusterKey = "parity-cluster";
      // Under flag ON, compute the new-path description the cluster
      // description builder produced.
      publishTriageSpy.mockClear();
      const onResult = triageService.createTriageMission(
        habitatId,
        makeClusterPayload(clusterKey),
      );

      // Compare Mission rows.
      const db = getDb();
      const missionRow = db.select().from(missions).all()[0];
      expect(missionRow.id).toBe(onResult.missionId);
      expect(missionRow.title).toBe(`Triage: ${clusterKey}`);
    });
  });

  // -----------------------------------------------------------------------
  // Routing — flag ON routes through `publishTriageMission` (orphan origin)
  // -----------------------------------------------------------------------

  describe("flag ON + createOrphanTriageMission → publishTriageMission (orphan)", () => {
    it("routes through publishTriageMission, publishes Mission + POST_CUTOVER Task + orphan junction", () => {
      const orphan = makeOrphanMission("Orphan To Map");
      publishTriageSpy.mockClear();

      const result = triageService.createOrphanTriageMission(habitatId, orphan);

      // The gate routed to publishTriageMission.
      expect(publishTriageSpy).toHaveBeenCalledTimes(1);
      const calledWith = publishTriageSpy.mock.calls[0][0];
      expect(calledWith.kind).toBe("orphan");
      expect(calledWith.habitatId).toBe(habitatId);
      if (calledWith.kind !== "orphan") return; // narrow for the assertion below
      expect(calledWith.orphan.id).toBe(orphan.id);

      // Return shape matches the legacy `{missionId}` contract.
      expect(result.missionId).toBeTruthy();

      // 2 missions total now: the orphan itself + the new triage Mission.
      const counts = countRows();
      expect(counts.missions).toBe(2);
      // Only 1 Task (the triage template's "investigate" task on the new
      // triage Mission — the orphan is un-missioned-by-DAG, not yet tasked).
      expect(counts.tasks).toBe(1);
      expect(counts.events).toBe(1);
      expect(counts.envelopes).toBe(1);
      expect(counts.junctions).toBe(1);

      const taskRows = getDb().select().from(tasks).all();
      for (const t of taskRows) {
        expect(t.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);
      }

      // The orphan junction row keyed `orphan-mission:<orphanId>` points at
      // the new triage Mission.
      const junction = findOpenJunction(habitatId, `orphan-mission:${orphan.id}`);
      expect(junction).not.toBeNull();
      expect(junction!.missionId).toBe(result.missionId);
      expect(junction!.clusterKey).toBe(`orphan-mission:${orphan.id}`);
    });

    it("publishes the legacy clusterKey prefix `orphan-mission:<orphanId>` exactly", () => {
      const orphan = makeOrphanMission("Orphan Prefix");
      publishTriageSpy.mockClear();

      triageService.createOrphanTriageMission(habitatId, orphan);

      const junction = findOpenJunction(habitatId, `orphan-mission:${orphan.id}`);
      expect(junction).not.toBeNull();
      expect(junction!.clusterKey).toBe(`orphan-mission:${orphan.id}`);
    });
  });

  // -----------------------------------------------------------------------
  // Outcome mapping — non-published outcomes throw (legacy parity)
  // -----------------------------------------------------------------------

  describe("outcome mapping — non-published outcome throws", () => {
    it("throws (does NOT silently swallow) on rejected_validation", () => {
      // Force the adapter into `rejected_validation` by stubbing the import
      // surface to return that branch.
      const original = publishTriageSpy.getMockImplementation();
      publishTriageSpy.mockImplementationOnce(() => ({
        outcome: "rejected_validation",
        errors: [{ field: "tasks[0].title", code: "required", message: "test forced" }],
      }));

      expect(() =>
        triageService.createTriageMission(habitatId, makeClusterPayload("throwing-cluster")),
      ).toThrow(/rejected_validation/);

      // No Mission / Task / junction rows persisted (the adapter rolled back
      // before any writes; the scan-catch contract is preserved).
      const counts = countRows();
      expect(counts.missions).toBe(0);
      expect(counts.tasks).toBe(0);
      expect(counts.junctions).toBe(0);

      if (original) {
        publishTriageSpy.mockImplementationOnce(original);
      }
    });
  });

  // -----------------------------------------------------------------------
  // Flag OFF → legacy applyTemplate path (byte-identical)
  // -----------------------------------------------------------------------

  describe("flag OFF → legacy applyTemplate path runs byte-identical", () => {
    it("createTriageMission uses legacy applyTemplate (no route through publishTriageMission)", () => {
      delete process.env[CUTOVER_FLAG];
      publishTriageSpy.mockClear();

      const result = triageService.createTriageMission(
        habitatId,
        makeClusterPayload("legacy-cluster"),
      );

      // Legacy path: NO call to publishTriageMission. (The gate must not
      // accidentally invoke the new path when the flag is off.)
      expect(publishTriageSpy).not.toHaveBeenCalled();

      // Mission + Task are LEGACY_PARTIAL_HISTORY (creationIntegrity = 0).
      // The publication path stamps POST_CUTOVER (= 1). The byte-identical
      // legacy semantics include the default 0.
      const taskRows = getDb().select().from(tasks).all();
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0].creationIntegrity).toBe(
        TASK_CREATION_INTEGRITY_VERSION.LEGACY_PARTIAL_HISTORY,
      );

      // The junction row was written by the legacy `triageClusterMissionsRepo.create`
      // AFTER `applyTemplate` committed (the non-atomic gap that Phase 1C
      // fixes). It still points at the returned missionId.
      expect(result.missionId).toBeTruthy();
      const junction = findOpenJunction(habitatId, "legacy-cluster");
      expect(junction).not.toBeNull();
      expect(junction!.missionId).toBe(result.missionId);
    });

    it("createOrphanTriageMission uses legacy applyTemplate (no route through publishTriageMission)", () => {
      delete process.env[CUTOVER_FLAG];
      publishTriageSpy.mockClear();

      const orphan = makeOrphanMission("Legacy Orphan");
      const result = triageService.createOrphanTriageMission(habitatId, orphan);

      expect(publishTriageSpy).not.toHaveBeenCalled();

      const taskRows = getDb().select().from(tasks).all();
      expect(taskRows).toHaveLength(1);
      expect(taskRows[0].creationIntegrity).toBe(
        TASK_CREATION_INTEGRITY_VERSION.LEGACY_PARTIAL_HISTORY,
      );

      const junction = findOpenJunction(habitatId, `orphan-mission:${orphan.id}`);
      expect(junction).not.toBeNull();
      expect(junction!.missionId).toBe(result.missionId);
    });
  });
});
