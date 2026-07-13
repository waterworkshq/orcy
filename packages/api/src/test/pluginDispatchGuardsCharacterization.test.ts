/**
 * v0.28-T2b — dispatch Tier-2 characterization (generic dispatch guards).
 *
 * Approach (b): drive the dispatch entry point, observe outcomes through
 * DB state (`plugin_runs`, `plugin_quarantines`). No test seam — dispatch
 * production code is untouched (Q1 non-goal). Purely additive.
 *
 * Targets (all sit behind the generic dispatch infrastructure; private/fire-and-forget):
 *
 *   | target                              | file:line            | env var                              | observation path                                                  |
 *   |-------------------------------------|----------------------|--------------------------------------|-------------------------------------------------------------------|
 *   | `isRateLimited`                     | pluginManager.ts:1054| `ORCY_PLUGIN_QUARANTINE_THRESHOLD`   | errors cross threshold → dispatch skip observable (no new run)    |
 *   | `acquireConcurrencySlot`            | pluginManager.ts:1106| `ORCY_DETECTOR_MAX_CONCURRENT`       | saturate cap → overflow skip observable (dispatched < submitted)  |
 *   | `releaseConcurrencySlot`            | pluginManager.ts:1114| (paired with above)                  | after release, next dispatch is unblocked                        |
 *   | `withTimeout` late-rejection swallow| pluginManager.ts:191 | (handler `timeoutMs` in manifest)    | run marked `failed`, no `unhandledRejection` event fires         |
 *
 * The rate-limit and concurrency guards are characterized via the
 * *observable skip* (bounded `plugin_runs` count under saturation),
 * not internal counter mutation. The 60s window rollover is private
 * timing precision — documented as deferred (no fake clock available).
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
import type { PluginEvaluationContext } from "@orcy/shared";

// --- Mocks (mirror T2a) ---
const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));
vi.mock("../lib/logger.js", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
// Passthrough `pulseService` (T2a pattern): keep createPulseAndNotify/broadcastPulse real
// for any pulseWriter.createDetectedSignal side effect; only mock the recursion-guard hook.
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
  const h = habitatRepo.createHabitat({ name: "T2b dispatch guards habitat" });
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
  const tmpDir = `/tmp/test-t2b-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  await mkdir(tmpDir, { recursive: true });
  await writeFile(`${tmpDir}/${name}.mjs`, `export default ${moduleBody};`);
  pluginManager.setPluginDirectory(tmpDir);
  await pluginManager.loadPlugins();
  return tmpDir;
}

async function cleanup(tmpDir: string): Promise<void> {
  await rm(tmpDir, { recursive: true, force: true });
}

// Poll helper: spin until `isMatch(last)` is true or `timeoutMs` elapses.
// Returns the last observed value (could be undefined if timeout reached).
// Array returns: pass an explicit matcher like `(arr) => arr.length > 0` to avoid
// the empty-array-truthy pitfall.
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
  // Default threshold high so non-rate-limit tests don't trip the threshold.
  // Individual describe blocks override ORCY_PLUGIN_QUARANTINE_THRESHOLD / ORCY_DETECTOR_MAX_CONCURRENT.
  if (!process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD) {
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  }
});

afterEach(async () => {
  pluginManager.resetPlugins();
  closeDb();
  delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
  delete process.env.ORCY_DETECTOR_MAX_CONCURRENT;
});

// ---------------------------------------------------------------------------
// isRateLimited — threshold block (pluginManager.ts:1054)
// ADR-0039 RETAIN + REPLACE (T3): The observable skip behavior (errors cross
// threshold → dispatch skip) is RETAINED — it survives the migration via the
// quarantine gate. What changes is the MECHANISM: the error-based isRateLimited
// function is removed (Q14), and rate_limited status becomes capacity-only.
// These tests pin the CURRENT shared-counter mechanism (rate-limit = quarantine
// threshold). T3 updates the mechanism while preserving the threshold-skip
// observable. See ADR-0039 § Rate-Limited Semantics (Q14) and
// § Intentional Behavior Reversals and Additions.
// ---------------------------------------------------------------------------
describe("v0.28-T2b: isRateLimited threshold block (errors in 60s window)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
    // Threshold of 3 makes the "below threshold" path observable without quarantine.
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "3";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("below threshold: errors accumulating under the limit still allow dispatch (rate-limit not yet triggered)", async () => {
    tmpDir = await writePlugin(
      "rate-under",
      `{
        manifest: {
          id: 'rate-under',
          version: '1.0.0',
          description: 'detector that throws but stays under threshold',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: 'u',
            label: 'U',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
            requires: [],
          }],
        },
        detectors: {
          u: async () => { throw new Error('u-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "rate-under", "u", "signalDetector");

    publishMock.mockClear();

    // Threshold=3, drive 2 errors (count goes 1 → 2, both below threshold).
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "u-1",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 100));
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "u-2",
      habitatId,
      occurredAt: new Date().toISOString(),
    });

    // Wait for the second run to settle.
    const failedRuns = await pollUntil(
      () =>
        runRepo
          .listByHabitat(habitatId, { pluginId: "rate-under" })
          .filter((r) => r.status === "failed"),
      (r) => r.length >= 2,
      1500,
    );
    expect(failedRuns).toBeDefined();
    expect(failedRuns!.length).toBe(2);

    // count is 2, threshold is 3 → not rate-limited, not quarantined.
    // A third dispatch should still proceed.
    const runsBeforeThird = runRepo.listByHabitat(habitatId, { pluginId: "rate-under" }).length;
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "u-3",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    // Wait long enough for the third run to record.
    await pollUntil(
      () => runRepo.listByHabitat(habitatId, { pluginId: "rate-under" }).length,
      (n) => n > runsBeforeThird,
      1500,
    );
    const runsAfterThird = runRepo.listByHabitat(habitatId, { pluginId: "rate-under" }).length;
    // The third call dispatched a new run (count went to 3, no quarantine because
    // we drive once more after to trip it).
    expect(runsAfterThird).toBe(3);
  });

  it("at/above threshold: errors crossing the limit skip subsequent dispatch (observable via no new plugin_runs)", async () => {
    tmpDir = await writePlugin(
      "rate-over",
      `{
        manifest: {
          id: 'rate-over',
          version: '1.0.0',
          description: 'detector that throws past the threshold',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: 'o',
            label: 'O',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
            requires: [],
          }],
        },
        detectors: {
          o: async () => { throw new Error('o-boom'); },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "rate-over", "o", "signalDetector");

    publishMock.mockClear();

    // Threshold=3, drive 3 errors → count reaches threshold → quarantine trips.
    for (const sourceId of ["o-1", "o-2", "o-3"]) {
      pluginManager.dispatchDetectionEvent("pulseCreated", {
        kind: "pulseCreated",
        sourceId,
        habitatId,
        occurredAt: new Date().toISOString(),
      });
      await new Promise((r) => setTimeout(r, 100));
    }

    // Confirm quarantine row exists (proves the threshold was crossed).
    const quar = await pollUntil(
      () => quarantineRepo.listByPluginId("rate-over"),
      (rows) => rows.length > 0,
      1500,
    );
    expect(quar).toBeDefined();
    expect(quar!.length).toBeGreaterThanOrEqual(1);

    // Now prove the OBSERVABLE SKIP: a fourth dispatch produces no new run.
    const runsBeforeSkip = runRepo.listByHabitat(habitatId, { pluginId: "rate-over" }).length;

    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "o-after-skip",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 250));

    const runsAfterSkip = runRepo.listByHabitat(habitatId, { pluginId: "rate-over" }).length;
    expect(runsAfterSkip).toBe(runsBeforeSkip);

    // The skip is dispatched=false on the post-quarantine call (no eligible
    // detector passed the guards). The boolean return value is the closest
    // external proxy for "guarded by rate-limit/quarantine".
    const stillDispatched = pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "o-probe",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    expect(stillDispatched).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// acquireConcurrencySlot / releaseConcurrencySlot — per-habitat cap
// pluginManager.ts:1106 / :1114. Cap is per-habitat Map<habitatId, number>.
// Approach: write 3 slow detectors in the same habitat, cap=2. On each call,
// exactly 2 acquire slots and dispatch; the 3rd is skipped (no slot).
// After slots release (runDetector's finally), the next call can dispatch again.
// ---------------------------------------------------------------------------
describe("v0.28-T2b: acquireConcurrencySlot / releaseConcurrencySlot — per-habitat cap", () => {
  let tmpDirs: string[];

  beforeEach(() => {
    tmpDirs = [];
    // Cap=2 lets us prove saturation with 3 detectors in one call.
    process.env.ORCY_DETECTOR_MAX_CONCURRENT = "2";
    // Keep threshold high so quarantine doesn't interfere.
    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "1000";
  });

  afterEach(async () => {
    for (const dir of tmpDirs) await cleanup(dir);
  });

  it("saturating concurrent dispatch with cap=2 and 3 detectors: exactly 2 dispatch, 1 skip (observable via no new plugin_runs for the loser)", async () => {
    // Three detectors, each in its own plugin module so the registry iteration is
    // unambiguous. All sleep ~250ms so slots stay held while we observe.
    const detectors: Array<{ pluginId: string; detectorId: string }> = [
      { pluginId: "conc-a", detectorId: "a" },
      { pluginId: "conc-b", detectorId: "b" },
      { pluginId: "conc-c", detectorId: "c" },
    ];
    for (const { pluginId, detectorId } of detectors) {
      tmpDirs.push(
        await writePlugin(
          pluginId,
          `{
            manifest: {
              id: '${pluginId}',
              version: '1.0.0',
              description: 'slow detector for concurrency saturation',
              contributions: [{
                kind: 'signalDetector',
                scope: 'habitat',
                detectorId: '${detectorId}',
                label: '${detectorId.toUpperCase()}',
                detects: 'pulseCreated',
                rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
                requires: [],
              }],
            },
            detectors: {
              ${detectorId}: async () => {
                await new Promise((r) => setTimeout(r, 250));
                return [];
              },
            },
          }`,
        ),
      );
    }

    const habitatId = setupHabitat();
    for (const { pluginId, detectorId } of detectors) {
      enroll(habitatId, pluginId, detectorId, "signalDetector");
    }

    publishMock.mockClear();

    // --- First call: 2 acquire slots, 1 is skipped ---
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "conc-1",
      habitatId,
      occurredAt: new Date().toISOString(),
    });

    // Wait until 2 runs are recorded (the 2 slot-acquiring detectors have started).
    // The losing detector should NOT have a run row yet because the slot was denied.
    const twoRuns = await pollUntil(
      () => {
        const runsByPlugin = detectors.map(({ pluginId }) => ({
          pluginId,
          count: runRepo.listByHabitat(habitatId, { pluginId }).length,
        }));
        return runsByPlugin.filter((x) => x.count > 0).length;
      },
      (n) => n === 2,
      1500,
    );
    expect(twoRuns).toBeDefined();

    // Snapshot: exactly 2 detectors have a run row, 1 (the loser) has none yet.
    const countsAfterFirst = detectors.map(({ pluginId }) => ({
      pluginId,
      count: runRepo.listByHabitat(habitatId, { pluginId }).length,
    }));
    const dispatchingCount = countsAfterFirst.filter((x) => x.count > 0).length;
    const skippedCount = countsAfterFirst.filter((x) => x.count === 0).length;
    expect(dispatchingCount).toBe(2);
    expect(skippedCount).toBe(1);

    // Wait long enough for the slots to release (runDetector finally{}).
    await new Promise((r) => setTimeout(r, 400));

    // --- Second call: slots are free, 2 acquire again, same loser is skipped ---
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "conc-2",
      habitatId,
      occurredAt: new Date().toISOString(),
    });

    await pollUntil(
      () => {
        const totalRuns = detectors.reduce(
          (acc, { pluginId }) => acc + runRepo.listByHabitat(habitatId, { pluginId }).length,
          0,
        );
        return totalRuns;
      },
      (n) => n >= 4,
      1500,
    );

    const countsAfterSecond = detectors.map(({ pluginId }) => ({
      pluginId,
      count: runRepo.listByHabitat(habitatId, { pluginId }).length,
    }));

    // The same plugin consistently loses (still has 0 runs after two calls
    // if its slot was denied both times — its detectors run only when slots
    // free up between calls, but since we drive back-to-back, it stays behind).
    // More importantly: total runs == 4 (2 per call), proving saturation held
    // across both calls and release freed the slot between them.
    const totalRunsAfterSecond = countsAfterSecond.reduce((acc, x) => acc + x.count, 0);
    expect(totalRunsAfterSecond).toBe(4);

    // At least one detector has ≤1 run while others have 2 — the saturation effect.
    const loserCounts = countsAfterSecond.filter((x) => x.count <= 1).length;
    expect(loserCounts).toBeGreaterThanOrEqual(1);
  });

  it("releaseConcurrencySlot frees the slot: after the in-flight runs finish, subsequent dispatch is not blocked", async () => {
    // 2 detectors, cap=2 → both should dispatch cleanly. After they finish,
    // the cap is effectively reset (activeRuns cleared for this habitat).
    // We assert this by driving two back-to-back calls and observing that
    // both calls produced runs for both detectors.
    tmpDirs.push(
      await writePlugin(
        "rel-a",
        `{
          manifest: {
            id: 'rel-a',
            version: '1.0.0',
            description: 'fast detector a',
            contributions: [{
              kind: 'signalDetector',
              scope: 'habitat',
              detectorId: 'a',
              label: 'A',
              detects: 'pulseCreated',
              rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
              requires: [],
            }],
          },
          detectors: { a: async () => [] },
        }`,
      ),
      await writePlugin(
        "rel-b",
        `{
          manifest: {
            id: 'rel-b',
            version: '1.0.0',
            description: 'fast detector b',
            contributions: [{
              kind: 'signalDetector',
              scope: 'habitat',
              detectorId: 'b',
              label: 'B',
              detects: 'pulseCreated',
              rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
              requires: [],
            }],
          },
          detectors: { b: async () => [] },
        }`,
      ),
    );

    const habitatId = setupHabitat();
    enroll(habitatId, "rel-a", "a", "signalDetector");
    enroll(habitatId, "rel-b", "b", "signalDetector");

    // First call: both should dispatch (cap=2, 2 detectors).
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "rel-1",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    await pollUntil(
      () =>
        runRepo.listByHabitat(habitatId, { pluginId: "rel-a" }).length +
        runRepo.listByHabitat(habitatId, { pluginId: "rel-b" }).length,
      (n) => n >= 2,
      1500,
    );

    // Second call (after slots released from first): both should dispatch again.
    await new Promise((r) => setTimeout(r, 100));
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "rel-2",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    await pollUntil(
      () =>
        runRepo.listByHabitat(habitatId, { pluginId: "rel-a" }).length +
        runRepo.listByHabitat(habitatId, { pluginId: "rel-b" }).length,
      (n) => n >= 4,
      1500,
    );

    // Each detector ran twice — proving release freed the slot between calls.
    expect(runRepo.listByHabitat(habitatId, { pluginId: "rel-a" }).length).toBe(2);
    expect(runRepo.listByHabitat(habitatId, { pluginId: "rel-b" }).length).toBe(2);
  });

  it("the concurrency cap is per-habitat: saturating H1 does not block H2's dispatch", async () => {
    // Two slow detectors in H1 → saturate H1's cap=2 (both hold slots).
    // One fast detector in H2. While H1's slots are held, dispatch for H2 must
    // proceed immediately — the counter is keyed by habitatId.
    tmpDirs.push(
      await writePlugin(
        "iso-a1",
        `{
          manifest: {
            id: 'iso-a1',
            version: '1.0.0',
            description: 'slow detector in H1 (a1)',
            contributions: [{
              kind: 'signalDetector',
              scope: 'habitat',
              detectorId: 'a1',
              label: 'A1',
              detects: 'pulseCreated',
              rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
              requires: [],
            }],
          },
          detectors: {
            a1: async () => {
              await new Promise((r) => setTimeout(r, 400));
              return [];
            },
          },
        }`,
      ),
      await writePlugin(
        "iso-a2",
        `{
          manifest: {
            id: 'iso-a2',
            version: '1.0.0',
            description: 'slow detector in H1 (a2)',
            contributions: [{
              kind: 'signalDetector',
              scope: 'habitat',
              detectorId: 'a2',
              label: 'A2',
              detects: 'pulseCreated',
              rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
              requires: [],
            }],
          },
          detectors: {
            a2: async () => {
              await new Promise((r) => setTimeout(r, 400));
              return [];
            },
          },
        }`,
      ),
      await writePlugin(
        "iso-b",
        `{
          manifest: {
            id: 'iso-b',
            version: '1.0.0',
            description: 'fast detector in H2',
            contributions: [{
              kind: 'signalDetector',
              scope: 'habitat',
              detectorId: 'b',
              label: 'B',
              detects: 'pulseCreated',
              rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
              requires: [],
            }],
          },
          detectors: { b: async () => [] },
        }`,
      ),
    );

    const h1 = setupHabitat();
    const h2 = setupHabitat();
    enroll(h1, "iso-a1", "a1", "signalDetector");
    enroll(h1, "iso-a2", "a2", "signalDetector");
    enroll(h2, "iso-b", "b", "signalDetector");

    publishMock.mockClear();

    // Saturate H1: both detectors start, hold H1's slots for ~400ms.
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "iso-h1",
      habitatId: h1,
      occurredAt: new Date().toISOString(),
    });

    // Wait until both H1 detectors have started (have a run row).
    const h1Started = await pollUntil(
      () =>
        runRepo.listByHabitat(h1, { pluginId: "iso-a1" }).length +
        runRepo.listByHabitat(h1, { pluginId: "iso-a2" }).length,
      (n) => n === 2,
      1000,
    );
    expect(h1Started).toBeDefined();

    // While H1's slots are still held, drive H2 — H2 has its own counter.
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "iso-h2",
      habitatId: h2,
      occurredAt: new Date().toISOString(),
    });

    // H2's dispatch must proceed (not blocked by H1's saturation).
    const h2Run = await pollUntil(
      () => runRepo.listByHabitat(h2, { pluginId: "iso-b" }).find((r) => r.status === "succeeded"),
      (r) => r !== undefined,
      1500,
    );
    expect(h2Run).toBeDefined();
    expect(h2Run!.status).toBe("succeeded");
  });
});

// ---------------------------------------------------------------------------
// withTimeout late-rejection swallowing (pluginManager.ts:191)
// The contract: when a handler's promise rejects AFTER timeoutMs has won the race,
// the late rejection must NOT trigger an unhandledRejection event. This is what
// `promise.catch(() => {})` at L191 guarantees.
// Approach: action with timeoutMs=100 and a handler that rejects at 500ms.
// The dispatcher awaits, sees timeout at 100ms, marks run failed, returns.
// The handler's promise later rejects at 500ms with no consumer — must be swallowed.
// ---------------------------------------------------------------------------
describe("v0.28-T2b: withTimeout late-rejection swallowing (no unhandledRejection escapes)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = "";
  });

  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("handler rejecting AFTER timeout wins: run marked failed, no unhandledRejection fires", async () => {
    tmpDir = await writePlugin(
      "late-reject",
      `{
        manifest: {
          id: 'late-reject',
          version: '1.0.0',
          description: 'action whose handler rejects after its timeout',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'late',
            label: 'Late',
            requires: [],
            timeoutMs: 100,
          }],
        },
        actions: {
          late: () => new Promise((_, reject) => {
            setTimeout(() => reject(new Error('late-boom-at-500ms')), 500);
          }),
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "late-reject", "late", "automationAction");

    // Trap unhandledRejection events so we can assert none fire.
    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);

    try {
      const entry = pluginManager.getActionEntry("late");
      expect(entry).not.toBeNull();
      const evalCtx = {
        habitat: null,
        task: null,
        mission: null,
        agent: null,
        sprint: null,
        raw: {},
      } as PluginEvaluationContext;

      const result = await pluginManager.dispatchActionHandler(
        entry!,
        "late",
        habitatId,
        evalCtx,
        {},
      );

      // Dispatch returned (timeout won the race at 100ms).
      expect(result.status).toBe("failed");
      expect(result.error).toContain("timed out");

      // Run record is marked failed with timeout error.
      const failedRun = await pollUntil(
        () =>
          runRepo
            .listByHabitat(habitatId, { pluginId: "late-reject" })
            .find((r) => r.status === "failed"),
        (r) => r !== undefined,
        1500,
      );
      expect(failedRun).toBeDefined();
      expect(failedRun!.error).toContain("timed out");

      // Wait past the handler's late-rejection timestamp (500ms) so any
      // unhandledRejection would have fired by now.
      await new Promise((r) => setTimeout(r, 700));

      // The swallow at pluginManager.ts:191 means no unhandledRejection escapes.
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("handler that succeeds within timeout: no rejection, no run 'failed'", async () => {
    // Negative control: a well-behaved handler that returns within timeoutMs
    // should produce a successful run and trigger no late rejection.
    tmpDir = await writePlugin(
      "ok-fast",
      `{
        manifest: {
          id: 'ok-fast',
          version: '1.0.0',
          description: 'action that completes in time',
          contributions: [{
            kind: 'automationAction',
            scope: 'habitat',
            actionId: 'ok',
            label: 'OK',
            requires: [],
            timeoutMs: 500,
          }],
        },
        actions: {
          ok: async () => {
            await new Promise((r) => setTimeout(r, 50));
            return { status: 'succeeded', result: { ok: true } };
          },
        },
      }`,
    );
    const habitatId = setupHabitat();
    enroll(habitatId, "ok-fast", "ok", "automationAction");

    const rejections: unknown[] = [];
    const listener = (reason: unknown): void => {
      rejections.push(reason);
    };
    process.on("unhandledRejection", listener);

    try {
      const entry = pluginManager.getActionEntry("ok");
      const evalCtx = {
        habitat: null,
        task: null,
        mission: null,
        agent: null,
        sprint: null,
        raw: {},
      } as PluginEvaluationContext;
      const result = await pluginManager.dispatchActionHandler(
        entry!,
        "ok",
        habitatId,
        evalCtx,
        {},
      );
      expect(result.status).toBe("succeeded");

      // Wait past the action's slow handler duration + buffer.
      await new Promise((r) => setTimeout(r, 200));

      const okRun = await pollUntil(
        () =>
          runRepo
            .listByHabitat(habitatId, { pluginId: "ok-fast" })
            .find((r) => r.status === "succeeded"),
        (r) => r !== undefined,
        1500,
      );
      expect(okRun).toBeDefined();
      expect(rejections).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });
});
