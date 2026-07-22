/**
 * T10C M3 — v3 Habitat-Import REST routes (flag-gated version dispatch).
 *
 * Exercises the load-bearing HTTP contract of the two import routes
 * (`POST /habitats/import` + `POST /habitats/:habitatId/import`) under the
 * T10C M3 flag-gated version-dispatch wrapper. Coverage matrix maps 1:1 to
 * the M3 HTTP outcome table — every cell has at least one test:
 *
 *   HTTP-level (real Fastify injection — the load-bearing path):
 *     - PRESERVE: flag OFF → v1/v2 inputs route to legacy `importHabitat`
 *       byte-identically (the existing 4-endpoint inventory unchanged).
 *     - flag ON + v3 input + mode:"new" → 201 `published`.
 *     - flag ON + v3 input + mode:"replacement" → 201 `published` (existing
 *       habitat preserved where declared).
 *     - flag ON + v1/v2 input → adapter → 201 `published` (round-trip with
 *       M2 exporter output is the load-bearing end-to-end test).
 *     - `rejected_preflight` → 422 with ALL accumulated errors.
 *     - `replayed` → 200 (same manifestId re-submitted).
 *     - `already_exists` → 200 (same manifestId, fresh request).
 *     - Unknown version (4) → 400.
 *     - v3 mode mismatch (replacement manifest to /habitats/import) → 400.
 *
 *   Unit-level (direct mapper exercise for branches that are
 *   impractical to trigger deterministically via HTTP — the route forwards
 *   the kernel outcome verbatim via this mapper, so mapper-level coverage
 *   IS route-level coverage for these branches):
 *     - `published` → 201 (mirrors the HTTP-level assertion).
 *     - `already_publishing` → 202 + `status:"publishing"`.
 *     - `guard_mismatch` → 409 + `fields`.
 *     - `vetoed` → 422 + ALL decisive vetoes.
 *     - `illegal_source_state` → 409 + `fromState`.
 *     - `not_found` → 404.
 *     - `replayed` → 200 + `terminal`.
 *     - `rejected_preflight` → 422 + ALL errors.
 *     - `already_exists` → 200 + `attempt`.
 *     - `feature_disabled` → 501.
 *
 *   The hard-to-trigger-via-HTTP branches (`guard_mismatch`, `vetoed`,
 *   `already_publishing`, `illegal_source_state`, `not_found`) require
 *   mid-flight row manipulation or unreliable races. They ARE covered at
 *   the kernel level in `importPublication.test.ts:545+` (guard_mismatch),
 *   `:660+` (already_publishing, illegal_source_state, not_found), +
 *   `templateAggregatePublication.test.ts` (vetoed atomicity). The route
 *   forwards those exact outcomes through the unit-tested mapper here.
 *
 *   Round-trip (M2 → M3 — the load-bearing end-to-end):
 *     - Seed a full habitat → `exportHabitatManifest` → POST manifest to
 *       `/api/habitats/import` → 201 `published` → verify the new habitat
 *       matches the source's portable domains.
 *
 * Out of scope: the kernel surfaces themselves (covered by
 * `importPublication.test.ts` + `preflightImport.test.ts`); the UI (M4);
 * the flag flip (T11).
 *
 * DORMANT: the v3 dispatch is exercised only when
 * `ORCY_CREATION_PUBLICATION_ENABLED=true`. Tests force the flag ON/OFF
 * per-scenario via `beforeEach` env-var manipulation.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";

import { closeDb, getDb, initTestDb } from "../db/index.js";
import {
  columns as columnsTable,
  habitats,
  importAttempts,
  missionComments,
  missions as missionsTable,
  missionTemplates,
  taskCreationAttempts,
  taskCreationEnvelopes,
  taskDependencies,
  taskEvents,
  tasks as tasksTable,
  taskSubtasks,
} from "../db/schema/index.js";

import { perAgentRateLimit } from "../middleware/rateLimit.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as subtaskRepo from "../repositories/subtask.js";
import * as commentRepo from "../repositories/comment.js";
import * as templateRepo from "../repositories/template.js";
import * as dependencyRepo from "../repositories/dependency.js";

import { createHabitat } from "../services/habitatService.js";
import { exportHabitatManifest } from "../services/habitatManifestExporter.js";
import type { HabitatImportManifest } from "../services/importManifest/types.js";
import {
  prepareImport,
  type PrepareImportOutcome,
} from "../services/importManifest/preflightImport.js";
import {
  publishImportAggregateWithClient,
  type PublishImportOutcome,
} from "../services/importManifest/importPublication.js";
import {
  prepareImportOutcomeToHttpResponse,
  publishImportOutcomeToHttpResponse,
} from "../routes/helpers/importPublicationHttp.js";
import { habitatExportRoutes } from "../routes/board-export.js";
import { registerErrorHandler } from "../errors/plugin.js";

// ---------------------------------------------------------------------------
// Setup — JWT helpers, env-flag handling, app builder.
// ---------------------------------------------------------------------------

const JWT_SECRET = "dev-secret-change-in-production";
const CUTOVER_FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";
let originalFlag: string | undefined;

function makeToken(payload: { sub: string; username: string; role: string }): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

function adminToken(): string {
  // `humanAuth` verifies the JWT signature + sets `request.user` from the
  // payload — it does NOT look up the DB. The import flow's `createdBy` is
  // a plain string (no FK). So the JWT's `sub` need not match a users row.
  return makeToken({ sub: "admin-1", username: "route-test-admin", role: "admin" });
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
    },
    { prefix: "/api" },
  );
  await app.ready();
  return app;
}

/** Wipes publication-related tables between tests (mirrors
 *  `importPublication.test.ts`'s wipeTables). */
function wipeTables(): void {
  const db = getDb();
  db.delete(taskSubtasks).run();
  db.delete(taskDependencies).run();
  db.delete(missionComments).run();
  db.delete(taskEvents).run();
  db.delete(tasksTable).run();
  db.delete(missionsTable).run();
  db.delete(columnsTable).run();
  db.delete(missionTemplates).run();
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(importAttempts).run();
  db.delete(habitats).run();
}

// ---------------------------------------------------------------------------
// Fixture builders — minimal v3 manifest + v2 export shape.
// ---------------------------------------------------------------------------

const EXPORTED_AT = "2026-07-21T12:00:00.000Z";

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
        ],
      },
    },
  };
}

/** Returns a minimal v2-shape export (matches `HabitatExportData`).
 *  Used to exercise the legacy adapter path (v2 → adaptUnknown → v3 pipeline)
 *  AND the PRESERVE flag-off legacy `importHabitat` path. */
function v2Export(opts?: { habitatName?: string }): Record<string, unknown> {
  return {
    version: 2,
    exportedAt: EXPORTED_AT,
    habitat: {
      name: opts?.habitatName ?? "Legacy Imported Habitat",
      description: "v2 source",
      columns: [
        { name: "Todo", order: 0, wipLimit: null, nextColumnName: null, isTerminal: false },
        { name: "Done", order: 1, wipLimit: null, nextColumnName: null, isTerminal: true },
      ],
      missions: [
        {
          title: "Legacy Mission",
          description: "from v2",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Todo",
          dependsOn: [],
          blocks: [],
          dueAt: null,
          tasks: [
            {
              title: "Legacy Task",
              description: "from v2",
              priority: "medium",
              requiredDomain: null,
              requiredCapabilities: [],
            },
          ],
        },
      ],
      comments: [],
      templates: [],
      webhooks: [],
    },
  };
}

/** Returns a minimal v1-shape export (top-level `board` + habitat `features`). */
function v1Export(opts?: { habitatName?: string }): Record<string, unknown> {
  return {
    version: 1,
    exportedAt: EXPORTED_AT,
    board: {
      name: opts?.habitatName ?? "V1 Board",
      description: "",
      features: [
        {
          title: "V1 Mission",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Todo",
          dependsOn: [],
          blocks: [],
          dueAt: null,
          tasks: [],
        },
      ],
      columns: [
        { name: "Todo", order: 0, wipLimit: null, isTerminal: false },
        { name: "Done", order: 1, wipLimit: null, isTerminal: true },
      ],
      comments: [],
      templates: [],
      webhooks: [],
    },
  };
}

/** Seeds a full habitat with ALL 8 portable domains populated (columns,
 *  missions, tasks, subtasks, dependencies, comments, templates) — including
 *  a reverse-dependency mission pair (high-priority alpha depends on medium-
 *  priority beta, so alpha sorts FIRST in export but its edge points to beta
 *  which sorts LATER) + a parent-child comment pair. This is the load-bearing
 *  fixture for the full-shape HTTP round-trip (cold-review Finding 3) and
 *  exercises every forward-FK chain the cold review identified. */
function seedFullHabitat(name = "Source Habitat"): string {
  const { habitat } = createHabitat({ name, defaultColumns: true });
  const habitatId = habitat.id;
  const byName = new Map(
    habitatRepo.getHabitatWithColumnsAndTasks(habitatId)!.columns.map((c) => [c.name, c]),
  );
  const todo = byName.get("Todo") ?? byName.values().next().value!;
  const inProgress = byName.get("In Progress") ?? todo;

  // Beta first (medium priority — priorityOrder 2). This is the dependency
  // TARGET for the reverse-dependency pair.
  const beta = missionRepo.createMission({
    habitatId,
    columnId: inProgress.id,
    title: "Mission Beta",
    description: "Beta description",
    acceptanceCriteria: "Beta AC",
    priority: "medium",
    labels: ["beta"],
    createdBy: "tester",
  });

  // Alpha (high priority — priorityOrder 1) depends on beta. Alpha sorts
  // BEFORE beta in `getMissionsByHabitatId` (high < medium), so in the
  // exported manifest alpha's `dependsOn` edge points to beta which appears
  // LATER. This is the reverse-dependency case (cold-review Finding 1).
  const alpha = missionRepo.createMission({
    habitatId,
    columnId: todo.id,
    title: "Mission Alpha",
    description: "Alpha description",
    acceptanceCriteria: "Alpha AC",
    priority: "high",
    labels: ["alpha"],
    dependsOn: [beta.id],
    createdBy: "tester",
  });

  // Two tasks on alpha (alphaTask1 + alphaTask2) for a task-dependency edge.
  const alphaTask1 = taskRepo.createTask({
    missionId: alpha.id,
    title: "Alpha Task 1",
    description: "First alpha task",
    priority: "high",
    requiredDomain: "code_review",
    requiredCapabilities: ["review"],
    createdBy: "tester",
  });
  const alphaTask2 = taskRepo.createTask({
    missionId: alpha.id,
    title: "Alpha Task 2",
    description: "Second alpha task",
    priority: "low",
    requiredDomain: null,
    requiredCapabilities: [],
    createdBy: "tester",
  });

  // Subtask on alphaTask1.
  subtaskRepo.createSubtask({
    taskId: alphaTask1.id,
    title: "Subtask A",
    order: 0,
  });

  // Task dependency: alphaTask2 depends on alphaTask1.
  dependencyRepo.addTaskDependency(alphaTask2.id, alphaTask1.id);

  // Parent comment + child comment on alphaTask1 (exercises the self-
  // referential parentId FK — cold-review Finding 2).
  const parentComment = commentRepo.createComment({
    taskId: alphaTask1.id,
    authorType: "human",
    authorId: "user-1",
    content: "Parent comment",
  });
  commentRepo.createComment({
    taskId: alphaTask1.id,
    authorType: "human",
    authorId: "user-2",
    content: "Child reply",
    parentId: parentComment.id,
  });

  // Default template.
  templateRepo.createTemplate({
    habitatId,
    name: "Default Template",
    titlePattern: "Templated Mission",
    descriptionPattern: "Template description",
    priority: "medium",
    labels: ["template"],
    requiredDomain: null,
    requiredCapabilities: [],
    isDefault: true,
    createdBy: "tester",
  });

  return habitatId;
}

// ---------------------------------------------------------------------------
// Shared lifecycle — flag + DB per-test.
// ---------------------------------------------------------------------------

let app: FastifyInstance | null = null;

beforeEach(async () => {
  await initTestDb();
  wipeTables();
  originalFlag = process.env[CUTOVER_FLAG];
});

afterEach(async () => {
  if (app) {
    await app.close();
    app = null;
  }
  if (originalFlag !== undefined) {
    process.env[CUTOVER_FLAG] = originalFlag;
  } else {
    delete process.env[CUTOVER_FLAG];
  }
  closeDb();
});

// ===========================================================================
// 1. PRESERVE — flag OFF: legacy `importHabitat` byte-identical behavior.
//    v1/v2 inputs route to `habitatService.importHabitat` exactly as today.
// ===========================================================================

describe("T10C M3 — flag OFF (PRESERVE): legacy importHabitat byte-identical", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "";
  });

  it("POST /habitats/import with a v2 input → 201 legacy response shape {habitat, columns, imported, warnings}", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: v2Export({ habitatName: "Legacy Flag-Off Habitat" }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.habitat).toBeDefined();
    expect(body.habitat.name).toBe("Legacy Flag-Off Habitat");
    expect(Array.isArray(body.columns)).toBe(true);
    expect(body.imported).toBeDefined();
    expect(Array.isArray(body.warnings)).toBe(true);

    // **Failure mode**: if the flag-off path regressed, the body shape would
    // become the v3 `{outcome, importAttempt, habitatId, importedCounts}`,
    // breaking every existing UI / API caller.
  });

  it("POST /habitats/import with a v1 input (board/features) → 201 legacy response", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: v1Export({ habitatName: "V1 Flag-Off Board" }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.habitat.name).toBe("V1 Flag-Off Board");
  });
});

// ===========================================================================
// 2. Flag ON — v3 input, mode:"new" happy path → 201 published.
// ===========================================================================

describe("T10C M3 — flag ON + v3 input + mode:'new' → 201 published", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "true";
  });

  it("POST /habitats/import with a valid v3 manifest → 201 published + body shape", async () => {
    app = await buildApp();
    const manifest = v3Manifest({ habitatName: "V3 New Habitat" });

    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("published");
    expect(body.importAttempt).toBeDefined();
    expect(body.habitatId).toBeDefined();
    expect(body.importedCounts).toBeDefined();
    const newHabitat = habitatRepo.getHabitatById(body.habitatId);
    expect(newHabitat).not.toBeNull();
    expect(newHabitat!.name).toBe("V3 New Habitat");
  });
});

// ===========================================================================
// 3. Flag ON — v3 input, mode:"replacement" → 201 published (preserve).
// ===========================================================================

describe("T10C M3 — flag ON + v3 input + mode:'replacement' → 201 published (preserve)", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "true";
  });

  it("POST /habitats/:habitatId/import with a preserve-declared v3 manifest → 201 + existing missions preserved", async () => {
    const existingHabitatId = seedFullHabitat("Replace Target");
    const existingMissionsBefore = missionRepo.getMissionsByHabitatId(existingHabitatId).missions;
    expect(existingMissionsBefore.length).toBeGreaterThanOrEqual(2);

    // v3 manifest with missions + tasks + columns omitted (preserve). Only
    // habitatSettings:replace updates the name.
    const manifest = v3Manifest({
      manifestId: `replace-${randomUUID()}`,
      mode: "replacement",
      habitatName: "Replace Target (Updated)",
    });
    delete manifest.domains.missions;
    delete manifest.domains.tasks;
    delete manifest.domains.columns;

    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${existingHabitatId}/import`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("published");
    expect(body.habitatId).toBe(existingHabitatId);

    // Preserve semantics: existing missions survive; habitat name updated.
    const existingMissionsAfter = missionRepo.getMissionsByHabitatId(existingHabitatId).missions;
    expect(existingMissionsAfter.length).toBe(existingMissionsBefore.length);
    const updatedHabitat = habitatRepo.getHabitatById(existingHabitatId);
    expect(updatedHabitat!.name).toBe("Replace Target (Updated)");
  });
});

// ===========================================================================
// 4. Flag ON — v1/v2 input → adapter → 201 published.
// ===========================================================================

describe("T10C M3 — flag ON + v1/v2 input → adapter → 201 published", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "true";
  });

  it("POST /habitats/import with a v2 input → 201 published (adapter route)", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: v2Export({ habitatName: "V2 Via Adapter" }),
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("published");
    expect(body.habitatId).toBeDefined();
    const newHabitat = habitatRepo.getHabitatById(body.habitatId);
    expect(newHabitat!.name).toBe("V2 Via Adapter");
  });

  it("POST /habitats/import with a v1 (board/features) input → 201 published", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: v1Export({ habitatName: "V1 Via Adapter" }),
    });
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("published");
    const newHabitat = habitatRepo.getHabitatById(body.habitatId);
    expect(newHabitat!.name).toBe("V1 Via Adapter");
  });
});

// ===========================================================================
// 5. Flag ON — rejected_preflight → 422 with ALL accumulated errors.
// ===========================================================================

describe("T10C M3 — flag ON + rejected_preflight → 422 with ALL errors", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "true";
  });

  it("manifest with a duplicate column name → 422 + errors[] carries the failure", async () => {
    app = await buildApp();
    const manifest = v3Manifest();
    // Inject a duplicate column name — the columns handler MUST reject.
    manifest.domains.columns!.data = [
      {
        sourceId: "col-1",
        name: "Dup",
        order: 0,
        color: null,
        wipLimit: null,
        nextColumnName: null,
        isTerminal: false,
      },
      {
        sourceId: "col-2",
        name: "Dup",
        order: 1,
        color: null,
        wipLimit: null,
        nextColumnName: null,
        isTerminal: false,
      },
    ];

    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("rejected_preflight");
    expect(body.importAttemptId).toBeDefined();
    expect(Array.isArray(body.errors)).toBe(true);
    expect(body.errors.length).toBeGreaterThan(0);
    for (const err of body.errors) {
      expect(typeof err.field).toBe("string");
      expect(typeof err.code).toBe("string");
      expect(typeof err.message).toBe("string");
    }
  });
});

// ===========================================================================
// 6. Flag ON — replayed / already_exists → 200 (same manifestId).
// ===========================================================================

describe("T10C M3 — flag ON + replayed / already_exists → 200", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "true";
  });

  it("re-submitting the same manifestId → 200 (replay path or already_exists)", async () => {
    app = await buildApp();
    const manifest = v3Manifest({ manifestId: `replay-${randomUUID()}` });

    // First POST → 201 published.
    const first = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });
    expect(first.statusCode).toBe(201);

    // Second POST with the same manifestId → 200 (replay or already_exists).
    const second = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });
    expect(second.statusCode).toBe(200);
    const body = JSON.parse(second.body);
    expect(["already_exists", "replayed"]).toContain(body.outcome);
  });

  it("re-submitting an expired publishing attempt reclaims the lease and completes publication", async () => {
    app = await buildApp();
    const manifest = v3Manifest({ manifestId: `expired-publishing-${randomUUID()}` });

    const prepared = prepareImport({
      rawManifest: manifest,
      habitatId: null,
      actor: { type: "human", id: "admin" },
      auditSource: "rest_api",
    });
    expect(prepared.outcome).toBe("prepared");
    if (prepared.outcome !== "prepared") return;

    expect(() =>
      publishImportAggregateWithClient(getDb(), {
        prepared: prepared.prepared,
        participants: () => {
          throw new Error("simulate crash after lease acquisition");
        },
      }),
    ).toThrow(/simulate crash after lease acquisition/);

    getDb()
      .update(importAttempts)
      .set({ leaseExpiresAt: "2000-01-01T00:00:00.000Z" })
      .where(eq(importAttempts.id, manifest.manifestId))
      .run();

    const resumed = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });

    expect(resumed.statusCode).toBe(201);
    expect(resumed.json().outcome).toBe("published");
    expect(getDb().select().from(tasksTable).all().length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// 7. Flag ON — unknown version → 400 + v3 mode mismatch → 400.
// ===========================================================================

describe("T10C M3 — flag ON + version/mode dispatch errors → 400", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "true";
  });

  it("POST /habitats/import with version:4 → 400 'Unsupported export version'", async () => {
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: { version: 4, habitat: { name: "X" } },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/Unsupported export version.*4.*1, 2, and 3/s);
  });

  it("POST /habitats/import with a mode:'replacement' v3 manifest → 400 (route mismatch)", async () => {
    app = await buildApp();
    const manifest = v3Manifest({ mode: "replacement" });
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not match the route's declared mode/s);
  });

  it("POST /habitats/:habitatId/import with a mode:'new' v3 manifest → 400 (route mismatch)", async () => {
    const existingHabitatId = seedFullHabitat("Mismatch Target");
    app = await buildApp();
    const manifest = v3Manifest({ mode: "new" });
    const res = await app.inject({
      method: "POST",
      url: `/api/habitats/${existingHabitatId}/import`,
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/does not match the route's declared mode/s);
  });
});

// ===========================================================================
// 8. Unit-level mapper coverage — every PublishImportOutcome branch maps
//    to the M3-contract status code. These branches are impractical to
//    trigger deterministically via HTTP (they require mid-flight row
//    manipulation or unreliable races). The route forwards the kernel
//    outcome verbatim via this mapper, so mapper-level coverage IS
//    route-level coverage for these branches.
//
//    Kernel-level coverage of the underlying outcomes lives in:
//      - `importPublication.test.ts:545+` (guard_mismatch)
//      - `importPublication.test.ts:610+` (CAS-refusal: illegal_source_state,
//        already_publishing, not_found)
//      - `importPublication.test.ts:713+` (replayed)
//      - `templateAggregatePublication.test.ts:431+` (vetoed atomicity)
// ===========================================================================

describe("T10C M3 — publishImportOutcomeToHttpResponse (every PublishImportOutcome branch)", () => {
  it("published → 201 + {importAttempt, habitatId, importedCounts}", () => {
    const result: PublishImportOutcome = {
      outcome: "published",
      importAttempt: { id: "ia-1" } as never,
      habitatId: "h-1",
      tasks: [],
      importedCounts: { columns: 2 },
    };
    const { statusCode, body } = publishImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(201);
    expect(body.outcome).toBe("published");
    expect(body.importAttempt).toEqual({ id: "ia-1" });
    expect(body.habitatId).toBe("h-1");
    expect(body.importedCounts).toEqual({ columns: 2 });
  });

  it("already_publishing → 202 + status:'publishing'", () => {
    const result: PublishImportOutcome = {
      outcome: "already_publishing",
      importAttempt: { id: "ia-2" } as never,
    };
    const { statusCode, body } = publishImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(202);
    expect(body.outcome).toBe("already_publishing");
    expect(body.status).toBe("publishing");
    expect(body.importAttempt).toEqual({ id: "ia-2" });
  });

  it("guard_mismatch → 409 + fields=['targetHabitatUpdatedAt']", () => {
    const result: PublishImportOutcome = {
      outcome: "guard_mismatch",
      importAttempt: { id: "ia-3" } as never,
      fields: ["targetHabitatUpdatedAt"],
    };
    const { statusCode, body } = publishImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(409);
    expect(body.outcome).toBe("guard_mismatch");
    expect(body.fields).toEqual(["targetHabitatUpdatedAt"]);
  });

  it("vetoed → 422 + ALL decisive vetoes", () => {
    const result: PublishImportOutcome = {
      outcome: "vetoed",
      importAttempt: { id: "ia-4" } as never,
      vetoes: [
        {
          taskIndex: 0,
          prospectiveTaskId: "t-1",
          interceptorKey: '["lifecycleInterceptor","p","i","pre","taskCreated"]',
          reason: "no",
          pluginRunId: null,
        },
        {
          taskIndex: 2,
          prospectiveTaskId: "t-3",
          interceptorKey: '["lifecycleInterceptor","p","i2","pre","taskCreated"]',
          reason: "no 2",
          pluginRunId: null,
        },
      ],
    };
    const { statusCode, body } = publishImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(422);
    expect(body.outcome).toBe("vetoed");
    const vetoes = body.vetoes as unknown[];
    expect(vetoes).toHaveLength(2);
    expect((vetoes[0] as { prospectiveTaskId: string }).prospectiveTaskId).toBe("t-1");
    expect((vetoes[1] as { prospectiveTaskId: string }).prospectiveTaskId).toBe("t-3");
  });

  it("illegal_source_state → 409 + fromState", () => {
    const result: PublishImportOutcome = {
      outcome: "illegal_source_state",
      importAttempt: { id: "ia-5" } as never,
      fromState: "published",
    };
    const { statusCode, body } = publishImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(409);
    expect(body.outcome).toBe("illegal_source_state");
    expect(body.fromState).toBe("published");
  });

  it("not_found → 404 + {outcome:'not_found'}", () => {
    const result: PublishImportOutcome = { outcome: "not_found" };
    const { statusCode, body } = publishImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(404);
    expect(body.outcome).toBe("not_found");
  });

  it("replayed → 200 + terminal", () => {
    const result: PublishImportOutcome = {
      outcome: "replayed",
      importAttempt: { id: "ia-6" } as never,
      attemptId: "ta-1",
      terminal: { outcome: "created", taskId: "t-9" } as never,
    };
    const { statusCode, body } = publishImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(200);
    expect(body.outcome).toBe("replayed");
    const terminal = body.terminal as { outcome: string; taskId: string };
    expect(terminal.outcome).toBe("created");
    expect(terminal.taskId).toBe("t-9");
  });
});

describe("T10C M3 — prepareImportOutcomeToHttpResponse (every non-prepared PrepareImportOutcome branch)", () => {
  it("rejected_preflight → 422 + ALL errors", () => {
    const result: PrepareImportOutcome = {
      outcome: "rejected_preflight",
      importAttemptId: "ia-rp",
      errors: [
        { field: "columns[0].name", code: "duplicate_name", message: "dup" },
        { field: "missions[0].columnName", code: "unresolved_column_name", message: "no column" },
      ],
    };
    const { statusCode, body } = prepareImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(422);
    expect(body.outcome).toBe("rejected_preflight");
    expect(body.importAttemptId).toBe("ia-rp");
    expect(body.errors).toHaveLength(2);
  });

  it("already_exists → 200 + attempt", () => {
    const result: PrepareImportOutcome = {
      outcome: "already_exists",
      attempt: { id: "ia-ae", state: "published" } as never,
    };
    const { statusCode, body } = prepareImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(200);
    expect(body.outcome).toBe("already_exists");
    expect(body.attempt).toEqual({ id: "ia-ae", state: "published" });
  });

  it("feature_disabled → 501 (defensive — flag-off never reaches this branch)", () => {
    const result: PrepareImportOutcome = { outcome: "feature_disabled" };
    const { statusCode, body } = prepareImportOutcomeToHttpResponse(result);
    expect(statusCode).toBe(501);
    expect(body.outcome).toBe("feature_disabled");
  });
});

// ===========================================================================
// 9. Round-trip — M2 exporter output → POST /api/habitats/import → 201.
//    The load-bearing end-to-end: a habitat exported via `exportHabitatManifest`
//    (the M2 native v3 exporter) round-trips through the v3 import route
//    (this M3 milestone) into a new habitat.
//
// RE-ENABLED after T10B-FK-FIX (the columns handler's FK-ordering fix):
//
//    The columns handler originally iterated `prepared.columns` in their
//    declared order (Todo first, then In Progress, Review, Done) and
//    inserted each with its `nextColumnServerId` — which forward-referenced
//    the NEXT sibling. SQLite enforces FK at INSERT time for non-DEFERRABLE
//    constraints (the `columns.next_column_id` FK at `0000_schema.sql:209`
//    is NOT `DEFERRABLE INITIALLY DEFERRED`), so the INSERT failed with
//    `FOREIGN KEY constraint failed` under better-sqlite3 (FK always ON).
//
//    The fix in `applyColumns` (see columns.ts docstring): insert columns
//    in topological order over the `nextColumnServerId` dependency graph.
//    With the fix, this test passes deterministically regardless of
//    sql.js's FK PRAGMA state in the surrounding test context.
//
// NOTE: `seedFullHabitat` now seeds ALL 8 domains (cold-review Finding 3),
//    including a reverse-dependency mission pair + a parent-child comment
//    pair. This existing test asserts only the happy-path 201 + Mission
//    Alpha's survival — it does NOT set `PRAGMA foreign_keys = ON`. The
//    comprehensive full-shape round-trip WITH FK ON + per-domain survival
//    assertions is the dedicated test in section 10 below (cold-review
//    Finding 3). Both tests now exercise the full 8-domain seed.
// ===========================================================================

describe("T10C M3 — round-trip M2 → M3 (exportHabitatManifest → POST /api/habitats/import)", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "true";
  });

  it("an M2-exported manifest POSTed to the v3 route → 201 published + portable domains survive", async () => {
    const sourceHabitatId = seedFullHabitat("Round-trip Source");

    // M2 exporter — produces a v3 manifest from the live habitat.
    const manifest = exportHabitatManifest(sourceHabitatId);
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });

    // Load-bearing: assert the success path. The comprehensive per-domain
    // survival assertions + FK ON live in section 10 below.
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("published");
    expect(body.habitatId).toBeDefined();
    expect(body.habitatId).not.toBe(sourceHabitatId);
    const newHabitat = habitatRepo.getHabitatById(body.habitatId);
    expect(newHabitat!.name).toBe("Round-trip Source");
    const newMissions = missionRepo.getMissionsByHabitatId(body.habitatId).missions;
    expect(newMissions.some((m) => m.title === "Mission Alpha")).toBe(true);
  });
});

// ===========================================================================
// 10. Full-shape HTTP round-trip with FK ON — cold-review Finding 3.
//     The ONLY test that exercises BOTH the HTTP layer AND the full 8-domain
//     set under `PRAGMA foreign_keys = ON` (mirrors production's better-
//     sqlite3 always-ON enforcement). Proves the three cold-review FK fixes
//     (applyMissions two-pass, applyComments topological sort, the
//     orchestrator's pre/post-task split) all hold under the real HTTP path.
//     Matches the M2 kernel-level round-trip's per-domain assertion depth
//     (`habitatManifestExporter.test.ts:247`).
// ===========================================================================

describe("T10C cold-review Finding 3 — full-shape HTTP round-trip with FK ON", () => {
  beforeEach(() => {
    process.env[CUTOVER_FLAG] = "true";
    getDb().run(`PRAGMA foreign_keys = ON`);
  });

  it("seeds all 8 domains → export → POST /api/habitats/import → 201 + per-domain survival (FK ON)", async () => {
    // --- arrange (seed source with ALL 8 domains) ---
    const sourceHabitatId = seedFullHabitat("Full-Shape Source");

    // --- act (export source) ---
    const manifest = exportHabitatManifest(sourceHabitatId);
    expect(manifest).not.toBeNull();
    if (!manifest) return;

    // Sanity: the manifest carries all 8 domains.
    expect(Object.keys(manifest.domains).sort()).toEqual(
      [
        "habitatSettings",
        "columns",
        "missions",
        "tasks",
        "subtasks",
        "dependencies",
        "comments",
        "templates",
      ].sort(),
    );

    // --- act (POST to the HTTP route with FK ON) ---
    app = await buildApp();
    const res = await app.inject({
      method: "POST",
      url: "/api/habitats/import",
      headers: { authorization: `Bearer ${adminToken()}` },
      payload: manifest,
    });

    // --- assert publication committed ---
    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.outcome).toBe("published");
    expect(body.habitatId).toBeDefined();
    expect(body.habitatId).not.toBe(sourceHabitatId);
    const newHabitatId = body.habitatId;

    // --- assert per-domain survival (matches M2 kernel test depth) ---

    // Columns: 4 default columns survive.
    const newColumns = habitatRepo.getHabitatWithColumnsAndTasks(newHabitatId)!.columns;
    expect(newColumns.map((c) => c.name).sort()).toEqual(
      ["Done", "In Progress", "Review", "Todo"].sort(),
    );

    // Missions: 2 survive (alpha + beta). The reverse-dependency edge
    // (alpha depends on beta — alpha sorts FIRST in export) survived the
    // two-pass applyMissions fix (Finding 1).
    const { missions: newMissions } = missionRepo.getMissionsByHabitatId(newHabitatId);
    expect(newMissions).toHaveLength(2);
    const newAlpha = newMissions.find((m) => m.title === "Mission Alpha")!;
    const newBeta = newMissions.find((m) => m.title === "Mission Beta")!;
    expect(newAlpha).toBeDefined();
    expect(newBeta).toBeDefined();
    const alphaDeps = dependencyRepo.getMissionDependencies(newAlpha.id);
    expect(alphaDeps.dependsOn.map((d) => d.missionId)).toContain(newBeta.id);

    // Tasks: 2 survive under alpha (alphaTask1 + alphaTask2).
    const newAlphaTasks = taskRepo.getTasksByMissionId(newAlpha.id);
    expect(newAlphaTasks).toHaveLength(2);
    const newAlphaTask1 = newAlphaTasks.find((t) => t.title === "Alpha Task 1")!;
    const newAlphaTask2 = newAlphaTasks.find((t) => t.title === "Alpha Task 2")!;
    expect(newAlphaTask1).toBeDefined();
    expect(newAlphaTask2).toBeDefined();

    // Subtasks: 1 survives under alphaTask1.
    const newSubtasks = subtaskRepo.getSubtasksByTaskId(newAlphaTask1.id);
    expect(newSubtasks).toHaveLength(1);
    expect(newSubtasks[0].title).toBe("Subtask A");

    // Task dependencies: alphaTask2 → alphaTask1 survives.
    const newDep = dependencyRepo.getTaskDependencies(newAlphaTask2.id);
    expect(newDep.dependsOn).toHaveLength(1);
    expect(newDep.dependsOn[0].taskId).toBe(newAlphaTask1.id);

    // Comments: 2 survive (parent + child). The parent-child pair survived
    // the topological-sort applyComments fix (Finding 2). Query directly
    // from missionComments (the v3 table).
    const db = getDb();
    const newComments = db
      .select()
      .from(missionComments)
      .where(eq(missionComments.missionId, newAlpha.id))
      .all();
    expect(newComments).toHaveLength(2);
    const childComment = newComments.find((c) => c.parentId !== null);
    const parentComment = newComments.find((c) => c.parentId === null);
    expect(parentComment).toBeDefined();
    expect(childComment).toBeDefined();
    expect(childComment!.parentId).toBe(parentComment!.id);

    // Templates: 1 default template survives.
    const newTemplates = templateRepo
      .getTemplatesByHabitatId(newHabitatId)
      .filter((t) => t.habitatId === newHabitatId);
    expect(newTemplates).toHaveLength(1);
    expect(newTemplates[0].name).toBe("Default Template");
    expect(newTemplates[0].isDefault).toBe(true);
  });
});
