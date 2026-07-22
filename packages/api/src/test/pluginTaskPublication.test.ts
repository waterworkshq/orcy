/**
 * T8B Phase 2 — Plugin `taskWriter.createTask` producer migration guardrail
 * tests.
 *
 * The plugin `createTask` (`plugins/context.ts:buildTaskWriter`) routes through
 * the Story-1 kernel chain (reserve → prepare → govern → publish) with a fresh
 * `plugin_run` causal root + server-constructed provenance.
 *
 * This suite is the SOLE exerciser until T11 cutover. Each test maps 1:1 to a
 * guardrail named in the T8B P2 ticket:
 *
 *   - **Scope/cap preserved:** the publication path still enforces `checkCap`
 *     (write-cap exceeded → throw) + the habitat-scope check (cross-habitat
 *     mission → throw; no habitat context → throw).
 *   - **Published Task:** `created` event + `POST_CUTOVER` + governance (first
 *     time for plugin-created Tasks). Restricted fields only (labels/priority
 *     carried; no execution-history).
 *   - **Plugin Run provenance persisted:** the committed envelope carries
 *     `causalContext.root = {type:"plugin_run", id:<runId>}` (NOT just logged).
 *   - **Replay:** same-`(runId, actionKey)` → replays (no duplicate Task).
 *   - **Vetoed → throw:** an enrolled `taskCreated` interceptor vetoing → the
 *     publication fails → the plugin `createTask` throws (the plugin contract).
 *   - **No inherited causal chain:** the plugin's envelope has a fresh root
 *     (no hops from an automation chain). `hops` is absent.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { eq } from "drizzle-orm";
import { closeDb, getDb, initTestDb } from "../db/index.js";
import { tasks, taskEvents, taskCreationEnvelopes } from "../db/schema/index.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import { buildPluginContext } from "../plugins/context.js";
import { publishPluginTask } from "../services/pluginTaskPublication.js";
import { TASK_CREATION_INTEGRITY_VERSION } from "../db/schema/taskPublication.js";
import type { CausalContext } from "@orcy/shared";

// --- Mocks: the adapter composes the kernel, which emits NO pre-commit
//     effects. Assert the plugin path never reaches the broadcaster. ---
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
let habitatId: string;
let columnId: string;
let missionId: string;

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  const habitat = habitatRepo.createHabitat({ name: "T8B-P2 Habitat" });
  habitatId = habitat.id;
  const column = columnRepo.createColumn({
    habitatId,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  columnId = column.id;
  missionId = missionRepo.createMission({
    habitatId,
    columnId,
    title: "t8b-p2-mission",
    createdBy: "test",
  }).id;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
  delete process.env.ORCY_PLUGIN_WRITE_CAP;
  closeDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Builds a plugin context with `taskWriter` required (the createTask surface). */
function buildWriterCtx(
  opts: {
    pluginId?: string;
    runId?: string;
    /** Pass `null` explicitly to exercise the no-habitat guard. */
    habitatId?: string | null;
  } = {},
) {
  // Distinguish an explicit `null` habitatId from an omitted field — `??`
  // would collapse `null` back to the fixture default.
  const ctxHabitatId = opts.habitatId === undefined ? habitatId : opts.habitatId;
  return buildPluginContext({
    pluginId: opts.pluginId ?? "test-plugin",
    contributionId: "task-writer",
    habitatId: ctxHabitatId,
    runId: opts.runId ?? `run-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    requires: ["taskWriter"],
  });
}

/** Reads the committed envelope row for a taskId. */
function envelopeForTask(taskId: string) {
  return getDb()
    .select()
    .from(taskCreationEnvelopes)
    .where(eq(taskCreationEnvelopes.taskId, taskId))
    .all()[0];
}

/** Returns the count of `tasks` rows for the seeded mission. */
function missionTaskCount(): number {
  return getDb().select().from(tasks).where(eq(tasks.missionId, missionId)).all().length;
}

/** Writes a plugin module to a tmp dir + loads it (for interceptor enrollment). */
async function writePlugin(name: string, moduleBody: string): Promise<void> {
  const { mkdir, writeFile } = await import("node:fs/promises");
  const tmpDir = `/tmp/test-t8b-p2-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
}

/** Enrolls a `taskCreated` lifecycle interceptor for the habitat. */
function enrollInterceptor(hId: string, pluginId: string, contributionId: string): void {
  enrollmentRepo.create({
    habitatId: hId,
    pluginId,
    contributionId,
    contributionKind: "lifecycleInterceptor",
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(hId);
}

// ===========================================================================
// 1. SCOPE/CAP PRESERVED — the publication path still enforces the plugin-
//    contract guards (write cap + habitat scope) BEFORE composing the kernel.
// ===========================================================================

describe("T8B P2 scope/cap preserved — plugin-contract guards run before publication", () => {
  it("write-cap exceeded → throws (same as legacy)", async () => {
    // Cap = 1: the first createTask consumes the single allotment; the second
    // throws. The env var is read inside buildPluginContext at construction.
    process.env.ORCY_PLUGIN_WRITE_CAP = "1";
    const ctx = buildWriterCtx({ runId: "cap-run" });
    await ctx.taskWriter!.createTask({ missionId, title: "first" });
    await expect(ctx.taskWriter!.createTask({ missionId, title: "second" })).rejects.toThrow(
      /write cap exceeded/i,
    );
  });

  it("cross-habitat mission → throws (same as legacy)", async () => {
    // Create a second habitat + mission; the plugin is bound to the first.
    const other = habitatRepo.createHabitat({ name: "Other Habitat" });
    const otherColumn = columnRepo.createColumn({
      habitatId: other.id,
      name: "Todo",
      order: 0,
      requiresClaim: false,
    });
    const otherMission = missionRepo.createMission({
      habitatId: other.id,
      columnId: otherColumn.id,
      title: "other-mission",
      createdBy: "test",
    }).id;

    const ctx = buildWriterCtx({ habitatId, runId: "xhost-run" });
    await expect(
      ctx.taskWriter!.createTask({ missionId: otherMission, title: "xhost" }),
    ).rejects.toThrow(/does not belong to this habitat/i);
  });

  it("no habitat context → throws (same as legacy)", async () => {
    const ctx = buildWriterCtx({ habitatId: null, runId: "nohab-run" });
    await expect(ctx.taskWriter!.createTask({ missionId, title: "nohab" })).rejects.toThrow(
      /habitat-scoped plugin context/i,
    );
  });
});

// ===========================================================================
// 2. PUBLISHED TASK — `created` event + POST_CUTOVER + restricted fields.
//    The legacy raw-insert produces NONE of these.
// ===========================================================================

describe("T8B P2 published Task — created event + POST_CUTOVER + restricted fields", () => {
  it("commits a plugin Task with exactly one `created` event + POST_CUTOVER + restricted fields", async () => {
    const ctx = buildWriterCtx({ pluginId: "alpha", runId: "pub-run" });
    const before = missionTaskCount();

    const task = await ctx.taskWriter!.createTask({
      missionId,
      title: "Plugin Task",
      description: "from a plugin",
      labels: ["automated", "p2"],
      priority: "high",
    });

    expect(missionTaskCount()).toBe(before + 1);
    expect(task.title).toBe("Plugin Task");
    expect(task.description).toBe("from a plugin");
    expect(task.priority).toBe("high");
    expect(task.labels).toEqual(["automated", "p2"]);
    // Provenance preserved as structured actor identity.
    expect(task.createdBy).toBe("plugin:alpha");
    // POST_CUTOVER — the kernel stamps it; the legacy raw-insert does not.
    // `creationIntegrity` is a DB-row field not on the shared `Task` type;
    // re-read the committed row to assert it (the automation-test pattern).
    const committedRow = getDb().select().from(tasks).where(eq(tasks.id, task.id)).all()[0];
    expect(committedRow.creationIntegrity).toBe(TASK_CREATION_INTEGRITY_VERSION.POST_CUTOVER);

    // Exactly ONE `created` Lifecycle Event — the legacy raw-insert produces
    // ZERO events. This is the first-time-history correction.
    const events = getDb().select().from(taskEvents).where(eq(taskEvents.taskId, task.id)).all();
    expect(events).toHaveLength(1);
    expect(events[0].action).toBe("created");

    // A committed envelope exists — the legacy raw-insert produces none. The
    // envelope's existence also proves prospective governance authorized the
    // publication (the coordinator commits the envelope ONLY after governance
    // passes).
    const env = envelopeForTask(task.id);
    expect(env).toBeDefined();
  });
});

// ===========================================================================
// 3. PLUGIN RUN PROVENANCE PERSISTED — the committed envelope carries
//    causalContext.root = {type:"plugin_run", id:<runId>}. The legacy path
//    only LOGGED runId; the migrated path persists it on the envelope.
// ===========================================================================

describe("T8B P2 provenance — Plugin Run persisted on the envelope (not just logged)", () => {
  it("committed envelope carries source='plugin', actor 'plugin:<pluginId>', root plugin_run:<runId>", async () => {
    const ctx = buildWriterCtx({ pluginId: "prov-plugin", runId: "prov-run-123" });

    const task = await ctx.taskWriter!.createTask({
      missionId,
      title: "Provenanced Task",
    });

    const env = envelopeForTask(task.id);
    expect(env).toBeDefined();
    expect(env!.source).toBe("plugin");
    expect(env!.actorType).toBe("system");
    expect(env!.actorId).toBe("plugin:prov-plugin");

    // The Plugin Run is persisted as the causal root — NOT merely logged. The
    // legacy path logged runId but never persisted it on the Task; the
    // envelope's causal root is the durable record (gap-audit O5 closure).
    const causal = env!.causalContext as unknown as CausalContext;
    expect(causal.root).toEqual({ type: "plugin_run", id: "prov-run-123" });
  });
});

// ===========================================================================
// 4. REPLAY — same-(runId, actionKey) replays (no duplicate Task).
// ===========================================================================

describe("T8B P2 replay — same-(runId, actionKey) does not create twice", () => {
  it("identical (runId, createTask call) replays the committed Task (no duplicate)", async () => {
    // Two distinct contexts sharing the SAME runId. The per-run
    // taskCreateSequence resets on each buildPluginContext call, so the first
    // createTask in each context derives actionKey="0". Same-(runId, "0") →
    // replay.
    const runId = "shared-replay-run";
    const ctxA = buildWriterCtx({ runId });
    const ctxB = buildWriterCtx({ runId });

    const baseline = missionTaskCount();

    const t1 = await ctxA.taskWriter!.createTask({ missionId, title: "Replay Task" });
    expect(missionTaskCount()).toBe(baseline + 1);

    // Same-(runId, actionKey="0") retry via a fresh context: the attempt is at
    // published_pending_observation (recovering); the adapter re-reads the
    // committed publication and returns the same Task. NO duplicate.
    const t2 = await ctxB.taskWriter!.createTask({ missionId, title: "Replay Task" });
    expect(t2.id).toBe(t1.id);
    expect(missionTaskCount()).toBe(baseline + 1);
  });

  it("a second distinct createTask under the same run creates a distinct attempt", async () => {
    const runId = "multi-create-run";
    const ctx = buildWriterCtx({ runId });
    const baseline = missionTaskCount();

    // First createTask → actionKey "0".
    const t1 = await ctx.taskWriter!.createTask({ missionId, title: "First" });
    // Second createTask under the same context → actionKey "1" (distinct).
    const t2 = await ctx.taskWriter!.createTask({ missionId, title: "Second" });

    expect(t1.id).not.toBe(t2.id);
    expect(missionTaskCount()).toBe(baseline + 2);
  });
});

// ===========================================================================
// 5. FLAG OFF → LEGACY — createTask does the legacy raw insert (byte-
//    unchanged behavior).
// ===========================================================================

// ===========================================================================
// 6. VETOED → THROW — an enrolled taskCreated interceptor vetoing → the
//    publication fails → the plugin createTask throws (the plugin contract).
// ===========================================================================

describe("T8B P2 vetoed → throw — plugin createTask contract is success-or-throw", () => {
  it("an enrolled taskCreated interceptor vetoing → createTask throws + no Task created", async () => {
    await writePlugin(
      "veto-plugin",
      `{
      manifest: {
        id: 'veto-plugin', version: '1.0.0', description: 'veto plugin create',
        contributions: [
          { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'veto-create', phase: 'pre', event: 'taskCreated', priority: 1, requires: [] },
        ],
      },
      interceptors: {
        'veto-create': () => ({ allow: false, reason: 'plugin policy refuses' }),
      },
    }`,
    );
    enrollInterceptor(habitatId, "veto-plugin", "veto-create");

    const ctx = buildWriterCtx({ runId: "veto-run" });
    const before = missionTaskCount();

    // The veto rolls back the whole aggregate; the wrapper maps the `vetoed`
    // publication outcome to a thrown error (the plugin contract).
    await expect(ctx.taskWriter!.createTask({ missionId, title: "Vetoed Task" })).rejects.toThrow(
      /vetoed by governance/i,
    );

    // No Task created (the aggregate rolled back).
    expect(missionTaskCount()).toBe(before);
  });
});

// ===========================================================================
// 7. NO INHERITED CAUSAL CHAIN — the plugin's envelope has a fresh root
//    (no hops from an automation chain). Plugins are NOT part of the
//    automation causal chain; they have their own provenance.
// ===========================================================================

describe("T8B P2 no inherited causal chain — fresh plugin_run root, no hops", () => {
  it("committed envelope carries no hops (fresh root, not a chained continuation)", async () => {
    const ctx = buildWriterCtx({ runId: "no-chain-run" });
    const task = await ctx.taskWriter!.createTask({ missionId, title: "Fresh Root" });

    const env = envelopeForTask(task.id);
    const causal = env!.causalContext as unknown as CausalContext;

    // Fresh root per plugin run — the plugin run IS the originating action.
    expect(causal.root).toEqual({ type: "plugin_run", id: "no-chain-run" });

    // NO inherited hops. The plugin is NOT part of any automation causal
    // chain; `hops` is absent (plugins don't append rule hops).
    expect(causal.hops).toBeUndefined();
    // NO parent (the plugin run is the root, not a continuation).
    expect(causal.parent).toBeUndefined();
  });

  it("the adapter-level call constructs an independent root (no automation-chain coupling)", () => {
    // Drive the adapter directly to confirm it never consults or appends to an
    // automation-style chain — the causalContext is synthesized from the runId
    // alone.
    const result = publishPluginTask({
      pluginId: "direct-plugin",
      runId: "direct-run",
      actionKey: "0",
      habitatId,
      missionId,
      title: "Direct Adapter Call",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;

    const causal = result.publication.envelope.causalContext as unknown as CausalContext;
    expect(causal.root).toEqual({ type: "plugin_run", id: "direct-run" });
    expect(causal.hops).toBeUndefined();
    expect(causal.parent).toBeUndefined();
  });
});
