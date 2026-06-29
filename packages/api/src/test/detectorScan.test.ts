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
import * as habitatRepo from "../repositories/board.js";
import * as columnRepo from "../repositories/column.js";
import * as missionRepo from "../repositories/feature.js";
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

    runScan();
    await new Promise((r) => setTimeout(r, 300));

    expect(runRepo.existsForTriggerEvent("scan-recover", "scan-recover-detector", pulseId)).toBe(
      true,
    );

    const runs = runRepo.listByHabitat(habitatId);
    const successRun = runs.find(
      (r) => r.pluginId === "scan-recover" && r.status === "succeeded",
    );
    expect(successRun).toBeDefined();
    expect(successRun!.signalsEmitted).toBe(1);
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

    runScan();
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

    runScan();

    const updated = enrollmentRepo.getById(enrollment.id);
    expect(updated!.lastScannedAt).not.toBeNull();
    expect(new Date(updated!.lastScannedAt!).getTime()).toBeGreaterThan(Date.now() - 5000);
  });
});
