/**
 * Request collection cap — the central pre-validation bound on request
 * collections.
 *
 * Zod validates every element of an array and records one issue per failing
 * element, so the work a request triggers is driven by the request's shape
 * rather than by what the schema would ever accept. The root `preValidation`
 * hook (`middleware/requestCollectionCap.ts`) answers an oversized
 * collection before any schema runs — declared on the route or parsed inside
 * the handler — and before authentication and rate limiting.
 *
 * Proofs, smallest first:
 *   - the walk itself (unit table: what counts, what is skipped, the depth
 *     bound);
 *   - no element of an oversized collection is validated: an element schema
 *     that counts how often zod runs it, for both validation styles, with a
 *     fixture a few elements over the cap (no load test, no large fixture);
 *   - a request exactly at the cap is accepted and fully validated;
 *   - the production assembly installs the guard for real routes, for the
 *     query string, and ahead of authentication;
 *   - the routes that carry a whole board, a workflow, or a pull request's
 *     evidence accept more than the default cap, exactly up to their own cap
 *     and not one past it, and a real board export round trip passes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import jwt from "jsonwebtoken";
import { z } from "zod";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import {
  BOARD_REQUEST_COLLECTION_CAP,
  CODE_EVIDENCE_REQUEST_COLLECTION_CAP,
  DEFAULT_REQUEST_COLLECTION_CAP,
  MAX_REQUEST_DEPTH,
  findOversizedCollection,
  requestCollectionCap,
} from "../middleware/requestCollectionCap.js";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { badRequest } from "../errors.js";
import { setJwtSecret } from "../middleware/jwt-verification.js";
import { closeDb, initTestDb } from "../db/index.js";
import { exportHabitatManifest } from "../services/habitatManifestExporter.js";
import * as taskRepo from "../repositories/task.js";

const CAP = DEFAULT_REQUEST_COLLECTION_CAP;
const BOARD_CAP = BOARD_REQUEST_COLLECTION_CAP;
const CODE_EVIDENCE_CAP = CODE_EVIDENCE_REQUEST_COLLECTION_CAP;
const OVER_CAP = `Request contains a collection with more than ${CAP} items`;
const OVER_BOARD_CAP = `Request contains a collection with more than ${BOARD_CAP} items`;
const OVER_CODE_EVIDENCE_CAP = `Request contains a collection with more than ${CODE_EVIDENCE_CAP} items`;
const TOO_DEEP = `Request is nested more than ${MAX_REQUEST_DEPTH} levels deep`;
const VALIDATION_ERROR = "VALIDATION_ERROR";

const strings = (count: number): string[] =>
  Array.from({ length: count }, (_, i) => `item-${i}`);

const wideObject = (count: number, prefix = "key"): Record<string, number> =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}-${i}`, i]));

/** `value` wrapped in `arrays` nested arrays, so it sits `arrays + 1` container levels deep. */
function nested(value: unknown, arrays: number): unknown {
  let node = value;
  for (let i = 0; i < arrays; i += 1) node = [node];
  return node;
}

describe("findOversizedCollection", () => {
  const cap = 4;
  const cases: [string, unknown, string | null][] = [
    ["a primitive", "x", null],
    ["null", null, null],
    ["a Buffer (raw bytes, not a collection)", Buffer.alloc(9), null],
    ["a typed array", new Uint8Array(9), null],
    ["an array at the cap", [1, 2, 3, 4], null],
    ["an array over the cap", [1, 2, 3, 4, 5], "array"],
    ["an array over the cap at a nesting level", { a: { b: [[1, 2, 3, 4, 5]] } }, "array"],
    ["an object at the cap", { a: 1, b: 2, c: 3, d: 4 }, null],
    ["an object over the cap", { a: 1, b: 2, c: 3, d: 4, e: 5 }, "object"],
    [
      "a null-prototype object over the cap",
      Object.assign(Object.create(null), wideObject(5)),
      "object",
    ],
    [
      "an array held by a class instance (not plain, still walked)",
      new (class {
        items = [1, 2, 3, 4, 5];
      })(),
      "array",
    ],
    // Each collection is at the cap on its own; the cap bounds one
    // collection, never the sum of siblings.
    ["siblings that are each at the cap", [[1, 2, 3, 4], { a: 1, b: 2, c: 3, d: 4 }], null],
    ["nesting exactly at the depth bound", nested({}, MAX_REQUEST_DEPTH), null],
    ["nesting one level past the depth bound", nested({}, MAX_REQUEST_DEPTH + 1), "depth"],
  ];
  it.each(cases)("%s", (_label, value, expected) => {
    expect(findOversizedCollection(value, cap)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// Bare instance: the hook plus an element schema that counts how often zod
// runs it. One app per test, so every counter starts at zero.
// ---------------------------------------------------------------------------

function countingString(): { schema: z.ZodTypeAny; runs: () => number } {
  let runs = 0;
  return {
    schema: z.preprocess((value) => {
      runs += 1;
      return value;
    }, z.string()),
    runs: () => runs,
  };
}

async function buildCapApp(options: { requestCollectionCap?: number } = {}) {
  const declared = countingString();
  const parsed = countingString();
  const handlerCalls = { count: 0 };
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  app.addHook("preValidation", requestCollectionCap);
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );

  /** Route that declares its schema (Fastify validates it before preHandler). */
  const declare = {
    schema: { body: z.object({ items: z.array(declared.schema) }) },
  };
  app.post("/declared", declare, async (request) => ({ count: request.body.items.length }));
  app.post(
    "/raised",
    { ...declare, config: { requestCollectionCap: options.requestCollectionCap ?? CAP * 2 } },
    async (request) => ({ count: request.body.items.length }),
  );
  app.post("/query", async (request) => {
    const ids = (request.query as { ids?: string | string[] }).ids;
    return { count: ids === undefined ? 0 : [ids].flat().length };
  });
  app.post("/opaque", async (request) => ({
    isBuffer: Buffer.isBuffer(request.body),
    type: typeof request.body,
  }));

  /** Route that parses inside its handler (no declared schema). */
  const handlerSchema = z.object({ items: z.array(parsed.schema) });
  app.post("/parsed", async (request) => {
    handlerCalls.count += 1;
    const result = handlerSchema.safeParse(request.body);
    if (!result.success) throw badRequest("handler validation failed");
    return { count: result.data.items.length };
  });

  await app.ready();
  return { app, declared, parsed, handlerCalls };
}

describe("requestCollectionCap with a counting element schema", () => {
  it("declared schema: a few elements over the cap → 400 VALIDATION_ERROR, no element validated", async () => {
    const { app, declared } = await buildCapApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/declared",
        payload: { items: strings(CAP + 3) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });
      expect(declared.runs()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("declared schema: exactly at the cap → accepted, every element validated", async () => {
    const { app, declared } = await buildCapApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/declared",
        payload: { items: strings(CAP) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ count: CAP });
      expect(declared.runs()).toBe(CAP);
    } finally {
      await app.close();
    }
  });

  it("handler-parsed schema: a few elements over the cap → the handler never runs", async () => {
    const { app, parsed, handlerCalls } = await buildCapApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/parsed",
        payload: { items: strings(CAP + 3) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });
      expect(handlerCalls.count).toBe(0);
      expect(parsed.runs()).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("handler-parsed schema: exactly at the cap → accepted, every element validated", async () => {
    const { app, parsed, handlerCalls } = await buildCapApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/parsed",
        payload: { items: strings(CAP) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ count: CAP });
      expect(handlerCalls.count).toBe(1);
      expect(parsed.runs()).toBe(CAP);
    } finally {
      await app.close();
    }
  });

  it("answers one fixed-size body that never echoes the request", async () => {
    const { app } = await buildCapApp();
    // Long enough that one leaked marker would show, short enough that the
    // largest payload stays under the request body limit.
    const marker = `NEVER-ECHO-${"x".repeat(64)}`;
    const oversized = [
      // A top-level array.
      strings(CAP + 1).map(() => marker),
      // An array nested inside an object.
      { items: [marker, marker], extra: { deep: [strings(CAP + 2).map(() => marker)] } },
      // A map-like object (one issue per value when validated by a record).
      { items: [marker], extra: wideObject(CAP + 1, marker) },
    ];
    try {
      const bodies: string[] = [];
      for (const payload of oversized) {
        for (const url of ["/declared", "/parsed"]) {
          const res = await app.inject({ method: "POST", url, payload });
          expect(res.statusCode, `${url}`).toBe(400);
          expect(res.body).not.toContain(marker);
          bodies.push(res.body);
        }
      }
      expect(new Set(bodies).size).toBe(1);
      expect(JSON.parse(bodies[0]!)).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });
    } finally {
      await app.close();
    }
  });

  it("rejects an object with more keys than the cap, and accepts it at the cap", async () => {
    const { app } = await buildCapApp();
    try {
      const over = await app.inject({ method: "POST", url: "/declared", payload: wideObject(CAP + 1) });
      expect(over.statusCode).toBe(400);
      expect(over.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });

      const atCap = await app.inject({ method: "POST", url: "/declared", payload: wideObject(CAP) });
      // Past the guard; the route's own schema answers the shape it does not declare.
      expect(atCap.statusCode).toBe(400);
      expect(atCap.json().error).toBe("Validation failed");
    } finally {
      await app.close();
    }
  });

  it("rejects nesting past the depth bound with its own fixed message", async () => {
    const { app } = await buildCapApp();
    try {
      const res = await app.inject({
        method: "POST",
        url: "/parsed",
        payload: nested({ items: [] }, MAX_REQUEST_DEPTH + 1) as object,
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: TOO_DEEP, code: VALIDATION_ERROR });
    } finally {
      await app.close();
    }
  });

  it("applies the same cap to query-string collections", async () => {
    const { app } = await buildCapApp();
    try {
      const repeat = (count: number) => `?${strings(count).map((_, i) => `ids=${i}`).join("&")}`;
      const over = await app.inject({ method: "POST", url: `/query${repeat(CAP + 1)}` });
      expect(over.statusCode).toBe(400);
      expect(over.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });

      const atCap = await app.inject({ method: "POST", url: `/query${repeat(CAP)}` });
      expect(atCap.statusCode).toBe(200);
      expect(atCap.json()).toEqual({ count: CAP });
    } finally {
      await app.close();
    }
  });

  it("skips bodies that are not objects or arrays (raw bytes reach the route untouched)", async () => {
    const { app } = await buildCapApp();
    try {
      const text = await app.inject({
        method: "POST",
        url: "/opaque",
        headers: { "content-type": "text/plain" },
        payload: "x".repeat(200_000),
      });
      expect(text.statusCode).toBe(200);
      expect(text.json()).toEqual({ isBuffer: false, type: "string" });

      const bytes = await app.inject({
        method: "POST",
        url: "/opaque",
        headers: { "content-type": "application/octet-stream" },
        payload: Buffer.alloc(200_000),
      });
      expect(bytes.statusCode).toBe(200);
      expect(bytes.json()).toEqual({ isBuffer: true, type: "object" });
    } finally {
      await app.close();
    }
  });

  it("a route may raise its cap through route config; an unusable value falls back to the default", async () => {
    const raised = await buildCapApp();
    try {
      const atRaisedCap = await raised.app.inject({
        method: "POST",
        url: "/raised",
        payload: { items: strings(CAP * 2) },
      });
      expect(atRaisedCap.statusCode).toBe(200);
      expect(atRaisedCap.json()).toEqual({ count: CAP * 2 });

      const overRaisedCap = await raised.app.inject({
        method: "POST",
        url: "/raised",
        payload: { items: strings(CAP * 2 + 1) },
      });
      expect(overRaisedCap.statusCode).toBe(400);
      expect(overRaisedCap.json()).toEqual({
        error: `Request contains a collection with more than ${CAP * 2} items`,
        code: VALIDATION_ERROR,
      });
    } finally {
      await raised.app.close();
    }

    const unusable = await buildCapApp({ requestCollectionCap: 0 });
    try {
      const res = await unusable.app.inject({
        method: "POST",
        url: "/raised",
        payload: { items: strings(CAP + 1) },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });
    } finally {
      await unusable.app.close();
    }
  });
});

// ---------------------------------------------------------------------------
// Production assembly: the guard as the executable boots it.
// ---------------------------------------------------------------------------

const JWT_SECRET = "dev-secret-change-in-production";

/**
 * The assembly tests boot the real application and write to a real database.
 * A four-worker CI runner is several times slower than a local one, so every
 * step here gets the same explicit budget instead of vitest's 5 s default.
 */
const ASSEMBLY_TIMEOUT_MS = 60_000;

/** Deterministic API-only mode: no UI directory exists. */
let noUiDir: string;
let priorUiPath: string | undefined;

async function readyApp(): Promise<HttpRuntimeHandle> {
  const app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes([]);
  await app.finalize();
  return app;
}

let exportSeq = 0;

/**
 * A v2 export document whose task and comment collections each hold `count`
 * elements. A legacy import is keyed by `version:exportedAt`, so every
 * document gets its own export time.
 */
function exportDocument(count: number): Record<string, unknown> {
  const tasks = Array.from({ length: count }, (_, i) => ({
    title: `Task ${i}`,
    description: "",
    priority: "medium",
    requiredDomain: null,
    requiredCapabilities: [],
  }));
  exportSeq += 1;
  return {
    version: 2,
    exportedAt: new Date(Date.UTC(2026, 10, 25, 0, 0, exportSeq)).toISOString(),
    habitat: {
      name: "Collection cap import",
      description: "",
      columns: [
        { name: "Todo", order: 0, wipLimit: null, nextColumnName: null, isTerminal: false },
        { name: "Done", order: 1, wipLimit: null, nextColumnName: null, isTerminal: true },
      ],
      missions: [
        {
          title: "Mission",
          description: "",
          acceptanceCriteria: "",
          priority: "medium",
          labels: [],
          columnName: "Todo",
          dependsOn: [],
          blocks: [],
          dueAt: null,
          tasks,
        },
      ],
      comments: tasks.map((task) => ({
        taskTitle: task.title,
        parentTaskTitle: null,
        content: "note",
        authorType: "human",
        authorId: "admin-1",
      })),
      templates: [],
      webhooks: [],
    },
  };
}

describe("request collection cap in the production assembly", () => {
  let app: HttpRuntimeHandle;
  let auth: { authorization: string };
  let habitatId: string;

  beforeAll(async () => {
    priorUiPath = process.env.ORCY_UI_PATH;
    noUiDir = await mkdtemp(path.join("/tmp", "collection-cap-noui-"));
    await rm(noUiDir, { recursive: true, force: true }); // existsSync must be false
    process.env.ORCY_UI_PATH = noUiDir;

    await initTestDb();
    setJwtSecret(JWT_SECRET);
    auth = {
      authorization: `Bearer ${jwt.sign({ sub: "admin-1", username: "admin", role: "admin" }, JWT_SECRET, { issuer: "orcy" })}`,
    };
    app = await readyApp();

    const created = await app.inject({
      method: "POST",
      url: "/api/v1/habitats",
      headers: auth,
      payload: { name: "Collection cap habitat" },
    });
    expect(created.statusCode).toBe(201);
    habitatId = (created.json() as { habitat: { id: string } }).habitat.id;
  }, ASSEMBLY_TIMEOUT_MS);

  afterAll(async () => {
    await app.close();
    closeDb();
    if (priorUiPath === undefined) delete process.env.ORCY_UI_PATH;
    else process.env.ORCY_UI_PATH = priorUiPath;
  }, ASSEMBLY_TIMEOUT_MS);

  /** A mission in the test habitat with `taskCount` tasks: the real create route, then the repository. */
  async function missionWithTasks(
    title: string,
    taskCount: number,
  ): Promise<{ missionId: string; taskIds: string[] }> {
    const created = await app.inject({
      method: "POST",
      url: `/api/v1/habitats/${habitatId}/missions`,
      headers: auth,
      payload: { title },
    });
    expect(created.statusCode).toBe(201);
    const missionId = (created.json() as { mission: { id: string } }).mission.id;
    const taskIds = Array.from({ length: taskCount }, (_, i) =>
      taskRepo.createTask({ missionId, title: `Task ${i}`, createdBy: "admin-1" }).id,
    );
    return { missionId, taskIds };
  }

  const post = (url: string, payload: object, authenticated = true) =>
    app.inject({ method: "POST", url, headers: authenticated ? auth : undefined, payload });

  /** Imports a one-task board, then exports it as a manifest-v3 replacement whose mission carries `labels`. */
  async function replacementExport(
    labels: string[],
  ): Promise<NonNullable<ReturnType<typeof exportHabitatManifest>>> {
    const imported = await post("/api/v1/habitats/import", exportDocument(1));
    expect(imported.statusCode).toBe(201);
    const manifest = exportHabitatManifest((imported.json() as { habitatId: string }).habitatId, {
      mode: "replacement",
    });
    if (manifest === null) throw new Error("exportHabitatManifest returned null");
    exportSeq += 1;
    manifest.manifestId = `collection-cap-${exportSeq}`;
    manifest.domains.missions!.data[0]!.labels = labels;
    return manifest;
  }

  it("runs ahead of authentication on a route that declares its schema", async () => {
    const url = `/api/v1/habitats/${habitatId}/missions`;
    // No credentials: the guard answers first.
    const over = await post(url, { title: "x", labels: strings(CAP + 1) }, false);
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });

    // Control: at the cap the guard stays silent and authentication speaks.
    const atCap = await post(url, { title: "x", labels: strings(CAP) }, false);
    expect(atCap.statusCode).toBe(401);
  }, ASSEMBLY_TIMEOUT_MS);

  it("declared-schema route: at the cap is created, one past it is rejected before validation", async () => {
    const url = `/api/v1/habitats/${habitatId}/missions`;
    const atCap = await post(url, { title: "At cap", labels: strings(CAP) });
    expect(atCap.statusCode).toBe(201);
    expect((atCap.json() as { mission: { labels: string[] } }).mission.labels).toHaveLength(CAP);

    // Every element is invalid for the schema: one issue per element if validated.
    const over = await post(url, { title: "Over cap", labels: strings(CAP + 1).map(() => 0) });
    expect(over.statusCode).toBe(400);
    // The guard's fixed body, not the schema's per-element `details`.
    expect(over.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });
  }, ASSEMBLY_TIMEOUT_MS);

  it("handler-parsed route: at the cap is created, one past it never reaches the handler", async () => {
    const url = `/api/v1/habitats/${habitatId}/wiki/pages`;
    const atCap = await post(url, { title: "At cap", content: "", tags: strings(CAP) });
    expect(atCap.statusCode).toBe(201);

    const over = await post(url, { title: "Over cap", content: "", tags: strings(CAP + 1) });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });
  }, ASSEMBLY_TIMEOUT_MS);

  it("covers query-string collections", async () => {
    const repeat = (count: number) => strings(count).map((_, i) => `ids=${i}`).join("&");
    const over = await app.inject({
      method: "GET",
      url: `/api/v1/habitats?${repeat(CAP + 1)}`,
      headers: auth,
    });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: OVER_CAP, code: VALIDATION_ERROR });

    const atCap = await app.inject({
      method: "GET",
      url: `/api/v1/habitats?${repeat(CAP)}`,
      headers: auth,
    });
    expect(atCap.statusCode).toBe(200);
  }, ASSEMBLY_TIMEOUT_MS);

  it("board import: a real export round trip passes on both import routes", async () => {
    const imported = await post("/api/v1/habitats/import", exportDocument(40));
    expect(imported.statusCode).toBe(201);
    expect((imported.json() as { outcome: string }).outcome).toBe("published");
    const importedHabitatId = (imported.json() as { habitatId: string }).habitatId;

    // The round trip: what the import committed is what the export emits.
    const exported = await app.inject({
      method: "GET",
      url: `/api/v1/habitats/${importedHabitatId}/export`,
      headers: auth,
    });
    expect(exported.statusCode).toBe(200);
    const roundTrip = exported.json() as { habitat: { missions: { tasks: unknown[] }[] } };
    expect(roundTrip.habitat.missions[0]!.tasks).toHaveLength(40);

    const reimported = await post("/api/v1/habitats/import", roundTrip);
    expect(reimported.statusCode).toBe(201);
    const reimportedHabitatId = (reimported.json() as { habitatId: string }).habitatId;

    // A manifest-v3 export of the re-imported board, replacing an existing one
    // (the replacement route's format).
    const manifest = exportHabitatManifest(reimportedHabitatId, { mode: "replacement" });
    if (manifest === null) throw new Error("exportHabitatManifest returned null");
    const replaced = await post(`/api/v1/habitats/${habitatId}/import`, manifest);
    expect(replaced.statusCode).toBe(201);
    expect((replaced.json() as { outcome: string }).outcome).toBe("published");
  }, ASSEMBLY_TIMEOUT_MS);

  it("board import: a collection larger than the default cap passes on both import routes", async () => {
    const legacy = exportDocument(1);
    (legacy.habitat as { missions: { labels: string[] }[] }).missions[0]!.labels = strings(CAP + 1);
    const intoNewHabitat = await post("/api/v1/habitats/import", legacy);
    expect(intoNewHabitat.statusCode).toBe(201);

    const replacing = await post(
      `/api/v1/habitats/${habitatId}/import`,
      await replacementExport(strings(CAP + 1)),
    );
    expect(replacing.statusCode).toBe(201);
  }, ASSEMBLY_TIMEOUT_MS);

  it("board import: exactly at the board cap passes, one past it is rejected", async () => {
    const withLabels = (count: number): Record<string, unknown> => {
      const document = exportDocument(1);
      const habitat = document.habitat as { missions: { labels: string[] }[] };
      habitat.missions[0]!.labels = strings(count);
      return document;
    };

    const atCap = await post("/api/v1/habitats/import", withLabels(BOARD_CAP));
    expect(atCap.statusCode).toBe(201);

    const over = await post("/api/v1/habitats/import", withLabels(BOARD_CAP + 1));
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: OVER_BOARD_CAP, code: VALIDATION_ERROR });

    const replacingAtCap = await post(
      `/api/v1/habitats/${habitatId}/import`,
      await replacementExport(strings(BOARD_CAP)),
    );
    expect(replacingAtCap.statusCode).toBe(201);

    const replacingOver = await post(
      `/api/v1/habitats/${habitatId}/import`,
      await replacementExport(strings(BOARD_CAP + 1)),
    );
    expect(replacingOver.statusCode).toBe(400);
    expect(replacingOver.json()).toEqual({ error: OVER_BOARD_CAP, code: VALIDATION_ERROR });
  }, ASSEMBLY_TIMEOUT_MS);

  it("workflow routes: a DAG larger than the default cap attaches; at the board cap passes, one past it is rejected", async () => {
    // One gate per dependency edge: more edges than the default cap allows,
    // attached in one request and written for real.
    const dag = await missionWithTasks("DAG mission", 2);
    const gate = (taskIds: string[]) => ({
      upstreamTaskKey: taskIds[0],
      downstreamTaskKey: taskIds[1],
      gateType: "on_complete",
    });
    const attached = await post(`/api/v1/missions/${dag.missionId}/workflow`, {
      definition: { gates: Array.from({ length: CAP + 1 }, () => gate(dag.taskIds)) },
    });
    expect(attached.statusCode).toBe(201);

    // One join spec per task key, on the workflow the DAG just created.
    const workflow = (attached.json() as { workflow: { id: string; version: number } }).workflow;
    const joinSpecs = (count: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`key-${i}`, { mode: "all_of" }]));
    const patched = await app.inject({
      method: "PATCH",
      url: `/api/v1/workflows/${workflow.id}`,
      headers: auth,
      payload: { expectedVersion: workflow.version, joinSpecs: joinSpecs(BOARD_CAP) },
    });
    expect(patched.statusCode).toBe(200);
    const overPatched = await app.inject({
      method: "PATCH",
      url: `/api/v1/workflows/${workflow.id}`,
      headers: auth,
      payload: { expectedVersion: workflow.version, joinSpecs: joinSpecs(BOARD_CAP + 1) },
    });
    expect(overPatched.statusCode).toBe(400);
    expect(overPatched.json()).toEqual({ error: OVER_BOARD_CAP, code: VALIDATION_ERROR });

    // The attach route's own boundary, on its cheapest collection.
    const small = await missionWithTasks("Two-gate mission", 2);
    const variables = (count: number) =>
      Array.from({ length: count }, (_, i) => ({ key: `variable-${i}`, description: "" }));
    const definition = (count: number) => ({
      gates: [gate(small.taskIds)],
      variables: variables(count),
    });
    const atCap = await post(`/api/v1/missions/${small.missionId}/workflow`, {
      definition: definition(BOARD_CAP),
    });
    expect(atCap.statusCode).toBe(201);

    const over = await post(`/api/v1/missions/${small.missionId}/workflow`, {
      definition: definition(BOARD_CAP + 1),
    });
    expect(over.statusCode).toBe(400);
    expect(over.json()).toEqual({ error: OVER_BOARD_CAP, code: VALIDATION_ERROR });
  }, ASSEMBLY_TIMEOUT_MS);

  it("code-evidence link routes: at the cap reaches the handler, one past it is rejected", async () => {
    const commits = (count: number) => Array.from({ length: count }, (_, i) => ({ sha: `s${i}` }));
    const targets = [
      `/api/v1/tasks/${randomUUID()}/code-evidence`,
      `/api/v1/missions/${randomUUID()}/code-evidence`,
    ];
    for (const url of targets) {
      // Past the guard and past the declared schema (every commit validated);
      // the handler then answers for a target that does not exist.
      const atCap = await post(url, { commits: commits(CODE_EVIDENCE_CAP) });
      expect(atCap.statusCode, url).toBe(404);

      const over = await post(url, { commits: commits(CODE_EVIDENCE_CAP + 1) });
      expect(over.statusCode, url).toBe(400);
      expect(over.json(), url).toEqual({
        error: OVER_CODE_EVIDENCE_CAP,
        code: VALIDATION_ERROR,
      });
    }
  }, ASSEMBLY_TIMEOUT_MS);
});
