/**
 * ADR-0039 T1 — Plugin Invocation Policy characterization.
 *
 * Strengthens coverage of behavior that MUST survive the managed-runtime
 * migration (T2–T8). All tests are purely additive: they drive public
 * dispatch surfaces and observe outcomes through DB state, matching the
 * v0.28-T2a/T2b approach (b) — no test seam, no production-code change.
 *
 * Areas strengthened (per T1 scope):
 *
 *   1. pre priority + first-veto short-circuit (combination not previously tested)
 *   2. Detector recursion guard (live hook + scanner level)
 *   3. Action/Channel public result shapes (success-field pass-through on success path)
 *   4. Post fire-and-forget timing (caller detaches before handler side effects)
 *
 * timeoutMs propagation and late-rejection suppression are already thoroughly
 * characterized in pluginDispatchGuardsCharacterization.test.ts (T2b) and are
 * not duplicated here.
 *
 * Tests that ADR-0039 intentionally reverses are marked in
 * pluginDispatchContractCharacterization.test.ts (T1.4 annotations).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { closeDb, initTestDb, getDb } from "../db/index.js";
import { pulses } from "../db/schema/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as quarantineRepo from "../repositories/pluginQuarantine.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as pulseRepo from "../repositories/pulse.js";
import * as pulseService from "../services/pulseService.js";
import { runScan } from "../services/detectorScanService.js";
import type { PluginEvaluationContext } from "@orcy/shared";

// --- Mocks (mirror T2a) ---
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
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
  const h = habitatRepo.createHabitat({ name: "ADR-0039 T1 habitat" });
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
  const tmpDir = `/tmp/test-t1policy-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

async function cleanup(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

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

const evalCtx = {
  habitat: null,
  task: null,
  mission: null,
  agent: null,
  sprint: null,
  raw: {},
} as PluginEvaluationContext;

beforeEach(async () => {
  await initTestDb();
  pluginManager.resetPlugins();
  publishMock.mockClear();
  vi.mocked(pulseService.onPulseCreated).mockClear();
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
  delete (globalThis as { __intCalls?: string[] }).__intCalls;
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
  delete process.env.ORCY_DETECTOR_MAX_CONCURRENT;
  delete (globalThis as { __intCalls?: string[] }).__intCalls;
  delete (globalThis as { __detResolved?: () => void }).__detResolved;
});

// ---------------------------------------------------------------------------
// 1. pre priority + first-veto short-circuit
// ---------------------------------------------------------------------------
describe("ADR-0039 T1: pre priority + first-veto short-circuit", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("low-priority pre-interceptor veto short-circuits: higher-priority handler never runs", async () => {
    tmpDir = await writePlugin(
      "pre-short-circuit",
      `{
        manifest: {
          id: 'pre-short-circuit',
          version: '1.0.0',
          description: 'priority + veto short-circuit',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'low-veto', phase: 'pre', event: 'taskClaimed', priority: 1, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'high-never-runs', phase: 'pre', event: 'taskClaimed', priority: 5, requires: [] },
          ],
        },
        interceptors: {
          'low-veto': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('low-veto'); return { allow: false, reason: 'priority-1-veto' }; },
          'high-never-runs': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('high-never-runs'); return { allow: true }; },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "pre-short-circuit", "low-veto", "lifecycleInterceptor");
    enroll(habitatId, "pre-short-circuit", "high-never-runs", "lifecycleInterceptor");

    const result = pluginManager.runPreInterceptors("task-sc", "taskClaimed", habitatId, {
      actor: "test",
    } as never);

    expect(result).not.toBeNull();
    expect(result!.allow).toBe(false);
    expect(result!.reason).toBe("priority-1-veto");
    expect((globalThis as { __intCalls?: string[] }).__intCalls).toEqual(["low-veto"]);
  });

  it("low-priority allow does not short-circuit: all higher-priority handlers run in order", async () => {
    tmpDir = await writePlugin(
      "pre-all-allow",
      `{
        manifest: {
          id: 'pre-all-allow',
          version: '1.0.0',
          description: 'priority ascending all allow',
          contributions: [
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'pri-1', phase: 'pre', event: 'taskClaimed', priority: 1, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'pri-3', phase: 'pre', event: 'taskClaimed', priority: 3, requires: [] },
            { kind: 'lifecycleInterceptor', scope: 'habitat', interceptorId: 'pri-5', phase: 'pre', event: 'taskClaimed', priority: 5, requires: [] },
          ],
        },
        interceptors: {
          'pri-1': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('pri-1'); return { allow: true }; },
          'pri-3': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('pri-3'); return { allow: true }; },
          'pri-5': () => { (globalThis.__intCalls = globalThis.__intCalls || []).push('pri-5'); return { allow: true }; },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "pre-all-allow", "pri-1", "lifecycleInterceptor");
    enroll(habitatId, "pre-all-allow", "pri-3", "lifecycleInterceptor");
    enroll(habitatId, "pre-all-allow", "pri-5", "lifecycleInterceptor");

    const result = pluginManager.runPreInterceptors("task-aa", "taskClaimed", habitatId, {
      actor: "test",
    } as never);

    expect(result).toBeNull();
    expect((globalThis as { __intCalls?: string[] }).__intCalls).toEqual([
      "pri-1",
      "pri-3",
      "pri-5",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 2a. Detector recursion guard — live hook (onPulseCreated callback)
// The live entry registers a callback on pulseService.onPulseCreated that
// checks `if (pulse.signalType === "detected") return;` before dispatching.
// We capture the callback by calling initializePlugins (which triggers
// registerDetectorHooks), then invoke it directly with detected and normal
// pulses to prove the guard and fire-and-forget semantics.
// ---------------------------------------------------------------------------
describe("ADR-0039 T1: Detector live-entry recursion guard + fire-and-forget", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("detected pulse does NOT trigger detector dispatch via live hook", async () => {
    tmpDir = await writePlugin(
      "live-recursion-det",
      `{
        manifest: {
          id: 'live-recursion-det',
          version: '1.0.0',
          description: 'detector for live recursion guard',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: 'lrd',
            label: 'LRD',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
            requires: [],
          }],
        },
        detectors: { lrd: async () => [] },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "live-recursion-det", "lrd", "signalDetector");

    // Trigger registerDetectorHooks via initializePlugins.
    await pluginManager.initializePlugins({ register: vi.fn() } as never);

    // Extract the callback registered on onPulseCreated.
    const mockFn = pulseService.onPulseCreated as unknown as {
      mock: { calls: Array<[(pulse: unknown) => void]> };
    };
    const callback = mockFn.mock.calls[mockFn.mock.calls.length - 1][0];

    // Invoke with a detected pulse — the recursion guard must short-circuit.
    callback({
      id: "detected-live-1",
      habitatId,
      signalType: "detected",
      subject: "x",
      body: "x",
      createdAt: new Date().toISOString(),
    });

    // Give any (incorrect) async dispatch time to settle.
    await new Promise((r) => setTimeout(r, 100));

    // No plugin_runs row should exist for the detected pulse.
    const runs = runRepo.listByHabitat(habitatId, { pluginId: "live-recursion-det" });
    expect(runs).toEqual([]);
  });

  it("normal pulse DOES trigger detector dispatch via live hook (fire-and-forget)", async () => {
    // The handler awaits a deferred Promise we control. This proves the live
    // hook callback returns BEFORE the handler settles (fire-and-forget).
    tmpDir = await writePlugin(
      "live-ff-det",
      `{
        manifest: {
          id: 'live-ff-det',
          version: '1.0.0',
          description: 'detector with deferred handler for fire-and-forget proof',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: 'ffd',
            label: 'FFD',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
            requires: [],
          }],
        },
        detectors: {
          ffd: async () => {
            await new Promise((resolve) => { globalThis.__detResolved = resolve; });
            return [];
          },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "live-ff-det", "ffd", "signalDetector");

    await pluginManager.initializePlugins({ register: vi.fn() } as never);

    const mockFn = pulseService.onPulseCreated as unknown as {
      mock: { calls: Array<[(pulse: unknown) => void]> };
    };
    const callback = mockFn.mock.calls[mockFn.mock.calls.length - 1][0];

    // Invoke with a normal (non-detected) pulse. The callback should return
    // synchronously — the handler is fire-and-forget via the runtime (T4).
    const runCountBefore = runRepo.listByHabitat(habitatId, { pluginId: "live-ff-det" }).length;
    callback({
      id: "normal-live-1",
      habitatId,
      signalType: "experience",
      subject: "x",
      body: "x",
      createdAt: new Date().toISOString(),
    });

    // The callback returned synchronously. A "running" row exists (startPluginRun
    // is synchronous), but the handler is still pending on our deferred Promise.
    const runsAfter = runRepo.listByHabitat(habitatId, { pluginId: "live-ff-det" });
    expect(runsAfter.length).toBe(runCountBefore + 1);
    expect(runsAfter[0].status).toBe("running");

    // Resolve the deferred handler and wait for the run to finish.
    const resolve = (globalThis as { __detResolved?: () => void }).__detResolved;
    expect(resolve).toBeDefined();
    resolve!();

    const finished = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "live-ff-det" })
          .find((r) => r.status === "succeeded"),
      (r) => r !== undefined,
    );
    expect(finished).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 2b. Detector recursion guard — scanner level
// The scanner filters signalType !== "detected" in queryMissedPulses.
// Detected signals are detector OUTPUT, not INPUT — processing them
// would create infinite loops. This test proves the filter by inserting
// a detected pulse directly in the DB and verifying the scanner never
// dispatches a detector for it. The handler returns [] so no new detected
// pulse is created, making the assertion deterministic.
// ---------------------------------------------------------------------------
describe("ADR-0039 T1: Detector recursion guard (scanner excludes detected signals)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("a detected pulse in the DB does NOT trigger detector re-dispatch via catch-up scan", async () => {
    tmpDir = await writePlugin(
      "recursion-det",
      `{
        manifest: {
          id: 'recursion-det',
          version: '1.0.0',
          description: 'detector for recursion guard test',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: 'rd',
            label: 'RD',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
            requires: [],
          }],
        },
        detectors: {
          rd: async () => [],
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "recursion-det", "rd", "signalDetector");

    // Insert a detected pulse directly into the DB.
    const db = getDb();
    const detectedPulseId = "detected-test-pulse-1";
    db.insert(pulses)
      .values({
        id: detectedPulseId,
        habitatId,
        fromType: "system",
        fromId: "test",
        signalType: "detected",
        subject: "detector output",
        body: "should not re-trigger",
        createdAt: new Date().toISOString(),
      })
      .run();

    // Also insert a normal pulse that SHOULD be picked up.
    const normalPulseId = "normal-test-pulse-1";
    db.insert(pulses)
      .values({
        id: normalPulseId,
        habitatId,
        fromType: "system",
        fromId: "test",
        signalType: "experience",
        subject: "normal signal",
        body: "should be scanned",
        createdAt: new Date().toISOString(),
      })
      .run();

    // Run the scan. The scanner should skip the detected pulse and process
    // only the normal one.
    runScan();

    // Wait for the detector to finish processing the normal pulse.
    const succeededRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "recursion-det" })
          .find((r) => r.status === "succeeded"),
      (r) => r !== undefined,
      2000,
    );
    expect(succeededRun).toBeDefined();

    // Exactly ONE run was created — for the normal pulse only.
    const allRuns = runRepo.listByHabitat(habitatId, { pluginId: "recursion-det" });
    expect(allRuns.length).toBe(1);

    // No run has triggerEventId matching the detected pulse.
    const runsForDetected = allRuns.filter((r) => r.triggerEventId === detectedPulseId);
    expect(runsForDetected).toEqual([]);

    // Run a second scan to confirm stability — the detected pulse is still
    // excluded and no new runs are created.
    runScan();
    await new Promise((r) => setTimeout(r, 200));
    const runsAfterSecondScan = runRepo.listByHabitat(habitatId, { pluginId: "recursion-det" });
    expect(runsAfterSecondScan.length).toBe(1);

    // No new detected pulses were created by the detector (handler returns []).
    const allPulses = pulseRepo.listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z");
    const detectedCount = allPulses.filter((p) => p.signalType === "detected").length;
    expect(detectedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 3. Action/Channel public result shapes (success-field pass-through)
// ---------------------------------------------------------------------------
describe("ADR-0039 T1: Action/Channel success result shape pass-through", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("Action success preserves the custom result object end-to-end", async () => {
    tmpDir = await writePlugin(
      "act-result",
      `{
        manifest: {
          id: 'act-result',
          version: '1.0.0',
          description: 'action with rich result',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'rich',
            label: 'Rich',
            requires: [],
          }],
        },
        actions: {
          rich: async () => ({ status: 'succeeded', result: { items: [1, 2, 3], meta: 'data' } }),
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "act-result", "rich", "automationAction");

    const entry = pluginManager.getActionEntry("rich");
    expect(entry).not.toBeNull();
    const result = await pluginManager.dispatchActionHandler(
      entry!,
      "rich",
      habitatId,
      evalCtx,
      {},
    );

    expect(result.status).toBe("succeeded");
    expect(result.result).toEqual({ items: [1, 2, 3], meta: "data" });
    expect(result.error).toBeUndefined();

    const okRun = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "act-result" })
          .find((r) => r.status === "succeeded"),
      (r) => r !== undefined,
    );
    expect(okRun).toBeDefined();
  });

  it("Channel success preserves success:true and custom attemptId end-to-end", async () => {
    tmpDir = await writePlugin(
      "chan-success",
      `{
        manifest: {
          id: 'chan-success',
          version: '1.0.0',
          description: 'channel that succeeds with attemptId',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'ok',
            label: 'OK',
            requires: [],
          }],
        },
        channels: {
          ok: async () => ({ success: true, attemptId: 'att-custom-42' }),
        },
      }`,
    );
    const habitatId = setupHabitat();

    const fakeDelivery = {
      id: "d-ok",
      habitatId,
      eventId: "e-ok",
      recipientType: "human" as const,
      recipientId: "u-ok",
      channels: ["ok" as never],
      payload: null,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fakeEvent = {
      id: "e-ok",
      habitatId,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: "task-ok",
      severity: "info" as const,
      title: "x",
      body: "y",
      createdByType: "system" as const,
      createdAt: new Date().toISOString(),
    };

    const result = await pluginManager.dispatchToChannelPlugin(
      "ok",
      fakeDelivery as never,
      fakeEvent as never,
    );

    expect(result).not.toBeNull();
    expect(result!.success).toBe(true);
    expect(result!.error).toBeUndefined();
    // MAJOR 2 fix: explicitly assert attemptId pass-through — without this,
    // stripping attemptId from the result would still pass the test.
    expect(result!.attemptId).toBe("att-custom-42");

    const okRun = runRepo
      .listByHabitat(habitatId, { pluginId: "chan-success" })
      .find((r) => r.status === "succeeded");
    expect(okRun).toBeDefined();
  });

  it("Channel expected failure {success:false} marks run failed but does NOT increment error counter", async () => {
    // Current behavior: {success:false} marks the Plugin Run as "failed"
    // (dispatchToChannelPlugin: `result.success ? "succeeded" : "failed"`).
    // However, the channel dispatcher does NOT call incrementError, so expected
    // domain failures never reach the quarantine threshold. Channels never
    // quarantine, whether the failure is expected or a throw.
    tmpDir = await writePlugin(
      "chan-expected-fail",
      `{
        manifest: {
          id: 'chan-expected-fail',
          version: '1.0.0',
          description: 'channel returns expected failure',
          contributions: [{
            kind: 'notificationChannel',
            scope: 'system',
            channelId: 'ef',
            label: 'EF',
            requires: [],
          }],
        },
        channels: {
          ef: async () => ({ success: false, error: 'recipient not reachable' }),
        },
      }`,
    );
    const habitatId = setupHabitat();

    const fakeDelivery = {
      id: "d-ef",
      habitatId,
      eventId: "e-ef",
      recipientType: "human" as const,
      recipientId: "u-ef",
      channels: ["ef" as never],
      payload: null,
      status: "pending" as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    const fakeEvent = {
      id: "e-ef",
      habitatId,
      eventType: "task.assigned",
      sourceType: "task",
      sourceId: "task-ef",
      severity: "info" as const,
      title: "x",
      body: "y",
      createdByType: "system" as const,
      createdAt: new Date().toISOString(),
    };

    const result = await pluginManager.dispatchToChannelPlugin(
      "ef",
      fakeDelivery as never,
      fakeEvent as never,
    );

    expect(result).not.toBeNull();
    expect(result!.success).toBe(false);
    expect(result!.error).toBe("recipient not reachable");

    // Current behavior: run marked "failed" (not "succeeded").
    const run = runRepo
      .listByHabitat(habitatId, { pluginId: "chan-expected-fail" })
      .find((r) => r.status === "failed");
    expect(run).toBeDefined();

    // No quarantine row exists regardless (channel never calls incrementError).
    const quarantines = await import("../repositories/pluginQuarantine.js").then((m) =>
      m.listByPluginId("chan-expected-fail"),
    );
    expect(quarantines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Post fire-and-forget timing (caller detaches before handler side effects)
// Uses a deferred Promise to deterministically prove the caller returns before
// the handler produces side effects — no wall-clock timing assumptions.
// ---------------------------------------------------------------------------
describe("ADR-0039 T1: post fire-and-forget timing (caller detaches before handler)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("runPostInterceptors returns before the post handler produces side effects", async () => {
    // The handler awaits a deferred Promise. We control when it resolves.
    // This proves the caller detaches without relying on wall-clock timing.
    tmpDir = await writePlugin(
      "post-timing",
      `{
        manifest: {
          id: 'post-timing',
          version: '1.0.0',
          description: 'post with deferred handler',
          contributions: [{
            kind: 'lifecycleInterceptor',
            scope: 'habitat',
            phase: 'post',
            event: 'taskClaimed',
            interceptorId: 'deferred-post',
            priority: 0,
            requires: [],
          }],
        },
        interceptors: {
          'deferred-post': async () => {
            await new Promise((resolve) => { globalThis.__postResolve = resolve; });
            globalThis.__postSideEffect = true;
            return { signals: [] };
          },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "post-timing", "deferred-post", "lifecycleInterceptor");

    // Call runPostInterceptors — it returns void synchronously.
    pluginManager.runPostInterceptors("task-timing", "taskClaimed", habitatId, {
      actor: "test",
    } as never);

    // The handler is deferred — its side effect has NOT happened yet because
    // we haven't resolved the Promise. This proves the caller detached.
    expect((globalThis as { __postSideEffect?: boolean }).__postSideEffect).toBeUndefined();

    // Resolve the deferred handler.
    const resolve = (globalThis as { __postResolve?: () => void }).__postResolve;
    expect(resolve).toBeDefined();
    resolve!();

    // Now the side effect should appear.
    await pollUntil(
      () => (globalThis as { __postSideEffect?: boolean }).__postSideEffect,
      (v) => v === true,
      2000,
    );
    expect((globalThis as { __postSideEffect?: boolean }).__postSideEffect).toBe(true);

    delete (globalThis as { __postResolve?: () => void }).__postResolve;
    delete (globalThis as { __postSideEffect?: boolean }).__postSideEffect;
  });
});

// ---------------------------------------------------------------------------
// ADR-0039 T2 — Cross-kind contribution identity (the headline T2 contract)
// ---------------------------------------------------------------------------

describe("ADR-0039 T2: kind-safe canonical contribution identity", () => {
  let tmpDir: string;

  beforeEach(() => {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "2";
    tmpDir = "";
  });

  afterEach(async () => {
    delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
    if (tmpDir) await cleanup(tmpDir);
  });

  /**
   * Same plugin + same kind-local ID `x` declared as BOTH a signalDetector AND
   * an automationAction. Under the legacy `pluginId:contributionId` key both
   * would share `cross-kind:x` and a single quarantine row would block both
   * contributions. The kind-safe canonical key keeps them distinct.
   *
   * This is the end-to-end version of the unit matrix in
   * `pluginIdentityCharacterization.test.ts`. It pins the contract via real
   * plugin load + dispatch + DB observation (approach b — no test seam).
   */
  it("cross-kind contributions with the same kind-local ID get distinct quarantine rows", async () => {
    tmpDir = await writePlugin(
      "cross-kind",
      `{
        manifest: {
          id: 'cross-kind',
          version: '1.0.0',
          description: 'detector + action sharing id "x"',
          contributions: [
            {
              kind: 'signalDetector',
              scope: 'habitat',
              detectorId: 'x',
              label: 'X',
              detects: 'pulseCreated',
              rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
              requires: [],
            },
            {
              kind: 'automationAction',
              scope: 'system',
              actionId: 'x',
              label: 'X',
              requires: [],
              timeoutMs: 1000,
            },
          ],
        },
        detectors: { x: async () => { throw new Error('det-boom'); } },
        actions:   { x: async () => { throw new Error('act-boom'); } },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "cross-kind", "x", "signalDetector");

    publishMock.mockClear();

    // Drive the DETECTOR past threshold (2 errors under the test env var).
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "ck-1",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "ck-2",
      habitatId,
      occurredAt: new Date().toISOString(),
    });

    const detRows = await pollUntil(
      () => quarantineRepo.listByPluginId("cross-kind"),
      (r) => r.some((row) => row.pluginKey.startsWith('["signalDetector",')),
      2000,
    );
    expect(detRows).toBeDefined();
    const detKey = detRows!.find((r) => r.pluginKey.startsWith('["signalDetector",'))!.pluginKey;
    expect(detKey).toBe('["signalDetector","cross-kind","x"]');

    // Now drive the ACTION past threshold with two failing dispatches.
    const entry = pluginManager.getActionEntry("x");
    expect(entry).not.toBeNull();
    await pluginManager.dispatchActionHandler(entry!, "x", habitatId, evalCtx, {});
    await pluginManager.dispatchActionHandler(entry!, "x", habitatId, evalCtx, {});

    const actRows = await pollUntil(
      () => quarantineRepo.listByPluginId("cross-kind"),
      (r) => r.some((row) => row.pluginKey.startsWith('["automationAction",')),
      2000,
    );
    expect(actRows).toBeDefined();
    const actKey = actRows!.find((r) => r.pluginKey.startsWith('["automationAction",'))!.pluginKey;
    expect(actKey).toBe('["automationAction","cross-kind","x"]');

    // Headline assertion: detector and action keys for the SAME kind-local ID
    // are distinct (the legacy format would have collided on "cross-kind:x").
    expect(detKey).not.toBe(actKey);
    expect(new Set([detKey, actKey]).size).toBe(2);
  });
});
