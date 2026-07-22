/**
 * T11 Phase 1G — flag-gated template-application route tests.
 *
 * Verifies the `routes/templates.ts` `isCreationPublicationEnabled` gate for
 * `POST /missions/:missionId/apply-template/:templateId` — the LAST production
 * caller of `templateRepo.applyTemplate` that bypassed the new publication
 * kernel:
 *   - Flag ON → route composes
 *     `prepareTemplateAggregate` + `publishTemplateAggregateWithClient`
 *     (reserve N attempts + atomic Mission + Tasks + Workflow + usage). Tasks
 *     carry `creationIntegrity: POST_CUTOVER` + a `created` Lifecycle Event +
 *     a committed envelope (verifiable from the DB side-effects).
 *   - Flag OFF → legacy `templateRepo.applyTemplate` direct-insert path runs
 *     byte-identical (verified by the existing `applyTemplate.test.ts` + the
 *     `templateWorkflowPassthrough.test.ts` suites, which do NOT set the flag
 *     and so default OFF — this suite doesn't disturb that).
 *
 * The flag-OFF legacy parity is covered EXHAUSTIVELY by the existing template
 * test suites (unchanged — the flag defaults OFF when these tests don't set
 * it). This suite covers the flag-ON routing + outcome-mapping that the
 * Phase 1G change adds.
 *
 * Reference: the precedents
 *   - `services/triageService.ts:38-64` (Phase 1C — triage routing,
 *     `triageServicePublicationRouting.test.ts`)
 *   - `services/scheduledTaskService.ts:152-154` (Phase 1B — scheduler routing,
 *     `scheduledTaskPublicationRouting.test.ts`)
 *   - `services/automationExecutor.ts:273-275` (Phase 1 — automation routing,
 *     `automationTaskPublication.test.ts`)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { sql } from "drizzle-orm";
import Fastify, { type FastifyInstance } from "fastify";
import { validatorCompiler, serializerCompiler } from "fastify-type-provider-zod";
import jwt from "jsonwebtoken";
import {
  closeDb,
  getDb,
  initTestDb,
} from "../db/index.js";
import {
  habitats,
  columns as columnsTable,
  missions,
  missionTemplates,
  tasks,
  taskEvents,
  taskCreationAttempts,
  taskCreationEnvelopes,
} from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as templateRepo from "../repositories/template.js";
import { templateRoutes } from "../routes/templates.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";

// --- Mocks: assert the route emits NO pre-commit effects (SSE/hooks). -----
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

// --- Shared fixtures ------------------------------------------------------
const CUTOVER_FLAG = "ORCY_CREATION_PUBLICATION_ENABLED";
const JWT_SECRET = "dev-secret-change-in-production";
let habitatId: string;
let columnId: string;
let missionId: string;
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
  db.delete(taskCreationEnvelopes).run();
  db.delete(taskCreationAttempts).run();
  db.delete(taskEvents).run();
  db.delete(tasks).run();
  db.delete(missions).run();
  db.delete(columnsTable).run();
  db.delete(habitats).run();
  db.delete(missionTemplates).run();

  const habitat = habitatRepo.createHabitat({ name: "T11 Phase 1G Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Backlog",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  const mission = missionRepo.createMission({
    habitatId,
    columnId,
    title: "Existing Mission",
    createdBy: "test",
  });
  missionId = mission.id;
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

// --- Helpers --------------------------------------------------------------
function makeToken(payload: {
  sub: string;
  username: string;
  role: string;
}): string {
  return jwt.sign(payload, JWT_SECRET, { issuer: "orcy" });
}

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(templateRoutes);
  await app.ready();
  return app;
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
    attempts: db
      .select({ count: sql<number>`COUNT(*)` })
      .from(taskCreationAttempts)
      .get()!.count,
  };
}

// ---------------------------------------------------------------------------
// Routing — flag ON routes through prepareTemplateAggregate +
// publishTemplateAggregateWithClient (not legacy applyTemplate)
// ---------------------------------------------------------------------------

describe("T11 Phase 1G — flag-gated template-application routing", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("flag ON: routes through the T9A aggregate kernel chain", async () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Phase 1G Template",
      titlePattern: "Sprint Task",
      descriptionPattern: "## Goal\nComplete the work",
      priority: "high",
      tasksTemplate: [{ key: "task_1", title: "Investigate", priority: "medium" }],
      createdBy: "human",
    });

    const token = makeToken({ sub: "user-1", username: "admin", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/missions/${missionId}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Custom Sprint Title",
        priority: "critical",
      },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.mission.title).toBe("Custom Sprint Title");
    expect(body.mission.priority).toBe("critical");
    expect(Array.isArray(body.tasks)).toBe(true);
    expect(body.tasks.length).toBe(1);
    // The T9A kernel stamps `creationIntegrity: "POST_CUTOVER"` on every Task
    // it publishes (verifiable on the DB row). The legacy `applyTemplate`
    // path inserts Tasks directly without this stamp — so its presence
    // proves the gate actually routes through the new kernel.
    const counts = countRows();
    expect(counts.attempts).toBe(1); // one attempt per prepared Task
    expect(counts.envelopes).toBe(1); // one envelope per published Task
    expect(counts.events).toBeGreaterThanOrEqual(1); // at least the `created` event

    const taskRow = getDb()
      .select()
      .from(tasks)
      .where(sql`${tasks.missionId} = ${body.mission.id}`)
      .get();
    expect(taskRow).toBeTruthy();
    expect(taskRow!.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);

    // No pre-commit effects fired (no SSE events).
    expect(publishMock).not.toHaveBeenCalled();
  });

  it("flag ON: returns 422 with prepared validation errors on bad template payload", async () => {
    // Create a template whose workflowTemplate references a required variable
    // the caller will not supply → preparation collects a
    // `missing_required_variable` error.
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Phase 1G Validation Template",
      titlePattern: "Validation Task",
      descriptionPattern: "## Goal\nComplete the work",
      priority: "high",
      tasksTemplate: [{ key: "task_1", title: "Do work", priority: "medium" }],
      workflowTemplate: {
        variables: [{ key: "sprintGoal", description: "Sprint goal", required: true }],
        gates: [],
        joinSpecs: {},
      },
      createdBy: "human",
    });

    const token = makeToken({ sub: "user-1", username: "admin", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/missions/${missionId}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        title: "Custom Title",
        // No `variables.sprintGoal` → preparation rejects.
      },
    });

    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.code).toBe("TEMPLATE_PREPARATION_REJECTED");
    expect(body.details?.errors).toBeTruthy();
    expect(
      (body.details.errors as Array<{ code: string }>).some(
        (e) => e.code === "missing_required_variable",
      ),
    ).toBe(true);

    // No partial aggregate: zero Missions + zero Tasks committed.
    const counts = countRows();
    expect(counts.missions).toBe(1); // only the seed Mission
    expect(counts.tasks).toBe(0);
    expect(counts.attempts).toBe(0);
    expect(counts.envelopes).toBe(0);
  });

  it("flag ON: response shape matches the legacy `{mission, tasks, workflow}` contract", async () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Shape Template",
      titlePattern: "Shape Task",
      descriptionPattern: "## Goal\nShape",
      priority: "medium",
      tasksTemplate: [
        { key: "task_1", title: "First", priority: "medium" },
        { key: "task_2", title: "Second", priority: "high" },
      ],
      createdBy: "human",
    });

    const token = makeToken({ sub: "user-1", username: "admin", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/missions/${missionId}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Shape Title" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);

    // Top-level keys match the legacy shape exactly.
    expect(Object.keys(body).sort()).toEqual(["mission", "tasks", "workflow"]);
    expect(body.mission.title).toBe("Shape Title");
    expect(body.tasks.length).toBe(2);
    // No workflowTemplate on the template → workflow is null (mirrors legacy).
    expect(body.workflow).toBeNull();
  });

  it("flag ON: reservation creates one attempt per prepared Task with aligned index", async () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Multi Task Template",
      titlePattern: "Multi Task",
      descriptionPattern: "## Goal\nMulti",
      priority: "medium",
      tasksTemplate: [
        { key: "task_1", title: "A", priority: "low" },
        { key: "task_2", title: "B", priority: "medium" },
        { key: "task_3", title: "C", priority: "high" },
      ],
      createdBy: "human",
    });

    const token = makeToken({ sub: "user-1", username: "admin", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/missions/${missionId}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Multi Task Title" },
    });

    expect(res.statusCode).toBe(201);
    const counts = countRows();
    // One attempt per prepared Task — 3 tasks → 3 attempts (the kernel's
    // N-per-Task-attempts contract forbids sharing one attemptId across N).
    expect(counts.attempts).toBe(3);
    expect(counts.envelopes).toBe(3);
    expect(counts.tasks).toBe(3);
  });

  it("flag ON: per-click reservations are distinct (no replay surface)", async () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Per-Click Template",
      titlePattern: "Per-Click Task",
      descriptionPattern: "## Goal\nPer-Click",
      priority: "medium",
      tasksTemplate: [{ key: "task_1", title: "Do work", priority: "medium" }],
      createdBy: "human",
    });

    const token = makeToken({ sub: "user-1", username: "admin", role: "admin" });
    const res1 = await app!.inject({
      method: "POST",
      url: `/missions/${missionId}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Click 1" },
    });
    expect(res1.statusCode).toBe(201);

    const res2 = await app!.inject({
      method: "POST",
      url: `/missions/${missionId}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Click 2" },
    });
    expect(res2.statusCode).toBe(201);

    // Two distinct clicks → two distinct attempts (per-click UUID nonce in
    // the attemptKey). No replay dedup; each click commits a fresh Mission +
    // Task.
    const counts = countRows();
    expect(counts.missions).toBe(3); // seed + 2 publications
    expect(counts.tasks).toBe(2);
    expect(counts.attempts).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Flag OFF — legacy `applyTemplate` path (byte-identical to pre-T11 behavior)
// ---------------------------------------------------------------------------

describe("T11 Phase 1G — flag OFF: legacy applyTemplate path preserved", () => {
  let app: FastifyInstance | null = null;

  beforeEach(async () => {
    process.env[CUTOVER_FLAG] = "false";
    app = await buildApp();
  });

  afterEach(async () => {
    if (app) await app.close();
  });

  it("flag OFF: returns 201 via legacy path (no T9A envelopes)", async () => {
    const template = templateRepo.createTemplate({
      habitatId,
      name: "Legacy Template",
      titlePattern: "Legacy Task",
      descriptionPattern: "## Goal\nLegacy",
      priority: "high",
      tasksTemplate: [{ key: "task_1", title: "Legacy work", priority: "medium" }],
      createdBy: "human",
    });

    const token = makeToken({ sub: "user-1", username: "admin", role: "admin" });
    const res = await app!.inject({
      method: "POST",
      url: `/missions/${missionId}/apply-template/${template.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { title: "Legacy Title" },
    });

    expect(res.statusCode).toBe(201);
    const body = JSON.parse(res.body);
    expect(body.mission.title).toBe("Legacy Title");
    expect(body.tasks.length).toBe(1);

    // No T9A envelopes / attempts created on the legacy path — proves the
    // flag actually gates the routing (when OFF, no preparation + no
    // reservation + no kernel publication).
    const counts = countRows();
    expect(counts.envelopes).toBe(0);
    expect(counts.attempts).toBe(0);

    // Legacy Tasks do NOT carry `creationIntegrity: POST_CUTOVER` (they were
    // inserted by the pre-T11 direct-insert path, not the kernel).
    const taskRow = getDb()
      .select()
      .from(tasks)
      .where(sql`${tasks.missionId} = ${body.mission.id}`)
      .get();
    expect(taskRow).toBeTruthy();
    expect(taskRow!.creationIntegrity).not.toBe("POST_CUTOVER");
  });
});