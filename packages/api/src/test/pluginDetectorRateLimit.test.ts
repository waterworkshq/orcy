import { describe, it, expect, beforeEach } from "vitest";
import {
  checkAndRecordDetection,
  checkSignalHourQuota,
  recordSignalsEmitted,
  resetDetectorRateLimits,
} from "../plugins/detectorRateLimiter.js";
import {
  createInvocationRuntime,
  type DetectorTarget,
  type RuntimeDeps,
  type DetectorInvocationRequest,
} from "../plugins/invocationRuntime.js";

describe("PLG-5: Plugin Detector Rate Limiting", () => {
  beforeEach(() => {
    resetDetectorRateLimits();
  });

  describe("detectorRateLimiter unit logic", () => {
    it("enforces maxDetectionsPerMinute sliding window", () => {
      const habitatId = "hab-1";
      const key = "plugin-a:det-1";
      const limit = 3;
      const baseTime = 1000000;

      expect(checkAndRecordDetection(habitatId, key, limit, baseTime)).toBe(true);
      expect(checkAndRecordDetection(habitatId, key, limit, baseTime + 1000)).toBe(true);
      expect(checkAndRecordDetection(habitatId, key, limit, baseTime + 2000)).toBe(true);
      // 4th invocation in the same minute should be rejected
      expect(checkAndRecordDetection(habitatId, key, limit, baseTime + 3000)).toBe(false);

      // After 61 seconds, previous invocations expire from window
      expect(checkAndRecordDetection(habitatId, key, limit, baseTime + 61000)).toBe(true);
    });

    it("enforces maxSignalsPerHour sliding window", () => {
      const habitatId = "hab-1";
      const key = "plugin-a:det-1";
      const limit = 5;
      const baseTime = 1000000;

      expect(checkSignalHourQuota(habitatId, key, limit, baseTime)).toBe(true);
      recordSignalsEmitted(habitatId, key, 3, baseTime);

      expect(checkSignalHourQuota(habitatId, key, limit, baseTime + 1000)).toBe(true);
      recordSignalsEmitted(habitatId, key, 2, baseTime + 1000);

      // Quota is now 5/5 -> subsequent checks return false
      expect(checkSignalHourQuota(habitatId, key, limit, baseTime + 2000)).toBe(false);

      // After 3601 seconds, previous emissions expire
      expect(checkSignalHourQuota(habitatId, key, limit, baseTime + 3601000)).toBe(true);
    });
  });

  describe("InvocationRuntime rate limit integration", () => {
    it("throttles detector exceeding rate limit and finishes as rate_limited with handlerLaunched: false", async () => {
      let slots = 0;
      let finishedStatus: string | null = null;
      let finishedError: string | null = null;

      const mockDeps: RuntimeDeps = {
        startRun: () => ({ id: "run-1" } as any),
        finishRun: (_id, status, _signals, error) => {
          finishedStatus = status;
          finishedError = error ?? null;
          return { id: "run-1", status } as any;
        },
        deleteRun: () => true,
        buildContext: () => ({ runId: "run-1" } as any),
        isQuarantined: () => false,
        incrementError: () => {},
        withTimeout: (p) => p,
        acquireDetectorSlot: () => {
          slots++;
          return true;
        },
        releaseDetectorSlot: () => {
          slots--;
        },
        checkDetectorRateLimit: () => ({
          allowed: false,
          reason: "Exceeded maxDetectionsPerMinute (1)",
        }),
        logger: { error: () => {}, warn: () => {}, info: () => {} },
      };

      const runtime = createInvocationRuntime(mockDeps);
      const target: DetectorTarget = {
        kind: "signalDetector",
        pluginId: "test-plugin",
        contributionId: "det-1",
        canonicalKey: "test-plugin:det-1",
        handler: async () => [],
        contribution: {
          kind: "signalDetector",
          scope: "habitat",
          detectorId: "det-1",
          label: "Test Detector",
          detects: "taskEvent",
          rateLimitDefaults: { maxDetectionsPerMinute: 1, maxSignalsPerHour: 10 },
          requires: [],
        },
        requires: [],
        timeoutMs: 5000,
      };

      const request: DetectorInvocationRequest = {
        target,
        habitatId: "hab-1",
        triggerEventId: "task-1",
        triggerType: "task.created",
        source: {
          kind: "taskEvent",
          habitatId: "hab-1",
          sourceId: "task-1",
          occurredAt: new Date().toISOString(),
        },
        onResult: async () => 0,
      };

      const outcome = await runtime.invokeManaged(request);

      expect(outcome.status).toBe("rate_limited");
      expect(outcome.handlerLaunched).toBe(false);
      expect(finishedStatus).toBe("rate_limited");
      expect(finishedError).toContain("Exceeded maxDetectionsPerMinute");
      // Concurrency slot must have been acquired and then cleanly released
      expect(slots).toBe(0);
    });
  });
});
