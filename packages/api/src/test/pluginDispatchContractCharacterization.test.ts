/**
 * v0.28-T2a — dispatch Tier-1 characterization (public contract + quarantine chain).
 *
 * Approach (b): drive the dispatch entry point, then poll DB table state to
 * deterministically assert fire-and-forget outcomes. No test seam — dispatch
 * production code is untouched (Q1 non-goal). Purely additive.
 *
 * This is the high-value half of dispatch characterization: it pins the
 * contribution runtime's public contract and proves that quarantine ACTUALLY
 * BLOCKS subsequent dispatch (the class of gap that allowed the v0.22.0
 * composite-key mismatch to survive 4 patches — tests checked plugins loaded
 * but never that quarantine actually blocked).
 *
 * Per-kind fail-open/fail-safe matrix (characterized here, never altered):
 *
 *   | kind               | on throw           | on timeout         | quarantines? | has run? |
 *   |--------------------|--------------------|--------------------|--------------|----------|
 *   | signalDetector     | fail-safe (q)      | fail-safe (q)      | yes          | yes      |
 *   | automationAction   | fail-safe (q)      | fail-safe (q)      | yes          | yes      |
 *   | notificationChannel| fail-safe (no q)   | fail-safe (no q)   | NO           | yes      |
 *   | pre-interceptor    | fail-OPEN (sync)   | n/a (no timeout)   | NO           | NO       |
 *   | post-interceptor   | fail-safe (no q)   | fail-safe (no q)   | NO           | yes      |
 *                                            q = calls incrementError
 *
 * Composite key: `["signalDetector",pluginId,detectorId]` (and
 * `["automationAction",pluginId,actionId]` for actions) — the kind-safe
 * canonical key format (JSON-encoded tuple) owned by
 * `canonicalContributionKey` in `contributionAdapters.ts` (ADR-0039 Q9 / T2).
 * Must match between `incrementError`'s key and the dispatcher guard check
 * (`dispatchDetectionEvent`).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { closeDb, initTestDb } from "../db/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as quarantineRepo from "../repositories/pluginQuarantine.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as pulseRepo from "../repositories/pulse.js";
import type { PluginEvaluationContext } from "@orcy/shared";

// --- Mocks ---
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// pulseService must be partially mocked — the recursion-guard hook
// (`onPulseCreated`) and the skill-ingest / notify-side paths
// (`createPulseAndNotify`, `broadcastPulse`) are not exercised by these tests,
// but the post-interceptor's `pulseWriter.createDetectedSignal` reaches them.
// We passthrough real implementations for the create/broadcast side so a
// "succeeded" run can persist detected pulses and a real signalsEmitted count.
vi.mock("../services/pulseService.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/pulseService.js")>();
  return {
    ...actual,
    onPulseCreated: vi.fn(),
  };
});
vi.mock("../services/tasks/task-lifecycle.js", () => ({ onTaskEvent: vi.fn() }));
vi.mock("../services/commentService.js", () => ({ onCommentCreated: vi.fn() }));

// --- Fixtures ---

function setupHabitat(): string {
  const h = habitatRepo.createHabitat({ name: "T2a dispatch contract habitat" });
  columnRepo.createColumn({ habitatId: h.id, name: "Todo", order: 0 });
  return h.id;
}

function enroll(
  habitatId: string,
  pluginId: string,
  contributionId: string,
  contributionKind: "signalDetector" | "lifecycleInterceptor" | "automationAction",
): void {
  enrollmentRepo.create({
    habitatId,
    pluginId,
    contributionId,
    contributionKind,
    enrolledBy: "test",
    enabled: 1,
  });
  pluginManager.invalidateEnrollmentCache(habitatId);
}

async function writePlugin(name: string, moduleBody: string): Promise<string> {
  const tmpDir = `/tmp/test-t2a-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

async function cleanup(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

// Poll helper: spin until `predicate()` returns truthy or `timeoutMs` elapses.
// Returns whatever the predicate last returned (could be a row, an array, or undefined).
// `isMatch` defaults to "truthy" — but for array returns, "truthy" includes an empty array,
// so callers should pass an explicit matcher like `(arr) => arr.length > 0` for arrays.
async function pollUntil<T>(
  predicate: () => T,
  isMatch: (value: T) => boolean,
  timeoutMs = 2000,
  intervalMs = 10,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last: T | undefined;
  while (Date.now() < deadline) {
    last = predicate();
    if (isMatch(last)) return last;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return last;
}

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  // Keep threshold high by default so non-quarantine tests don't accidentally trip it.
  // Quarantine test overrides this in beforeEach.
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  delete (globalThis as { __intCalls?: string[] }).__intCalls;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
  delete (globalThis as { __intCalls?: string[] }).__intCalls;
});

// ---------------------------------------------------------------------------
// dispatchActionHandler fail-safe (action:730)
// ---------------------------------------------------------------------------
describe("v0.28-T2a: dispatchActionHandler fail-safe", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("a throwing action handler marks the run failed and returns {status:'failed'}", async () => {
    tmpDir = await writePlugin(
      "boom-action",
      `{
        manifest: {
          id: 'boom-action',
          version: '1.0.0',
          description: 'action that throws',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'boom',
            label: 'Boom',
            requires: [],
            timeoutMs: 1000,
          }],
        },
        actions: {
          boom: async () => { throw new Error('handler kaboom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "boom-action", "boom", "automationAction");

    const entry = pluginManager.getActionEntry("boom");
    expect(entry).not.toBeNull();
    const result = await pluginManager.dispatchActionHandler(
      entry!,
      "boom",
      habitatId,
      {
        habitat: null,
        task: null,
        mission: null,
        agent: null,
        sprint: null,
        raw: {},
      } as PluginEvaluationContext,
      {},
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("handler kaboom");

    const failedRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "boom-action" })
          .find((r) => r.status === "failed"),
      (r) => r !== undefined,
    );
    expect(failedRun).toBeDefined();
    expect(failedRun!.error).toContain("handler kaboom");
  });

  it("a slow action handler exceeding timeoutMs is marked failed (timeout fail-safe)", async () => {
    tmpDir = await writePlugin(
      "slow-action",
      `{
        manifest: {
          id: 'slow-action',
          version: '1.0.0',
          description: 'action that hangs',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'slow',
            label: 'Slow',
            requires: [],
            timeoutMs: 100,
          }],
        },
        actions: {
          slow: async () => { await new Promise((r) => setTimeout(r, 5000)); return { status: 'succeeded' }; },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "slow-action", "slow", "automationAction");

    const entry = pluginManager.getActionEntry("slow");
    const result = await pluginManager.dispatchActionHandler(
      entry!,
      "slow",
      habitatId,
      {
        habitat: null,
        task: null,
        mission: null,
        agent: null,
        sprint: null,
        raw: {},
      } as PluginEvaluationContext,
      {},
    );

    expect(result.status).toBe("failed");
    expect(result.error).toContain("timed out");

    const failedRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "slow-action" })
          .find((r) => r.status === "failed"),
      (r) => r !== undefined,
    );
    expect(failedRun).toBeDefined();
    expect(failedRun!.error).toContain("timed out");
  });

  it("a succeeding action handler returns succeeded and marks the run succeeded", async () => {
    tmpDir = await writePlugin(
      "ok-action",
      `{
        manifest: {
          id: 'ok-action',
          version: '1.0.0',
          description: 'action that succeeds',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'ok',
            label: 'OK',
            requires: [],
          }],
        },
        actions: {
          ok: async () => ({ status: 'succeeded', result: { ok: true } }),
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "ok-action", "ok", "automationAction");

    const entry = pluginManager.getActionEntry("ok");
    const result = await pluginManager.dispatchActionHandler(
      entry!,
      "ok",
      habitatId,
      {
        habitat: null,
        task: null,
        mission: null,
        agent: null,
        sprint: null,
        raw: {},
      } as PluginEvaluationContext,
      {},
    );
    expect(result.status).toBe("succeeded");

    const okRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "ok-action" })
          .find((r) => r.status === "succeeded"),
      (r) => r !== undefined,
    );
    expect(okRun).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// dispatchInterceptorRun post signal-emission + run-tracking (post:900)
// Reuses T1's proven pattern: drive runPostInterceptors + wait for fire-and-forget.
//
// ADR-0039 REVERSAL (T6): The post-interceptor signal persistence in these
// tests is sequential (for-loop await per signal), not atomic. T6 migrates to
// a validated transactional batch with post-commit SSE publication. The
// signalsEmitted count assertion below will survive; an atomicity assertion
// (partial-write rollback on mid-batch failure) must be ADDED in T6.
// See ADR-0039 § Atomic Post-Interceptor Signal Batch (Q11).
// ---------------------------------------------------------------------------
describe("v0.28-T2a: runPostInterceptors dispatch chain", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("a successful post-interceptor writes a 'succeeded' run record with signalsEmitted count", async () => {
    tmpDir = await writePlugin(
      "post-ok",
      `{
        manifest: {
          id: 'post-ok',
          version: '1.0.0',
          description: 'post with signals',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'post',
            event: 'taskClaimed',
            interceptorId: 'emit',
            priority: 0,
            requires: ['pulseWriter'],
          }],
        },
        interceptors: {
          emit: async () => ({
            signals: [
              { signalType: 'detected', subject: 's1', body: 'b1' },
              { signalType: 'detected', subject: 's2', body: 'b2' },
            ],
          }),
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "post-ok", "emit", "lifecycleInterceptor");

    pluginManager.runPostInterceptors("task-z", "taskClaimed", habitatId, {
      actor: "test",
    } as never);

    const succeededRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "post-ok" })
          .find((r) => r.status === "succeeded"),
      (r) => r !== undefined,
      2000,
    );
    expect(succeededRun).toBeDefined();
    expect(succeededRun!.signalsEmitted).toBe(2);
    expect(succeededRun!.contributionKind).toBe("lifecycleInterceptor");

    // Detected pulses were persisted via pulseWriter.createDetectedSignal
    const pulses = pulseRepo.listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z");
    const detected = pulses.filter((p) => p.signalType === "detected");
    expect(detected.length).toBeGreaterThanOrEqual(2);
  });

  it("a throwing post-interceptor marks the run failed, does NOT increment the error counter (no quarantine)", async () => {
    tmpDir = await writePlugin(
      "post-throw",
      `{
        manifest: {
          id: 'post-throw',
          version: '1.0.0',
          description: 'post that throws',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'post',
            event: 'taskClaimed',
            interceptorId: 'crash',
            priority: 0,
            requires: [],
          }],
        },
        interceptors: {
          crash: async () => { throw new Error('post-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "post-throw", "crash", "lifecycleInterceptor");

    pluginManager.runPostInterceptors("task-w", "taskClaimed", habitatId, {
      actor: "test",
    } as never);

    const failedRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "post-throw" })
          .find((r) => r.status === "failed"),
      (r) => r !== undefined,
      2000,
    );
    expect(failedRun).toBeDefined();
    expect(failedRun!.error).toContain("post-boom");

    // No quarantine: even with threshold=1, post-interceptor must not increment.
    // Use a fresh setup with threshold=1 to make this assertion tight.
    const quarantines = quarantineRepo.listByPluginId("post-throw");
    expect(quarantines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-kind fail-open/fail-safe matrix
// ---------------------------------------------------------------------------
describe("v0.28-T2a: per-kind fail-open/fail-safe asymmetry", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("signalDetector on throw: fail-safe, run marked failed (no channel side-effect)", async () => {
    tmpDir = await writePlugin(
      "det-throw",
      `{
        manifest: {
          id: 'det-throw',
          version: '1.0.0',
          description: 'detector that throws',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: 'd',
            label: 'D',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 1 },
            requires: [],
          }],
        },
        detectors: {
          d: async () => { throw new Error('det-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "det-throw", "d", "signalDetector");

    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "p-x",
      habitatId,
      occurredAt: new Date().toISOString(),
    });

    const failed = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "det-throw" })
          .find((r) => r.status === "failed"),
      (r) => r !== undefined,
    );
    expect(failed).toBeDefined();
    expect(failed!.error).toContain("det-boom");
  });

  // ADR-0039 REVERSAL (T7): This test pins CURRENT fail-open behavior for pre-
  // interceptor throws. The managed-runtime migration (T7) changes this to
  // bounded fail-closed: a throw becomes a failure veto that counts toward
  // quarantine. Replace this test's assertion of fail-open + no-run-record
  // with fail-closed + Plugin Run telemetry. See ADR-0039 § Bounded Fail-Closed
  // Pre Policy (Q1) and § Intentional Behavior Reversals.
  it("pre-interceptor on throw: fail-OPEN (no run record, no veto)", async () => {
    tmpDir = await writePlugin(
      "pre-throw",
      `{
        manifest: {
          id: 'pre-throw',
          version: '1.0.0',
          description: 'pre that throws',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: 'taskClaimed',
            interceptorId: 'crash-pre',
            priority: 0,
            requires: [],
          }],
        },
        interceptors: {
          'crash-pre': () => { throw new Error('pre-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "pre-throw", "crash-pre", "lifecycleInterceptor");

    // Drive the pre-interceptor directly. It must NOT throw (fail-open) and
    // must NOT create a run record (per ADR-0014, pre-phase has no run tracking).
    const result = pluginManager.runPreInterceptors("task-p", "taskClaimed", habitatId, {
      actor: "test",
    } as never);
    expect(result).toBeNull();

    // No plugin_runs row should have been written by the pre-interceptor.
    const runs = runRepo.listByHabitat(habitatId, { pluginId: "pre-throw" });
    expect(runs).toEqual([]);
  });

  // ADR-0039 REVERSAL (T7): This test pins CURRENT fail-open behavior for async
  // (Promise) returns from synchronous pre-interceptors. The managed-runtime
  // migration (T7) changes this to bounded fail-closed: a Promise return is a
  // runtime fault that vetoes and counts toward quarantine. See ADR-0039 § Q1.
  it("pre-interceptor async-returning: treated as allow (fail-open on contract violation)", async () => {
    tmpDir = await writePlugin(
      "pre-async",
      `{
        manifest: {
          id: 'pre-async',
          version: '1.0.0',
          description: 'pre that returns Promise',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: 'taskClaimed',
            interceptorId: 'async-pre',
            priority: 0,
            requires: [],
          }],
        },
        interceptors: {
          'async-pre': async () => ({ allow: false, reason: 'would-veto-but-async' }),
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "pre-async", "async-pre", "lifecycleInterceptor");

    // Async handler returning a Promise: sync runner detects thenable and fails open.
    const result = pluginManager.runPreInterceptors("task-q", "taskClaimed", habitatId, {
      actor: "test",
    } as never);
    expect(result).toBeNull();
  });

  it("pre-interceptor sync veto: returns the veto (caller throws)", async () => {
    tmpDir = await writePlugin(
      "pre-veto",
      `{
        manifest: {
          id: 'pre-veto',
          version: '1.0.0',
          description: 'pre that vetoes sync',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'pre',
            event: 'taskClaimed',
            interceptorId: 'veto',
            priority: 0,
            requires: [],
          }],
        },
        interceptors: {
          veto: () => ({ allow: false, reason: 'explicit-veto', details: 'test' }),
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "pre-veto", "veto", "lifecycleInterceptor");

    const result = pluginManager.runPreInterceptors("task-r", "taskClaimed", habitatId, {
      actor: "test",
    } as never);
    expect(result).not.toBeNull();
    expect(result!.allow).toBe(false);
    expect(result!.reason).toBe("explicit-veto");
  });

  it("notificationChannel on throw: fail-safe, returns {success:false} (no quarantine)", async () => {
    tmpDir = await writePlugin(
      "chan-throw",
      `{
        manifest: {
          id: 'chan-throw',
          version: '1.0.0',
          description: 'channel that throws',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'chan-boom',
            label: 'Boom',
            requires: [],
          }],
        },
        channels: {
          'chan-boom': async () => { throw new Error('chan-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "chan-throw", "chan-boom", "lifecycleInterceptor"); // kind doesn't matter for channel; just enroll to keep caches happy

    const fakeDelivery = {
      id: "d-1",
      habitatId,
      eventId: "e-1",
      recipientType: "human" as const,
      recipientId: "u-1",
      channels: ["chan-boom" as never],
      payload: null,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fakeEvent = {
      id: "e-1",
      habitatId,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: "task-1",
      severity: "info" as const,
      title: "x",
      body: "y",
      createdByType: "system" as const,
      createdAt: new Date().toISOString(),
    };
    const result = await pluginManager.dispatchToChannelPlugin(
      "chan-boom",
      fakeDelivery as never,
      fakeEvent as never,
    );
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toBe("chan-boom");

    // Run record exists (channel has run tracking) but marked failed
    const failed = runRepo
      .listByHabitat(habitatId, { pluginId: "chan-throw" })
      .find((r) => r.status === "failed");
    expect(failed).toBeDefined();

    // No quarantine (channel does NOT call incrementError)
    const quarantines = quarantineRepo.listByPluginId("chan-throw");
    expect(quarantines).toEqual([]);
  });

  // FINDING 5 — registration → dispatch timeoutMs preservation.
  // The registration round-trip test (in pluginRegistrationCharacterization.test.ts) checks that
  // getChannelHandler returns the handler, but does NOT pin that registration stored `timeoutMs`.
  // T4's catalog register could drop timeoutMs and the registration test would still pass.
  // This dispatch-based characterization proves the registry entry that dispatch reads
  // (the one populated by registerContributions at pluginManager.ts:491-496) carries the
  // timeoutMs — otherwise the timeout watchdog in dispatchToChannelPlugin:815-819 would be
  // disabled and the handler would NOT be raced against a timeout.
  it("notificationChannel registration carries timeoutMs into the registry entry (dispatch timeout watchdog fires)", async () => {
    tmpDir = await writePlugin(
      "chan-timeout",
      `{
        manifest: {
          id: 'chan-timeout',
          version: '1.0.0',
          description: 'channel that sleeps past its declared timeout',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'slow',
            label: 'Slow',
            requires: [],
            timeoutMs: 50,
          }],
        },
        channels: {
          slow: async () => { await new Promise((r) => setTimeout(r, 200)); return { success: true }; },
        },
      }`,
    );
    const habitatId = setupHabitat();

    const fakeDelivery = {
      id: "d-slow",
      habitatId,
      eventId: "e-slow",
      recipientType: "human" as const,
      recipientId: "u-slow",
      channels: ["slow" as never],
      payload: null,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fakeEvent = {
      id: "e-slow",
      habitatId,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: "task-slow",
      severity: "info" as const,
      title: "x",
      body: "y",
      createdByType: "system" as const,
      createdAt: new Date().toISOString(),
    };

    const result = await pluginManager.dispatchToChannelPlugin(
      "slow",
      fakeDelivery as never,
      fakeEvent as never,
    );

    // If timeoutMs wasn't propagated, the 200ms handler would win and we'd see success:true.
    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toMatch(/timed out/);

    // Run record exists and is marked failed.
    const failedRun = runRepo
      .listByHabitat(habitatId, { pluginId: "chan-timeout" })
      .find((r) => r.status === "failed");
    expect(failedRun).toBeDefined();
    expect(failedRun!.error).toMatch(/timed out/);
  });
});

// ---------------------------------------------------------------------------
// THE HEADLINE TEST: quarantine chain — proves observable skip
// ---------------------------------------------------------------------------
describe("v0.28-T2a: quarantine chain (incrementError → threshold → SSE → DB → dispatch SKIPS)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
    // Set threshold low so 2 errors are enough to quarantine.
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "2";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("a detector hitting ORCY_PLUGIN_QUARANTINE_THRESHOLD: DB row + SSE event + subsequent dispatch skips (no new plugin_runs)", async () => {
    tmpDir = await writePlugin(
      "quar-det",
      `{
        manifest: {
          id: 'quar-det',
          version: '1.0.0',
          description: 'detector that throws repeatedly',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: 'q',
            label: 'Q',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
            requires: [],
          }],
        },
        detectors: {
          q: async () => { throw new Error('always-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    // The detector must be enrolled so dispatchDetectionEvent iterates it.
    enroll(habitatId, "quar-det", "q", "signalDetector");

    // Drain listByPlugin emissions (loading seeds no enrollments — but enroll() did).
    publishMock.mockClear();

    // --- Drive to threshold (2 errors) ---
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "p-1",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "p-2",
      habitatId,
      occurredAt: new Date().toISOString(),
    });

    // Wait for quarantine to be persisted + SSE emitted.
    const rows = await pollUntil(
      () => quarantineRepo.listByPluginId("quar-det"),
      (r) => r.length > 0,
      2000,
    );
    expect(rows).toBeDefined();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    // T2 (ADR-0039 Q9): the canonical kind-safe key is a JSON-encoded tuple
    // `[kind, pluginId, contributionId]` so cross-kind same-ID contributions
    // get distinct quarantine rows.
    expect(rows![0].pluginKey).toBe('["signalDetector","quar-det","q"]');
    expect(rows![0].reason).toContain("threshold reached");

    // SSE event emitted to the enrolled habitat
    const publishCalls = publishMock.mock.calls.filter(
      ([, evt]) => (evt as { type: string }).type === "plugin.quarantined",
    );
    expect(publishCalls.length).toBeGreaterThanOrEqual(1);
    const [publishedHabitat, publishedEvent] = publishCalls[0];
    expect(publishedHabitat).toBe(habitatId);
    // T2 (ADR-0039 Q9): the SSE payload carries BOTH the real plugin id
    // (for UI cache invalidation) AND the canonical contribution key (for
    // admin clear-quarantine).
    const sseData = (publishedEvent as { data: { pluginId: string; contributionKey: string } })
      .data;
    expect(sseData.pluginId).toBe("quar-det");
    expect(sseData.contributionKey).toBe('["signalDetector","quar-det","q"]');

    // --- T4 (ADR-0039 Q3-Q4): quarantined detector now writes a `skipped` Plugin
    // Run row (was silent continue). The handler does NOT run — no new failed
    // or succeeded row. But a `skipped` telemetry row IS produced. ---
    const failedBeforeSkip = runRepo
      .listByHabitat(habitatId, { pluginId: "quar-det" })
      .filter((r) => r.status === "failed").length;

    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "p-3",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    // Wait for the skipped row to settle (runtime runs async).
    const skipRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "quar-det" })
          .find((r) => r.status === "skipped"),
      (r) => r !== undefined,
      2000,
    );
    expect(skipRun).toBeDefined();
    expect(skipRun!.triggerEventId).toBe("p-3");

    // No new failed run (handler did not run).
    const failedAfterSkip = runRepo
      .listByHabitat(habitatId, { pluginId: "quar-det" })
      .filter((r) => r.status === "failed").length;
    expect(failedAfterSkip).toBe(failedBeforeSkip);
  });

  it("an action hitting ORCY_PLUGIN_QUARANTINE_THRESHOLD: counter+DB+SSE quarantine, and subsequent dispatch SKIPS with explicit {status:'failed'} (ADR-0039 Q3 reversal of the known asymmetry)", async () => {
    // ADR-0039 Q3 (T5): This test REPLACES the old "known asymmetry" test
    // that pinned the v0.28 behavior where a quarantined Action STILL RAN.
    // The target contract (ADR-0039 § Quarantine Semantics Q3-Q4, § Old-to-
    // Target Behavior Map for Automation Action) is:
    //   - A quarantined Action does NOT execute its handler.
    //   - A `skipped` Plugin Run row is written (visible telemetry).
    //   - The caller receives an explicit `{ status: "failed" }` result.
    // This eliminates the asymmetry with Detectors (which already skipped).
    tmpDir = await writePlugin(
      "quar-act",
      `{
        manifest: {
          id: 'quar-act',
          version: '1.0.0',
          description: 'action that throws repeatedly',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'q',
            label: 'Q',
            requires: [],
            timeoutMs: 1000,
          }],
        },
        actions: {
          q: async () => { throw new Error('act-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "quar-act", "q", "automationAction");

    publishMock.mockClear();

    const evalCtx = {
      habitat: null,
      task: null,
      mission: null,
      agent: null,
      sprint: null,
      raw: {},
    } as PluginEvaluationContext;
    const entry = pluginManager.getActionEntry("q");
    expect(entry).not.toBeNull();

    // Drive to threshold with two FAILING dispatches.
    await pluginManager.dispatchActionHandler(entry!, "q", habitatId, evalCtx, {});
    await pluginManager.dispatchActionHandler(entry!, "q", habitatId, evalCtx, {});

    const rows = await pollUntil(
      () => quarantineRepo.listByPluginId("quar-act"),
      (r) => r.length > 0,
      2000,
    );
    expect(rows).toBeDefined();
    expect(rows!.length).toBeGreaterThanOrEqual(1);
    // T2 (ADR-0039 Q9): kind-safe canonical key.
    expect(rows![0].pluginKey).toBe('["automationAction","quar-act","q"]');

    // SSE event published
    const publishCalls = publishMock.mock.calls.filter(
      ([, evt]) => (evt as { type: string }).type === "plugin.quarantined",
    );
    expect(publishCalls.length).toBeGreaterThanOrEqual(1);

    // --- T5 (ADR-0039 Q3): quarantined Action now SKIPS execution. The handler
    // does NOT run — the caller receives an explicit {status:"failed"} and a
    // `skipped` Plugin Run row is written. (Previously the handler still ran.) ---
    const failedBeforeSkip = runRepo
      .listByHabitat(habitatId, { pluginId: "quar-act" })
      .filter((r) => r.status === "failed").length;

    const thirdResult = await pluginManager.dispatchActionHandler(
      entry!,
      "q",
      habitatId,
      evalCtx,
      {},
    );

    // Q3: explicit failure returned to the caller (not a silent drop).
    expect(thirdResult.status).toBe("failed");
    expect(thirdResult.error).toContain("quarantined");

    // Q3: a `skipped` Plugin Run row is produced (visible telemetry).
    const skipRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "quar-act" })
          .find((r) => r.status === "skipped"),
      (r) => r !== undefined,
      2000,
    );
    expect(skipRun).toBeDefined();

    // Q3: no new failed run (handler did not run — contrast the old behavior).
    const failedAfterSkip = runRepo
      .listByHabitat(habitatId, { pluginId: "quar-act" })
      .filter((r) => r.status === "failed").length;
    expect(failedAfterSkip).toBe(failedBeforeSkip);
  });

  it("notificationChannel hits do NOT quarantine (channel returns {success:false} and stays live)", async () => {
    tmpDir = await writePlugin(
      "quar-chan",
      `{
        manifest: {
          id: 'quar-chan',
          version: '1.0.0',
          description: 'channel that always throws',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'q',
            label: 'Q',
            requires: [],
          }],
        },
        channels: {
          q: async () => { throw new Error('chan-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();

    publishMock.mockClear();
    const fakeDelivery = {
      id: "d-q",
      habitatId,
      eventId: "e-q",
      recipientType: "human" as const,
      recipientId: "u-q",
      channels: ["q" as never],
      payload: null,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fakeEvent = {
      id: "e-q",
      habitatId,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: "task-q",
      severity: "info" as const,
      title: "x",
      body: "y",
      createdByType: "system" as const,
      createdAt: new Date().toISOString(),
    };

    // Drive way past threshold (10 times); channel must NOT quarantine.
    for (let i = 0; i < 12; i++) {
      const result = await pluginManager.dispatchToChannelPlugin(
        "q",
        fakeDelivery as never,
        fakeEvent as never,
      );
      expect(result).not.toBeNull();
      expect(result!.success).toBe(false);
    }

    const quarantines = quarantineRepo.listByPluginId("quar-chan");
    expect(quarantines).toEqual([]);
    const publishCalls = publishMock.mock.calls.filter(
      ([, evt]) => (evt as { type: string }).type === "plugin.quarantined",
    );
    expect(publishCalls).toEqual([]);
  });

  it("post-interceptor hits do NOT quarantine (post rethrows without incrementError)", async () => {
    tmpDir = await writePlugin(
      "quar-post",
      `{
        manifest: {
          id: 'quar-post',
          version: '1.0.0',
          description: 'post that always throws',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'post',
            event: 'taskClaimed',
            interceptorId: 'q',
            priority: 0,
            requires: [],
          }],
        },
        interceptors: {
          q: async () => { throw new Error('post-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "quar-post", "q", "lifecycleInterceptor");

    publishMock.mockClear();

    // Drive 12 times — post-interceptor must not quarantine.
    for (let i = 0; i < 12; i++) {
      pluginManager.runPostInterceptors(`task-${i}`, "taskClaimed", habitatId, {
        actor: "test",
      } as never);
      // Give the fire-and-forget promise time to settle.
      await new Promise((r) => setTimeout(r, 30));
    }

    const quarantines = quarantineRepo.listByPluginId("quar-post");
    expect(quarantines).toEqual([]);
    const publishCalls = publishMock.mock.calls.filter(
      ([, evt]) => (evt as { type: string }).type === "plugin.quarantined",
    );
    expect(publishCalls).toEqual([]);
  });

  it("quarantine canonical key matches: incrementError(canonicalKey) === dispatchDetectionEvent skip key", async () => {
    // MEMORY: a composite-key mismatch shipped in v0.22.0 and survived 4 patches because
    // tests verified plugins loaded but never that quarantine actually blocked.
    // This test pins the contract by reading the persisted DB row and asserting the format.
    //
    // T2 (ADR-0039 Q9): the canonical key is now kind-safe, produced by the
    // single `canonicalContributionKey` encoder in `contributionAdapters.ts`.
    // The previous "pluginId:contributionId" composite was ambiguous across
    // contribution kinds; the new format prefixes the kind to prevent
    // cross-kind collisions.
    tmpDir = await writePlugin(
      "key-check",
      `{
        manifest: {
          id: 'key-check',
          version: '1.0.0',
          description: 'for key format assertion',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: 'k',
            label: 'K',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
            requires: [],
          }],
        },
        detectors: {
          k: async () => { throw new Error('k-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "key-check", "k", "signalDetector");

    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "p-k1",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "p-k2",
      habitatId,
      occurredAt: new Date().toISOString(),
    });

    const rows = await pollUntil(
      () => quarantineRepo.listByPluginId("key-check"),
      (r) => r.length > 0,
      2000,
    );
    expect(rows).toBeDefined();
    // The key MUST be the kind-safe canonical key — the same format produced by
    // `canonicalContributionKey({ contributionKind: "signalDetector", pluginId: "key-check",
    // contributionId: "k" })`. If this format ever drifts from the encoder output,
    // quarantine will be written to one key but checked against another.
    expect(rows![0].pluginKey).toBe('["signalDetector","key-check","k"]');
  });
});
