/**
 * v0.22.3 detector catch-up scan tests.
 *
 * Verifies that pulses missed during detector downtime are recovered by the scan,
 * and that already-processed events are skipped (dedup via plugin_runs check).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { closeDb, initTestDb } from "../db/index.js";
import * as pluginManager from "../plugins/pluginManager.js";
import * as enrollmentRepo from "../repositories/pluginEnrollment.js";
import * as runRepo from "../repositories/pluginRun.js";
import * as habitatRepo from "../repositories/habitat.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/mission.js";
import * as taskRepo from "../repositories/task.js";
import * as pulseRepo from "../repositories/pulse.js";
import { resetPlugins } from "../plugins/pluginManager.js";
import { runScan, stopDetectorScan } from "../services/detectorScanService.js";

const publishMock = vi.fn();
vi.mock("../sse/broadcaster.js", () => ({
  sseBroadcaster: { publish: (...args: unknown[]) => publishMock(...args) },
}));

function setupFixtures(): { habitatId: string; missionId: string; taskId: string } {
  const habitat = habitatRepo.createHabitat({ name: "Scan Test" });
  const column = columnRepo.createColumn({
    habitatId: habitat.id,
    name: "Todo",
    order: 0,
    requiresClaim: false,
  });
  const mission = missionRepo.createMission({
    habitatId: habitat.id,
    columnId: column.id,
    title: "M",
    createdBy: "test",
  });
  const task = taskRepo.createTask({
    missionId: mission.id,
    title: "T",
    priority: "medium",
    createdBy: "test",
  });
  return { habitatId: habitat.id, missionId: mission.id, taskId: task.id };
}

function insertPulse(
  habitatId: string,
  missionId: string,
  taskId: string,
  subject: string,
): string {
  const pulse = pulseRepo.createPulse({
    habitatId,
    missionId,
    scope: "mission",
    fromType: "agent",
    fromId: "test-agent",
    signalType: "finding",
    subject,
    body: "",
    taskId,
  });
  return pulse.id;
}

describe("detector catch-up scan (v0.22.3)", () => {
  let tmpDir: string;

  beforeEach(async () => {
    await initTestDb();
    resetPlugins();
    publishMock.mockClear();
  });

  afterEach(async () => {
    stopDetectorScan();
    resetPlugins();
    closeDb();
    if (tmpDir) {
      const { rm } = await import("node:fs/promises");
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function writeDetectorPlugin(name: string, handlerBody: string): Promise<void> {
    const { mkdir, writeFile } = await import("node:fs/promises");
    tmpDir = `/tmp/test-scan-${name}-${Date.now()}`;
    await mkdir(tmpDir, { recursive: true });
    await writeFile(
      `${tmpDir}/${name}.mjs`,
      `export default {
        manifest: {
          id: '${name}',
          version: '1.0.0',
          description: 'test detector',
          contributions: [{
            kind: 'signalDetector',
            scope: 'habitat',
            detectorId: '${name}-detector',
            label: 'Test Detector',
            detects: 'pulseCreated',
            rateLimitDefaults: { maxDetectionsPerMinute: 100, maxSignalsPerHour: 100 },
            requires: [],
          }],
        },
        detectors: {
          '${name}-detector': ${handlerBody},
        },
      };`,
    );
    pluginManager.setPluginDirectory(tmpDir);
    await pluginManager.loadPlugins();
  }

  it("recovers pulses that arrived while the scanner was not running", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();

    await writeDetectorPlugin(
      "scan-recover",
      `async (ctx, ref) => {
        return [{ signalType: 'detected', subject: 'caught up signal for ' + ref.sourceId }];
      }`,
    );

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-recover",
      contributionId: "scan-recover-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    // Backdate watermark to simulate prior scan. Pulses after this were "missed."
    const staleWatermark = new Date(Date.now() - 60000).toISOString();
    enrollmentRepo.updateLastScannedAt(enrollment.id, staleWatermark);

    // Pulse arrives AFTER the stale watermark but BEFORE the scan runs.
    const pulseId = insertPulse(habitatId, missionId, taskId, "missed pulse");

    await runScan();
    await new Promise((r) => setTimeout(r, 300));

    expect(
      runRepo.existsForTriggerEvent(
        "scan-recover",
        "signalDetector",
        "scan-recover-detector",
        pulseId,
      ),
    ).toBe(true);

    const runs = runRepo.listByHabitat(habitatId);
    const successRun = runs.find((r) => r.pluginId === "scan-recover" && r.status === "succeeded");
    expect(successRun).toBeDefined();
    expect(successRun!.signalsEmitted).toBe(1);
  });

  it("rolls back every detector signal when a mid-batch write fails", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();

    await writeDetectorPlugin(
      "scan-tx-fail",
      `async () => [
        { signalType: 'detected', subject: 's1-will-insert-then-rollback' },
        { signalType: 'detected', subject: 's2-will-fail' },
        { signalType: 'detected', subject: 's3-never-reached' },
      ]`,
    );

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-tx-fail",
      contributionId: "scan-tx-fail-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);
    enrollmentRepo.updateLastScannedAt(
      enrollment.id,
      new Date(Date.now() - 60_000).toISOString(),
    );
    insertPulse(habitatId, missionId, taskId, "detector transaction failure source");

    const realCreateWithClient = pulseRepo.createPulseWithClient;
    let insertCallCount = 0;
    const insertSpy = vi
      .spyOn(pulseRepo, "createPulseWithClient")
      .mockImplementation((db, input) => {
        insertCallCount++;
        if (insertCallCount === 2) {
          throw new Error("simulated detector mid-batch write failure on signal 2");
        }
        return realCreateWithClient.call(pulseRepo, db, input);
      });

    await runScan();

    const failedRun = runRepo
      .listByHabitat(habitatId, { pluginId: "scan-tx-fail" })
      .find((run) => run.status === "failed");
    expect(failedRun).toBeDefined();
    expect(failedRun!.error).toContain("simulated detector mid-batch write failure on signal 2");
    expect(failedRun!.signalsEmitted).toBeNull();
    expect(insertCallCount).toBe(2);

    const detected = pulseRepo
      .listByHabitatSince(habitatId, "1970-01-01T00:00:00.000Z")
      .filter((pulse) => pulse.signalType === "detected" && pulse.fromId === "scan-tx-fail");
    expect(detected).toEqual([]);

    insertSpy.mockRestore();
  });

  it("skips events already processed by the live hook (dedup)", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();
    const pulseId = insertPulse(habitatId, missionId, taskId, "already processed");

    await writeDetectorPlugin("scan-dedup", `async () => []`);

    enrollmentRepo.create({
      habitatId,
      pluginId: "scan-dedup",
      contributionId: "scan-dedup-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    runRepo.startRun({
      habitatId,
      pluginId: "scan-dedup",
      contributionId: "scan-dedup-detector",
      contributionKind: "signalDetector",
      triggerEventId: pulseId,
      triggerType: "pulseCreated",
    });

    const runsBefore = runRepo.listByHabitat(habitatId).length;

    await runScan();
    await new Promise((r) => setTimeout(r, 200));

    const runsAfter = runRepo.listByHabitat(habitatId).length;
    expect(runsAfter).toBe(runsBefore);
  });

  it("updates lastScannedAt watermark after each scan pass", async () => {
    const { habitatId } = setupFixtures();

    await writeDetectorPlugin("scan-watermark", `async () => []`);

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-watermark",
      contributionId: "scan-watermark-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    expect(enrollment.lastScannedAt).toBeNull();

    await runScan();

    const updated = enrollmentRepo.getById(enrollment.id);
    expect(updated!.lastScannedAt).not.toBeNull();
    expect(new Date(updated!.lastScannedAt!).getTime()).toBeGreaterThan(Date.now() - 5000);
  });

  // ─── T4 (ADR-0039) — status-aware dedup + recovery ───────────────────

  it("T4: skipped rows do NOT satisfy dedup — scanner retries the event", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();

    await writeDetectorPlugin(
      "scan-skip-recover",
      `async (ctx, ref) => {
        return [{ signalType: 'detected', subject: 'recovered after skip: ' + ref.sourceId }];
      }`,
    );

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-skip-recover",
      contributionId: "scan-skip-recover-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    const staleWatermark = new Date(Date.now() - 60000).toISOString();
    enrollmentRepo.updateLastScannedAt(enrollment.id, staleWatermark);

    const pulseId = insertPulse(habitatId, missionId, taskId, "pre-skipped pulse");

    // Insert a `skipped` run for this pulse — simulates a prior quarantine block.
    const run = runRepo.startRun({
      habitatId,
      pluginId: "scan-skip-recover",
      contributionId: "scan-skip-recover-detector",
      contributionKind: "signalDetector",
      triggerEventId: pulseId,
      triggerType: "pulseCreated",
    });
    runRepo.finishRun(run.id, "skipped");

    // The skipped row must NOT satisfy dedup — the event is recovery-eligible.
    expect(
      runRepo.existsForTriggerEvent(
        "scan-skip-recover",
        "signalDetector",
        "scan-skip-recover-detector",
        pulseId,
      ),
    ).toBe(false);

    await runScan();
    await new Promise((r) => setTimeout(r, 300));

    // The scanner retried the event and produced a succeeded run.
    const successRun = runRepo
      .listByHabitat(habitatId)
      .find((r) => r.pluginId === "scan-skip-recover" && r.status === "succeeded");
    expect(successRun).toBeDefined();
    expect(successRun!.triggerEventId).toBe(pulseId);
  });

  it("T4: rate_limited rows do NOT satisfy dedup — scanner retries the event", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();

    await writeDetectorPlugin(
      "scan-rl-recover",
      `async (ctx, ref) => {
        return [{ signalType: 'detected', subject: 'recovered after rate_limit: ' + ref.sourceId }];
      }`,
    );

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-rl-recover",
      contributionId: "scan-rl-recover-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    const staleWatermark = new Date(Date.now() - 60000).toISOString();
    enrollmentRepo.updateLastScannedAt(enrollment.id, staleWatermark);

    const pulseId = insertPulse(habitatId, missionId, taskId, "pre-rate-limited pulse");

    // Insert a `rate_limited` run — simulates a prior capacity denial.
    const run = runRepo.startRun({
      habitatId,
      pluginId: "scan-rl-recover",
      contributionId: "scan-rl-recover-detector",
      contributionKind: "signalDetector",
      triggerEventId: pulseId,
      triggerType: "pulseCreated",
    });
    runRepo.finishRun(run.id, "rate_limited");

    // The rate_limited row must NOT satisfy dedup.
    expect(
      runRepo.existsForTriggerEvent(
        "scan-rl-recover",
        "signalDetector",
        "scan-rl-recover-detector",
        pulseId,
      ),
    ).toBe(false);

    await runScan();
    await new Promise((r) => setTimeout(r, 300));

    const successRun = runRepo
      .listByHabitat(habitatId)
      .find((r) => r.pluginId === "scan-rl-recover" && r.status === "succeeded");
    expect(successRun).toBeDefined();
    expect(successRun!.triggerEventId).toBe(pulseId);
  });

  it("R2: context-failure skipped row is retried on next scan (BLOCKER 2)", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();

    await writeDetectorPlugin(
      "scan-ctx-recover",
      `async (ctx, ref) => {
        return [{ signalType: 'detected', subject: 'recovered after ctx failure: ' + ref.sourceId }];
      }`,
    );

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-ctx-recover",
      contributionId: "scan-ctx-recover-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    const staleWatermark = new Date(Date.now() - 60000).toISOString();
    enrollmentRepo.updateLastScannedAt(enrollment.id, staleWatermark);

    const pulseId = insertPulse(habitatId, missionId, taskId, "pre-context-failure pulse");

    // Simulate a context-construction failure: the runtime now finishes
    // these as "skipped" (not "failed") so the row is recovery-eligible.
    const run = runRepo.startRun({
      habitatId,
      pluginId: "scan-ctx-recover",
      contributionId: "scan-ctx-recover-detector",
      contributionKind: "signalDetector",
      triggerEventId: pulseId,
      triggerType: "pulseCreated",
    });
    runRepo.finishRun(run.id, "skipped", undefined, "buildContext failed: ctx fail");

    // The skipped row must NOT satisfy dedup (BLOCKER 2 — context failure
    // does not advance the scan watermark and retries on a later pass).
    expect(
      runRepo.existsForTriggerEvent(
        "scan-ctx-recover",
        "signalDetector",
        "scan-ctx-recover-detector",
        pulseId,
      ),
    ).toBe(false);

    await runScan();
    await new Promise((r) => setTimeout(r, 300));

    // The scanner retried the event and produced a succeeded run.
    const successRun = runRepo
      .listByHabitat(habitatId)
      .find((r) => r.pluginId === "scan-ctx-recover" && r.status === "succeeded");
    expect(successRun).toBeDefined();
    expect(successRun!.triggerEventId).toBe(pulseId);
  });

  it("R2: stranded running row deleted by finish-failure fallback is retried (BLOCKER 2)", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();

    await writeDetectorPlugin(
      "scan-del-recover",
      `async (ctx, ref) => {
        return [{ signalType: 'detected', subject: 'recovered after delete: ' + ref.sourceId }];
      }`,
    );

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-del-recover",
      contributionId: "scan-del-recover-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    const staleWatermark = new Date(Date.now() - 60000).toISOString();
    enrollmentRepo.updateLastScannedAt(enrollment.id, staleWatermark);

    const pulseId = insertPulse(habitatId, missionId, taskId, "pre-delete pulse");

    // Simulate a pre-launch finish failure: the row was supposed to be
    // "skipped" but finishRun failed, leaving it stranded as "running".
    // The runtime's safeDeleteRun fallback deletes it.
    const run = runRepo.startRun({
      habitatId,
      pluginId: "scan-del-recover",
      contributionId: "scan-del-recover-detector",
      contributionKind: "signalDetector",
      triggerEventId: pulseId,
      triggerType: "pulseCreated",
    });
    // Row is "running" — would falsely satisfy dedup.
    expect(
      runRepo.existsForTriggerEvent(
        "scan-del-recover",
        "signalDetector",
        "scan-del-recover-detector",
        pulseId,
      ),
    ).toBe(true);

    // safeDeleteRun fallback removes the stranded row.
    runRepo.deleteRun(run.id);

    // After deletion, dedup no longer matches — event is recovery-eligible.
    expect(
      runRepo.existsForTriggerEvent(
        "scan-del-recover",
        "signalDetector",
        "scan-del-recover-detector",
        pulseId,
      ),
    ).toBe(false);

    await runScan();
    await new Promise((r) => setTimeout(r, 300));

    const successRun = runRepo
      .listByHabitat(habitatId)
      .find((r) => r.pluginId === "scan-del-recover" && r.status === "succeeded");
    expect(successRun).toBeDefined();
    expect(successRun!.triggerEventId).toBe(pulseId);
  });

  it("T4: running/succeeded/failed rows DO satisfy dedup — scanner skips them", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();

    await writeDetectorPlugin("scan-durable", `async () => []`);

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-durable",
      contributionId: "scan-durable-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    const staleWatermark = new Date(Date.now() - 60000).toISOString();
    enrollmentRepo.updateLastScannedAt(enrollment.id, staleWatermark);

    const pulseId = insertPulse(habitatId, missionId, taskId, "durable pulse");

    // Insert a `running` run — handler was durably launched.
    runRepo.startRun({
      habitatId,
      pluginId: "scan-durable",
      contributionId: "scan-durable-detector",
      contributionKind: "signalDetector",
      triggerEventId: pulseId,
      triggerType: "pulseCreated",
    });

    // running satisfies dedup — at-most-once after durable launch.
    expect(
      runRepo.existsForTriggerEvent(
        "scan-durable",
        "signalDetector",
        "scan-durable-detector",
        pulseId,
      ),
    ).toBe(true);

    const runsBefore = runRepo.listByHabitat(habitatId).length;

    await runScan();
    await new Promise((r) => setTimeout(r, 200));

    // Scanner skipped this event — no new run.
    const runsAfter = runRepo.listByHabitat(habitatId).length;
    expect(runsAfter).toBe(runsBefore);
  });

  it("T4: recovery_deferred (quarantine) prevents watermark advance", async () => {
    const { habitatId, missionId, taskId } = setupFixtures();

    process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD = "2";

    await writeDetectorPlugin("scan-quar", `async () => { throw new Error('quarantine-boom'); }`);

    const enrollment = enrollmentRepo.create({
      habitatId,
      pluginId: "scan-quar",
      contributionId: "scan-quar-detector",
      contributionKind: "signalDetector",
      enrolledBy: "test",
      enabled: 1,
    });
    pluginManager.invalidateEnrollmentCache(habitatId);

    // Drive 2 errors to quarantine the detector.
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "quar-pre-1",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    pluginManager.dispatchDetectionEvent("pulseCreated", {
      kind: "pulseCreated",
      sourceId: "quar-pre-2",
      habitatId,
      occurredAt: new Date().toISOString(),
    });
    await new Promise((r) => setTimeout(r, 300));

    // Backdate watermark.
    const staleWatermark = new Date(Date.now() - 60000).toISOString();
    enrollmentRepo.updateLastScannedAt(enrollment.id, staleWatermark);

    // Insert a pulse AFTER the stale watermark.
    insertPulse(habitatId, missionId, taskId, "post-quarantine pulse");

    await runScan();
    await new Promise((r) => setTimeout(r, 300));

    // The watermark must NOT advance — the detector is quarantined (recovery_deferred).
    const updated = enrollmentRepo.getById(enrollment.id);
    expect(updated!.lastScannedAt).toBe(staleWatermark);

    delete process.env.ORCY_PLUGIN_QUARANTINE_THRESHOLD;
  });
});
