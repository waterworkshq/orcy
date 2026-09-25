/**
 * REC-06 final contract — habitat import `tasks:reset` marker atomicity on
 * the PRODUCTION driver (better-sqlite3, file-backed, WAL).
 *
 * Two rollback proofs against the real publication transaction
 * (`runTxWithBeginImmediate` — manual BEGIN IMMEDIATE on the caller-owned
 * client), mirroring the plugin-release file-DB proof pattern
 * (`pluginTaskReleaseFileDb.test.ts`):
 *
 *   1. A failure staged AFTER the reset write (a participant throw — the
 *      participant seam runs inside the publication tx, after the domain
 *      writes and the per-task markers) rolls back the WHOLE aggregate:
 *      tasks byte-identical, zero markers, earlier import writes (the
 *      habitatSettings replace UPDATE) reverted. NOT an invalid-input
 *      failure — real writes happened before the abort.
 *   2. An event-INSERT failure (the marker's `createEventWithClient` throws
 *      after the task UPDATE already ran in the same tx) rolls back the
 *      aggregate the same way.
 *
 * Import-attempt rows are created BEFORE the publication tx (attempt
 * reservation + publishing CAS) and therefore SURVIVE the rollback — the
 * resumable-outcome posture is preserved.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, getDb, initDb } from "../db/index.js";
import {
  habitats,
  importAttempts,
  missions as missionsTable,
  tasks as tasksTable,
  taskEvents,
} from "../db/schema/index.js";
import * as missionRepo from "../repositories/mission.js";
import * as agentRepo from "../repositories/agent.js";
import * as taskRepo from "../repositories/task.js";
import * as taskStateMachine from "../repositories/taskStateMachine.js";
import { prepareImport } from "../services/importManifest/preflightImport.js";
import { publishImportAggregateWithClient } from "../services/importManifest/importPublication.js";
import type { HabitatImportManifest } from "../services/importManifest/types.js";
import { createHabitat } from "../services/habitatService.js";

// Fault-injection toggle for the marker event-INSERT failure: the reset's
// task UPDATE has already run when the marker INSERT throws — the whole
// publication tx must roll back.
const eventCrudState = vi.hoisted(() => ({ failCreateWithClient: false }));
vi.mock("../repositories/events/event-crud.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../repositories/events/event-crud.js")>();
  return {
    ...actual,
    createEventWithClient: (db: unknown, input: unknown) => {
      if (eventCrudState.failCreateWithClient) {
        throw new Error("injected mid-aggregate marker insert failure");
      }
      return actual.createEventWithClient(db as never, input as never);
    },
  };
});

vi.mock("../lib/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dbFile: string;

beforeEach(async () => {
  dbFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "orcy-import-reset-")), "orcy.db");
  await initDb(dbFile);
  eventCrudState.failCreateWithClient = false;
});

afterEach(async () => {
  closeDb();
  fs.rmSync(path.dirname(dbFile), { recursive: true, force: true });
});

interface DirtyFixture {
  habitatId: string;
  claimedTaskId: string;
  doneTaskId: string;
  staleToken: string;
}

function seedDirtyHabitat(): DirtyFixture {
  const { habitat } = createHabitat({ name: "Before Reset", defaultColumns: true });
  const habitatId = habitat.id;
  const missionId = missionRepo.createMission({
    habitatId,
    title: "FileDb Mission",
    createdBy: "seeder",
  }).id;
  const agentId = agentRepo.createAgent({
    name: "filedb-agent",
    type: "claude-code",
    domain: "backend",
  }).agent.id;

  const claimed = taskRepo.createTask({ missionId, title: "Claimed", createdBy: "seeder" });
  const claimRes = taskStateMachine.claimTask(claimed.id, agentId);
  if (!claimRes.success) throw new Error(`seed claim failed: ${claimRes.reason}`);

  const now = new Date().toISOString();
  const doneTaskId = `fdb-done-${Math.random().toString(36).slice(2)}`;
  getDb()
    .insert(tasksTable)
    .values({
      id: doneTaskId,
      missionId,
      title: "Done",
      description: "",
      priority: "medium",
      status: "done",
      assignedAgentId: agentId,
      claimedAt: now,
      startedAt: now,
      completedAt: now,
      rejectedCount: 1,
      rejectionReason: "once",
      result: "shipped",
      artifacts: [{ type: "file", url: "x", description: "x" }],
      lastFailureEventId: "legacy-failure-event",
      retryCount: 1,
      nextRetryAt: now,
      createdBy: "seeder",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const claimedRow = getDb().select().from(tasksTable).where(eq(tasksTable.id, claimed.id)).get();
  if (!claimedRow?.executionToken) throw new Error("seed token missing");

  return {
    habitatId,
    claimedTaskId: claimed.id,
    doneTaskId,
    staleToken: claimedRow.executionToken,
  };
}

/** replacement manifest: habitatSettings:replace (an EARLIER import write) + tasks:reset. */
function resetPlusSettingsManifest(): HabitatImportManifest {
  return {
    version: 3,
    manifestId: `fdb-rst-${Math.random().toString(36).slice(2)}`,
    generatedAt: "2026-07-25T12:00:00.000Z",
    mode: "replacement",
    identityPolicy: "remap",
    lineage: {
      sourceHabitatId: null,
      sourceExportedAt: "2026-07-25T12:00:00.000Z",
      sourceManifestId: null,
    },
    domains: {
      habitatSettings: {
        disposition: "replace",
        data: { sourceId: "habitat-1", name: "After Reset", description: "replaced", settings: {} },
      },
      tasks: { disposition: "reset", data: [] },
    },
  } as unknown as HabitatImportManifest;
}

function resetMarkers(): Array<{ taskId: string }> {
  return getDb()
    .select()
    .from(taskEvents)
    .all()
    .filter(
      (e) => (e.metadata as Record<string, unknown> | null)?.importDisposition === "tasks:reset",
    )
    .map((e) => ({ taskId: e.taskId }));
}

/** Full-row snapshots of the habitat's tasks (byte-identical comparison). */
function snapshotTasks(habitatId: string): unknown[] {
  const missionIds = getDb()
    .select({ id: missionsTable.id })
    .from(missionsTable)
    .where(eq(missionsTable.habitatId, habitatId))
    .all()
    .map((r) => r.id);
  return getDb()
    .select()
    .from(tasksTable)
    .all()
    .filter((t) => missionIds.includes((t as { missionId: string }).missionId));
}

describe("import tasks:reset markers — whole-aggregate rollback (production file DB)", () => {
  it("a failure AFTER the reset write rolls back tasks + markers + earlier import writes", () => {
    const fixture = seedDirtyHabitat();
    const manifest = resetPlusSettingsManifest();
    const beforeTasks = snapshotTasks(fixture.habitatId);

    const prepared = prepareImport({
      rawManifest: manifest,
      habitatId: fixture.habitatId,
      mode: "replacement",
      actor: { type: "human", id: "filedb-admin" },
      auditSource: "rest_api",
    });
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") return;

    // The participant seam runs INSIDE the publication tx, AFTER the domain
    // writes + the per-task markers — a real post-write abort, not an
    // invalid-input failure that throws before any write.
    expect(() =>
      publishImportAggregateWithClient(getDb(), {
        prepared: prepared.prepared,
        participants: () => {
          throw new Error("injected post-reset participant failure");
        },
      }),
    ).toThrow(/injected post-reset participant failure/);

    // Tasks byte-identical (dirty state intact — the reset was rolled back).
    expect(snapshotTasks(fixture.habitatId)).toEqual(beforeTasks);
    // Zero markers survived.
    expect(resetMarkers()).toHaveLength(0);
    // The EARLIER import write (habitatSettings replace UPDATE) rolled back.
    const habitatRow = getDb()
      .select()
      .from(habitats)
      .where(eq(habitats.id, fixture.habitatId))
      .get();
    expect(habitatRow?.name).toBe("Before Reset");
    // Import-attempt rows were created BEFORE the tx — preserved (resumable).
    const attempt = getDb()
      .select()
      .from(importAttempts)
      .where(eq(importAttempts.id, manifest.manifestId))
      .get();
    expect(attempt).toBeDefined();
    expect(attempt?.state).toBe("publishing");
  });

  it("a marker event-INSERT failure after the reset UPDATE rolls back the whole aggregate", () => {
    const fixture = seedDirtyHabitat();
    const manifest = resetPlusSettingsManifest();
    const beforeTasks = snapshotTasks(fixture.habitatId);

    const prepared = prepareImport({
      rawManifest: manifest,
      habitatId: fixture.habitatId,
      mode: "replacement",
      actor: { type: "human", id: "filedb-admin" },
      auditSource: "rest_api",
    });
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") return;

    eventCrudState.failCreateWithClient = true;
    expect(() =>
      publishImportAggregateWithClient(getDb(), { prepared: prepared.prepared }),
    ).toThrow(/injected mid-aggregate marker insert failure/);

    // The reset UPDATE + every marker rolled back together.
    expect(snapshotTasks(fixture.habitatId)).toEqual(beforeTasks);
    expect(resetMarkers()).toHaveLength(0);
    const habitatRow = getDb()
      .select()
      .from(habitats)
      .where(eq(habitats.id, fixture.habitatId))
      .get();
    expect(habitatRow?.name).toBe("Before Reset");
    const attempt = getDb()
      .select()
      .from(importAttempts)
      .where(eq(importAttempts.id, manifest.manifestId))
      .get();
    expect(attempt).toBeDefined();
  });
});
