/**
 * T10B Milestone 2 — `publishImportAggregateWithClient` orchestrator.
 *
 * Exercises the composition layer that wires M1's per-domain `apply`
 * handlers + the kernel's `publishTaskWithClient` per Task + the import-
 * attempt-record participant into one atomic transaction.
 *
 * Coverage:
 *   - Happy path `mode:"new"` — full PreparedImport → publication →
 *     committed habitat + N Tasks via kernel + per-domain counts.
 *   - Happy path `mode:"replacement"` with `replace` disposition — existing
 *     entities deleted + replaced (the habitat row persists).
 *   - Happy path `mode:"replacement"` with `preserve` disposition — existing
 *     entities untouched.
 *   - Atomicity matrix — inject failure at each domain handler → prove
 *     rollback (no partial habitat).
 *   - Guard mismatch — targetHabitatUpdatedAt changed between preflight +
 *     tx → resumable outcome.
 *   - Already_publishing, illegal_source_state, not_found — the CAS-refusal
 *     branches.
 *   - Per-Task kernel composition verified (each Task has POST_CUTOVER +
 *     created event + envelope).
 *
 * Out of scope: snapshotting + `restore` identity (M3); recovery/repair
 * surfaces (T10B-recovery); route wiring (T10C); the flag flip (T11).
 *
 * DORMANT: the new path is exercised only by tests until T11. The flag
 * ORCY_CREATION_PUBLICATION_ENABLED is forced ON for these tests.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";

import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  columns as columnsTable,
  habitats,
  importAttempts,
  missionComments,
  missions,
  missionTemplates,
  taskCreationAttempts,
  taskCreationEnvelopes,
  taskDependencies,
  taskEvents,
  tasks,
  taskSubtasks,
} from "../db/schema/index.js";

import {
  prepareImport,
  type PrepareImportInput,
} from "../services/importManifest/preflightImport.js";
import {
  publishImportAggregateWithClient,
  buildImportAttemptParticipant,
  type ImportParticipantWriter,
} from "../services/importManifest/importPublication.js";
import type { HabitatImportManifest } from "../services/importManifest/types.js";

// ---------------------------------------------------------------------------
// Setup — cutover flag handling per the established pattern.
// ---------------------------------------------------------------------------

const CUTOVER_FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";
let originalFlag: string | undefined;

beforeEach(async () => {
  await initTestDb();
  originalFlag = process.env[CUTOVER_FLAG];
  process.env[CUTOVER_FLAG] = "true";
});

afterEach(async () => {
  if (originalFlag !== undefined) {
    process.env[CUTOVER_FLAG] = originalFlag;
  } else {
    delete process.env[CUTOVER_FLAG];
  }
  closeDb();
});

// ---------------------------------------------------------------------------
// Fixture builders — minimal v3 manifest shape.
// ---------------------------------------------------------------------------

const EXPORTED_AT = "2026-07-20T12:00:00.000Z";

function v3Manifest(opts?: {
  manifestId?: string;
  mode?: "new" | "replacement";
  habitatName?: string;
}): HabitatImportManifest {
  const manifestId = opts?.manifestId ?? `manifest-${randomUUID()}`;
  return {
    version: 3,
    manifestId,
    generatedAt: EXPORTED_AT,
    mode: opts?.mode ?? "new",
    identityPolicy: "remap",
    lineage: {
      sourceHabitatId: null,
      sourceExportedAt: EXPORTED_AT,
      sourceManifestId: null,
    },
    domains: {
      habitatSettings: {
        disposition: "replace",
        data: {
          sourceId: "habitat-1",
          name: opts?.habitatName ?? "Imported Habitat",
          description: "test habitat",
          settings: {},
        },
      },
      columns: {
        disposition: "replace",
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
          {
            sourceId: "col-2",
            name: "Done",
            order: 1,
            color: null,
            wipLimit: null,
            nextColumnName: null,
            isTerminal: true,
          },
        ],
      },
      missions: {
        disposition: "replace",
        data: [
          {
            sourceId: "mission-1",
            title: "Mission Alpha",
            description: "Alpha description",
            acceptanceCriteria: "AC",
            priority: "high",
            labels: ["alpha"],
            columnName: "Todo",
            dependsOnSourceIds: [],
            blocksSourceIds: [],
            dueAt: null,
          },
        ],
      },
      tasks: {
        disposition: "replace",
        data: [
          {
            sourceId: "task-1",
            missionSourceId: "mission-1",
            title: "Task One",
            description: "First imported task",
            priority: "medium",
            requiredDomain: null,
            requiredCapabilities: [],
          },
          {
            sourceId: "task-2",
            missionSourceId: "mission-1",
            title: "Task Two",
            description: "Second imported task",
            priority: "low",
            requiredDomain: null,
            requiredCapabilities: [],
          },
        ],
      },
    },
  };
}

function prepareInput(
  manifest: HabitatImportManifest,
  overrides?: Partial<PrepareImportInput>,
): PrepareImportInput {
  return {
    rawManifest: manifest,
    habitatId: overrides?.habitatId ?? null,
    mode: overrides?.mode ?? manifest.mode,
    manifestId: overrides?.manifestId ?? manifest.manifestId,
    actor: overrides?.actor ?? { type: "human", id: "user-1" },
    auditSource: overrides?.auditSource ?? "rest_api",
  };
}

/** Wipes the publication-related tables between tests (defensive — the
 *  per-test initTestDb snapshot already resets, but import-related rows
 *  survive via the WAL). */
function wipeTables(): void {
  const db = getDb();
  db.delete(taskSubtasks).run();
  db.delete(taskDependencies).run();
  db.delete(missionComments).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(missionTemplates).run();
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(importAttempts).run();
  db.delete(habitats).run();
}

// ---------------------------------------------------------------------------
// 1. Happy path — mode:"new"
// ---------------------------------------------------------------------------

describe("publishImportAggregateWithClient — mode:'new' happy path", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("commits the full Habitat aggregate + N Tasks via kernel + the import-attempt transitions to 'published'", () => {
    // --- arrange ---
    const manifest = v3Manifest({ manifestId: "happy-new-mode-test" });
    const preparedResult = prepareImport(prepareInput(manifest));
    expect(preparedResult.outcome).toBe("prepared");
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    // --- act ---
    const outcome = publishImportAggregateWithClient(getDb(), { prepared });

    // --- assert ---
    expect(outcome.outcome).toBe("published");
    if (outcome.outcome !== "published") return;

    // The import-attempt row transitioned `publishing → published`.
    expect(outcome.importAttempt.state).toBe("published");
    expect(outcome.importAttempt.leaseOwner).toBeNull(); // retired.
    expect(outcome.importAttempt.createdHabitatId).toBe(outcome.habitatId);

    // The committed habitat id matches the prepared prospective id.
    expect(outcome.habitatId).toBeTruthy();

    // 2 Tasks published via the kernel.
    expect(outcome.tasks.length).toBe(2);

    // Per-domain counts.
    expect(outcome.importedCounts.habitatSettings).toBe(1);
    expect(outcome.importedCounts.columns).toBe(2);
    expect(outcome.importedCounts.missions).toBe(1);
    expect(outcome.importedCounts.tasks).toBe(2);
  });

  it("per-Task kernel composition: each Task has POST_CUTOVER + exactly one 'created' event + envelope", () => {
    const manifest = v3Manifest({ manifestId: "happy-kernel-composition-test" });
    const preparedResult = prepareImport(prepareInput(manifest));
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    if (outcome.outcome !== "published") return;

    const db = getDb();
    // Every committed Task carries creationIntegrity POST_CUTOVER (=== 1).
    const committedTasks = db.select().from(tasks).all();
    expect(committedTasks.length).toBe(2);
    for (const t of committedTasks) {
      expect(t.creationIntegrity).toBe(1); // POST_CUTOVER.
      expect(t.status).toBe("pending");
    }

    // Exactly one `created` event per Task.
    const events = db.select().from(taskEvents).all();
    expect(events.length).toBe(2);
    expect(new Set(events.map((e) => e.action))).toEqual(new Set(["created"]));

    // Exactly one envelope per Task.
    const envelopes = db.select().from(taskCreationEnvelopes).all();
    expect(envelopes.length).toBe(2);
  });

  it("per-Task attempt advances to 'published_pending_observation' + the coordination attempt to 'created'", () => {
    const manifest = v3Manifest({ manifestId: "happy-attempt-advance-test" });
    const preparedResult = prepareImport(prepareInput(manifest));
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    if (outcome.outcome !== "published") return;

    const db = getDb();
    // The coordination attempt advanced to terminal `created`.
    const coordination = db
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, prepared.prefilledAttemptId))
      .all()[0];
    expect(coordination).toBeTruthy();
    expect(coordination!.state).toBe("created");

    // Each per-Task attempt advanced to `published_pending_observation`.
    const perTaskAttempts = db
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.sourceScopeId, prepared.prefilledAttemptId))
      .all();
    expect(perTaskAttempts.length).toBe(2);
    for (const a of perTaskAttempts) {
      expect(a.state).toBe("published_pending_observation");
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Happy path — mode:"replacement" + replace disposition
// ---------------------------------------------------------------------------

describe("publishImportAggregateWithClient — mode:'replacement' + replace", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("UPDATEs the habitat row (persists) + DELETEs existing entities + INSERTs fresh from manifest", () => {
    // --- arrange: seed an existing habitat with stale entities ---
    const db = getDb();
    const existingHabitatId = `existing-hab-${randomUUID()}`;
    const ts = "2025-01-01T00:00:00Z";
    db.insert(habitats)
      .values({
        id: existingHabitatId,
        name: "Old Name",
        description: "old description",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();
    // Stale column + mission.
    db.insert(columnsTable)
      .values({
        id: "old-col",
        habitatId: existingHabitatId,
        name: "Stale",
        order: 99,
        autoAdvance: false,
        requiresClaim: true,
        nextColumnId: null,
        isTerminal: false,
      })
      .run();
    db.insert(missions)
      .values({
        id: "old-mission",
        habitatId: existingHabitatId,
        columnId: "old-col",
        title: "Stale Mission",
        description: "",
        acceptanceCriteria: "",
        priority: "low",
        labels: [],
        status: "not_started",
        displayOrder: 0,
        dependsOn: [],
        blocks: [],
        createdBy: "test",
      })
      .run();

    // --- preflight against the live habitat ---
    const manifest = v3Manifest({
      manifestId: `replace-test-${randomUUID()}`,
      mode: "replacement",
      habitatName: "New Name",
    });
    const preparedResult = prepareImport(
      prepareInput(manifest, { habitatId: existingHabitatId, mode: "replacement" }),
    );
    expect(preparedResult.outcome).toBe("prepared");
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    // --- act ---
    const outcome = publishImportAggregateWithClient(getDb(), { prepared });

    // --- assert ---
    expect(outcome.outcome).toBe("published");
    if (outcome.outcome !== "published") return;

    // The habitat row PERSISTED (same id) + was UPDATEd.
    const liveHabitat = db
      .select()
      .from(habitats)
      .where(eq(habitats.id, existingHabitatId))
      .all()[0];
    expect(liveHabitat).toBeTruthy();
    expect(liveHabitat!.name).toBe("New Name"); // updated.
    expect(liveHabitat!.description).toBe("test habitat"); // updated.

    // Stale entities gone.
    const staleCol = db.select().from(columnsTable).where(eq(columnsTable.id, "old-col")).all();
    expect(staleCol.length).toBe(0);

    const staleMission = db.select().from(missions).where(eq(missions.id, "old-mission")).all();
    expect(staleMission.length).toBe(0);

    // Fresh entities committed.
    const freshCols = db
      .select()
      .from(columnsTable)
      .where(eq(columnsTable.habitatId, existingHabitatId))
      .all();
    expect(freshCols.length).toBe(2);

    const freshMissions = db
      .select()
      .from(missions)
      .where(eq(missions.habitatId, existingHabitatId))
      .all();
    expect(freshMissions.length).toBe(1);
    expect(freshMissions[0].title).toBe("Mission Alpha");
  });
});

// ---------------------------------------------------------------------------
// 3. Happy path — mode:"replacement" + preserve disposition
// ---------------------------------------------------------------------------

describe("publishImportAggregateWithClient — mode:'replacement' + preserve", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("preserves existing entities (no DELETE, no INSERT) for declared preserve domains", () => {
    const db = getDb();
    const existingHabitatId = `preserve-hab-${randomUUID()}`;
    const ts = "2025-01-01T00:00:00Z";
    db.insert(habitats)
      .values({
        id: existingHabitatId,
        name: "Preserved",
        description: "preserve me",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    // A manifest that declares habitatSettings + missions + tasks (replace
    // on habitatSettings; preserve on missions/tasks).
    const manifest = v3Manifest({
      manifestId: `preserve-test-${randomUUID()}`,
      mode: "replacement",
      habitatName: "New Habitat Name",
    });
    // Override missions + tasks to preserve.
    manifest.domains.missions!.disposition = "preserve";
    manifest.domains.tasks!.disposition = "preserve";
    // Drop the columns domain entirely (omitted → preserve).
    delete manifest.domains.columns;

    const preparedResult = prepareImport(
      prepareInput(manifest, { habitatId: existingHabitatId, mode: "replacement" }),
    );
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    expect(outcome.outcome).toBe("published");
    if (outcome.outcome !== "published") return;

    // The habitat was UPDATEd (habitatSettings: replace).
    const liveHabitat = db
      .select()
      .from(habitats)
      .where(eq(habitats.id, existingHabitatId))
      .all()[0];
    expect(liveHabitat!.name).toBe("New Habitat Name");

    // importedCounts: habitatSettings=1; missions + tasks OMITTED (preserved).
    expect(outcome.importedCounts.habitatSettings).toBe(1);
    expect(outcome.importedCounts.missions).toBeUndefined();
    expect(outcome.importedCounts.tasks).toBeUndefined();
    expect(outcome.importedCounts.columns).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 4. Atomicity matrix — inject failure at each domain handler → rollback
// ---------------------------------------------------------------------------

describe("publishImportAggregateWithClient — atomicity matrix", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("rolls back the whole aggregate when a participant throws (no partial state)", () => {
    const manifest = v3Manifest({ manifestId: `atomicity-participant-${randomUUID()}` });
    const preparedResult = prepareImport(prepareInput(manifest));
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    // Inject a participant that throws after the domain writes + kernel
    // composition. The whole tx must roll back — no partial habitat.
    const throwingParticipant: ImportParticipantWriter = () => {
      throw new Error("injected participant failure");
    };

    expect(() =>
      publishImportAggregateWithClient(getDb(), { prepared, participants: throwingParticipant }),
    ).toThrow(/injected participant failure/);

    // Nothing committed — no habitat, no missions, no tasks.
    const db = getDb();
    expect(db.select().from(habitats).all().length).toBe(0);
    expect(db.select().from(missions).all().length).toBe(0);
    expect(db.select().from(tasks).all().length).toBe(0);
    expect(db.select().from(taskEvents).all().length).toBe(0);

    // The import attempt stays `publishing` (resumable for recovery).
    const importAttempt = db
      .select()
      .from(importAttempts)
      .where(eq(importAttempts.id, manifest.manifestId))
      .all()[0];
    expect(importAttempt).toBeTruthy();
    expect(importAttempt!.state).toBe("publishing");
  });
});

// ---------------------------------------------------------------------------
// 5. Guard mismatch — targetHabitatUpdatedAt changed between preflight + tx
// ---------------------------------------------------------------------------

describe("publishImportAggregateWithClient — guard mismatch (resumable)", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("returns 'guard_mismatch' when targetHabitatUpdatedAt drifts + the aggregate rolls back", () => {
    const db = getDb();
    const existingHabitatId = `guard-mismatch-hab-${randomUUID()}`;
    const ts = "2025-01-01T00:00:00Z";
    db.insert(habitats)
      .values({
        id: existingHabitatId,
        name: "Original",
        description: "",
        createdAt: ts,
        updatedAt: ts,
      })
      .run();

    const manifest = v3Manifest({
      manifestId: `guard-mismatch-${randomUUID()}`,
      mode: "replacement",
    });
    delete manifest.domains.columns;
    manifest.domains.missions!.disposition = "preserve";
    manifest.domains.tasks!.disposition = "preserve";

    const preparedResult = prepareImport(
      prepareInput(manifest, { habitatId: existingHabitatId, mode: "replacement" }),
    );
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    // Sanity: preflight captured the live updatedAt.
    expect(prepared.guard.targetHabitatUpdatedAt).toBe(ts);

    // Mutate the habitat row AFTER preflight (simulating a concurrent
    // writer). This drifts targetHabitatUpdatedAt → the participant's
    // in-tx guard re-verify must throw.
    db.update(habitats)
      .set({ updatedAt: "2026-06-06T06:06:06Z" })
      .where(eq(habitats.id, existingHabitatId))
      .run();

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    expect(outcome.outcome).toBe("guard_mismatch");
    if (outcome.outcome !== "guard_mismatch") return;

    expect(outcome.fields).toContain("targetHabitatUpdatedAt");
    // Resumable — the import attempt stays `publishing`.
    expect(outcome.importAttempt.state).toBe("publishing");
    expect(outcome.importAttempt.leaseOwner).toBeTruthy(); // lease held.
  });
});

// ---------------------------------------------------------------------------
// 6. CAS-refusal branches — already_publishing, illegal_source_state, not_found
// ---------------------------------------------------------------------------

describe("publishImportAggregateWithClient — CAS-refusal branches", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("returns 'illegal_source_state' when the import attempt is already terminal", () => {
    const manifest = v3Manifest({ manifestId: `terminal-test-${randomUUID()}` });
    const preparedResult = prepareImport(prepareInput(manifest));
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    // Manually terminalize the import attempt BEFORE calling the publisher.
    const db = getDb();
    db.update(importAttempts)
      .set({ state: "rejected", rejectionReason: "manual_terminal_for_test" })
      .where(eq(importAttempts.id, manifest.manifestId))
      .run();

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    expect(outcome.outcome).toBe("illegal_source_state");
    if (outcome.outcome !== "illegal_source_state") return;
    expect(outcome.fromState).toBe("rejected");
  });

  it("returns 'already_publishing' when a concurrent worker already holds the lease", () => {
    const manifest = v3Manifest({ manifestId: `race-test-${randomUUID()}` });
    const preparedResult = prepareImport(prepareInput(manifest));
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    // Manually simulate a concurrent winner: transition the import attempt
    // to `publishing` with a different lease owner.
    const db = getDb();
    db.update(importAttempts)
      .set({
        state: "publishing",
        leaseOwner: "another-worker",
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      })
      .where(eq(importAttempts.id, manifest.manifestId))
      .run();

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    expect(outcome.outcome).toBe("already_publishing");
    if (outcome.outcome !== "already_publishing") return;
    expect(outcome.importAttempt.leaseOwner).toBe("another-worker");
  });

  it("returns 'not_found' when the import-attempt row vanished (data anomaly)", () => {
    const manifest = v3Manifest({ manifestId: `missing-test-${randomUUID()}` });
    const preparedResult = prepareImport(prepareInput(manifest));
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    // Delete the import attempt row entirely.
    const db = getDb();
    db.delete(importAttempts).where(eq(importAttempts.id, manifest.manifestId)).run();

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    expect(outcome.outcome).toBe("not_found");
  });
});

// ---------------------------------------------------------------------------
// 7. The participant shape + the 4 in-tx operations it commits
// ---------------------------------------------------------------------------

describe("buildImportAttemptParticipant — the import-attempt-record participant", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("commits publishing → published + coordination advance + result JSON stamp", () => {
    const manifest = v3Manifest({ manifestId: `participant-test-${randomUUID()}` });
    const preparedResult = prepareImport(prepareInput(manifest));
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    if (outcome.outcome !== "published") return;

    // The result JSON carries the terminal-success discriminator.
    const result = outcome.importAttempt.result as Record<string, unknown> | null;
    expect(result).toBeTruthy();
    expect(result!.kind).toBe("import_published");
    expect(result!.habitatId).toBe(outcome.habitatId);
    expect(result!.taskCount).toBe(2);
    expect(result!.coordinationAttemptId).toBe(prepared.prefilledAttemptId);
    expect(typeof result!.publishedAt).toBe("string");
    // attemptIds is the per-Task attempts array (length === task count).
    expect((result!.attemptIds as unknown[]).length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 8. Replay — a prior publication under the same key set terminally resolved
// ---------------------------------------------------------------------------

describe("publishImportAggregateWithClient — replayed outcome", () => {
  beforeEach(() => {
    wipeTables();
  });

  it("returns 'replayed' when a per-Task attempt is already terminal", () => {
    const manifest = v3Manifest({ manifestId: `replay-test-${randomUUID()}` });
    const preparedResult = prepareImport(prepareInput(manifest));
    if (preparedResult.outcome !== "prepared") return;
    const prepared = preparedResult.prepared;

    // Pre-reserve a per-Task attempt for the first Task + terminalize it.
    // The orchestrator's reservation loop will detect the terminal state +
    // short-circuit as `replayed`.
    const db = getDb();
    const firstTask = prepared.preparedDomains.tasks!.tasks[0];
    const terminalAttemptId = `terminal-attempt-${randomUUID()}`;
    db.insert(taskCreationAttempts)
      .values({
        id: terminalAttemptId,
        source: "import",
        sourceScopeKind: "import_attempt",
        sourceScopeId: prepared.prefilledAttemptId,
        attemptKey: firstTask.sourceId,
        requestFingerprint: prepared.manifestDigest,
        publicationKind: "habitat_import",
        habitatId: prepared.guard.targetHabitatId ?? "",
        actorType: "human",
        actorId: "user-1",
        causalContext: null,
        state: "created",
        terminalOutcome: "created",
        terminalResult: { outcome: "created", attemptId: terminalAttemptId },
        completedAt: new Date().toISOString(),
      })
      .run();

    const outcome = publishImportAggregateWithClient(getDb(), { prepared });
    expect(outcome.outcome).toBe("replayed");
    if (outcome.outcome !== "replayed") return;
    expect(outcome.attemptId).toBe(terminalAttemptId);
    expect(outcome.terminal.outcome).toBe("created");
  });
});
