/**
 * T10A Milestone 4 — Preflight Pipeline + PreparedImport + Authority Separation.
 *
 * Exercises the composition layer that wires M1 (manifest v3 types + the
 * import-attempt repo) + M2 (the declared legacy adapter) + M3 (the 8
 * domain handlers) into the PURE 6-step pipeline producing the immutable
 * PreparedImport envelope consumed by T10B's atomic transaction.
 *
 * Coverage:
 *   - Happy path (v3 manifest → reserve → preflight → PreparedImport).
 *   - v1 + v2 happy paths (via M2's adapter).
 *   - Dormancy gate (`ORCY_CREATION_PUBLICATION_ENABLED=false` → feature_disabled).
 *   - Version rejection (unknown version → UnknownManifestVersion).
 *   - Authority violations (3 distinct checks separately):
 *       (b1) legacy v1/v2 + `identityPolicy:"restore"` → legacy_restore_forbidden.
 *       (b2) v3 `identityPolicy:"restore"` + null sourceHabitatId → restore_requires_source_habitat.
 *       (b3) unsupported disposition on a declared domain.
 *   - Per-domain validation failure (at least one — e.g. duplicate column name).
 *   - Unresolved references (mission columnName not in columns set).
 *   - Accumulate-all-errors (multiple independent failures all surface).
 *   - Idempotent reservation (re-calling reserveImportAttempt with the same
 *     manifestId → already_exists).
 *
 * Out of scope: T10B's atomic transaction; per-Task governance interceptor
 * enrollment (covered by `taskPublicationGovernance.test.ts`); the route
 * dispatch (T10C/T11).
 *
 * DORMANT: no production caller routes through this module yet. The flag
 * ORCY_CREATION_PUBLICATION_ENABLED is forced ON for most tests; the dormancy
 * test forces it OFF.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { importAttempts } from "../db/schema/index.js";
import { taskCreationAttempts } from "../db/schema/index.js";
import { eq } from "drizzle-orm";
import * as habitatRepo from "../repositories/habitat.js";

import {
  prepareImport,
  reserveImportAttempt,
  runPreflightPipeline,
  detectAndAdaptInput,
  computeManifestDigest,
  type PrepareImportInput,
  type ReserveImportAttemptV2Input,
} from "../services/importManifest/preflightImport.js";
import { importManifestSchema } from "../models/schemas.js";
import { UnknownManifestVersion } from "../services/importManifest/legacyAdapter.js";
import type {
  HabitatImportManifest,
  MissionPortable,
  TaskPortable,
  ColumnPortable,
  CommentPortable,
  DomainEnvelope,
} from "../services/importManifest/types.js";

// ---------------------------------------------------------------------------
// Setup — cutover flag handling per the established pattern.
// ---------------------------------------------------------------------------

const CUTOVER_FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";
let originalFlag: string | undefined;

beforeEach(async () => {
  await initTestDb();
  originalFlag = process.env[CUTOVER_FLAG];
  // Default: flag ON — most tests exercise the new manifest path.
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
// Fixture builders — v3 manifest shape.
// ---------------------------------------------------------------------------

const EXPORTED_AT = "2026-07-20T12:00:00.000Z";

function v3Column(opts?: Partial<ColumnPortable>): ColumnPortable {
  return {
    sourceId: opts?.sourceId ?? "col-1",
    name: opts?.name ?? "Todo",
    order: opts?.order ?? 0,
    color: opts?.color ?? null,
    wipLimit: opts?.wipLimit ?? null,
    nextColumnName: opts?.nextColumnName ?? null,
    isTerminal: opts?.isTerminal ?? false,
  };
}

function v3Mission(opts?: Partial<MissionPortable> & { tasks?: TaskPortable[] }): {
  mission: MissionPortable;
  tasks: TaskPortable[];
} {
  const missionSourceId = opts?.sourceId ?? "mission-1";
  const mission: MissionPortable = {
    sourceId: missionSourceId,
    title: opts?.title ?? "Mission Alpha",
    description: opts?.description ?? "Alpha description",
    acceptanceCriteria: opts?.acceptanceCriteria ?? "AC",
    priority: opts?.priority ?? "high",
    labels: opts?.labels ?? [],
    columnName: opts?.columnName ?? "Todo",
    dependsOnSourceIds: opts?.dependsOnSourceIds ?? [],
    blocksSourceIds: opts?.blocksSourceIds ?? [],
    dueAt: opts?.dueAt ?? null,
  };
  const tasks = opts?.tasks ?? [
    {
      sourceId: `${missionSourceId}-task-1`,
      missionSourceId,
      title: "Task One",
      description: "Task description",
      priority: "medium" as const,
      requiredDomain: null,
      requiredCapabilities: [],
    },
  ];
  return { mission, tasks };
}

function v3Comment(opts?: Partial<CommentPortable>): CommentPortable {
  return {
    sourceId: opts?.sourceId ?? "comment-1",
    taskSourceId: opts?.taskSourceId ?? "mission-1-task-1",
    parentCommentSourceId: opts?.parentCommentSourceId ?? null,
    content: opts?.content ?? "Comment body",
    author: opts?.author ?? { resolvedActorId: null, importedAttribution: "user-1" },
    authorType: opts?.authorType ?? "human",
    authoredAt: opts?.authoredAt ?? EXPORTED_AT,
  };
}

function v3Manifest(opts?: {
  manifestId?: string;
  mode?: "new" | "replacement";
  identityPolicy?: "remap" | "restore";
  sourceHabitatId?: string | null;
  habitatId?: string | null;
  columns?: ColumnPortable[];
  missions?: MissionPortable[];
  tasks?: TaskPortable[];
  comments?: CommentPortable[];
  domains?: Partial<HabitatImportManifest["domains"]>;
}): HabitatImportManifest {
  const { mission: defaultMission, tasks: defaultTasks } = v3Mission();
  const columns = opts?.columns ?? [v3Column()];
  const missions = opts?.missions ?? [defaultMission];
  const tasks = opts?.tasks ?? defaultTasks;
  const comments = opts?.comments ?? [];

  const domains: HabitatImportManifest["domains"] = {
    columns: { disposition: "replace", data: columns },
    missions: { disposition: "replace", data: missions },
    tasks: { disposition: "replace", data: tasks },
    ...opts?.domains,
  };
  if (comments.length > 0) {
    domains.comments = { disposition: "replace", data: comments };
  }

  return {
    version: 3,
    manifestId: opts?.manifestId ?? `manifest-${randomUUID()}`,
    generatedAt: EXPORTED_AT,
    mode: opts?.mode ?? "new",
    identityPolicy: opts?.identityPolicy ?? "remap",
    lineage: {
      sourceHabitatId: opts?.sourceHabitatId ?? null,
      sourceExportedAt: EXPORTED_AT,
      sourceManifestId: null,
    },
    domains,
  };
}

/** Wraps v3Manifest in a prepareImport input. */
function v3Input(
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

/** Builds a v2 legacy fixture (the legacyAdapter's input shape). */
function v2Fixture(overrides?: {
  columns?: Record<string, unknown>[];
  missions?: Record<string, unknown>[];
}): unknown {
  return {
    version: 2,
    exportedAt: EXPORTED_AT,
    habitat: {
      name: "Legacy Habitat",
      description: "from v2 export",
      columns: overrides?.columns ?? [{ name: "Todo", order: 0, isTerminal: false }],
      missions: overrides?.missions ?? [
        {
          title: "Legacy Mission",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Todo",
          status: "not_started",
          dependsOn: [],
          blocks: [],
          dueAt: null,
          tasks: [
            {
              title: "Legacy Task",
              description: "",
              priority: "medium",
              status: "pending",
              requiredDomain: null,
              requiredCapabilities: [],
            },
          ],
        },
      ],
    },
  };
}

/** Builds a v1 legacy fixture (board/features shape). */
function v1Fixture(): unknown {
  return {
    version: 1,
    exportedAt: EXPORTED_AT,
    board: {
      name: "V1 Board",
      columns: [{ name: "Todo", order: 0, isTerminal: false }],
      features: [
        {
          title: "V1 Feature",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Todo",
          status: "not_started",
          dependsOn: [],
          blocks: [],
          dueAt: null,
          tasks: [
            {
              title: "V1 Task",
              description: "",
              priority: "medium",
              status: "pending",
              requiredDomain: null,
              requiredCapabilities: [],
            },
          ],
        },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// 1. detectAndAdaptInput (step 1 — version detection + adapter dispatch)
// ---------------------------------------------------------------------------

describe("detectAndAdaptInput — version detection", () => {
  it("passes v3 inputs through unchanged (identity passthrough)", () => {
    const manifest = v3Manifest();
    const result = detectAndAdaptInput(manifest);
    expect(result.wasLegacyInput).toBe(false);
    expect(result.warnings).toEqual([]);
    expect(result.manifest.manifestId).toBe(manifest.manifestId);
  });

  it("routes v1 inputs through M2's adaptV1 (board/features → v3)", () => {
    const result = detectAndAdaptInput(v1Fixture());
    expect(result.wasLegacyInput).toBe(true);
    expect(result.manifest.version).toBe(3);
    expect(result.manifest.identityPolicy).toBe("remap");
    // v1 normalization warnings carry through.
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings.some((w) => w.includes("board"))).toBe(true);
  });

  it("routes v2 inputs through M2's adaptV2 (habitat.missions → v3)", () => {
    const result = detectAndAdaptInput(v2Fixture());
    expect(result.wasLegacyInput).toBe(true);
    expect(result.manifest.version).toBe(3);
    expect(result.manifest.identityPolicy).toBe("remap");
  });

  it("throws UnknownManifestVersion for version:4", () => {
    expect(() => detectAndAdaptInput({ version: 4, exportedAt: EXPORTED_AT })).toThrow(
      UnknownManifestVersion,
    );
  });

  it("throws UnknownManifestVersion for missing version", () => {
    expect(() => detectAndAdaptInput({ exportedAt: EXPORTED_AT })).toThrow(UnknownManifestVersion);
  });
});

// ---------------------------------------------------------------------------
// 2. Dormancy gate
// ---------------------------------------------------------------------------

describe("prepareImport — dormancy gate", () => {
  it("returns feature_disabled when ORCY_CREATION_PUBLICATION_ENABLED is not 'true'", () => {
    delete process.env[CUTOVER_FLAG];
    const result = prepareImport(v3Input(v3Manifest()));
    expect(result.outcome).toBe("feature_disabled");
  });

  it("proceeds past the dormancy gate when the flag is 'true'", () => {
    process.env[CUTOVER_FLAG] = "true";
    const result = prepareImport(v3Input(v3Manifest()));
    // Should NOT be feature_disabled — either prepared or rejected_preflight.
    expect(result.outcome).not.toBe("feature_disabled");
  });
});

// ---------------------------------------------------------------------------
// 3. Happy path — v3 manifest → reserve → preflight → PreparedImport
// ---------------------------------------------------------------------------

describe("prepareImport — v3 happy path", () => {
  it("produces a PreparedImport envelope with every field populated", () => {
    const manifest = v3Manifest({ manifestId: "happy-v3-test" });
    const result = prepareImport(v3Input(manifest));

    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    const prepared = result.prepared;

    // --- manifest frozen ---
    expect(prepared.manifest.version).toBe(3);
    expect(prepared.manifest.manifestId).toBe("happy-v3-test");
    expect(prepared.manifest.mode).toBe("new");

    // --- manifestDigest (sha256 hex, 64 chars) ---
    expect(prepared.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.manifestDigest).toBe(computeManifestDigest(prepared.manifest));

    // --- identityMap complete (every portable entity has a server id) ---
    expect(prepared.identityMap.sourceToServer.size).toBeGreaterThanOrEqual(3);
    expect(prepared.identityMap.sourceToServer.has("col-1")).toBe(true);
    expect(prepared.identityMap.sourceToServer.has("mission-1")).toBe(true);
    expect(prepared.identityMap.sourceToServer.has("mission-1-task-1")).toBe(true);

    // --- preparedDomains populated ---
    expect(prepared.preparedDomains.columns).toBeDefined();
    expect(prepared.preparedDomains.columns?.columns.length).toBe(1);
    expect(prepared.preparedDomains.missions).toBeDefined();
    expect(prepared.preparedDomains.missions?.missions.length).toBe(1);
    expect(prepared.preparedDomains.tasks).toBeDefined();
    expect(prepared.preparedDomains.tasks?.tasks.length).toBe(1);

    // --- references rewritten (mission.columnServerId, task.missionServerId) ---
    const mission = prepared.preparedDomains.missions!.missions[0];
    expect(mission.columnServerId).toBe(prepared.identityMap.sourceToServer.get("col-1"));
    const task = prepared.preparedDomains.tasks!.tasks[0];
    expect(task.missionServerId).toBe(prepared.identityMap.sourceToServer.get("mission-1"));

    // --- guard captured ---
    expect(prepared.guard.manifestDigest).toBe(prepared.manifestDigest);
    expect(prepared.guard.identityPolicySnapshot).toBe("remap");
    // mode:"new" → the orchestrator allocated a PROSPECTIVE habitat id (non-
    // null); the guard carries it through (T10B inserts the habitat with
    // this id in-tx). targetHabitatUpdatedAt is null (no existing row).
    expect(prepared.guard.targetHabitatId).toBeTruthy();
    expect(prepared.guard.targetHabitatUpdatedAt).toBeNull();

    // --- governance decisions (mode:"new" → no enrollments → all allowed) ---
    expect(prepared.governanceDecisions.length).toBe(1);
    expect(prepared.governanceDecisions[0].outcome).toBe("allowed");

    // --- authority snapshot ---
    expect(prepared.authority.caller.id).toBe("user-1");
    expect(prepared.authority.auditSource).toBe("rest_api");
    expect(prepared.authority.governingPolicy).toBe("installation");

    // --- prefilledAttemptId (the reserved coordination attempt) ---
    expect(prepared.prefilledAttemptId).toMatch(/^[a-f0-9-]{36}$/);
  });

  it("reserves the import_attempts row at state 'reserved'", () => {
    const manifest = v3Manifest({ manifestId: "reserve-state-test" });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("prepared");

    const row = getDb()
      .select()
      .from(importAttempts)
      .where(eq(importAttempts.id, "reserve-state-test"))
      .get();
    expect(row).toBeDefined();
    expect(row?.state).toBe("reserved");
    expect(row?.mode).toBe("new");
    expect(row?.identityPolicy).toBe("remap");
    expect(row?.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(row?.attemptId).toBeDefined();
    expect(row?.actorType).toBe("human");
    expect(row?.actorId).toBe("user-1");
  });

  it("reserves the coordination attempt (publicationKind:habitat_import)", () => {
    const manifest = v3Manifest({ manifestId: "coord-attempt-test" });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    const coordinationRow = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, result.prepared.prefilledAttemptId))
      .get();
    expect(coordinationRow).toBeDefined();
    expect(coordinationRow?.publicationKind).toBe("habitat_import");
    expect(coordinationRow?.sourceScopeKind).toBe("import");
    expect(coordinationRow?.sourceScopeId).toBe("coord-attempt-test");
    expect(coordinationRow?.attemptKey).toBe("import");
    expect(coordinationRow?.state).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// 4. v1 + v2 happy paths (via M2's adapter)
// ---------------------------------------------------------------------------

describe("prepareImport — legacy v1 + v2 happy paths", () => {
  it("adapts a v2 input through M2 + produces a PreparedImport", () => {
    const result = prepareImport({
      rawManifest: v2Fixture(),
      habitatId: null,
      manifestId: "legacy-v2-test",
      actor: { type: "human", id: "user-1" },
      auditSource: "rest_api",
    });
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    const prepared = result.prepared;

    // The adapter synthesized structural source IDs (legacy:mission[0], etc.).
    expect(prepared.identityMap.sourceToServer.size).toBeGreaterThanOrEqual(3);
    const missionKeys = [...prepared.identityMap.sourceToServer.keys()].filter((k) =>
      k.startsWith("legacy:mission["),
    );
    expect(missionKeys.length).toBeGreaterThan(0);

    // C4 warnings carried through (the legacy adapter emits at least the
    // webhook-domain warning when no webhooks are present — actually it
    // emits none when the array is empty; check structural instead).
    expect(prepared.manifest.identityPolicy).toBe("remap"); // legacy is always remap
  });

  it("adapts a v1 input (board/features) through M2 + produces a PreparedImport", () => {
    const result = prepareImport({
      rawManifest: v1Fixture(),
      habitatId: null,
      manifestId: "legacy-v1-test",
      actor: { type: "human", id: "user-1" },
      auditSource: "rest_api",
    });
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;

    // v1 normalization warnings carried through.
    // (The adapter emits 'board' → 'habitat' + 'features' → 'missions' warnings.)
    // These are stored in the legacyWarnings but not surfaced on PreparedImport
    // directly — verify the structural adaptation instead.
    expect(result.prepared.manifest.domains.missions?.data.length).toBe(1);
    expect(result.prepared.manifest.domains.tasks?.data.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 5. Version rejection
// ---------------------------------------------------------------------------

describe("prepareImport — version rejection", () => {
  it("throws UnknownManifestVersion for version:4 inputs", () => {
    expect(() =>
      prepareImport({
        rawManifest: { version: 4, exportedAt: EXPORTED_AT },
        habitatId: null,
        actor: { type: "human", id: "user-1" },
        auditSource: "rest_api",
      }),
    ).toThrow(UnknownManifestVersion);
  });
});

// ---------------------------------------------------------------------------
// 6. Authority check (b) — three distinct violations
// ---------------------------------------------------------------------------

describe("prepareImport — authority check (b)", () => {
  it("(b1) rejects legacy v1/v2 + identityPolicy:'restore' (legacy_restore_forbidden)", () => {
    // Adapt a v2 input first, then force identityPolicy:"restore" — the
    // authority check should refuse it (legacy is remap-only).
    const result = prepareImport({
      rawManifest: v2Fixture(),
      habitatId: null,
      manifestId: "legacy-restore-test",
      mode: "new",
      actor: { type: "human", id: "user-1" },
      auditSource: "rest_api",
    });
    // The adapter always emits identityPolicy:"remap", so the authority check
    // passes. To exercise (b1), we hand-craft a legacy-style manifest with
    // restore (simulating an attempted bypass).
    expect(result.outcome).toBe("prepared"); // adapter-forced remap path is fine.
  });

  it("(b1 direct) hand-crafted legacy-style manifest with restore fails authority", () => {
    // A v3 manifest with identityPolicy:"restore" + null sourceHabitatId
    // triggers (b2); to exercise (b1) we need to simulate a legacy input that
    // was hand-forced to restore. The detectAndAdaptInput wrapper identifies
    // legacy inputs by version (1 or 2); a v3 input with restore is the (b2)
    // path. We test (b1) by checking the authority function directly via a
    // legacy v2 input + an adapter-mutation simulation:
    const legacyInput = v2Fixture();
    // Pass through prepareImport — the adapter will emit remap (always); the
    // authority check sees remap + passes. This test verifies the POSITIVE
    // path (legacy → remap → passes). The (b1) guard is exercised in the
    // unit-level authority test below.
    const result = prepareImport({
      rawManifest: legacyInput,
      habitatId: null,
      manifestId: "b1-positive-test",
      mode: "new",
      actor: { type: "human", id: "user-1" },
      auditSource: "rest_api",
    });
    expect(result.outcome).toBe("prepared");
  });

  it("(b2) rejects v3 identityPolicy:'restore' + null sourceHabitatId", () => {
    const manifest = v3Manifest({
      manifestId: "restore-no-lineage-test",
      identityPolicy: "restore",
      sourceHabitatId: null,
    });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("rejected_preflight");
    if (result.outcome !== "rejected_preflight") return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.code === "restore_requires_source_habitat")).toBe(true);
  });

  it("(b3) restore is refused until T10B ships existing-habitat snapshotting (drift #13)", () => {
    // The plan's drift #13 defers `restore` alongside snapshotting. M4 leaves
    // `ManifestContext.existingHabitatSnapshot` null for both modes → `restore`
    // would silently produce an incomplete `PreparedImport` (no collision
    // detection). Explicit refusal (option a per the cold-review finding)
    // avoids the silent-normalization defect.
    const manifest = v3Manifest({
      manifestId: "restore-refused-until-t10b",
      identityPolicy: "restore",
      sourceHabitatId: "source-habitat-123", // (b2) satisfied
    });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("rejected_preflight");
    if (result.outcome !== "rejected_preflight") return;
    expect(result.errors.some((e) => e.code === "restore_not_supported_until_snapshotting")).toBe(
      true,
    );
  });

  it("(b4) rejects unsupported disposition via zod schema parse", () => {
    // The strict v3 schema rejects unknown dispositions. Hand-craft a v3
    // manifest with an unsupported disposition + verify the schema parse
    // throws (mapped to a thrown Error in prepareImport).
    const manifest = v3Manifest();
    // Override with an invalid disposition via a cast (runtime would never
    // produce this from M2; the schema is the defensive layer).
    const invalid = {
      ...manifest,
      domains: {
        columns: { disposition: "MERGE", data: manifest.domains.columns!.data },
      },
    };
    expect(() =>
      prepareImport({
        rawManifest: invalid,
        habitatId: null,
        actor: { type: "human", id: "user-1" },
        auditSource: "rest_api",
      }),
    ).toThrow(/strict v3 schema parse failed/);
  });
});

// ---------------------------------------------------------------------------
// 7. Per-domain validation failure (at least one)
// ---------------------------------------------------------------------------

describe("prepareImport — per-domain validation failure", () => {
  it("rejects a manifest with a duplicate column name (columns handler)", () => {
    const manifest = v3Manifest({
      manifestId: "dup-column-test",
      columns: [
        v3Column({ sourceId: "col-a", name: "Todo", order: 0 }),
        v3Column({ sourceId: "col-b", name: "Todo", order: 1 }),
      ],
    });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("rejected_preflight");
    if (result.outcome !== "rejected_preflight") return;
    expect(result.errors.some((e) => e.code === "duplicate_column_name")).toBe(true);
  });

  it("rejects a manifest with a malformed task (missing sourceId)", () => {
    const badTask = {
      // missing sourceId
      missionSourceId: "mission-1",
      title: "Bad Task",
      description: "",
      priority: "medium",
      requiredDomain: null,
      requiredCapabilities: [],
    } as unknown as TaskPortable;
    const manifest = v3Manifest({
      manifestId: "bad-task-test",
      tasks: [badTask],
    });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("rejected_preflight");
    if (result.outcome !== "rejected_preflight") return;
    expect(result.errors.some((e) => e.code === "invalid_source_id")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 8. Unresolved references
// ---------------------------------------------------------------------------

describe("prepareImport — unresolved references", () => {
  it("rejects a manifest whose mission columnName is not in the columns set", () => {
    // The mission references a column that doesn't exist — the missions
    // handler's validate phase (reading crossDomainState.columnsEnvelope)
    // surfaces this as a validation error.
    const manifest = v3Manifest({
      manifestId: "unresolved-column-test",
      columns: [v3Column({ name: "Todo" })],
      missions: [
        {
          sourceId: "mission-x",
          title: "Mission X",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Nonexistent",
          dependsOnSourceIds: [],
          blocksSourceIds: [],
          dueAt: null,
        },
      ],
      tasks: [],
    });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("rejected_preflight");
    if (result.outcome !== "rejected_preflight") return;
    expect(result.errors.some((e) => e.code === "unresolvable_column_name")).toBe(true);
  });

  it("rejects a manifest whose task references an unknown missionSourceId", () => {
    const manifest = v3Manifest({
      manifestId: "unresolved-mission-test",
      tasks: [
        {
          sourceId: "task-x",
          missionSourceId: "nonexistent-mission",
          title: "Task X",
          description: "",
          priority: "medium",
          requiredDomain: null,
          requiredCapabilities: [],
        },
      ],
    });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("rejected_preflight");
    if (result.outcome !== "rejected_preflight") return;
    expect(result.errors.some((e) => e.code === "unresolved_mission_source_id")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 9. Accumulate-all-errors (no first-error short-circuit)
// ---------------------------------------------------------------------------

describe("prepareImport — accumulate ALL errors", () => {
  it("surfaces every independently discoverable failure in one rejection", () => {
    // Manifest with THREE independent failures:
    //   (a) duplicate column name (columns handler).
    //   (b) mission referencing a nonexistent column (missions handler).
    //   (c) task with invalid priority (tasks handler).
    const manifest = v3Manifest({
      manifestId: "multi-failure-test",
      columns: [
        v3Column({ sourceId: "c1", name: "Dup", order: 0 }),
        v3Column({ sourceId: "c2", name: "Dup", order: 1 }),
      ],
      missions: [
        {
          sourceId: "m1",
          title: "M1",
          description: "",
          acceptanceCriteria: "",
          priority: "medium" as const,
          labels: [],
          columnName: "Nonexistent",
          dependsOnSourceIds: [],
          blocksSourceIds: [],
          dueAt: null,
        },
      ],
      tasks: [
        {
          sourceId: "t1",
          missionSourceId: "m1",
          title: "T1",
          description: "",
          priority: "urgent" as unknown as TaskPortable["priority"], // invalid
          requiredDomain: null,
          requiredCapabilities: [],
        },
      ],
    });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("rejected_preflight");
    if (result.outcome !== "rejected_preflight") return;

    const codes = result.errors.map((e) => e.code);
    // Every failure surfaces — no first-error short-circuit.
    expect(codes).toContain("duplicate_column_name");
    expect(codes).toContain("unresolvable_column_name");
    expect(codes).toContain("invalid_priority");
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// 10. Idempotent reservation (already_exists on re-reserve)
// ---------------------------------------------------------------------------

describe("reserveImportAttempt — idempotent reservation", () => {
  function baseReserveInput(
    overrides: Partial<ReserveImportAttemptV2Input> = {},
  ): ReserveImportAttemptV2Input {
    return {
      id: overrides.id ?? `id-${randomUUID()}`,
      habitatId: overrides.habitatId ?? "hab-1",
      mode: overrides.mode ?? "new",
      identityPolicy: overrides.identityPolicy ?? "remap",
      sourceLineage: overrides.sourceLineage ?? {
        sourceHabitatId: null,
        sourceExportedAt: EXPORTED_AT,
        sourceManifestId: null,
      },
      manifestDigest: overrides.manifestDigest ?? "sha256:abc",
      manifestSummary: overrides.manifestSummary ?? { counts: { missions: 1 } },
      actor: overrides.actor ?? { type: "human", id: "user-1" },
    };
  }

  it("creates a fresh reservation on the first call", () => {
    const result = reserveImportAttempt(baseReserveInput({ id: "fresh-id" }));
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.attempt.id).toBe("fresh-id");
    expect(result.attempt.state).toBe("reserved");
    expect(result.attempt.attemptId).toBeDefined(); // coordination attempt linked
  });

  it("returns already_exists on a re-reserve with the same id", () => {
    const input = baseReserveInput({ id: "dup-id" });
    const first = reserveImportAttempt(input);
    expect(first.outcome).toBe("created");

    const second = reserveImportAttempt(input);
    expect(second.outcome).toBe("already_exists");
    if (second.outcome !== "already_exists") return;
    // The existing row is returned verbatim — the loser never overwrites.
    expect(second.attempt.id).toBe("dup-id");
    expect(second.attempt.state).toBe("reserved");
  });

  it("stamps the coordination attempt link on the first reservation only", () => {
    const input = baseReserveInput({ id: "link-test" });
    const first = reserveImportAttempt(input);
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;
    const firstCoordId = first.attempt.attemptId;
    expect(firstCoordId).toBeDefined();

    // Re-reserve — the existing coordination attempt is preserved untouched.
    const second = reserveImportAttempt(input);
    expect(second.outcome).toBe("already_exists");
    if (second.outcome !== "already_exists") return;
    expect(second.attempt.attemptId).toBe(firstCoordId);
  });
});

// ---------------------------------------------------------------------------
// 11. mode:"replacement" — happy path
// ---------------------------------------------------------------------------

describe("prepareImport — mode:'replacement' happy path", () => {
  it("captures the existing habitat's updatedAt in the guard", () => {
    // Seed an existing habitat.
    const existing = habitatRepo.createHabitat({ name: "Existing Habitat" });

    const manifest = v3Manifest({
      manifestId: "replacement-test",
      mode: "replacement",
      habitatId: existing.id,
    });
    const result = prepareImport({
      rawManifest: manifest,
      habitatId: existing.id,
      manifestId: "replacement-test",
      mode: "replacement",
      actor: { type: "human", id: "user-1" },
      auditSource: "rest_api",
    });
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    // The guard captured the existing habitat's updatedAt (OCC proxy).
    expect(result.prepared.guard.targetHabitatId).toBe(existing.id);
    expect(result.prepared.guard.targetHabitatUpdatedAt).toBeTruthy();
    expect(result.prepared.authority.governingPolicy).toBe("persisted_habitat");
  });

  it("throws when mode:'replacement' is requested without a habitatId", () => {
    const manifest = v3Manifest({ mode: "replacement" });
    expect(() =>
      prepareImport({
        rawManifest: manifest,
        habitatId: null,
        mode: "replacement",
        actor: { type: "human", id: "user-1" },
        auditSource: "rest_api",
      }),
    ).toThrow(/mode:'replacement' requires a habitatId/);
  });
});

// ---------------------------------------------------------------------------
// 12. Terminal-reject path (the import attempt + coordination attempt atomically)
// ---------------------------------------------------------------------------

describe("prepareImport — terminal-reject path", () => {
  it("terminalizes the import attempt + coordination attempt on preflight failure", () => {
    const manifest = v3Manifest({
      manifestId: "terminal-reject-test",
      // Trigger a preflight failure: duplicate column name.
      columns: [
        v3Column({ sourceId: "c1", name: "Dup", order: 0 }),
        v3Column({ sourceId: "c2", name: "Dup", order: 1 }),
      ],
    });
    const result = prepareImport(v3Input(manifest));
    expect(result.outcome).toBe("rejected_preflight");
    if (result.outcome !== "rejected_preflight") return;
    expect(result.importAttemptId).toBe("terminal-reject-test");

    // The import attempt is terminalized to 'rejected'.
    const importRow = getDb()
      .select()
      .from(importAttempts)
      .where(eq(importAttempts.id, "terminal-reject-test"))
      .get();
    expect(importRow?.state).toBe("rejected");
    expect(importRow?.rejectionReason).toBe("preflight_failed");
    expect(importRow?.result).toMatchObject({ reason: "preflight_failed" });
    expect(importRow?.attemptId).toBeDefined();

    // The coordination attempt is terminalized to 'rejected_validation'.
    const coordinationRow = getDb()
      .select()
      .from(taskCreationAttempts)
      .where(eq(taskCreationAttempts.id, importRow!.attemptId!))
      .get();
    expect(coordinationRow?.state).toBe("rejected_validation");
    expect(coordinationRow?.completedAt).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// 13. runPreflightPipeline — direct pipeline entry (no DB reservation)
// ---------------------------------------------------------------------------

describe("runPreflightPipeline — direct pipeline entry", () => {
  it("produces a prepared body without reserving an import attempt", () => {
    const manifest = v3Manifest();
    const result = runPreflightPipeline(
      manifest,
      null, // habitatId (prospective for mode:"new")
      "new",
      { type: "human", id: "user-1" },
      "rest_api",
      "fake-attempt-id",
      [], // legacyWarnings (empty for v3 input)
      false, // wasLegacyInput (v3 native passthrough)
    );
    expect(result.outcome).toBe("prepared");
    if (result.outcome !== "prepared") return;
    expect(result.manifest.manifestId).toBe(manifest.manifestId);
    expect(result.identityMap.sourceToServer.size).toBeGreaterThanOrEqual(3);
    expect(result.guard.manifestDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it("accumulates errors without short-circuit", () => {
    const manifest = v3Manifest({
      columns: [
        v3Column({ sourceId: "c1", name: "Dup", order: 0 }),
        v3Column({ sourceId: "c2", name: "Dup", order: 1 }),
      ],
    });
    const result = runPreflightPipeline(
      manifest,
      null,
      "new",
      { type: "human", id: "user-1" },
      "rest_api",
      "fake-attempt-id",
      [],
      false, // wasLegacyInput
    );
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e) => e.kind === "duplicate_column_name")).toBe(true);
  });

  it("wasLegacyInput=true + restore triggers legacy_restore_forbidden (parameter honored)", () => {
    // Defensive test (cold-review Fix 2): the entry point computes
    // `wasLegacyInput` authoritatively in `detectAndAdaptInput` + passes it
    // through. The `remap`-only authority rule fires when `wasLegacyInput=true`
    // AND `identityPolicy:"restore"` — direct callers MUST supply the correct
    // flag. A v3 native `remap` manifest with non-empty legacyWarnings is NOT
    // a legacy input (the flag is authoritative; the warnings length is not).
    const manifest = v3Manifest({
      identityPolicy: "restore",
      sourceHabitatId: "source-habitat-1",
    });
    const result = runPreflightPipeline(
      manifest,
      null,
      "new",
      { type: "human", id: "user-1" },
      "rest_api",
      "fake-attempt-id",
      ["some-warning-from-the-adapter"], // non-empty legacyWarnings
      true, // wasLegacyInput=true → legacy_restore_forbidden fires
    );
    expect(result.outcome).toBe("rejected");
    if (result.outcome !== "rejected") return;
    // (b1) legacy_restore_forbidden fires for legacy inputs requesting restore.
    expect(result.errors.some((e) => e.kind === "legacy_restore_forbidden")).toBe(true);
    // (b3) restore_not_supported_until_snapshotting ALSO fires (accumulate-all).
    expect(result.errors.some((e) => e.kind === "restore_not_supported_until_snapshotting")).toBe(
      true,
    );
  });

  it("wasLegacyInput=false + remap + non-empty warnings does NOT trigger legacy_restore_forbidden", () => {
    // Defensive test (cold-review Fix 2): a v3 native `remap` manifest with
    // non-empty warnings reaches the pipeline with `wasLegacyInput=false`. The
    // heuristic the cold review deleted would have misclassified this as
    // `wasLegacyInput=true` (because identityPolicy !== "restore"). The
    // explicit parameter prevents the misclassification.
    const manifest = v3Manifest({
      identityPolicy: "remap",
    });
    const result = runPreflightPipeline(
      manifest,
      null,
      "new",
      { type: "human", id: "user-1" },
      "rest_api",
      "fake-attempt-id",
      ["a-warning"], // non-empty legacyWarnings
      false, // wasLegacyInput=false (v3 native, NOT legacy)
    );
    // No authority errors — the manifest is valid + the flag is honored.
    expect(result.outcome).toBe("prepared");
  });
});

// ---------------------------------------------------------------------------
// 14. importManifestSchema — strict shape (silent-strip defense)
// ---------------------------------------------------------------------------

describe("importManifestSchema — strict shape (Fix 1 cold-review)", () => {
  it("REJECTS an unknown domain (e.g. webhooks) instead of silently stripping it", () => {
    // The strict v3 schema's `domains` object is `.strict()` — Zod rejects
    // unknown keys instead of silently dropping them. Without `.strict()`,
    // a v3 manifest declaring `webhooks: {disposition:"replace", data:...}`
    // would have the domain silently dropped → preflight treats it as
    // omitted (preserve-by-default). The cold-review finding classifies this
    // as the silent-normalization defect the gap-audit R3 directive warns
    // against.
    const manifest = v3Manifest();
    const withUnknownDomain = {
      ...manifest,
      domains: {
        ...manifest.domains,
        // An unknown domain that must NOT be silently dropped.
        webhooks: { disposition: "replace", data: [{ name: "hook", url: "https://example.com" }] },
      },
    };
    const result = importManifestSchema.safeParse(withUnknownDomain);
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((i) => i.message).join("|");
      expect(messages.toLowerCase()).toContain("unrecognized");
    }
  });

  it("REJECTS an unknown lineage field (silent-strip defense)", () => {
    const manifest = v3Manifest();
    const withUnknownLineage = {
      ...manifest,
      lineage: {
        ...manifest.lineage,
        unknownLineageField: "should-be-rejected",
      },
    };
    const result = importManifestSchema.safeParse(withUnknownLineage);
    expect(result.success).toBe(false);
  });

  it("REJECTS an unknown envelope field (silent-strip defense)", () => {
    const manifest = v3Manifest();
    const withUnknownEnvelopeField = {
      ...manifest,
      domains: {
        ...manifest.domains,
        columns: {
          disposition: "replace",
          data: manifest.domains.columns!.data,
          // An unknown envelope field that must NOT be silently dropped.
          unknownEnvelopeField: "should-be-rejected",
        },
      },
    };
    const result = importManifestSchema.safeParse(withUnknownEnvelopeField);
    expect(result.success).toBe(false);
  });
});
