/**
 * Learning Loop agent MCP read surface — production dispatch integration test.
 *
 * Exercises the REAL REST route path that the `orcy_learning` MCP dispatch tool
 * calls through: agent-authenticated HTTP → Zod validation → REST handler →
 * actor-bound repository predicate → real DB. Proves every acceptance gate
 * through the production surface, not only API helpers.
 *
 * Gates:
 * 1. Exact Task/Mission/domain-scoped findings appear.
 * 2. Cross-Habitat active work cannot query another Habitat.
 * 3. Reassignment/terminalization before the SELECT removes access.
 * 4. Direct get does not reveal whether a denied finding exists.
 * 5. Limit and character caps hold.
 * 6. Aggregate-only findings excluded (predicate filters visibility_ceiling).
 * 7. Schema exposes no mutating action (verified in MCP dispatch test).
 * 8. This test IS the production dispatch integration proof.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from "fastify-type-provider-zod";
import { v4 as uuid } from "uuid";
import { eq } from "drizzle-orm";
import { createHash } from "crypto";
import type {
  ExtractionFindingType,
  ExtractionFindingCompleteness,
  ExtractionVisibilityClass,
  ExtractionFindingStatus,
  ExtractionScopeType,
} from "@orcy/shared";
import { initTestDb, closeDb, getDb } from "../db/index.js";
import { registerErrorHandler } from "../errors/plugin.js";
import { extractionRoutes } from "../routes/extraction.js";
import { getAdapter } from "../services/extractionSourceCatalog/index.js";

function hashApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}
import {
  habitats,
  columns,
  missions,
  tasks,
  agents,
  extractedFindings,
  extractedFindingSources,
  extractedFindingScopeRefs,
  taskEvents,
} from "../db/schema/index.js";

// ---------------------------------------------------------------------------
// Fixture helpers (mirrors extractionReviewAuthorization.test.ts patterns)
// ---------------------------------------------------------------------------

interface HabitatFixture {
  habitatId: string;
  columnId: string;
  missionId: string;
  agentId: string;
  apiKey: string;
  taskId: string;
  requiredDomain: string | null;
}

function setupHabitat(opts: {
  id: string;
  agentName: string;
  apiKey?: string;
  taskStatus: "pending" | "claimed" | "in_progress" | "submitted" | "approved" | "rejected" | "done" | "failed";
  requiredDomain?: string | null;
}): HabitatFixture {
  const db = getDb();
  const habitatId = opts.id;
  const columnId = `col-${habitatId}`;
  const missionId = `mis-${habitatId}`;
  const agentId = `agt-${habitatId}`;
  const apiKey = opts.apiKey ?? `key-${agentId}`;
  const taskId = `task-${habitatId}`;

  db.insert(habitats).values({ id: habitatId, name: habitatId }).run();
  db.insert(columns).values({ id: columnId, habitatId, name: "Todo", order: 0 }).run();
  db.insert(missions).values({
    id: missionId, habitatId, columnId, title: `Mission ${habitatId}`, createdBy: "test",
  }).run();
  db.insert(agents).values({
    id: agentId, name: opts.agentName, type: "claude-code", domain: "general",
    apiKey: hashApiKey(apiKey), // Store the SHA-256 hash — getAgentByApiKey hashes the incoming key.
  }).run();
  db.insert(tasks).values({
    id: taskId, missionId, title: `Task ${habitatId}`,
    assignedAgentId: agentId, status: opts.taskStatus,
    requiredDomain: opts.requiredDomain ?? null, createdBy: "test",
  }).run();

  return { habitatId, columnId, missionId, agentId, apiKey, taskId, requiredDomain: opts.requiredDomain ?? null };
}

function insertFinding(opts: {
  habitatId: string;
  status?: ExtractionFindingStatus;
  completeness?: ExtractionFindingCompleteness;
  visibilityCeiling?: ExtractionVisibilityClass;
  scopeRefs?: Array<{ scopeType: ExtractionScopeType; scopeId: string }>;
  findingType?: ExtractionFindingType;
  subject?: string;
  body?: string;
  structuredPayload?: unknown;
  caveats?: string[];
  /** Task ID to create a resolvable task-lifecycle citation. Required for findings that should pass citation re-resolution. */
  resolvableTaskId?: string;
}): string {
  const db = getDb();
  const findingId = uuid();
  const now = new Date().toISOString();
  const attemptId = `att-${uuid()}`;

  db.insert(extractedFindings).values({
    id: findingId,
    habitatId: opts.habitatId,
    firstAttemptId: attemptId,
    lastSeenAttemptId: attemptId,
    lineageRootId: findingId,
    supersedesFindingId: null,
    revision: 1,
    extractorKey: "test_extractor",
    extractorVersion: 1,
    findingType: opts.findingType ?? "lesson",
    subject: opts.subject ?? "Test finding",
    body: opts.body ?? "Test body",
    structuredPayload: opts.structuredPayload ?? null,
    confidence: 0.85,
    sampleSize: 10,
    completeness: opts.completeness ?? "complete",
    visibilityCeiling: opts.visibilityCeiling ?? "habitat_member",
    fingerprint: `fp-${uuid()}`,
    evidenceDigest: `ed-${uuid()}`,
    status: opts.status ?? "accepted",
    decisionVersion: 1,
    firstSeenAt: now,
    lastSeenAt: now,
    occurrenceCount: 1,
    caveats: opts.caveats ?? [],
  }).run();

  // B1 fix: create a resolvable task-lifecycle citation so the finding
  // passes citation re-resolution through the service path.
  if (opts.resolvableTaskId) {
    const eventId = uuid();
    const sourceRowId = uuid();
    db.insert(taskEvents).values({
      id: eventId, taskId: opts.resolvableTaskId,
      actorType: "human", actorId: "test-user",
      action: "created", timestamp: now,
    }).run();
    db.insert(extractedFindingSources).values({
      id: sourceRowId, findingId, sourceType: "task_lifecycle_audit",
      sourceId: `task_event:${eventId}`, sourceVersion: "v1", role: "supporting",
      sourceDigest: "digest", occurredAt: now,
      entityRefs: [{ type: "task", id: opts.resolvableTaskId }],
      completeness: "complete", visibilityClass: "habitat_member",
    }).run();

    // Also insert scope refs if provided.
    if (opts.scopeRefs) {
      for (const ref of opts.scopeRefs) {
        db.insert(extractedFindingScopeRefs).values({
          id: uuid(), findingId,
          scopeType: ref.scopeType,
          scopeId: ref.scopeId, derivedFromSourceId: sourceRowId,
        }).run();
      }
    }
  } else if (opts.scopeRefs) {
    // No resolvable task ID — create unresolvable citations (source rows
    // without matching task events). These will resolve as "dangling" and
    // block the finding from agent reads through the service path.
    for (const ref of opts.scopeRefs) {
      const sourceRowId = uuid();
      db.insert(extractedFindingSources).values({
        id: sourceRowId, findingId, sourceType: "task_lifecycle_audit",
        sourceId: `task_event:nonexistent-${uuid()}`, sourceVersion: "v1", role: "supporting",
        sourceDigest: "digest", occurredAt: now,
        entityRefs: [{ type: "task", id: ref.scopeId }],
        completeness: "complete", visibilityClass: "habitat_member",
      }).run();
      db.insert(extractedFindingScopeRefs).values({
        id: uuid(), findingId,
        scopeType: ref.scopeType,
        scopeId: ref.scopeId, derivedFromSourceId: sourceRowId,
      }).run();
    }
  }

  return findingId;
}

function updateTask(taskId: string, updates: Record<string, unknown>): void {
  getDb().update(tasks).set(updates).where(eq(tasks.id, taskId)).run();
}

// ---------------------------------------------------------------------------
// Fastify app builder — registers the real production extraction route plugin
// ---------------------------------------------------------------------------

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: false }).withTypeProvider<ZodTypeProvider>();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await registerErrorHandler(app);
  await app.register(extractionRoutes);
  await app.ready();
  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Learning Loop agent MCP read surface — production dispatch integration", () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    await initTestDb();
    app = await buildApp();
  });
  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
    closeDb();
  });

  // -------------------------------------------------------------------------
  // Gate 1: Exact scope match appears
  // -------------------------------------------------------------------------

  it("gate 1: task-scoped finding appears in list_accepted", async () => {
    const fix = setupHabitat({ id: "hab-A", agentName: "Agent A", taskStatus: "claimed" });
    const findingId = insertFinding({
      habitatId: fix.habitatId,
      subject: "Use pnpm",
      body: "Always use pnpm not npm",
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].id).toBe(findingId);
    expect(body.findings[0].subject).toBe("Use pnpm");
    expect(body.findings[0].citationCount).toBe(1);
    // No raw sources or audit history exposed.
    expect(body.findings[0]).not.toHaveProperty("sources");
    expect(body.findings[0]).not.toHaveProperty("auditHistory");
  });

  it("gate 1: mission-scoped finding appears via task's mission", async () => {
    const fix = setupHabitat({ id: "hab-B", agentName: "Agent B", taskStatus: "in_progress" });
    insertFinding({
      habitatId: fix.habitatId,
      resolvableTaskId: fix.taskId,
      scopeRefs: [{ scopeType: "mission", scopeId: fix.missionId }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).findings).toHaveLength(1);
  });

  it("gate 1: domain-scoped finding appears when task has requiredDomain", async () => {
    const fix = setupHabitat({
      id: "hab-C", agentName: "Agent C", taskStatus: "submitted", requiredDomain: "backend",
    });
    insertFinding({
      habitatId: fix.habitatId,
      resolvableTaskId: fix.taskId,
      scopeRefs: [{ scopeType: "domain", scopeId: "backend" }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).findings).toHaveLength(1);
  });

  // -------------------------------------------------------------------------
  // Gate 1 (negative): Unscoped, mismatched findings reveal nothing
  // -------------------------------------------------------------------------

  it("gate 1-negative: unscoped finding returns nothing for agents", async () => {
    const fix = setupHabitat({ id: "hab-D", agentName: "Agent D", taskStatus: "claimed" });
    insertFinding({ habitatId: fix.habitatId }); // no scope refs

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).findings).toHaveLength(0);
  });

  it("gate 1-negative: wrong task scope returns nothing", async () => {
    const fix = setupHabitat({ id: "hab-E", agentName: "Agent E", taskStatus: "claimed" });
    insertFinding({
      habitatId: fix.habitatId,
      resolvableTaskId: fix.taskId,
      scopeRefs: [{ scopeType: "task", scopeId: "wrong-task" }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(JSON.parse(res.body).findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Gate 2: Cross-Habitat denial
  // -------------------------------------------------------------------------

  it("gate 2: cross-habitat query reveals nothing", async () => {
    const fixA = setupHabitat({ id: "hab-X", agentName: "Agent X", taskStatus: "claimed" });
    const fixB = setupHabitat({ id: "hab-Y", agentName: "Agent Y", taskStatus: "claimed" });
    // Finding in habitat Y, scoped to Y's task.
    insertFinding({
      habitatId: fixB.habitatId,
      resolvableTaskId: fixB.taskId,
      scopeRefs: [{ scopeType: "task", scopeId: fixB.taskId }],
    });

    // Agent X queries habitat Y — should get nothing.
    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fixB.habitatId}/extraction/agent/findings?taskId=${fixA.taskId}`,
      headers: { "x-agent-api-key": fixA.apiKey },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Gate 3: Reassignment/terminalization before SELECT removes access
  // -------------------------------------------------------------------------

  it("gate 3: reassignment before read removes access", async () => {
    const fix = setupHabitat({ id: "hab-R", agentName: "Agent R", taskStatus: "claimed" });
    insertFinding({
      habitatId: fix.habitatId,
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    // Create a second agent and reassign the task to them.
    getDb().insert(agents).values({
      id: "agt-other-R", name: "Other Agent", type: "claude-code", domain: "general",
      apiKey: hashApiKey("key-other-R"),
    }).run();
    updateTask(fix.taskId, { assignedAgentId: "agt-other-R" });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).findings).toHaveLength(0);
  });

  it("gate 3: terminalization (done) before read removes access", async () => {
    const fix = setupHabitat({ id: "hab-T", agentName: "Agent T", taskStatus: "claimed" });
    insertFinding({
      habitatId: fix.habitatId,
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    // Terminalize the task.
    updateTask(fix.taskId, { status: "done" });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).findings).toHaveLength(0);
  });

  // -------------------------------------------------------------------------
  // Gate 4: Direct get denial doesn't leak existence
  // -------------------------------------------------------------------------

  it("gate 4: direct get of denied finding returns identical 404 (no existence leak)", async () => {
    const fix = setupHabitat({ id: "hab-G", agentName: "Agent G", taskStatus: "claimed" });
    // Finding exists but is scoped to a different task.
    const deniedFindingId = insertFinding({
      habitatId: fix.habitatId,
      resolvableTaskId: fix.taskId,
      scopeRefs: [{ scopeType: "task", scopeId: "other-task" }],
    });
    // Non-existent finding.
    const nonexistentId = uuid();

    const resDenied = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings/${deniedFindingId}?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });
    const resNonexistent = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings/${nonexistentId}?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    // Both must return the same status and error shape.
    expect(resDenied.statusCode).toBe(resNonexistent.statusCode);
    expect(JSON.parse(resDenied.body).error ?? JSON.parse(resDenied.body).message).toEqual(
      JSON.parse(resNonexistent.body).error ?? JSON.parse(resNonexistent.body).message,
    );
  });

  it("gate 4-positive: direct get of authorized finding returns detail", async () => {
    const fix = setupHabitat({ id: "hab-GP", agentName: "Agent GP", taskStatus: "claimed" });
    const findingId = insertFinding({
      habitatId: fix.habitatId,
      subject: "Authorized finding",
      body: "Detail body",
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings/${findingId}?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.finding.id).toBe(findingId);
    expect(body.finding.subject).toBe("Authorized finding");
    expect(body.finding.occurrenceCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // Gate 5: Limit and character caps hold
  // -------------------------------------------------------------------------

  it("gate 5: production route rejects limits above 25 and accepts the hard cap", async () => {
    const fix = setupHabitat({ id: "hab-L", agentName: "Agent L", taskStatus: "claimed" });
    // Insert 30 findings.
    for (let i = 0; i < 30; i++) {
      insertFinding({
        habitatId: fix.habitatId,
        scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
        subject: `Finding ${i}`,
      });
    }

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}&limit=100`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(400);

    const capped = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}&limit=25`,
      headers: { "x-agent-api-key": fix.apiKey },
    });
    expect(capped.statusCode).toBe(200);
    expect(JSON.parse(capped.body).findings.length).toBeLessThanOrEqual(25);
  });

  it("gate 5: maxChars truncates subject and body", async () => {
    const fix = setupHabitat({ id: "hab-MC", agentName: "Agent MC", taskStatus: "claimed" });
    const longSubject = "A".repeat(500);
    const longBody = "B".repeat(500);
    insertFinding({
      habitatId: fix.habitatId,
      subject: longSubject,
      body: longBody,
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}&maxChars=50`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.findings[0].subject.length).toBeLessThanOrEqual(50);
    expect(body.findings[0].body.length).toBeLessThanOrEqual(50);
  });

  // -------------------------------------------------------------------------
  // Gate 6: Aggregate-only findings excluded (predicate filters visibility_ceiling)
  // -------------------------------------------------------------------------

  it("gate 6: aggregate_only findings are excluded from agent results", async () => {
    const fix = setupHabitat({ id: "hab-AO", agentName: "Agent AO", taskStatus: "claimed" });
    // Insert an aggregate_only finding with task scope ref.
    insertFinding({
      habitatId: fix.habitatId,
      visibilityCeiling: "aggregate_only",
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });
    // Insert a normal habitat_member finding with task scope ref.
    const normalFindingId = insertFinding({
      habitatId: fix.habitatId,
      visibilityCeiling: "habitat_member",
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    // Only the habitat_member finding appears; aggregate_only is excluded.
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0].id).toBe(normalFindingId);
  });

  it("gate 6: no contributor/source drill-down in summary fields", async () => {
    const fix = setupHabitat({ id: "hab-ND", agentName: "Agent ND", taskStatus: "claimed" });
    insertFinding({
      habitatId: fix.habitatId,
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    const finding = JSON.parse(res.body).findings[0];
    // Bounded summary fields only — no raw source/citation drill-down.
    expect(finding).not.toHaveProperty("sources");
    expect(finding).not.toHaveProperty("citations");
    expect(finding).not.toHaveProperty("auditHistory");
    expect(finding).not.toHaveProperty("reviewHistory");
    // Citation count is a number, not a drill-down.
    expect(typeof finding.citationCount).toBe("number");
  });

  // -------------------------------------------------------------------------
  // Gate 8: Auth required (no header = 401)
  // -------------------------------------------------------------------------

  it("gate 8: rejects request without agent API key", async () => {
    const fix = setupHabitat({ id: "hab-AU", agentName: "Agent AU", taskStatus: "claimed" });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
    });

    expect(res.statusCode).toBe(401);
  });

  // -------------------------------------------------------------------------
  // I1: Direct agent get output is bounded (subject + body ≤ total budget)
  // -------------------------------------------------------------------------

  it("I1: get endpoint bounds subject+body to total budget (default 4000)", async () => {
    const fix = setupHabitat({ id: "hab-I1", agentName: "Agent I1", taskStatus: "claimed" });
    const longSubject = "S".repeat(3000);
    const longBody = "B".repeat(3000);
    const findingId = insertFinding({
      habitatId: fix.habitatId,
      subject: longSubject,
      body: longBody,
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings/${findingId}?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    const finding = body.finding;

    // I1 fix: subject + body combined must be ≤ DEFAULT_TOTAL_CHAR_BUDGET (4000).
    expect(finding.subject.length + finding.body.length).toBeLessThanOrEqual(4000);
  });

  it("I1: get endpoint budgets caveats and structured payload within the serialized response", async () => {
    const fix = setupHabitat({ id: "hab-I1b", agentName: "Agent I1b", taskStatus: "claimed" });
    const findingId = insertFinding({
      habitatId: fix.habitatId,
      subject: "S".repeat(3000),
      body: "B".repeat(3000),
      caveats: ["C".repeat(12_000)],
      structuredPayload: {
        nested: { value: "P".repeat(12_000) },
      },
      resolvableTaskId: fix.taskId,
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
    });

    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings/${findingId}?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    expect(() => JSON.parse(res.body)).not.toThrow();
    expect(res.body.length).toBeLessThanOrEqual(4000);
  });

  // -------------------------------------------------------------------------
  // B1: Citation re-resolution through the real service path
  // -------------------------------------------------------------------------

  it("B1: degraded citation excludes finding from agent list (real service path)", async () => {
    const fix = setupHabitat({ id: "hab-B1", agentName: "Agent B1", taskStatus: "claimed" });
    const findingId = insertFinding({
      habitatId: fix.habitatId,
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    // Degrade the citation: change the sourceId to something that won't resolve.
    const db = getDb();
    db.update(extractedFindingSources)
      .set({ sourceId: "degraded-nonexistent" })
      .where(eq(extractedFindingSources.findingId, findingId))
      .run();

    // B1 fix: the service re-resolves citations. A degraded citation
    // blocks the finding from agent reads.
    const res = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.findings).toHaveLength(0);
  });

  it("B1: adapter omission excludes the finding through the real extraction route", async () => {
    const fix = setupHabitat({ id: "hab-B1-omit", agentName: "Agent B1 omit", taskStatus: "claimed" });
    const findingId = insertFinding({
      habitatId: fix.habitatId,
      scopeRefs: [{ scopeType: "task", scopeId: fix.taskId }],
      resolvableTaskId: fix.taskId,
    });

    const adapter = getAdapter("task_lifecycle_audit");
    vi.spyOn(adapter, "resolveByRefs").mockReturnValue([]);

    const list = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });
    const get = await app.inject({
      method: "GET",
      url: `/habitats/${fix.habitatId}/extraction/agent/findings/${findingId}?taskId=${fix.taskId}`,
      headers: { "x-agent-api-key": fix.apiKey },
    });

    expect(list.statusCode).toBe(200);
    expect(JSON.parse(list.body).findings).toHaveLength(0);
    expect(get.statusCode).toBe(404);
  });
});
