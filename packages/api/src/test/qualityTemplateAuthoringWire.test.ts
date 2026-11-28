/**
 * Quality checklist template authoring — REAL HTTP wire on BOTH served
 * prefixes (`/api/v1`, deprecated `/api`) over the sql.js test DB shared with
 * the in-process app. No inject, no route mocks; the write fault is a real
 * statement trigger (issue #326).
 *
 * Claims:
 *  - the whole body is validated at the served boundary: an invalid later
 *    item is 400 VALIDATION_ERROR naming the failing item;
 *  - a refused or failed create leaves no template and no items, so a later
 *    ordinarily started Task adopts nothing from it;
 *  - a valid create persists in order and still attaches when a Task starts
 *    (the existing required-template snapshot).
 *
 * Disclosed limit: adoption is observed through the started Task's quality
 * report and the persisted template rows; `ensureTaskChecklists` itself is
 * not instrumented.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import net from "node:net";
import jwt from "jsonwebtoken";
import { eq, sql } from "drizzle-orm";
import { createHttpApplication, type HttpRuntimeHandle } from "../httpApp.js";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/taskCrud.js";
import * as agentRepo from "../repositories/agent.js";
import * as pluginManager from "../plugins/pluginManager.js";
import { qualityChecklistTemplates, qualityChecklistItems } from "../db/schema/index.js";
import { getJwtSecret } from "../middleware/jwt-verification.js";

const PREFIXES = ["/api/v1", "/api"] as const;
type Prefix = (typeof PREFIXES)[number];
const TEMPLATES = "/quality/templates";

/**
 * Deterministic post-validation write fault. The SECOND item's INSERT aborts
 * only AFTER the template row and the first item exist in the same
 * transaction; reached without that prior work it aborts with the stage
 * marker instead, so a pass cannot come from a fault firing too early.
 */
const ITEM_FAULT = "qta_second_item_fault";
const ITEM_FAULT_SQL = `CREATE TRIGGER ${ITEM_FAULT} BEFORE INSERT ON quality_checklist_items
WHEN NEW.order_index = 1 BEGIN
  SELECT RAISE(ABORT, CASE
    WHEN EXISTS (SELECT 1 FROM quality_checklist_templates WHERE id = NEW.template_id)
     AND EXISTS (SELECT 1 FROM quality_checklist_items WHERE template_id = NEW.template_id AND order_index = 0)
    THEN 'item storage unavailable' ELSE 'incorrect fault stage' END);
END`;

let app: HttpRuntimeHandle;
let baseUrl: string;
let habitatId: string;
let columnId: string;
let serial = 0;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function wire(
  prefix: string,
  method: string,
  path: string,
  opts: { token?: string; agentKey?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
  if (opts.agentKey) headers["X-Agent-API-Key"] = opts.agentKey;
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`${baseUrl}${prefix}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
}

// Fresh token per call: the pre-auth rate limiter buckets by credential
// string (60/min) and every human call here shares one subject.
function humanJwt(): string {
  return jwt.sign(
    { sub: "qta-human", username: "qta-human", role: "admin", jti: Math.random().toString(36).slice(2) },
    getJwtSecret(),
    { expiresIn: "1h", issuer: "orcy" },
  );
}
const createTemplate = (prefix: Prefix, body: unknown) =>
  wire(prefix, "POST", TEMPLATES, { token: humanJwt(), body });

/** Every persisted template as `Name [item titles]` — the exact state a refused or failed create must leave unchanged. */
function savedTemplates(): string[] {
  const db = getDb();
  return db
    .select({ id: qualityChecklistTemplates.id, name: qualityChecklistTemplates.name })
    .from(qualityChecklistTemplates)
    .all()
    .map(
      (t) =>
        `${t.name} [${db
          .select({ title: qualityChecklistItems.title })
          .from(qualityChecklistItems)
          .where(eq(qualityChecklistItems.templateId, t.id))
          .all()
          .map((i) => i.title)
          .join(", ")}]`,
    );
}

function savedItems(templateName: string) {
  return getDb()
    .select({
      title: qualityChecklistItems.title,
      description: qualityChecklistItems.description,
      required: qualityChecklistItems.required,
      orderIndex: qualityChecklistItems.orderIndex,
    })
    .from(qualityChecklistItems)
    .innerJoin(qualityChecklistTemplates, eq(qualityChecklistItems.templateId, qualityChecklistTemplates.id))
    .where(eq(qualityChecklistTemplates.name, templateName))
    .all();
}

/** An ordinary Task start through the real routes: the agent claims, then starts. Returns the template names the started Task adopted. */
async function startTaskOrdinarily(title: string): Promise<string[]> {
  const mission = missionRepo.createMission({ habitatId, columnId, title, createdBy: "qta-seed" });
  const taskId = taskRepo.createTask({ missionId: mission.id, title, createdBy: "qta-seed" }).id;
  const { plainApiKey: agentKey } = agentRepo.createAgent({
    name: `qta-agent-${++serial}`,
    type: "claude-code",
    domain: "fullstack",
    capabilities: [],
  });
  const claim = await wire("/api/v1", "POST", `/tasks/${taskId}/claim`, { agentKey, body: {} });
  expect(claim.status).toBe(200);
  const start = await wire("/api/v1", "POST", `/tasks/${taskId}/start`, {
    agentKey,
    body: { executionToken: claim.body.task.executionToken },
  });
  expect(start.status).toBe(200);
  const report = await wire("/api/v1", "GET", `/tasks/${taskId}/quality-checklist`, { agentKey });
  expect(report.status).toBe(200);
  return report.body.checklists.map((c: { templateName: string }) => c.templateName);
}

/**
 * [label, body patch, `details.fieldErrors` key, expected message prefix].
 * The first six are the issue's scenario — a valid first item, then an
 * invalid LATER item; the rest are invalid top-level fields.
 */
const INVALID_INPUTS: [string, Record<string, unknown>, string, string][] = [
  ["missing title", { items: [{ title: "First" }, { description: "no title" }] }, "items", "items.1.title: "],
  ["null title", { items: [{ title: "First" }, { title: null }] }, "items", "items.1.title: "],
  ["non-string title", { items: [{ title: "First" }, { title: 42 }] }, "items", "items.1.title: "],
  ["empty title", { items: [{ title: "First" }, { title: "" }] }, "items", "items.1.title: "],
  [
    "non-string description",
    { items: [{ title: "First" }, { title: "Second", description: 42 }] },
    "items",
    "items.1.description: ",
  ],
  [
    "non-boolean required",
    { items: [{ title: "First" }, { title: "Second", required: "no" }] },
    "items",
    "items.1.required: ",
  ],
  ["empty items", { items: [] }, "items", "items: "],
  ["non-array items", { items: "abc" }, "items", "items: "],
  ["empty name", { name: "", items: [{ title: "Only" }] }, "name", "name: "],
  ["non-string category", { category: 7, items: [{ title: "Only" }] }, "category", "category: "],
  ["non-boolean isRequired", { isRequired: "false", items: [{ title: "Only" }] }, "isRequired", "isRequired: "],
];

beforeAll(async () => {
  await initTestDb();
  app = await createHttpApplication({ logger: false });
  await app.installPluginRoutes(pluginManager.getPluginRouteCatalog());
  await app.finalize();
  const port = await freePort();
  await app.listen({ port, host: "127.0.0.1" });
  baseUrl = `http://127.0.0.1:${port}`;
  habitatId = habitatRepo.createHabitat({ name: "qta-habitat" }).id;
  columnId = columnRepo.createColumn({ habitatId, name: "Todo", order: 0, requiresClaim: false }).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  closeDb();
});

describe.each(PREFIXES)("POST %s/quality/templates", (prefix) => {
  it("refuses invalid input as 400 naming the failing field, saves nothing, and a later Task start adopts nothing", async () => {
    const before = savedTemplates();
    const rejected: string[] = [];
    for (const [label, patch, field, messagePrefix] of INVALID_INPUTS) {
      const name = `qta-invalid ${++serial} ${label}`;
      rejected.push(name);
      const res = await createTemplate(prefix, { name, category: "testing", ...patch });
      // State before status: the defect is the partial save, not the code.
      expect(savedTemplates(), label).toEqual(before);
      expect(res.status, label).toBe(400);
      expect(res.body.code, label).toBe("VALIDATION_ERROR");
      expect(res.body.details, label).toEqual({
        formErrors: [],
        fieldErrors: { [field]: [expect.stringContaining(messagePrefix)] },
      });
    }

    const listed = await wire(prefix, "GET", TEMPLATES, { token: humanJwt() });
    expect(listed.status).toBe(200);
    expect(listed.body.templates.map((t: { name: string }) => t.name)).toEqual(
      expect.not.arrayContaining(rejected),
    );
    expect(await startTaskOrdinarily("qta-after-invalid")).toEqual(expect.not.arrayContaining(rejected));
  });

  it("leaves no template or items when a later item write fails after earlier writes", async () => {
    const before = savedTemplates();
    const name = `qta-fault ${++serial}`;
    getDb().run(sql.raw(ITEM_FAULT_SQL));
    try {
      const res = await createTemplate(prefix, {
        name,
        category: "testing",
        items: [{ title: "First" }, { title: "Second" }],
      });
      expect(savedTemplates()).toEqual(before);
      expect(res.status).toBe(500);
      expect(res.body.code).toBe("REPOSITORY_ERROR");
      expect(res.body.details).toMatchObject({ entity: "qualityChecklistItem", operation: "create" });
      // The fault fired at its stage: after the template and the first item.
      expect(JSON.stringify(res.body.details)).toContain("item storage unavailable");
    } finally {
      getDb().run(sql.raw(`DROP TRIGGER ${ITEM_FAULT}`));
    }
    expect(await startTaskOrdinarily("qta-after-fault")).not.toContain(name);
  });

  it("persists a valid two-item template in order and attaches it when a Task starts", async () => {
    const name = `qta-valid ${++serial}`;
    const res = await createTemplate(prefix, {
      name,
      category: "code_quality",
      // Omitted and null optional fields both take their defaults.
      description: null,
      isRequired: null,
      items: [{ title: "First", required: null }, { title: "Second", description: "optional", required: false }],
    });
    expect(res.status).toBe(200);
    expect(res.body.template).toMatchObject({ name, category: "code_quality", description: "", isRequired: true });
    expect(savedItems(name)).toEqual([
      { title: "First", description: "", required: true, orderIndex: 0 },
      { title: "Second", description: "optional", required: false, orderIndex: 1 },
    ]);
    const listed = await wire(prefix, "GET", TEMPLATES, { token: humanJwt() });
    expect(listed.body.templates.map((t: { name: string }) => t.name)).toContain(name);
    expect(await startTaskOrdinarily("qta-after-valid")).toContain(name);
  });

  it("keeps an optional template out of the Task-start snapshot", async () => {
    const name = `qta-optional ${++serial}`;
    const res = await createTemplate(prefix, { name, category: "testing", isRequired: false, items: [{ title: "Only" }] });
    expect(res.status).toBe(200);
    expect(res.body.template.isRequired).toBe(false);
    expect(await startTaskOrdinarily("qta-after-optional")).not.toContain(name);
  });

  it("admits humans only, and a refused caller saves nothing", async () => {
    const before = savedTemplates();
    const body = { name: `qta-refused ${++serial}`, category: "testing", items: [{ title: "Only" }] };
    const agent = agentRepo.createAgent({
      name: `qta-agent-${++serial}`,
      type: "claude-code",
      domain: "fullstack",
      capabilities: [],
    });
    const anonymous = await wire(prefix, "POST", TEMPLATES, { body });
    const asAgent = await wire(prefix, "POST", TEMPLATES, { agentKey: agent.plainApiKey, body });
    expect([anonymous.status, asAgent.status]).toEqual([401, 401]);
    expect(savedTemplates()).toEqual(before);
  });
});
