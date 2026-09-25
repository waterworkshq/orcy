/**
 * REC-06 final contract — habitat import `tasks:reset` per-task audit markers.
 *
 * Exercises the REAL PUBLIC import wire (`POST /api/habitats/:habitatId/import`
 * with an authenticated human JWT) and asserts the root-accepted contract:
 *
 *   1. Every task affected by a `tasks:reset` import emits exactly ONE
 *      `updated` task event inside the publication tx — actor = the REAL
 *      human caller, metadata = the bounded server-owned
 *      `{importDisposition, importAttemptId, mode, preStatus}` set, with
 *      `fromStatus`/`toStatus` carrying the true pre → pending transition.
 *      ALL pre-statuses are covered (pending/claimed/in_progress/submitted/
 *      approved/rejected/done/failed — the full schema enum, terminal states
 *      included).
 *      Attribution is two-rooted: on the expired-lease recovery path the
 *      marker actor is the ACTUAL executing human, which may differ from the
 *      import attempt's original initiator (section 4 proves the split).
 *   2. The full reset column matrix (pointers, token, delegation, retry incl.
 *      `nextRetryAt`, metrics, version bump) is unchanged by the marker work.
 *   3. Event-ROW only: zero recovery effects (no receipts, no spawned tasks).
 *   4. The marker is retrievable through the EXISTING task-events GET route —
 *      no new read surface.
 *   5. `preserve`/`replace` dispositions produce ZERO reset markers.
 *   6. Old-session/old-token safety: a stale execution token cannot mutate a
 *      reset-pending task; a fresh claim mints a new epoch.
 *
 * Driver-level rollback proofs (whole-aggregate rollback incl. the markers,
 * and event-INSERT failure rollback) live in the file-DB sibling
 * `importResetTaskAuditFileDb.test.ts` (production better-sqlite3 driver).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  effectReceipts,
  importAttempts,
  missions as missionsTable,
  tasks as tasksTable,
  taskEvents,
} from "../db/schema/index.js";
import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import * as eventRepo from "../repositories/event.js";

import { createHabitat } from "../services/habitatService.js";
import { prepareImport } from "../services/importManifest/preflightImport.js";
import { publishImportAggregateWithClient } from "../services/importManifest/importPublication.js";
import type { HabitatImportManifest } from "../services/importManifest/types.js";
import { habitatExportRoutes } from "../routes/board-export.js";
import { taskMiscRoutes } from "../routes/tasks/misc.js";
import { registerErrorHandler } from "../errors/plugin.js";

// ---------------------------------------------------------------------------
// Setup — JWT helpers, app builder (mirrors boardExportImportDispatch.test.ts).
// ---------------------------------------------------------------------------

const JWT_SECRET = "dev-secret-change-in-production";
const HUMAN_ID = "reset-admin-1";
const CUTOVER_FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";
let originalFlag: string | undefined;

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function humanToken(): string {
  return makeToken({ sub: HUMAN_ID, username: "reset-route-admin", role: "admin" });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(
    async (f) => {
      f.addHook("preHandler", perAgentRateLimit);
      await f.register(habitatExportRoutes);
      await f.register(taskMiscRoutes);
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

function wipeTables(): void {
  const db = getDb();
  db.delete(effectReceipts).run();
  db.delete(taskEvents).run();
  db.delete(tasksTable).run();
  db.delete(missionsTable).run();
  db.delete(importAttempts).run();
}

// ---------------------------------------------------------------------------
// Fixture — a habitat whose mission carries tasks in EVERY reset-relevant
// pre-status, with dirty execution state on each row.
// ---------------------------------------------------------------------------

interface SeededTask {
  id: string;
  preStatus: string;
}

interface SeededHabitat {
  habitatId: string;
  missionId: string;
  agentId: string;
  tasks: SeededTask[];
  /** The pre-reset execution token of the claimed/in_progress pair. */
  staleToken: string;
  claimedTaskId: string;
  inProgressTaskId: string;
}

function seedResetHabitat(): SeededHabitat {
  const { habitat } = createHabitat({ name: "Reset Audit Habitat", defaultColumns: true });
  const habitatId = habitat.id;
  const missionId = missionRepo.createMission({
    habitatId,
    title: "Reset Audit Mission",
    createdBy: "seeder",
  }).id;
  const agentId = agentRepo.createAgent({
    name: "reset-audit-agent",
    type: "claude-code",
    domain: "backend",
  }).agent.id;

  const db = getDb();
  const now = new Date().toISOString();
  const ids = {
    pending: `rst-pending-${randomUUID()}`,
    claimed: `rst-claimed-${randomUUID()}`,
    in_progress: `rst-inprog-${randomUUID()}`,
    submitted: `rst-submitted-${randomUUID()}`,
    approved: `rst-approved-${randomUUID()}`,
    rejected: `rst-rejected-${randomUUID()}`,
    done: `rst-done-${randomUUID()}`,
    failed: `rst-failed-${randomUUID()}`,
  };

  // pending — with dirty delegation + retry + metrics state.
  db.insert(tasksTable)
    .values({
      id: ids.pending,
      missionId,
      title: "PendingTask",
      description: "",
      priority: "low",
      status: "pending",
      delegatedToAgentId: agentId,
      retryCount: 4,
      nextRetryAt: now,
      actualMinutes: 11,
      cycleTimeMinutes: 22,
      leadTimeMinutes: 33,
      estimationAccuracy: 0.5,
      createdBy: "seeder",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  // claimed — via the canonical claim (mints a real execution token).
  const claimed = taskRepo.createTask({ missionId, title: "ClaimedTask", createdBy: "seeder" });
  db.update(tasksTable).set({ id: ids.claimed }).where(eq(tasksTable.id, claimed.id)).run();
  const claimRes = taskStateMachine.claimTask(ids.claimed, agentId);
  if (!claimRes.success) throw new Error(`seed claim failed: ${claimRes.reason}`);

  // in_progress — canonical claim + start (real token epoch).
  const inProg = taskRepo.createTask({
    missionId,
    title: "InProgressTask",
    createdBy: "seeder",
  });
  db.update(tasksTable).set({ id: ids.in_progress }).where(eq(tasksTable.id, inProg.id)).run();
  const claim2 = taskStateMachine.claimTask(ids.in_progress, agentId);
  if (!claim2.success) throw new Error(`seed claim2 failed: ${claim2.reason}`);
  const started = taskStateMachine.startTask(ids.in_progress, agentId);
  if (!started) throw new Error("seed start failed");

  // submitted / approved / rejected / done / failed — direct dirty rows
  // (ALL eight schema statuses: pending + claimed + in_progress above,
  // these five below; terminal + review + failure states included).
  for (const [key, status] of [
    ["submitted", "submitted"],
    ["approved", "approved"],
    ["rejected", "rejected"],
    ["done", "done"],
    ["failed", "failed"],
  ] as const) {
    db.insert(tasksTable)
      .values({
        id: ids[key],
        missionId,
        title: `${key}Task`,
        description: "",
        priority: "medium",
        status,
        assignedAgentId: agentId,
        claimedAt: now,
        startedAt: now,
        submittedAt: key === "submitted" || key === "approved" || key === "done" ? now : null,
        completedAt: key === "approved" || key === "done" ? now : null,
        rejectedCount: key === "rejected" ? 2 : key === "failed" ? 1 : 0,
        rejectionReason: key === "rejected" ? "needs work" : null,
        result: key === "submitted" ? "partial work" : null,
        artifacts: [{ type: "file", url: "x", description: "x" }],
        // The failed row carries the full failure/retry dirt the reset clears.
        executionToken: key === "failed" ? `stale-token-${key}` : null,
        retryCount: key === "failed" ? 3 : 0,
        nextRetryAt: key === "failed" ? now : null,
        lastFailureEventId: "legacy-failure-event",
        lastReleaseEventId: "legacy-release-event",
        createdBy: "seeder",
        createdAt: now,
        updatedAt: now,
      })
      .run();
  }

  const staleTokenRow = db
    .select()
    .from(tasksTable)
    .where(eq(tasksTable.id, ids.in_progress))
    .get();
  if (!staleTokenRow?.executionToken) throw new Error("seed token missing");

  return {
    habitatId,
    missionId,
    agentId,
    tasks: [
      { id: ids.pending, preStatus: "pending" },
      { id: ids.claimed, preStatus: "claimed" },
      { id: ids.in_progress, preStatus: "in_progress" },
      { id: ids.submitted, preStatus: "submitted" },
      { id: ids.approved, preStatus: "approved" },
      { id: ids.rejected, preStatus: "rejected" },
      { id: ids.done, preStatus: "done" },
      { id: ids.failed, preStatus: "failed" },
    ],
    staleToken: staleTokenRow.executionToken,
    claimedTaskId: ids.claimed,
    inProgressTaskId: ids.in_progress,
  };
}

/** Minimal v3 `replacement` manifest whose ONLY declared domain is tasks:reset. */
function resetManifest(opts?: {
  disposition?: "reset" | "preserve" | "replace";
}): HabitatImportManifest {
  return {
    version: 3,
    manifestId: `rst-${randomUUID()}`,
    generatedAt: "2026-07-25T12:00:00.000Z",
    mode: "replacement",
    identityPolicy: "remap",
    lineage: {
      sourceHabitatId: null,
      sourceExportedAt: "2026-07-25T12:00:00.000Z",
      sourceManifestId: null,
    },
    domains: {
      // `replace` republishes tasks — their missionSourceId must resolve, so
      // the replace fixture carries its own columns + missions domains (the
      // full-replacement shape). reset/preserve fixtures declare tasks only.
      ...(opts?.disposition === "replace"
        ? {
            columns: {
              disposition: "replace" as const,
              data: [
                {
                  sourceId: "col-1",
                  name: "Todo",
                  order: 0,
                  color: null,
                  wipLimit: null,
                  nextColumnName: null,
                  isTerminal: false,
                },
              ],
            },
            missions: {
              disposition: "replace" as const,
              data: [
                {
                  sourceId: "mission-src-1",
                  title: "Fresh Mission",
                  description: "",
                  acceptanceCriteria: "",
                  priority: "medium",
                  labels: [],
                  columnName: "Todo",
                  dependsOnSourceIds: [],
                  blocksSourceIds: [],
                  dueAt: null,
                },
              ],
            },
            // tasks:replace deletes tasks — the dependent domains must be
            // declared (the dependency-safety validate rule).
            subtasks: { disposition: "replace" as const, data: [] },
            dependencies: { disposition: "replace" as const, data: [] },
          }
        : {}),
      tasks: {
        disposition: opts?.disposition ?? "reset",
        data:
          opts?.disposition === "replace"
            ? [
                {
                  sourceId: "fresh-1",
                  missionSourceId: "mission-src-1",
                  title: "Fresh",
                  description: "",
                  priority: "medium",
                  requiredDomain: null,
                  requiredCapabilities: [],
                },
              ]
            : [],
      },
    },
  } as unknown as HabitatImportManifest;
}

/** All import-reset markers currently in the DB (scoped by metadata tag). */
function resetMarkers(): Array<{
  taskId: string;
  actorType: string;
  actorId: string;
  fromStatus: string | null;
  toStatus: string | null;
  metadata: Record<string, unknown>;
}> {
  return getDb()
    .select()
    .from(taskEvents)
    .all()
    .filter(
      (e) => (e.metadata as Record<string, unknown> | null)?.importDisposition === "tasks:reset",
    )
    .map((e) => ({
      taskId: e.taskId,
      actorType: e.actorType,
      actorId: e.actorId,
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      metadata: e.metadata as Record<string, unknown>,
    }));
}

let app: FastifyInstance | null = null;

beforeEach(async () => {
  await initTestDb();
  wipeTables();
  originalFlag = process.env[CUTOVER_FLAG];
  process.env[CUTOVER_FLAG] = "true";
});

afterEach(async () => {
  if (originalFlag !== undefined) {
    process.env[CUTOVER_FLAG] = originalFlag;
  } else {
    delete process.env[CUTOVER_FLAG];
  }
  if (app) {
    await app.close();
    app = null;
  }
  closeDb();
});

// ---------------------------------------------------------------------------
// 1. The contract: route-level reset import → exactly N `updated` markers.
// ---------------------------------------------------------------------------

describe("import tasks:reset audit markers — real route, human caller", () => {
  it("emits exactly one `updated` marker per reset task with real human actor, bounded server-owned metadata, and true preStatus", async () => {
    const seeded = seedResetHabitat();
    const manifest = resetManifest();
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      headers: { authorization: `Bearer ${humanToken()}` },
      payload: manifest,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe("published");

    const markers = resetMarkers();
    expect(markers).toHaveLength(seeded.tasks.length);
    for (const seededTask of seeded.tasks) {
      const marker = markers.filter((m) => m.taskId === seededTask.id);
      expect(marker).toHaveLength(1);
      const m = marker[0];
      // Real human principal — the authenticated import caller, not "system".
      expect(m.actorType).toBe("human");
      expect(m.actorId).toBe(HUMAN_ID);
      // Normal from/to status structure on the actual event model.
      expect(m.fromStatus).toBe(seededTask.preStatus);
      expect(m.toStatus).toBe("pending");
      // Bounded server-owned metadata — IDs never accepted from the upload.
      expect(m.metadata.importDisposition).toBe("tasks:reset");
      expect(m.metadata.importAttemptId).toBe(manifest.manifestId);
      expect(m.metadata.mode).toBe("replacement");
      expect(m.metadata.preStatus).toBe(seededTask.preStatus);
    }
  });

  it("reset column matrix unchanged: pointers, token, delegation, retry (incl. nextRetryAt), metrics, version bump", async () => {
    const seeded = seedResetHabitat();
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      headers: { authorization: `Bearer ${humanToken()}` },
      payload: resetManifest(),
    });
    expect(res.statusCode).toBe(201);

    const rows = getDb().select().from(tasksTable).all();
    expect(rows).toHaveLength(seeded.tasks.length);
    for (const row of rows) {
      expect(row.status).toBe("pending");
      expect(row.assignedAgentId).toBeNull();
      expect(row.remoteAssignedParticipantId).toBeNull();
      expect(row.claimedAt).toBeNull();
      expect(row.startedAt).toBeNull();
      expect(row.executionToken).toBeNull();
      expect(row.lastFailureEventId).toBeNull();
      expect(row.lastReleaseEventId).toBeNull();
      expect(row.submittedAt).toBeNull();
      expect(row.completedAt).toBeNull();
      expect(row.rejectedCount).toBe(0);
      expect(row.rejectionReason).toBeNull();
      expect(row.result).toBeNull();
      expect(row.artifacts).toEqual([]);
      expect(row.delegatedToAgentId).toBeNull();
      expect(row.retryCount).toBe(0);
      expect(row.nextRetryAt).toBeNull();
      expect(row.actualMinutes).toBeNull();
      expect(row.cycleTimeMinutes).toBeNull();
      expect(row.leadTimeMinutes).toBeNull();
      expect(row.estimationAccuracy).toBeNull();
      expect(row.version).toBeGreaterThanOrEqual(2);
    }
  });

  it("marker is event-ROW only: zero receipts, zero spawned recovery tasks, task count unchanged", async () => {
    const seeded = seedResetHabitat();
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      headers: { authorization: `Bearer ${humanToken()}` },
      payload: resetManifest(),
    });
    expect(res.statusCode).toBe(201);

    // No recovery receipts were enqueued for the reset.
    expect(getDb().select().from(effectReceipts).all()).toHaveLength(0);
    // No recovery task was spawned: exactly the seeded tasks remain, one mission.
    expect(getDb().select().from(tasksTable).all()).toHaveLength(seeded.tasks.length);
    const missions = getDb().select().from(missionsTable).all();
    expect(missions.filter((m) => m.habitatId === seeded.habitatId)).toHaveLength(1);
  });

  it("the marker is retrievable through the EXISTING GET /tasks/:id/events route (no new read surface)", async () => {
    const seeded = seedResetHabitat();
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      headers: { authorization: `Bearer ${humanToken()}` },
      payload: resetManifest(),
    });
    expect(res.statusCode).toBe(201);

    const eventsRes = await app.inject({
      method: "GET",
      url: `/api/tasks/${seeded.inProgressTaskId}/events`,
      headers: { authorization: `Bearer ${humanToken()}` },
    });
    expect(eventsRes.statusCode).toBe(200);
    const body = eventsRes.json() as {
      events: Array<{
        action: string;
        actorType: string;
        actorId: string;
        fromStatus: string | null;
        toStatus: string | null;
        metadata: Record<string, unknown>;
      }>;
      total: number;
    };
    const marker = body.events.filter(
      (e) => e.action === "updated" && e.metadata?.importDisposition === "tasks:reset",
    );
    expect(marker).toHaveLength(1);
    expect(marker[0].actorType).toBe("human");
    expect(marker[0].actorId).toBe(HUMAN_ID);
    expect(marker[0].fromStatus).toBe("in_progress");
    expect(marker[0].toStatus).toBe("pending");
    expect(marker[0].metadata.importAttemptId).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2. Scoped pin: preserve/replace produce ZERO reset markers.
// ---------------------------------------------------------------------------

describe("import tasks:preserve / tasks:replace — zero reset markers", () => {
  it("tasks:preserve leaves tasks untouched with zero reset markers", async () => {
    const seeded = seedResetHabitat();
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      headers: { authorization: `Bearer ${humanToken()}` },
      payload: resetManifest({ disposition: "preserve" }),
    });
    expect(res.statusCode).toBe(201);

    expect(resetMarkers()).toHaveLength(0);
    // Untouched: the in_progress task keeps its state.
    const row = getDb()
      .select()
      .from(tasksTable)
      .where(eq(tasksTable.id, seeded.inProgressTaskId))
      .get();
    expect(row?.status).toBe("in_progress");
    expect(row?.executionToken).toBe(seeded.staleToken);
  });

  it("tasks:replace republishes with zero reset markers (identity/history asymmetry is the documented replace behavior)", async () => {
    const seeded = seedResetHabitat();
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      headers: { authorization: `Bearer ${humanToken()}` },
      payload: resetManifest({ disposition: "replace" }),
    });
    expect(res.statusCode).toBe(201);

    expect(resetMarkers()).toHaveLength(0);
    // The replace-published fresh task carries its kernel `created` event —
    // no importDisposition metadata anywhere.
    const withImportTag = getDb()
      .select()
      .from(taskEvents)
      .all()
      .filter(
        (e) => (e.metadata as Record<string, unknown> | null)?.importDisposition !== undefined,
      );
    expect(withImportTag).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 3. Old-session / old-token safety around the reset boundary.
// ---------------------------------------------------------------------------

describe("import tasks:reset — stale-token safety", () => {
  it("an old token cannot mutate the reset-pending task; a fresh claim mints a new epoch", async () => {
    const seeded = seedResetHabitat();
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      headers: { authorization: `Bearer ${humanToken()}` },
      payload: resetManifest(),
    });
    expect(res.statusCode).toBe(201);

    // The pre-reset token is dead: status refusal (pending) precedes any
    // token check, and the epoch guard would fail regardless.
    expect(
      taskStateMachine.startTask(seeded.inProgressTaskId, seeded.agentId, seeded.staleToken),
    ).toBeNull();
    expect(
      taskStateMachine.submitTask(
        seeded.inProgressTaskId,
        seeded.agentId,
        "late submit",
        [],
        seeded.staleToken,
      ),
    ).toBeNull();
    expect(
      taskStateMachine.releaseTask(seeded.inProgressTaskId, "late release", seeded.staleToken),
    ).toBeNull();

    // A fresh claim succeeds and mints a NEW non-null epoch token.
    const reclaimed = taskStateMachine.claimTask(seeded.inProgressTaskId, seeded.agentId);
    expect(reclaimed.success).toBe(true);
    if (reclaimed.success) {
      expect(reclaimed.task.executionToken).not.toBeNull();
      expect(reclaimed.task.executionToken).not.toBe(seeded.staleToken);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Expired-lease recovery — truthful attribution with DISTINCT humans.
//    Reservation/initiation principal A ≠ the human who actually executes the
//    recovered reset (B). The marker records B (the actual resetting actor);
//    the import_attempt row keeps its historical reserver A (never rewritten,
//    never stamped with B); metadata.importAttemptId links the immutable
//    attempt. Derived from actual code: the attempt actor is written once at
//    reservation (importAttempts.ts reserveImportAttemptWithClient); the
//    expired-lease reclaim updates ONLY leaseOwner/lease timestamps; the
//    recovery route rebuilds prepared.authority.caller from the CURRENT
//    authenticated request (board-export.ts reclaim path).
// ---------------------------------------------------------------------------

describe("import tasks:reset — expired-lease recovery attribution (A reserves, B executes)", () => {
  const INITIATOR_A = "reset-initiator-a";
  const RECOVERER_B = "reset-recoverer-b";

  it("markers attribute to the ACTUAL executing human B while the import attempt keeps initiator A", async () => {
    const seeded = seedResetHabitat();
    const manifest = resetManifest();

    // Human A reserves the import + acquires the publishing lease; the
    // publication then fails mid-flight (simulated worker crash AFTER lease
    // acquisition — the dispatch-test precedent). The attempt stays
    // `publishing` under A's reservation.
    const preparedA = prepareImport({
      rawManifest: manifest,
      habitatId: seeded.habitatId,
      mode: "replacement",
      actor: { type: "human", id: INITIATOR_A },
      auditSource: "rest_api",
    });
    expect(preparedA.outcome).toBe("prepared");
    if (preparedA.outcome !== "prepared") return;
    expect(() =>
      publishImportAggregateWithClient(getDb(), {
        prepared: preparedA.prepared,
        participants: () => {
          throw new Error("simulate A's worker crash after lease acquisition");
        },
      }),
    ).toThrow(/simulate A's worker crash/);

    // The reservation's actor survives the crash: initiator A on the attempt.
    const attemptAfterCrash = getDb()
      .select()
      .from(importAttempts)
      .where(eq(importAttempts.id, manifest.manifestId))
      .get();
    expect(attemptAfterCrash).toBeDefined();
    expect(attemptAfterCrash?.state).toBe("publishing");
    expect(attemptAfterCrash?.actorType).toBe("human");
    expect(attemptAfterCrash?.actorId).toBe(INITIATOR_A);
    expect(attemptAfterCrash?.attemptId).not.toBeNull();

    // Expire A's lease.
    getDb()
      .update(importAttempts)
      .set({ leaseExpiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(importAttempts.id, manifest.manifestId))
      .run();

    app = await buildApp();

    // Authority is enforced on the recovery path too — no bypass: an
    // unauthenticated re-post of the exact manifest is refused and writes
    // nothing.
    const anon = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      payload: manifest,
    });
    expect(anon.statusCode).toBe(401);
    expect(resetMarkers()).toHaveLength(0);

    // Human B re-submits the SAME manifest id/digest through the PUBLIC
    // route → expired-lease reclaim → the recovered publication executes.
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      headers: {
        authorization: `Bearer ${makeToken({ sub: RECOVERER_B, username: "reset-recoverer", role: "admin" })}`,
      },
      payload: manifest,
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().outcome).toBe("published");

    // The attempt row STILL records initiator A — history not rewritten,
    // B never stamped as the reservation actor.
    const attemptFinal = getDb()
      .select()
      .from(importAttempts)
      .where(eq(importAttempts.id, manifest.manifestId))
      .get();
    expect(attemptFinal?.actorType).toBe("human");
    expect(attemptFinal?.actorId).toBe(INITIATOR_A);

    // The markers attribute to the ACTUAL resetting actor: human B, one per
    // task, correct preStatus, and metadata.importAttemptId linking the
    // immutable (A-reserved) attempt row.
    const markers = resetMarkers();
    expect(markers).toHaveLength(seeded.tasks.length);
    for (const seededTask of seeded.tasks) {
      const marker = markers.filter((m) => m.taskId === seededTask.id);
      expect(marker).toHaveLength(1);
      expect(marker[0].actorType).toBe("human");
      expect(marker[0].actorId).toBe(RECOVERER_B);
      expect(marker[0].fromStatus).toBe(seededTask.preStatus);
      expect(marker[0].toStatus).toBe("pending");
      expect(marker[0].metadata.importAttemptId).toBe(manifest.manifestId);
      expect(marker[0].metadata.importDisposition).toBe("tasks:reset");
      expect(marker[0].metadata.mode).toBe("replacement");
      expect(marker[0].metadata.preStatus).toBe(seededTask.preStatus);
    }
    // No initiator-identity duplication in the metadata by default — the
    // event actor (B) + the linked attempt (A) are the two provenance roots.
    for (const m of markers) {
      expect(m.metadata.initiatorActorId).toBeUndefined();
      expect(m.metadata.initiatorActorType).toBeUndefined();
    }
  });
});

// ---------------------------------------------------------------------------
// 5. Auth posture pin — the import route stays human-only.
// ---------------------------------------------------------------------------

describe("import tasks:reset — auth scope unchanged", () => {
  it("rejects an unauthenticated import request", async () => {
    const seeded = seedResetHabitat();
    app = await buildApp();

    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${seeded.habitatId}/import`,
      payload: resetManifest(),
    });
    expect(res.statusCode).toBe(401);
    expect(resetMarkers()).toHaveLength(0);
  });
});
